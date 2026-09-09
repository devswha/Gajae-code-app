use std::fmt::Write as _;
use std::{
    collections::VecDeque,
    env,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use getrandom::getrandom;
use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::time;

const READY_KIND: &str = "gajae-desktop-ready";
const PROTOCOL_VERSION: u32 = 1;
const OUTPUT_LIMIT: usize = 64 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const FAILED_STOP_GRACE: Duration = Duration::from_secs(5);
const FAILED_KILL_TIMEOUT: Duration = Duration::from_secs(5);
const SESSION_STOP_GRACE: Duration = Duration::from_secs(30);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const HEALTH_RESPONSE_LIMIT: usize = 16 * 1024;
const EXPECTED_PAYLOAD_VERSION: &str = env!("GJC_EXPECTED_PAYLOAD_VERSION");

#[derive(Default)]
pub(crate) struct RecoveryScreen(std::sync::Mutex<Option<(String, bool)>>);

/// Created only in the owned sidecar's independently verified health branch.
/// The updater cannot manufacture this from its receipt or HTTP input.
#[cfg(target_os = "macos")]
pub(crate) struct HealthyServer {
    target: crate::updater_attempt::Target,
    pid: u32,
}

#[cfg(target_os = "macos")]
impl crate::updater_attempt::proof_seal::Sealed for HealthyServer {}
#[cfg(target_os = "macos")]
impl crate::updater_attempt::VerifiedHealthProof for HealthyServer {
    fn target(&self) -> &crate::updater_attempt::Target {
        &self.target
    }
    fn server_pid(&self) -> u32 {
        self.pid
    }
}

#[derive(Debug, Deserialize)]
struct ReadyFrame {
    kind: String,
    pid: u32,
    host: String,
    port: u16,
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    version: String,
}

impl ReadyFrame {
    fn matches_sidecar(&self, pid: u32) -> bool {
        self.kind == READY_KIND
            && self.pid == pid
            && self.host == "127.0.0.1"
            && self.port != 0
            && self.protocol_version == PROTOCOL_VERSION
            && self.version == EXPECTED_PAYLOAD_VERSION
    }
}

#[derive(Debug, Deserialize)]
struct Health {
    status: String,
    product: String,
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    version: String,
}

#[derive(Default)]
struct OutputRing {
    bytes: VecDeque<u8>,
}

impl OutputRing {
    fn push(&mut self, output: &[u8]) {
        self.bytes.extend(output);
        while self.bytes.len() > OUTPUT_LIMIT {
            self.bytes.pop_front();
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.iter().copied().collect::<Vec<_>>()).into_owned()
    }
}

fn random_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom(&mut bytes)
        .map_err(|error| format!("could not generate desktop credential: {error}"))?;
    let mut secret = String::with_capacity(64);
    for byte in bytes {
        write!(&mut secret, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(secret)
}

fn payload_root(app: &AppHandle) -> Result<PathBuf, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("could not locate application resources: {error}"))?;
    let root = ["server-payload", "resources/server-payload"]
        .iter()
        .map(|relative| resources.join(relative))
        .find_map(|candidate| candidate.canonicalize().ok())
        .ok_or_else(|| "server payload is missing".to_owned())?;
    for relative in [
        "dist-server/server/index.js",
        "dist",
        "node_modules",
        "dist-native",
    ] {
        let path = root.join(relative);
        if !path.exists() {
            return Err(format!(
                "server payload is incomplete (missing {})",
                path.display()
            ));
        }
    }
    if !root.is_dir() {
        return Err("server payload root is not a directory".to_owned());
    }
    Ok(root)
}

fn endpoint(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn health_check(port: u16) -> Result<(), String> {
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .map_err(|error| format!("invalid loopback address: {error}"))?,
        HEALTH_TIMEOUT,
    )
    .map_err(|error| format!("health connection failed: {error}"))?;
    stream
        .set_write_timeout(Some(deadline.saturating_duration_since(Instant::now())))
        .map_err(|error| format!("could not set health write timeout: {error}"))?;
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|error| format!("health request failed: {error}"))?;
    let response = read_health_response(&mut stream, deadline)?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "malformed health response".to_owned())?;
    if !headers.starts_with("HTTP/1.1 200") {
        return Err(format!(
            "health endpoint rejected request: {}",
            headers.lines().next().unwrap_or_default()
        ));
    }
    let health: Health =
        serde_json::from_str(body).map_err(|error| format!("invalid health response: {error}"))?;
    if health.status != "ok"
        || health.product != "gajae-app"
        || health.protocol_version != PROTOCOL_VERSION
        || health.version != EXPECTED_PAYLOAD_VERSION
    {
        return Err("health endpoint identity did not match the supervised server".to_owned());
    }
    Ok(())
}

