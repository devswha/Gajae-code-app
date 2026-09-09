//! Main-view-bound updater bridge. Target-bound user requests enter the existing
//! guarded preparation and draft/backend-safe restart owners.
//! A dedicated owner-only socket keeps control data out of mixed child logs.
//! Its secret is written once to the owned child's stdin, never to its env.
use std::{
    fs,
    io::{Read, Write},
    os::fd::AsRawFd,
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::updater_backend::Backend;
use crate::updater_binding::{Binding, Mode};

const MAX_REQUEST: usize = 4096;
const MAX_RESPONSE: usize = 32 * 1024;
const MAX_PENDING: usize = 4;
const DEADLINE: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
#[serde(tag = "action", deny_unknown_fields)]
enum Command {
    #[serde(rename = "status")]
    Status {},
    #[serde(rename = "check")]
    Check {},
    #[serde(rename = "download")]
    Download {
        #[serde(rename = "targetId")]
        target_id: String,
    },
    #[serde(rename = "setAutomatic")]
    SetAutomatic { automatic: bool },
    #[serde(rename = "restart")]
    Restart {
        #[serde(rename = "targetId")]
        target_id: String,
    },
    #[serde(rename = "restartPrepared")]
    RestartPrepared {
        #[serde(rename = "attemptId")]
        attempt_id: String,
        #[serde(rename = "draftEpoch")]
        draft_epoch: u64,
    },
    #[serde(rename = "restartCancel")]
    RestartCancel {
        #[serde(rename = "attemptId")]
        attempt_id: String,
        #[serde(rename = "draftEpoch")]
        draft_epoch: u64,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol_version: u8,
    secret: String,
    epoch: String,
    pid: u32,
    sequence: u64,
    view: String,
    origin: String,
    command: Command,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Challenge {
    protocol_version: u8,
    kind: String,
    epoch: String,
    pid: u32,
    nonce: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendAttach {
    protocol_version: u8,
    kind: String,
    secret: String,
    epoch: String,
    pid: u32,
}

fn server_proof(secret: &str, epoch: &str, nonce: &str) -> String {
    use std::fmt::Write;
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(format!("gajae-native-update-v1\0{epoch}\0{nonce}").as_bytes());
    let mut encoded = String::with_capacity(64);
    for byte in mac.finalize().into_bytes() {
        write!(&mut encoded, "{byte:02x}").expect("string writing");
    }
    encoded
}

#[derive(Default)]
struct ReplayWindow {
    latest: u64,
    seen: u64,
}
impl ReplayWindow {
    fn accept(&mut self, sequence: u64) -> bool {
        if sequence == 0 || sequence > 9_007_199_254_740_991 {
            return false;
        }
        if sequence > self.latest {
            let difference = sequence - self.latest;
            self.seen = if difference >= 64 {
                0
            } else {
                self.seen << difference
            };
            self.latest = sequence;
        }
        let difference = self.latest - sequence;
        if difference >= 64 || self.seen & (1 << difference) != 0 {
            return false;
        }
        self.seen |= 1 << difference;
        true
    }
}

struct View {
    token: String,
    origin: String,
}
struct Authority {
    active: bool,
    secret: String,
    epoch: String,
    pid: u32,
    view: Option<View>,
    replay: ReplayWindow,
    last_mutation_sequence: u64,
}
impl Authority {
    fn admit(&mut self, request: &Request, peer: u32) -> bool {
        let mutating = !matches!(request.command, Command::Status {});
        let admitted = self.active
            && request.protocol_version == 1
            && peer == self.pid
            && request.pid == self.pid
            && equal_secret(&request.secret, &self.secret)
            && equal_secret(&request.epoch, &self.epoch)
            && self.view.as_ref().is_some_and(|view| {
                request.origin == view.origin && equal_secret(&request.view, &view.token)
            })
            && (!mutating || request.sequence > self.last_mutation_sequence)
            && self.replay.accept(request.sequence);
        if admitted && mutating {
            self.last_mutation_sequence = request.sequence;
        }
        admitted
    }

    fn challenge(&self, challenge: &Challenge, peer: u32) -> Option<String> {
        (self.active
            && challenge.protocol_version == 1
            && challenge.kind == "challenge"
            && peer == self.pid
            && challenge.pid == self.pid
            && equal_secret(&challenge.epoch, &self.epoch)
            && challenge.nonce.len() == 64
            && challenge
                .nonce
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .then(|| server_proof(&self.secret, &self.epoch, &challenge.nonce))
    }
}

fn equal_secret(left: &str, right: &str) -> bool {
    if left.len() != 64 || right.len() != 64 {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn secret() -> Result<String, String> {
    use std::fmt::Write;
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "updater_bridge_unavailable")?;
    let mut value = String::with_capacity(64);
    for byte in bytes {
        write!(&mut value, "{byte:02x}").expect("string writing");
    }
    Ok(value)
}

struct Run {
    authority: Mutex<Authority>,
    retired: AtomicBool,
    pending: AtomicUsize,
    socket: PathBuf,
    backend_claimed: AtomicBool,
    backend: OnceLock<Arc<Backend>>,
}

impl Run {
    fn retire(&self) {
        // Same short lock as admission. It is never held across preference I/O.
        if let Ok(mut authority) = self.authority.lock() {
            authority.active = false;
            authority.view = None;
        }
        self.retired.store(true, Ordering::Release);
        if let Some(backend) = self.backend.get() {
            backend.retire();
        }
    }

    fn attach_backend(&self, stream: &mut UnixStream, value: BackendAttach, peer: u32) {
        let admitted = self.authority.lock().is_ok_and(|authority| {
            authority.active
                && value.protocol_version == 1
                && value.kind == "backendAttach"
                && peer == authority.pid
                && value.pid == authority.pid
                && equal_secret(&value.epoch, &authority.epoch)
                && equal_secret(&value.secret, &authority.secret)
        });
        if !admitted
            || self.retired.load(Ordering::Acquire)
            || self.backend_claimed.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let Ok(clone) = stream.try_clone() else {
            return;
        };
        let Ok(backend) = Backend::new(clone, value.epoch.clone()) else {
            return;
        };
        let backend = Arc::new(backend);
        // Publish the channel only after its acknowledgement is on the wire,
        // so a concurrent UI request cannot send control before backendAttached.
        if !write_response(
            stream,
            &serde_json::json!({"protocolVersion":1,"kind":"backendAttached","epoch":value.epoch}),
        ) {
            backend.retire();
            return;
        }
        let _ = self.backend.set(backend.clone());
        if self.retired.load(Ordering::Acquire) {
            backend.retire();
        }
    }
}

#[derive(Default)]
pub(crate) struct Bridge(Mutex<Option<Arc<Run>>>);

pub(crate) fn available(app: &AppHandle) -> bool {
    app.try_state::<Bridge>().is_some_and(|bridge| {
        bridge.0.lock().is_ok_and(|slot| {
            slot.as_ref()
                .is_some_and(|run| !run.retired.load(Ordering::Acquire))
        })
    })
}

pub(crate) fn enabled(app: &AppHandle) -> bool {
    let binding = Binding::compiled();
    let profile = app.try_state::<crate::qa_profile::QaProfile>();
    binding.mode != Mode::Disabled
        && cfg!(target_arch = "aarch64")
        && binding.admits_profile(profile.as_ref().map(|p| p.root()), !cfg!(debug_assertions))
}

/// Caller writes the small initialization frame to fresh, otherwise-unused
/// owned stdin. Later requests use the bounded socket, not blocking pipe writes.
pub(crate) fn attach(app: &AppHandle, pid: u32) -> Result<Option<Vec<u8>>, String> {
    if !enabled(app) {
        return Ok(None);
    }
    let binding = Binding::compiled();
    let profile = app.try_state::<crate::qa_profile::QaProfile>();
    let root = crate::supervisor::desktop_data_root(app)?;
    binding.validate_runtime(
        profile.as_ref().map(|p| p.root()),
        &std::env::current_exe().map_err(|_| "updater_bridge_unavailable")?,
        &root,
        !cfg!(debug_assertions),
    )?;
    let key = secret()?;
    let epoch = secret()?;
    let directory = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| "updater_bridge_unavailable")?
        .join(format!("gju-{}", &epoch[..16]));
    let socket = directory.join("rpc");
    if socket.as_os_str().as_bytes().len() >= 100 {
        return Err("updater_bridge_unavailable".into());
    }
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .map_err(|_| "updater_bridge_unavailable")?;
    let listener = UnixListener::bind(&socket).map_err(|_| "updater_bridge_unavailable")?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
        .map_err(|_| "updater_bridge_unavailable")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "updater_bridge_unavailable")?;
    let inode = fs::symlink_metadata(&socket)
        .map_err(|_| "updater_bridge_unavailable")?
        .ino();
    let run = Arc::new(Run {
        authority: Mutex::new(Authority {
            active: true,
            secret: key.clone(),
            epoch: epoch.clone(),
            pid,
            view: None,
            replay: ReplayWindow::default(),
            last_mutation_sequence: 0,
        }),
        retired: AtomicBool::new(false),
        pending: AtomicUsize::new(0),
        socket,
        backend_claimed: AtomicBool::new(false),
        backend: OnceLock::new(),
    });
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Init<'a> {
        protocol_version: u8,
        socket: &'a std::path::Path,
        secret: &'a str,
        epoch: &'a str,
    }
    let frame = format!(
        "GJC_DESKTOP_UPDATE_INIT {}\n",
        serde_json::to_string(&Init {
            protocol_version: 1,
            socket: &run.socket,
            secret: &key,
            epoch: &epoch
        })
        .map_err(|_| "updater_bridge_unavailable")?
    )
    .into_bytes();
    if frame.len() > 1024 {
        return Err("updater_bridge_unavailable".into());
    }
    let managed = app.state::<Bridge>();
    if let Some(old) = managed
        .0
        .lock()
        .map_err(|_| "updater_bridge_unavailable")?
        .replace(run.clone())
    {
        old.retire();
    }
    let app = app.clone();
    std::thread::spawn(move || {
        while !run.retired.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    if run
                        .pending
                        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                            (n < MAX_PENDING).then_some(n + 1)
                        })
                        .is_err()
                    {
                        continue;
                    }
                    let run = run.clone();
                    let app = app.clone();
                    std::thread::spawn(move || {
                        serve(stream, &run, &app);
                        run.pending.fetch_sub(1, Ordering::AcqRel);
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                Err(_) => break,
            }
        }
        drop(listener);
        // Remove only this socket inode and its now-empty private directory.
        if fs::symlink_metadata(&run.socket).is_ok_and(|m| m.ino() == inode) {
            let _ = fs::remove_file(&run.socket);
        }
        let _ = fs::remove_dir(directory);
    });
    Ok(Some(frame))
}

pub(crate) fn retire(app: &AppHandle) {
    if let Some(bridge) = app.try_state::<Bridge>() {
        if let Ok(mut slot) = bridge.0.lock() {
            if let Some(run) = slot.take() {
                run.retire();
            }
        }
    }
}

fn read_frame<T: DeserializeOwned>(stream: &mut UnixStream, deadline: Instant) -> Result<T, ()> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(());
        }
        stream.set_read_timeout(Some(remaining)).map_err(|_| ())?;
        let count = stream.read(&mut chunk).map_err(|_| ())?;
        if count == 0 || bytes.len() + count > MAX_REQUEST {
            return Err(());
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(newline) = bytes.iter().position(|b| *b == b'\n') {
            if newline != bytes.len() - 1 {
                return Err(());
            }
            return serde_json::from_slice(&bytes[..newline]).map_err(|_| ());
        }
    }
}

fn peer_pid(stream: &UnixStream) -> Option<u32> {
    let mut pid: libc::pid_t = 0;
    let mut size = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // macOS binds this to the connecting process; descendants cannot simply
    // claim the server pid in JSON, even if they obtained a copied secret.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut size,
        )
    };
    (result == 0 && size as usize == std::mem::size_of::<libc::pid_t>() && pid > 0)
        .then_some(pid as u32)
}

fn serve(stream: UnixStream, run: &Arc<Run>, app: &AppHandle) {
    serve_protocol(stream, run, |request, peer| {
        // Authority is checked after acquiring the coordinator's operation lock.
        let admit = || {
            !app.state::<crate::lifecycle::SidecarLifecycle>()
                .is_shutting_down()
                && run
                    .authority
                    .lock()
                    .is_ok_and(|mut authority| authority.admit(request, peer))
        };
        let updater = app.state::<crate::updater::Preparation>();
        let restarts = app.state::<crate::updater_restart::Restarts>();
        match &request.command {
            Command::Status {} => updater.snapshot(admit).map(|state| {
                crate::updater_restart::Reply::Snapshot(restarts.decorate(
                    app,
                    run.backend.get(),
                    state,
                ))
            }),
            Command::Check {} => {
                if crate::updater_restart::blocks_start(app) {
                    return Err("updater_busy");
                }
                updater.manual_check(admit).map(|state| {
                    crate::updater_restart::Reply::Snapshot(restarts.decorate(
                        app,
                        run.backend.get(),
                        state,
                    ))
                })
            }
            Command::SetAutomatic { automatic } => {
                if crate::updater_restart::blocks_start(app) {
                    return Err("updater_busy");
                }
                updater.set_automatic(*automatic, admit).map(|state| {
                    crate::updater_restart::Reply::Snapshot(restarts.decorate(
                        app,
                        run.backend.get(),
                        state,
                    ))
                })
            }
            Command::Download { target_id } => {
                if crate::updater_restart::blocks_start(app) {
                    return Err("updater_busy");
                }
                updater.manual_download(target_id, admit).map(|state| {
                    crate::updater_restart::Reply::Snapshot(restarts.decorate(
                        app,
                        run.backend.get(),
                        state,
                    ))
                })
            }
            Command::Restart { target_id } => {
                if !admit() {
                    return Err("updater_unauthorized");
                }
                restarts.begin(app, restart_context(app, run, request, target_id)?)
            }
            Command::RestartPrepared {
                attempt_id,
                draft_epoch,
            } => {
                if !admit()
                    || !crate::updater_backend::hex_id(attempt_id)
                    || *draft_epoch == 0
                    || *draft_epoch > 9_007_199_254_740_991
                {
                    return Err("updater_unauthorized");
                }
                restarts.prepared(app, attempt_id, *draft_epoch)
            }
            Command::RestartCancel {
                attempt_id,
                draft_epoch,
            } => {
                if !admit()
                    || !crate::updater_backend::hex_id(attempt_id)
                    || *draft_epoch == 0
                    || *draft_epoch > 9_007_199_254_740_991
                {
                    return Err("updater_unauthorized");
                }
                restarts.cancel(app, attempt_id, *draft_epoch)
            }
        }
    });
}