fn read_health_response(stream: &mut TcpStream, deadline: Instant) -> Result<String, String> {
    let mut response = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("health response exceeded its deadline".to_owned());
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|error| format!("could not set health read timeout: {error}"))?;
        let size = match stream.read(&mut buffer) {
            Ok(size) => size,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(format!("health response failed: {error}")),
        };
        if size == 0 {
            return String::from_utf8(response)
                .map_err(|error| format!("invalid health response encoding: {error}"));
        }
        if response.len() + size > HEALTH_RESPONSE_LIMIT {
            return Err("health response exceeded its size limit".to_owned());
        }
        response.extend_from_slice(&buffer[..size]);
    }
}

fn recovery_script(message: &str, retry_enabled: bool) -> String {
    let escaped =
        serde_json::to_string(message).unwrap_or_else(|_| "\"Desktop server failed\"".to_owned());
    // The retry listener is attached programmatically: inline onclick handlers
    // are blocked by the page CSP (script-src 'self'), and the invoke API
    // global requires withGlobalTauri (enabled in tauri.conf.json).
    let disabled = if retry_enabled { "" } else { " disabled" };
    format!(
        "document.body.innerHTML = '<main style=\"font:16px system-ui;padding:3rem;max-width:48rem\"><h1>Gajae Code App could not start</h1><pre style=\"white-space:pre-wrap\"></pre><button id=\"gajae-retry\" type=\"button\"{disabled}>Retry</button></main>';document.querySelector('pre').textContent={escaped};document.getElementById('gajae-retry').addEventListener('click',async function(){{var button=this;if(button.disabled)return;button.disabled=true;button.textContent='Starting…';try{{var t=window.__TAURI__;if(t&&t.core&&t.core.invoke){{await t.core.invoke('retry_desktop_server');}}else if(window.__TAURI_INTERNALS__&&window.__TAURI_INTERNALS__.invoke){{await window.__TAURI_INTERNALS__.invoke('retry_desktop_server');}}else{{throw new Error('Desktop command bridge is unavailable.');}}}}catch(error){{button.disabled=false;button.textContent='Retry';document.querySelector('pre').textContent=String(error);}}}});"
    )
}

fn reset_desktop_readiness(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    crate::updater_bridge::retire(app);
    #[cfg(target_os = "macos")]
    crate::updater::unhealthy(app);
    app.state::<crate::navigation::LoopbackOrigin>().clear();
    crate::reset_deep_link_readiness(app);
}

fn show_error(window: &WebviewWindow, message: &str, retry_enabled: bool) {
    let app = window.app_handle();
    let lifecycle = app.state::<crate::lifecycle::SidecarLifecycle>();
    if lifecycle.is_shutting_down() || (retry_enabled && lifecycle.has_sidecar()) {
        return;
    }
    #[cfg(target_os = "macos")]
    if crate::updater_launch::server_failed(app, message) {
        return;
    }
    reset_desktop_readiness(app);
    *app.state::<RecoveryScreen>()
        .0
        .lock()
        .expect("recovery screen lock poisoned") = Some((message.to_owned(), retry_enabled));
    let local_page = window.url().is_ok_and(|url| is_recovery_origin(&url));
    if local_page {
        let _ = window.eval(recovery_script(message, retry_enabled));
    } else {
        // A failed server leaves the webview on its HTTP origin, which has no
        // local IPC capability. Restore the bundled page before wiring Retry.
        #[cfg(not(target_os = "windows"))]
        let url = "tauri://localhost/index.html";
        #[cfg(target_os = "windows")]
        let url = "http://tauri.localhost/index.html";
        if let Err(error) = window.navigate(url.parse().expect("valid bundled recovery URL")) {
            eprintln!("could not open desktop recovery page: {error}");
        }
    }
    let _ = window.show();
}

fn is_recovery_origin(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}

pub(crate) fn desktop_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    if let Some(profile) = app.try_state::<crate::qa_profile::QaProfile>() {
        return Ok(profile.home().join(".gajae-app"));
    }
    app.path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())
}

fn update_attempt_admission(app: &AppHandle, desktop_data_root: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::updater_launch::admit_server(app, desktop_data_root)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, desktop_data_root);
        Ok(())
    }
}