fn restart_context(
    app: &AppHandle,
    run: &Arc<Run>,
    request: &Request,
    target_id: &str,
) -> Result<crate::updater_restart::Context, &'static str> {
    if !crate::updater_backend::hex_id(target_id) {
        return Err("updater_target_changed");
    }
    let backend = run
        .backend
        .get()
        .filter(|backend| backend.available())
        .cloned()
        .ok_or("updater_backend_unavailable")?;
    let window = app
        .get_webview_window("main")
        .ok_or("updater_unavailable")?;
    let return_url = window.url().map_err(|_| "updater_unavailable")?;
    if return_url.origin().ascii_serialization() != request.origin || !spa_page(&return_url) {
        return Err("updater_unauthorized");
    }
    let view = request.view.clone();
    let epoch = request.epoch.clone();
    let pid = request.pid;
    let original = run.clone();
    let handle = app.clone();
    let current = Arc::new(move || {
        !original.retired.load(Ordering::Acquire)
            && handle
                .state::<crate::lifecycle::SidecarLifecycle>()
                .owns_pid(pid)
            && !handle
                .state::<crate::lifecycle::SidecarLifecycle>()
                .is_shutting_down()
            && original.authority.lock().is_ok_and(|authority| {
                authority.active
                    && authority.epoch == epoch
                    && authority
                        .view
                        .as_ref()
                        .is_some_and(|current| equal_secret(&current.token, &view))
            })
    });
    let original = run.clone();
    let handle = app.clone();
    let epoch = request.epoch.clone();
    let same_run = Arc::new(move || {
        !original.retired.load(Ordering::Acquire)
            && handle
                .state::<crate::lifecycle::SidecarLifecycle>()
                .owns_pid(pid)
            && !handle
                .state::<crate::lifecycle::SidecarLifecycle>()
                .is_shutting_down()
            && original
                .authority
                .lock()
                .is_ok_and(|authority| authority.active && authority.epoch == epoch)
    });
    Ok(crate::updater_restart::Context {
        target_id: target_id.to_owned(),
        backend,
        server_pid: pid,
        return_url,
        current,
        same_run,
    })
}