/// Called by the main page-load hook after the bundled document finishes.
/// Keep the message until the next accepted start, including cleanup updates
/// that can arrive while navigation back from a dead HTTP origin is pending.
pub(crate) fn restore_recovery(webview: &tauri::Webview<tauri::Wry>) {
    if webview.label() != "main" || !webview.url().is_ok_and(|url| is_recovery_origin(&url)) {
        return;
    }
    let app = webview.app_handle();
    let Some(lifecycle) = app.try_state::<crate::lifecycle::SidecarLifecycle>() else {
        return;
    };
    if lifecycle.is_shutting_down() {
        return;
    }
    let Some(recovery) = app.try_state::<RecoveryScreen>() else {
        return;
    };
    let message = recovery
        .0
        .lock()
        .expect("recovery screen lock poisoned")
        .clone();
    if let Some((message, retry_enabled)) = message {
        let _ = webview.eval(recovery_script(&message, retry_enabled));
    }
}

async fn wait_for_sidecar_exit(
    pid: u32,
    events: &mut tauri::async_runtime::Receiver<CommandEvent>,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let event = time::timeout(remaining.min(PROCESS_POLL_INTERVAL), events.recv()).await;
        if matches!(event, Ok(Some(CommandEvent::Terminated(_)))) {
            return true;
        }
        // The plugin reaps before waiting for output readers, so inherited
        // pipes can delay Terminated even though the child is already gone.
        #[cfg(unix)]
        if !crate::lifecycle::process_alive(pid) {
            return true;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        if matches!(event, Ok(None)) {
            time::sleep(remaining.min(PROCESS_POLL_INTERVAL)).await;
        }
    }
}

async fn stop_failed_sidecar(
    lifecycle: &crate::lifecycle::SidecarLifecycle,
    pid: u32,
    events: &mut tauri::async_runtime::Receiver<CommandEvent>,
    force_stop: Option<impl FnOnce() -> Result<(), String>>,
    grace: Duration,
    kill_timeout: Duration,
) -> Result<(), String> {
    let term_error = lifecycle.terminate(pid).err();
    if wait_for_sidecar_exit(pid, events, grace).await {
        lifecycle.exited(pid);
        return Ok(());
    }
    let Some(force_stop) = force_stop else {
        return Err(format!("Desktop server {pid} did not complete graceful shutdown. Retry remains disabled until it exits."));
    };
    // Use the owned child handle, never a raw SIGKILL against a stale PID.
    // The shell plugin's independent waiter remains responsible for reaping.
    let kill_error = force_stop().err();
    if wait_for_sidecar_exit(pid, events, kill_timeout).await {
        lifecycle.exited(pid);
        return Ok(());
    }
    // Signals and closed output are not proof of exit. Keep Retry fenced if
    // force termination fails or the OS has not completed the reap deadline.
    let detail = kill_error
        .or(term_error)
        .unwrap_or_else(|| "exit was not confirmed".to_owned());
    Err(format!("Desktop server {pid} could not be stopped: {detail}. Retry remains disabled until it exits."))
}

async fn handle_sidecar_failure(
    app: &AppHandle,
    window: &WebviewWindow,
    child: CommandChild,
    mut events: tauri::async_runtime::Receiver<CommandEvent>,
    message: String,
    was_ready: bool,
) {
    let lifecycle = app.state::<crate::lifecycle::SidecarLifecycle>();
    reset_desktop_readiness(app);
    show_error(
        window,
        &format!("{message}\n\nStopping the previous server…"),
        false,
    );
    let pid = child.pid();
    let result = stop_failed_sidecar(
        &lifecycle,
        pid,
        &mut events,
        (!was_ready).then_some(|| child.kill().map_err(|error| error.to_string())),
        if was_ready {
            SESSION_STOP_GRACE
        } else {
            FAILED_STOP_GRACE
        },
        FAILED_KILL_TIMEOUT,
    )
    .await;
    if let Err(error) = result {
        show_error(window, &format!("{message}\n\n{error}"), false);
        // Cleanup has reported its bounded failure. Keep observing without
        // signalling again so a late exit can still release Quit and Retry.
        while !wait_for_sidecar_exit(pid, &mut events, Duration::from_secs(1)).await {}
        lifecycle.exited(pid);
    }
    show_error(window, &message, true);
}

fn navigate_and_show(
    app: &AppHandle,
    window: &WebviewWindow,
    port: u16,
    nonce: &str,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::SidecarLifecycle>();
    if lifecycle.is_shutting_down() {
        return Err("Desktop server startup was cancelled.".to_owned());
    }
    let origin = endpoint(port);
    app.state::<crate::navigation::LoopbackOrigin>().set(origin);
    let url = crate::navigation::bootstrap_url(port, nonce)?;
    window
        .navigate(url)
        .map_err(|error| format!("could not open supervised server: {error}"))?;
    if lifecycle.is_shutting_down() {
        reset_desktop_readiness(app);
        return Err("Desktop server startup was cancelled.".to_owned());
    }
    window
        .show()
        .map_err(|error| format!("could not show main window: {error}"))
}