fn spa_page(url: &tauri::Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.username().is_empty()
        && url.password().is_none()
        && !url.path().starts_with("/api/")
        && !url.path().starts_with("/desktop/")
        && !url.path().starts_with("/assets/")
        && !url.path().ends_with(".html")
        && !url.path().ends_with(".svg")
}

/// A precommit owner sends a confirmed rollback directly to the currently bound
/// view even when its HTTP waiter disconnected. The event name is the private
/// current-view capability, not a cookie or public global property.
pub(crate) fn notify_restart_aborted(app: &AppHandle, attempt_id: &str, epoch: u64) {
    crate::resume_deep_links(app);
    let Some(run) = app
        .try_state::<Bridge>()
        .and_then(|bridge| bridge.0.lock().ok().and_then(|run| run.clone()))
    else {
        return;
    };
    let Some((token, origin)) = run.authority.lock().ok().and_then(|authority| {
        authority
            .view
            .as_ref()
            .map(|view| (view.token.clone(), view.origin.clone()))
    }) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if !window
        .url()
        .is_ok_and(|url| spa_page(&url) && url.origin().ascii_serialization() == origin)
    {
        return;
    }
    let event =
        serde_json::to_string(&format!("gajae:desktop-restart:{token}")).expect("event name");
    let detail =
        serde_json::json!({"kind":"restartAborted","attemptId":attempt_id,"draftEpoch":epoch});
    let _ = window.eval(format!(
        "window.dispatchEvent(new CustomEvent({event},{{detail:{detail}}}));"
    ));
}