#[cfg(target_os = "macos")]
fn update_bridge_environment(enabled: bool) -> [(&'static str, &'static str); 1] {
    [("GJC_DESKTOP_UPDATE_PIPE", if enabled { "1" } else { "0" })]
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let window = match app.get_webview_window("main") {
            Some(window) => window,
            None => return,
        };
        let lifecycle = app.state::<crate::lifecycle::SidecarLifecycle>();
        if lifecycle.is_shutting_down() || lifecycle.has_sidecar() {
            return;
        }
        let desktop_data_root = match desktop_data_root(&app) {
            Ok(root) => root,
            Err(error) => {
                show_error(&window, &error, !cfg!(target_os = "macos"));
                return;
            }
        };
        // Classify an already-invalid update-attempt path before origin
        // loading can turn it into an ordinary retryable origin error. The
        // lifecycle admission below repeats this check under its PID/shutdown
        // lock so neither startup nor Retry can skip admission.
        if let Err(error) = update_attempt_admission(&app, &desktop_data_root) {
            show_error(&window, &error, false);
            return;
        }
        let desktop_origin =
            match crate::desktop_origin::DesktopOrigin::load(desktop_data_root.clone()) {
                Ok(origin) => origin,
                Err(error) => {
                    show_error(&window, &error, true);
                    return;
                }
            };
        let payload = match payload_root(&app) {
            Ok(payload) => payload,
            Err(error) => {
                show_error(&window, &error, true);
                return;
            }
        };
        if let Err(error) = crate::expected_payload::ExpectedPayload::compiled()
            .and_then(|expected| expected.verify_payload(&payload))
        {
            show_error(&window, &error, true);
            return;
        }
        let api_key = match random_secret() {
            Ok(value) => value,
            Err(error) => {
                show_error(&window, &error, true);
                return;
            }
        };
        let nonce = match random_secret() {
            Ok(value) => value,
            Err(error) => {
                show_error(&window, &error, true);
                return;
            }
        };
        let home = env::var("HOME").unwrap_or_default();
        let path = env::var("PATH").unwrap_or_default();
        let entrypoint = payload.join("dist-server/server/index.js");
        let command = lifecycle.start(
            || update_attempt_admission(&app, &desktop_data_root),
            || {
                reset_desktop_readiness(&app);
                *app.state::<RecoveryScreen>()
                    .0
                    .lock()
                    .expect("recovery screen lock poisoned") = None;
                let command = app
                    .shell()
                    .sidecar("gajae-app-server")
                    .map_err(|error| format!("could not prepare server sidecar: {error}"))?
                    .arg(entrypoint.to_string_lossy().as_ref());
                #[cfg(target_os = "macos")]
                let command = if let Some(profile) = app.try_state::<crate::qa_profile::QaProfile>()
                {
                    if payload.join(".env").exists() {
                        return Err(
                            "QA refuses a server payload containing an environment file.".into(),
                        );
                    }
                    command
                        .env_clear()
                        .envs(profile.environment())
                        .current_dir(profile.home())
                } else {
                    command.env("HOME", &home).env("PATH", &path)
                };
                // Apply after QA's env_clear so isolated children get the flag.
                #[cfg(target_os = "macos")]
                let command = command.envs(update_bridge_environment(
                    crate::updater_bridge::enabled(&app),
                ));
                #[cfg(not(target_os = "macos"))]
                let command = command.env("HOME", &home).env("PATH", &path);
                let (events, child) = command
                    .env("HOST", "127.0.0.1")
                    .env("SERVER_PORT", desktop_origin.requested_port().to_string())
                    .env("NODE_ENV", "production")
                    .env("GJC_DESKTOP", "1")
                    .env("GJC_DESKTOP_API_KEY", api_key)
                    .env("GJC_DESKTOP_BOOTSTRAP_NONCE", &nonce)
                    .spawn()
                    .map_err(|error| format!("could not start server sidecar: {error}"))?;
                Ok((child.pid(), (events, child)))
            },
        );
        let (mut events, child) = match command {
            Ok(Some(child)) => child,
            Ok(None) => return,
            Err(crate::lifecycle::StartError::Admission(error)) => {
                show_error(&window, &error, false);
                return;
            }
            Err(crate::lifecycle::StartError::Spawn(error)) => {
                show_error(&window, &error, true);
                return;
            }
        };
        let sidecar_pid = child.pid();
        #[cfg(target_os = "macos")]
        let mut child = child;
        #[cfg(target_os = "macos")]
        match crate::updater_bridge::attach(&app, sidecar_pid) {
            Ok(Some(frame)) => {
                if child.write(&frame).is_err() {
                    crate::updater_bridge::retire(&app);
                }
            }
            Ok(None) => {}
            Err(_) => eprintln!("desktop updater bridge unavailable"),
        }
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let mut output = OutputRing::default();
        let mut ready = false;
        loop {
            if !ready && lifecycle.is_shutting_down() {
                handle_sidecar_failure(
                    &app,
                    &window,
                    child,
                    events,
                    "Desktop server startup was cancelled.".to_owned(),
                    false,
                )
                .await;
                return;
            }
            let remaining = if ready {
                PROCESS_POLL_INTERVAL
            } else {
                deadline.saturating_duration_since(Instant::now())
            };
            if remaining.is_zero() {
                handle_sidecar_failure(
                    &app,
                    &window,
                    child,
                    events,
                    format!(
                        "Desktop server did not become ready before the startup timeout.\n\n{}",
                        output.text()
                    ),
                    false,
                )
                .await;
                return;
            }
            // Poll even after readiness: an inherited output pipe can delay
            // the plugin's Terminated event after its waiter reaps the server.
            #[cfg(unix)]
            if !crate::lifecycle::process_alive(sidecar_pid) {
                reset_desktop_readiness(&app);
                lifecycle.exited(sidecar_pid);
                show_error(
                    &window,
                    &format!(
                        "Desktop server exited before its output closed.\n\n{}",
                        output.text()
                    ),
                    true,
                );
                return;
            }
            let event =
                match time::timeout(remaining.min(PROCESS_POLL_INTERVAL), events.recv()).await {
                    Ok(event) => event,
                    Err(_) => continue,
                };
            let Some(event) = event else {
                handle_sidecar_failure(
                    &app,
                    &window,
                    child,
                    events,
                    format!(
                        "Desktop server output closed unexpectedly.\n\n{}",
                        output.text()
                    ),
                    ready,
                )
                .await;
                return;
            };
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    output.push(&line);
                    if ready || lifecycle.is_shutting_down() {
                        continue;
                    }
                    for raw_line in String::from_utf8_lossy(&line).lines() {
                        let Ok(ready_frame) = serde_json::from_str::<ReadyFrame>(raw_line) else {
                            continue;
                        };
                        if !ready_frame.matches_sidecar(sidecar_pid) {
                            continue;
                        }
                        match health_check(ready_frame.port) {
                            Ok(()) => {
                                // Quit can arrive during the health request.
                                if lifecycle.is_shutting_down() {
                                    break;
                                }
                                #[cfg(target_os = "macos")]
                                {
                                    let successor =
                                        crate::updater_launch::revalidate_successor(&app).await;
                                    let target = match successor {
                                        Ok(target) => target,
                                        Err(error) => {
                                            handle_sidecar_failure(
                                                &app, &window, child, events, error, false,
                                            )
                                            .await;
                                            return;
                                        }
                                    };
                                    if let Some(target) = target {
                                        // Full bundle verification may take time. Recheck real
                                        // server health afterward, with the SPA still withheld.
                                        if lifecycle.is_shutting_down() {
                                            break;
                                        }
                                        let verified =
                                            health_check(ready_frame.port).and_then(|()| {
                                                if !lifecycle.owns_pid(sidecar_pid)
                                                    || !crate::lifecycle::process_alive(sidecar_pid)
                                                {
                                                    return Err(
                                                        "Successor server ownership was lost."
                                                            .into(),
                                                    );
                                                }
                                                desktop_origin
                                                    .persist_verified_port(ready_frame.port)?;
                                                crate::updater_launch::finish_health(
                                                    &app,
                                                    &HealthyServer {
                                                        target,
                                                        pid: sidecar_pid,
                                                    },
                                                )
                                            });
                                        if let Err(error) = verified {
                                            handle_sidecar_failure(
                                                &app, &window, child, events, error, false,
                                            )
                                            .await;
                                            return;
                                        }
                                    }
                                }
                                if let Err(error) = desktop_origin
                                    .persist_verified_port(ready_frame.port)
                                    .and_then(|()| {
                                        navigate_and_show(&app, &window, ready_frame.port, &nonce)
                                    })
                                {
                                    handle_sidecar_failure(
                                        &app, &window, child, events, error, false,
                                    )
                                    .await;
                                    return;
                                }
                                ready = true;
                                #[cfg(target_os = "macos")]
                                crate::updater::after_healthy(&app);
                                break;
                            }
                            Err(error) => {
                                handle_sidecar_failure(
                                    &app,
                                    &window,
                                    child,
                                    events,
                                    format!("Desktop server did not pass identity verification: {error}\n\n{}", output.text()),
                                    false,
                                ).await;
                                return;
                            }
                        }
                    }
                }
                CommandEvent::Terminated(status) => {
                    reset_desktop_readiness(&app);
                    lifecycle.exited(sidecar_pid);
                    show_error(
                        &window,
                        &format!(
                            "Desktop server exited unexpectedly ({status:?}).\n\n{}",
                            output.text()
                        ),
                        true,
                    );
                    return;
                }
                CommandEvent::Error(error) => {
                    handle_sidecar_failure(
                        &app,
                        &window,
                        child,
                        events,
                        format!("Desktop server failed: {error}\n\n{}", output.text()),
                        ready,
                    )
                    .await;
                    return;
                }
                _ => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn qa_environment_clear_preserves_only_the_explicit_late_update_flag() {
        for enabled in [true, false] {
            let output = std::process::Command::new("/usr/bin/env")
                .env("GJC_DESKTOP_UPDATE_PIPE", "wrong")
                .env_clear()
                .envs(update_bridge_environment(enabled))
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!(
                    "GJC_DESKTOP_UPDATE_PIPE={}\n",
                    if enabled { "1" } else { "0" }
                )
            );
        }
    }

    #[test]
    fn health_check_accepts_only_the_expected_server_identity() {
        for version in [EXPECTED_PAYLOAD_VERSION, "wrong"] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let responder = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0u8; 1024];
                assert!(socket.read(&mut request).unwrap() > 0);
                let body = format!(
                    r#"{{"status":"ok","product":"gajae-app","protocolVersion":1,"version":"{version}"}}"#
                );
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            });
            assert_eq!(
                health_check(port).is_ok(),
                version == EXPECTED_PAYLOAD_VERSION
            );
            responder.join().unwrap();
        }
    }

    #[test]
    fn ready_frame_and_health_agreeing_on_wrong_product_version_are_refused() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let child_version = "9.9.9";
        let responder = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0u8; 1024];
            assert!(socket.read(&mut request).unwrap() > 0);
            let body = format!(
                r#"{{"status":"ok","product":"gajae-app","protocolVersion":1,"version":"{child_version}"}}"#
            );
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        let ready = ReadyFrame {
            kind: READY_KIND.to_owned(),
            pid: 1,
            host: "127.0.0.1".to_owned(),
            port,
            protocol_version: PROTOCOL_VERSION,
            version: child_version.to_owned(),
        };

        assert!(!ready.matches_sidecar(1));
        assert!(health_check(port).is_err());
        responder.join().unwrap();
    }

    #[test]
    fn matching_ready_frame_and_health_pass_compiled_product_version() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let responder = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0u8; 1024];
            assert!(socket.read(&mut request).unwrap() > 0);
            let body = format!(
                r#"{{"status":"ok","product":"gajae-app","protocolVersion":1,"version":"{EXPECTED_PAYLOAD_VERSION}"}}"#
            );
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        let ready = ReadyFrame {
            kind: READY_KIND.to_owned(),
            pid: 1,
            host: "127.0.0.1".to_owned(),
            port,
            protocol_version: PROTOCOL_VERSION,
            version: EXPECTED_PAYLOAD_VERSION.to_owned(),
        };

        assert!(ready.matches_sidecar(1));
        assert!(health_check(port).is_ok());
        responder.join().unwrap();
    }

    #[test]
    fn trickling_health_response_cannot_extend_the_deadline() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let mut stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let responder = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            for _ in 0..100 {
                if socket.write_all(b"x").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let start = Instant::now();
        assert!(read_health_response(&mut stream, start + Duration::from_millis(100)).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(stream);
        responder.join().unwrap();
    }

    #[test]
    fn oversized_health_response_is_rejected() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let mut stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let responder = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let _ = socket.write_all(&vec![b'x'; HEALTH_RESPONSE_LIMIT + 1]);
        });
        assert!(
            read_health_response(&mut stream, Instant::now() + HEALTH_TIMEOUT)
                .unwrap_err()
                .contains("size limit")
        );
        responder.join().unwrap();
    }

    #[test]
    fn output_ring_is_bounded() {
        let mut ring = OutputRing::default();
        ring.push(&vec![b'x'; OUTPUT_LIMIT + 1]);
        assert_eq!(ring.bytes.len(), OUTPUT_LIMIT);
    }

    #[cfg(unix)]
    mod process_tests {
        use super::*;
        use crate::lifecycle::SidecarLifecycle;
        use std::io::BufRead;
        use std::os::unix::process::ExitStatusExt;
        use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
        use std::sync::{Arc, Mutex};

        struct TestChild {
            child: Arc<Mutex<Child>>,
            input: ChildStdin,
            pid: u32,
            waiter: Option<std::thread::JoinHandle<ExitStatus>>,
        }

        impl TestChild {
            fn spawn(
                ignore_term: bool,
                send_exit: bool,
            ) -> (Self, tauri::async_runtime::Receiver<CommandEvent>) {
                let script = if ignore_term {
                    "trap '' TERM; printf 'ready\\n'; read line"
                } else {
                    "trap 'exit 0' TERM; printf 'ready\\n'; read line"
                };
                let mut child = Command::new("/bin/sh")
                    .args(["-c", script])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap();
                let stdout = child.stdout.take().unwrap();
                let input = child.stdin.take().unwrap();
                let mut fixture = Self {
                    pid: child.id(),
                    child: Arc::new(Mutex::new(child)),
                    input,
                    waiter: None,
                };
                // Establish that TERM handling is installed, without relying
                // on sleeps or leaving a child behind if an assertion fails.
                let (ready_tx, ready_rx) = std::sync::mpsc::channel();
                let reader = std::thread::spawn(move || {
                    let mut line = String::new();
                    std::io::BufReader::new(stdout)
                        .read_line(&mut line)
                        .unwrap();
                    let _ = ready_tx.send(line);
                });
                assert_eq!(
                    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
                    "ready\n"
                );
                reader.join().unwrap();
                let (sender, events) = tauri::async_runtime::channel(2);
                sender
                    .try_send(CommandEvent::Error("output reader failed".to_owned()))
                    .unwrap();
                let sender = send_exit.then_some(sender);
                let waiting_child = Arc::clone(&fixture.child);
                fixture.waiter = Some(std::thread::spawn(move || loop {
                    let status = waiting_child.lock().unwrap().try_wait().unwrap();
                    if let Some(status) = status {
                        if let Some(sender) = sender {
                            let _ = sender.try_send(CommandEvent::Terminated(
                                tauri_plugin_shell::process::TerminatedPayload {
                                    code: status.code(),
                                    signal: status.signal(),
                                },
                            ));
                        }
                        return status;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }));
                (fixture, events)
            }

            fn kill(&self) -> Result<(), String> {
                self.child
                    .lock()
                    .unwrap()
                    .kill()
                    .map_err(|error| error.to_string())
            }

            fn status(&mut self) -> ExitStatus {
                self.waiter.take().unwrap().join().unwrap()
            }
        }

        impl Drop for TestChild {
            fn drop(&mut self) {
                let mut child = self.child.lock().unwrap();
                let _ = child.kill();
                let _ = child.wait();
                drop(child);
                if let Some(waiter) = self.waiter.take() {
                    let _ = waiter.join();
                }
            }
        }

        #[test]
        fn hung_startup_is_killed_and_reaped_before_retry_can_spawn() {
            tauri::async_runtime::block_on(async {
                for send_exit in [true, false] {
                    let lifecycle = SidecarLifecycle::default();
                    let (mut child, mut events) = TestChild::spawn(true, send_exit);
                    lifecycle.start(|| Ok(()), || Ok((child.pid, ()))).unwrap();
                    let mut stopping = Box::pin(stop_failed_sidecar(
                        &lifecycle,
                        child.pid,
                        &mut events,
                        Some(|| child.kill()),
                        Duration::from_millis(150),
                        Duration::from_secs(2),
                    ));
                    assert!(time::timeout(Duration::from_millis(30), &mut stopping)
                        .await
                        .is_err());
                    assert!(lifecycle.has_sidecar());
                    assert_eq!(
                        lifecycle.start::<()>(
                            || panic!("cleanup still owns the child"),
                            || panic!("cleanup still owns the child"),
                        ),
                        Ok(None)
                    );
                    time::timeout(Duration::from_secs(3), stopping)
                        .await
                        .unwrap()
                        .unwrap();
                    assert_eq!(child.status().signal(), Some(9));
                    assert!(!crate::lifecycle::process_alive(child.pid));
                    let (mut retry, mut retry_events) = TestChild::spawn(false, true);
                    assert_eq!(
                        lifecycle.start(|| Ok(()), || Ok((retry.pid, ()))).unwrap(),
                        Some(())
                    );
                    lifecycle.exited(child.pid);
                    assert!(
                        lifecycle.has_sidecar(),
                        "a stale exit must not clear Retry's PID"
                    );
                    stop_failed_sidecar(
                        &lifecycle,
                        retry.pid,
                        &mut retry_events,
                        Some(|| panic!("a cooperative child must not be killed")),
                        Duration::from_secs(2),
                        Duration::from_secs(1),
                    )
                    .await
                    .unwrap();
                    assert!(retry.status().success());
                }
            });
        }

        #[test]
        fn closing_during_startup_reaps_the_child_and_permanently_fences_retry() {
            tauri::async_runtime::block_on(async {
                let lifecycle = SidecarLifecycle::default();
                let (mut child, mut events) = TestChild::spawn(true, true);
                lifecycle.start(|| Ok(()), || Ok((child.pid, ()))).unwrap();
                assert_eq!(lifecycle.begin_shutdown(), Some(child.pid));
                assert_eq!(lifecycle.begin_shutdown(), None);
                assert!(!lifecycle.shutdown_complete());
                stop_failed_sidecar(
                    &lifecycle,
                    child.pid,
                    &mut events,
                    Some(|| child.kill()),
                    Duration::from_millis(50),
                    Duration::from_secs(2),
                )
                .await
                .unwrap();
                assert_eq!(child.status().signal(), Some(9));
                assert!(lifecycle.shutdown_complete());
                assert_eq!(
                    lifecycle.start::<()>(
                        || panic!("Quit already began"),
                        || panic!("Quit already began"),
                    ),
                    Ok(None)
                );
            });
        }

        #[test]
        fn failed_kill_is_bounded_and_never_releases_a_live_child() {
            tauri::async_runtime::block_on(async {
                let lifecycle = SidecarLifecycle::default();
                let (mut child, mut events) = TestChild::spawn(true, false);
                lifecycle.start(|| Ok(()), || Ok((child.pid, ()))).unwrap();
                let error = time::timeout(
                    Duration::from_secs(2),
                    stop_failed_sidecar(
                        &lifecycle,
                        child.pid,
                        &mut events,
                        Some(|| Err("kill denied".to_owned())),
                        Duration::from_millis(30),
                        Duration::from_millis(30),
                    ),
                )
                .await
                .unwrap()
                .unwrap_err();
                assert!(error.contains("kill denied"));
                assert!(lifecycle.has_sidecar());
                assert!(crate::lifecycle::process_alive(child.pid));
                assert_eq!(
                    lifecycle.start::<()>(
                        || panic!("exit remains unconfirmed"),
                        || panic!("exit remains unconfirmed"),
                    ),
                    Ok(None)
                );
                child.input.write_all(b"exit\n").unwrap();
                assert!(
                    wait_for_sidecar_exit(child.pid, &mut events, Duration::from_secs(2)).await
                );
                lifecycle.exited(child.pid);
                assert!(child.status().success());
                assert!(!lifecycle.has_sidecar());
            });
        }

        #[test]
        fn ready_session_shutdown_never_escalates_to_sigkill() {
            tauri::async_runtime::block_on(async {
                let lifecycle = SidecarLifecycle::default();
                let (mut child, mut events) = TestChild::spawn(true, true);
                lifecycle.start(|| Ok(()), || Ok((child.pid, ()))).unwrap();
                let result = stop_failed_sidecar(
                    &lifecycle,
                    child.pid,
                    &mut events,
                    None::<fn() -> Result<(), String>>,
                    Duration::from_millis(30),
                    Duration::from_millis(30),
                )
                .await;
                assert!(result.is_err());
                assert!(crate::lifecycle::process_alive(child.pid));
                assert!(lifecycle.has_sidecar());
                child.input.write_all(b"exit\n").unwrap();
                assert!(
                    wait_for_sidecar_exit(child.pid, &mut events, Duration::from_secs(2)).await
                );
                lifecycle.exited(child.pid);
                assert!(child.status().success());
            });
        }
    }

    #[test]
    fn ready_frame_requires_loopback_contract() {
        let ready: ReadyFrame = serde_json::from_str(&format!(
            r#"{{"kind":"gajae-desktop-ready","pid":1,"host":"127.0.0.1","port":1234,"protocolVersion":1,"version":"{EXPECTED_PAYLOAD_VERSION}"}}"#
        ))
        .unwrap();
        assert!(ready.matches_sidecar(1));
        assert!(!ready.matches_sidecar(2));
        for (field, value) in [
            ("kind", serde_json::json!("other-ready")),
            ("pid", serde_json::json!(0)),
            ("host", serde_json::json!("example.com")),
            ("port", serde_json::json!(0)),
            ("protocolVersion", serde_json::json!(2)),
            ("version", serde_json::json!("9.9.9")),
        ] {
            let mut frame = serde_json::json!({"kind":READY_KIND,"pid":1,"host":"127.0.0.1","port":1234,"protocolVersion":1,"version":EXPECTED_PAYLOAD_VERSION});
            frame[field] = value;
            assert!(!serde_json::from_value::<ReadyFrame>(frame)
                .unwrap()
                .matches_sidecar(1));
        }
    }
}