fn serve_protocol<T: Serialize>(
    mut stream: UnixStream,
    run: &Run,
    execute: impl FnOnce(&Request, u32) -> Result<T, &'static str>,
) {
    // BSD accepted sockets can retain the listener's nonblocking flag. A read
    // timeout does not clear O_NONBLOCK: frame 2 then spuriously fails before
    // the authenticated Node peer has time to send it. Only this accepted
    // stream becomes blocking; all reads keep their existing total deadline.
    if stream.set_nonblocking(false).is_err() {
        return;
    }
    let deadline = Instant::now() + DEADLINE;
    let Some(peer) = peer_pid(&stream) else {
        return;
    };
    let Ok(challenge) = read_frame::<Challenge>(&mut stream, deadline) else {
        return;
    };
    let Some(proof) = run
        .authority
        .lock()
        .ok()
        .and_then(|authority| authority.challenge(&challenge, peer))
    else {
        return;
    };
    // Authenticate this native endpoint before Node discloses its view token.
    // Kernel peer-pid validation prevents a substituted same-UID socket from
    // forwarding the challenge to the real native listener for an answer.
    let response = serde_json::json!({"protocolVersion":1,"kind":"challenge","epoch":challenge.epoch,"nonce":challenge.nonce,"proof":proof});
    if !write_response(&mut stream, &response) {
        return;
    }
    let Ok(message) = read_frame::<serde_json::Value>(&mut stream, deadline) else {
        return;
    };
    if message.get("kind").is_some() {
        if let Ok(attach) = serde_json::from_value::<BackendAttach>(message) {
            run.attach_backend(&mut stream, attach, peer);
        }
        return;
    }
    let Ok(request) = serde_json::from_value::<Request>(message) else {
        return;
    };
    let result = execute(&request, peer);
    let response = match result {
        Ok(snapshot) => {
            serde_json::json!({"protocolVersion":1,"sequence":request.sequence,"ok":true,"snapshot":snapshot})
        }
        Err(error) => {
            serde_json::json!({"protocolVersion":1,"sequence":request.sequence,"ok":false,"error":error})
        }
    };
    write_response(&mut stream, &response);
}

fn write_response(stream: &mut UnixStream, response: &serde_json::Value) -> bool {
    if let Ok(mut bytes) = serde_json::to_vec(response) {
        if bytes.len() + 1 > MAX_RESPONSE {
            return false;
        }
        bytes.push(b'\n');
        let _ = stream.set_write_timeout(Some(DEADLINE));
        return stream.write_all(&bytes).is_ok();
    }
    false
}

pub(crate) fn page_load(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if webview.label() != "main" {
        return;
    }
    let app = webview.app_handle();
    let Some(bridge) = app.try_state::<Bridge>() else {
        return;
    };
    let Some(run) = bridge.0.lock().ok().and_then(|r| r.clone()) else {
        return;
    };
    let Ok(mut authority) = run.authority.lock() else {
        return;
    };
    authority.view = None;
    if payload.event() == tauri::webview::PageLoadEvent::Started {
        crate::updater_restart::view_lost(app);
    }
    if payload.event() != tauri::webview::PageLoadEvent::Finished
        || run.retired.load(Ordering::Acquire)
        || !spa_page(payload.url())
        || !app
            .state::<crate::navigation::LoopbackOrigin>()
            .permits(payload.url())
    {
        return;
    }
    let Ok(token) = secret() else {
        return;
    };
    let origin = payload.url().origin().ascii_serialization();
    authority.view = Some(View {
        token: token.clone(),
        origin: origin.clone(),
    });
    drop(authority);
    let script = bridge_script(&token, &origin);
    if webview.eval(script).is_err() {
        if let Ok(mut authority) = run.authority.lock() {
            authority.view = None;
        }
    }
}

fn bridge_script(token: &str, origin: &str) -> String {
    let token = serde_json::to_string(token).expect("token string");
    let origin = serde_json::to_string(origin).expect("origin string");
    let qa_diagnostics = cfg!(debug_assertions) && Binding::compiled().mode == Mode::Qa;
    format!(
        "({})({token},{origin},{qa_diagnostics});",
        include_str!("updater_bridge.js")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn authority() -> Authority {
        Authority {
            active: true,
            secret: "a".repeat(64),
            epoch: "b".repeat(64),
            pid: 42,
            view: Some(View {
                token: "c".repeat(64),
                origin: "http://127.0.0.1:43123".into(),
            }),
            replay: ReplayWindow::default(),
            last_mutation_sequence: 0,
        }
    }
    fn request(sequence: u64) -> Request {
        Request {
            protocol_version: 1,
            secret: "a".repeat(64),
            epoch: "b".repeat(64),
            pid: 42,
            sequence,
            view: "c".repeat(64),
            origin: "http://127.0.0.1:43123".into(),
            command: Command::Status {},
        }
    }

    #[test]
    fn real_node_relay_completes_both_frames_on_a_nonblocking_accepted_socket() {
        let directory = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("gu-{}", &secret().unwrap()[..12]));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let socket_path = directory.join("rpc");
        let listener = UnixListener::bind(&socket_path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let script = r#"
            import {PassThrough} from 'node:stream';
            import {DesktopUpdateRelay} from './server/services/desktop-update-relay.ts';
            const input=new PassThrough();
            const relay=new DesktopUpdateRelay({input,platform:'darwin',env:{GJC_DESKTOP:'1',GJC_DESKTOP_UPDATE_PIPE:'1'}});
            input.write('GJC_DESKTOP_UPDATE_INIT '+JSON.stringify({protocolVersion:1,socket:process.argv[1],secret:'a'.repeat(64),epoch:'b'.repeat(64)})+'\n');
            try { const state=await relay.request({action:'status'},'c'.repeat(64),'http://127.0.0.1:43123'); if(state.phase!=='disabled')throw Error('wrong state');console.log('verified'); }
            finally {relay.retire();}
        "#;
        let mut child = std::process::Command::new("node")
            .args(["--import", "tsx", "--input-type=module", "--eval", script])
            .arg(&socket_path)
            .current_dir(repo)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break Some(stream),
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(_) => break None,
            }
        };
        let mut auth = authority();
        auth.pid = child.id();
        let run = Run {
            authority: Mutex::new(auth),
            retired: AtomicBool::new(false),
            pending: AtomicUsize::new(0),
            socket: socket_path.clone(),
            backend_claimed: AtomicBool::new(false),
            backend: OnceLock::new(),
        };
        if let Some(stream) = stream {
            // Deterministically exercise the BSD accept inheritance, regardless
            // of the host's default behavior. This must still wait for frame 2.
            stream.set_nonblocking(true).unwrap();
            serve_protocol(stream, &run, |request, peer| {
                if run.authority.lock().unwrap().admit(request, peer) {
                    Ok(crate::updater::Snapshot::default())
                } else {
                    Err("updater_unauthorized")
                }
            });
        } else {
            let _ = child.kill();
        }
        let result = child.wait_with_output().unwrap();
        drop(listener);
        fs::remove_file(socket_path).unwrap();
        fs::remove_dir(directory).unwrap();
        assert!(
            result.status.success(),
            "Node relay failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&result.stdout).trim(), "verified");
    }

    #[test]
    fn real_node_backend_channel_prepares_commits_and_never_reopens_on_disconnect() {
        use crate::updater_backend::{Control, State};
        let directory = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("gub-{}", &secret().unwrap()[..12]));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let socket_path = directory.join("rpc");
        let listener = UnixListener::bind(&socket_path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let script = r#"
            import {PassThrough} from 'node:stream';
            import {DesktopUpdateRelay} from './server/services/desktop-update-relay.ts';
            import {DesktopRestartBackend} from './server/services/desktop-restart-backend.ts';
            import {DesktopRestartAuthority} from './server/services/desktop-restart-authority.ts';
            const backend=new DesktopRestartBackend();
            // Transport fixture only: no execution owner is fabricated in an app.
            const authority=new DesktopRestartAuthority({requiredOwners:['ui-drafts'],ownerReaders:{'ui-drafts':backend.draftReader}});
            backend.attachAuthority(authority);
            const timer=setTimeout(()=>{process.exitCode=1;relay.retire();},5000);
            const handler={bind:e=>backend.bind(e),handle:(c,e)=>backend.handle(c,e),disconnected:e=>{
                backend.disconnected(e);clearTimeout(timer);
                if(authority.state!=='committed')process.exitCode=1;
                else console.log('committed fence retained');
            }};
            const input=new PassThrough();
            const relay=new DesktopUpdateRelay({input,restart:handler,platform:'darwin',env:{GJC_DESKTOP:'1',GJC_DESKTOP_UPDATE_PIPE:'1'}});
            input.write('GJC_DESKTOP_UPDATE_INIT '+JSON.stringify({protocolVersion:1,socket:process.argv[1],secret:'a'.repeat(64),epoch:'b'.repeat(64)})+'\n');
        "#;
        let mut child = std::process::Command::new("node")
            .args(["--import", "tsx", "--input-type=module", "--eval", script])
            .arg(&socket_path)
            .current_dir(repo)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut stream = None;
        while Instant::now() < deadline {
            if let Ok((accepted, _)) = listener.accept() {
                stream = Some(accepted);
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let mut auth = authority();
        auth.pid = child.id();
        auth.view = None;
        let run = Run {
            authority: Mutex::new(auth),
            retired: AtomicBool::new(false),
            pending: AtomicUsize::new(0),
            socket: socket_path.clone(),
            backend_claimed: AtomicBool::new(false),
            backend: OnceLock::new(),
        };
        if let Some(stream) = stream {
            serve_protocol(
                stream,
                &run,
                |_, _| -> Result<crate::updater::Snapshot, &'static str> {
                    panic!("backend attachment is not a UI command");
                },
            );
        } else {
            let _ = child.kill();
        }
        let transport = run
            .backend
            .get()
            .expect("native authenticated backend attachment");
        let status = transport
            .request(Control::Status, Instant::now() + Duration::from_secs(1))
            .unwrap();
        assert_eq!(status.state, State::Open);
        let id = "c".repeat(64);
        let prepared = transport
            .request(
                Control::Prepare {
                    attempt_id: id.clone(),
                    draft_epoch: 1,
                    remaining_ms: 1000,
                },
                Instant::now() + Duration::from_secs(2),
            )
            .unwrap();
        assert!(prepared.ok);
        assert_eq!(prepared.state, State::Prepared);
        let committed = transport
            .request(
                Control::Commit {
                    attempt_id: id.clone(),
                    token: prepared.token.unwrap(),
                },
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
        assert!(committed.ok);
        assert_eq!(committed.state, State::Committed);
        let cancelled = transport
            .request(
                Control::Cancel { attempt_id: id },
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
        assert!(!cancelled.ok);
        assert_eq!(cancelled.state, State::Committed);
        run.retire();
        let output = child.wait_with_output().unwrap();
        drop(listener);
        fs::remove_file(socket_path).unwrap();
        fs::remove_dir(directory).unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "committed fence retained"
        );
    }
    #[test]
    fn replay_window_is_bounded_and_accepts_reordered_live_requests_only_once() {
        let mut window = ReplayWindow::default();
        assert!(!window.accept(0));
        assert!(window.accept(2));
        assert!(window.accept(1));
        assert!(!window.accept(2));
        assert!(window.accept(100));
        assert!(!window.accept(1));
        assert!(window.accept(99));
        assert!(!window.accept(99));
    }
    #[test]
    fn copied_cookie_or_key_does_not_replace_current_main_view_or_peer_identity() {
        let mut auth = authority();
        let mut req = request(1);
        assert!(!auth.admit(&req, 43));
        req.view = "x".repeat(64);
        assert!(!auth.admit(&req, 42));
        req.view = "c".repeat(64);
        req.origin = "http://127.0.0.1:43124".into();
        assert!(!auth.admit(&req, 42));
        req.origin = "http://127.0.0.1:43123".into();
        assert!(auth.admit(&req, 42));
        assert!(!auth.admit(&req, 42));
        auth.view = None;
        assert!(!auth.admit(&request(2), 42));
    }
    #[test]
    fn stale_spawn_epoch_and_unknown_commands_are_rejected() {
        let mut auth = authority();
        let mut req = request(1);
        req.epoch = "d".repeat(64);
        assert!(!auth.admit(&req, 42));
        for input in [
            r#"{"action":"install","path":"/Applications"}"#,
            r#"{"action":"status","url":"https://evil.test"}"#,
            r#"{"action":"setAutomatic"}"#,
            r#"{"action":"download"}"#,
            r#"{"action":"download","targetId":null}"#,
            r#"{"action":"restart"}"#,
            r#"{"action":"restart","targetId":null}"#,
            r#"{"action":"restart","targetId":42}"#,
        ] {
            assert!(serde_json::from_str::<Command>(input).is_err());
        }
    }

    #[test]
    fn manual_download_and_restart_require_a_bound_target() {
        let target = "a".repeat(64);
        for action in ["download", "restart"] {
            let command: Command = serde_json::from_value(serde_json::json!({
                "action": action, "targetId": target,
            }))
            .unwrap();
            match command {
                Command::Download { target_id } | Command::Restart { target_id } => {
                    assert_eq!(target_id, target)
                }
                _ => panic!("unexpected command"),
            }
        }
    }
    #[test]
    fn unix_peer_pid_is_the_actual_connecting_process() {
        let (left, right) = UnixStream::pair().unwrap();
        assert_eq!(peer_pid(&left), Some(std::process::id()));
        assert_eq!(peer_pid(&right), Some(std::process::id()));
    }
    #[test]
    fn framing_rejects_oversized_truncated_and_extra_requests() {
        for bytes in [
            vec![b'x'; MAX_REQUEST + 1],
            b"{}\n{}\n".to_vec(),
            b"{".to_vec(),
        ] {
            let (mut reader, mut writer) = UnixStream::pair().unwrap();
            writer.write_all(&bytes).unwrap();
            drop(writer);
            assert!(read_frame::<Request>(&mut reader, Instant::now() + DEADLINE).is_err());
        }
    }
    #[test]
    fn injected_surface_contains_only_bounded_preparation_request_wrapper() {
        let script = bridge_script(&"c".repeat(64), "http://127.0.0.1:43123");
        assert!(script.contains("X-Gajae-Update-View"));
        assert!(!script.contains("__TAURI__"));
        assert!(!script.contains("updater_install"));
        assert!(script.contains("Object.freeze"));
    }

    #[test]
    fn endpoint_challenge_matches_node_hmac_and_refuses_a_forwarding_descendant() {
        let auth = authority();
        let challenge = Challenge {
            protocol_version: 1,
            kind: "challenge".into(),
            epoch: "b".repeat(64),
            pid: 42,
            nonce: "e".repeat(64),
        };
        assert_eq!(
            auth.challenge(&challenge, 42).as_deref(),
            Some("43414b0668a3c9af729f1b9a179354596ce5ac70c5085e779a2afe43bd1546a3")
        );
        assert!(auth.challenge(&challenge, 43).is_none());
        let mut retired = auth;
        retired.active = false;
        assert!(retired.challenge(&challenge, 42).is_none());
    }

    #[test]
    fn retirement_between_receipt_and_execution_refuses_the_queued_request() {
        let authority = Arc::new(Mutex::new(authority()));
        let received = Arc::new(std::sync::Barrier::new(2));
        let execute = Arc::new(std::sync::Barrier::new(2));
        let worker = {
            let authority = authority.clone();
            let received = received.clone();
            let execute = execute.clone();
            std::thread::spawn(move || {
                let request = request(1);
                received.wait();
                execute.wait();
                authority.lock().unwrap().admit(&request, 42)
            })
        };
        received.wait();
        authority.lock().unwrap().active = false;
        execute.wait();
        assert!(!worker.join().unwrap());
    }

    #[test]
    fn a_delayed_preference_write_cannot_overtake_a_newer_opt_out() {
        let mut authority = authority();
        let mut newer = request(2);
        newer.command = Command::SetAutomatic { automatic: false };
        let mut older = request(1);
        older.command = Command::SetAutomatic { automatic: true };
        assert!(authority.admit(&newer, 42));
        assert!(!authority.admit(&older, 42));
        assert!(authority.admit(&request(3), 42));
    }
}
