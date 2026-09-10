//! Native launch admission and verified successor health. Installation is
//! requires explicit compiled mode/profile admission. Default builds are inert;
//! production release publication still requires the qualification gates.
use std::{
    path::Path,
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        Mutex,
    },
    time::Duration,
};

use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

use crate::{
    updater_attempt::{self, Journal, Phase as AttemptPhase, SuccessorAttempt, Target},
    updater_binding::{Binding, Mode},
    updater_install::{
        ApplyError, PreparedInstall, Reconstruction, VerifiedArchive, VerifiedSuccessor,
        PREFLIGHT_TIMEOUT,
    },
    updater_location::InstallLocation,
    updater_screen::{self, Screen, ScreenState},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum Phase {
    Checking,
    Normal,
    AwaitingHealth,
    Installing,
    Restarting,
    Recovery,
    ManualRestart,
}

struct PendingSuccessor {
    attempt: SuccessorAttempt,
    proof: VerifiedSuccessor,
}

pub(crate) struct LaunchGate {
    phase: AtomicU8,
    pending: Mutex<Option<PendingSuccessor>>,
    rendered_epoch: AtomicU64,
    rendered: Notify,
}

impl Default for LaunchGate {
    fn default() -> Self {
        Self {
            phase: AtomicU8::new(Phase::Checking as u8),
            pending: Mutex::new(None),
            rendered_epoch: AtomicU64::new(0),
            rendered: Notify::new(),
        }
    }
}

impl LaunchGate {
    fn phase(&self) -> Phase {
        match self.phase.load(Ordering::Acquire) {
            1 => Phase::Normal,
            2 => Phase::AwaitingHealth,
            3 => Phase::Installing,
            4 => Phase::Restarting,
            5 => Phase::Recovery,
            6 => Phase::ManualRestart,
            _ => Phase::Checking,
        }
    }
    fn set_phase(&self, phase: Phase) {
        self.phase.store(phase as u8, Ordering::Release);
    }

    fn begin_install(&self) -> bool {
        self.phase
            .compare_exchange(
                Phase::Checking as u8,
                Phase::Installing as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn admit(&self, root: &Path) -> Result<(), String> {
        match self.phase() {
            Phase::Normal => updater_attempt::check(root),
            Phase::AwaitingHealth => {
                let pending = self
                    .pending
                    .lock()
                    .map_err(|_| "Update successor lock failed.")?;
                let pending = pending
                    .as_ref()
                    .ok_or("Missing verified update successor.")?;
                pending.attempt.validate_startup(&pending.proof)
            }
            _ => Err("Desktop update verification/recovery blocks server startup.".into()),
        }
    }
}

pub(crate) fn admit_server(app: &AppHandle, root: &Path) -> Result<(), String> {
    if crate::updater_restart::blocks_start(app) {
        return Err("Manual restart transaction blocks server startup.".into());
    }
    app.state::<LaunchGate>().admit(root)
}

pub(crate) fn holds_exit(app: &AppHandle) -> bool {
    crate::updater_restart::holds_exit(app)
        || app
            .try_state::<LaunchGate>()
            .is_some_and(|gate| matches!(gate.phase(), Phase::Installing | Phase::Restarting))
}

pub(crate) fn expected_restart(app: &AppHandle, code: Option<i32>) -> bool {
    code == Some(tauri::RESTART_EXIT_CODE)
        && app
            .try_state::<LaunchGate>()
            .is_some_and(|gate| gate.phase() == Phase::Restarting)
}

pub(crate) fn allows_navigation_intents(app: &AppHandle) -> bool {
    !crate::updater_restart::blocks_start(app)
        && app
            .try_state::<LaunchGate>()
            .is_some_and(|gate| gate.phase() == Phase::Normal)
}

fn local_page(url: &tauri::Url) -> bool {
    url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && matches!(url.path(), "/" | "/index.html")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

fn screen_script(app: &AppHandle) -> Option<String> {
    let (epoch, screen) = app.state::<ScreenState>().published()?;
    Some(paint_script(epoch, &screen))
}

fn paint_script(epoch: u64, screen: &Screen) -> String {
    let script = updater_screen::script(screen);
    // The callback is an embedded-page paint acknowledgment only. It cannot
    // choose an archive, command, location, key, or installation outcome.
    format!("(()=>{{const epoch={epoch};const html=document.documentElement;if(Number(html.dataset.gajaeUpdaterEpoch||0)>epoch)return;html.dataset.gajaeUpdaterEpoch=String(epoch);{script}const mounted=document.getElementById('gajae-updater-screen');if(!mounted)return;mounted.dataset.epoch=String(epoch);requestAnimationFrame(()=>requestAnimationFrame(()=>{{if(!mounted.isConnected||document.getElementById('gajae-updater-screen')!==mounted||mounted.dataset.epoch!==String(epoch)||html.dataset.gajaeUpdaterEpoch!==String(epoch))return;const t=window.__TAURI__?.core??window.__TAURI_INTERNALS__;if(t?.invoke)t.invoke('ack_updater_screen',{{epoch}}).catch(()=>{{}});}}));}})();")
}

pub(crate) fn restore_screen(webview: &tauri::Webview) -> bool {
    if webview.label() != "main" || !webview.url().is_ok_and(|url| local_page(&url)) {
        return false;
    }
    let app = webview.app_handle();
    if app.state::<LaunchGate>().phase() == Phase::Normal {
        return false;
    }
    if let Some(script) = screen_script(app) {
        let _ = webview.eval(script);
        return true;
    }
    false
}

pub(crate) fn acknowledge_screen(app: &AppHandle, window: &tauri::WebviewWindow, epoch: u64) {
    if window.label() != "main" || !window.url().is_ok_and(|url| local_page(&url)) {
        return;
    }
    let gate = app.state::<LaunchGate>();
    if epoch == 0
        || app
            .state::<ScreenState>()
            .published()
            .map(|(current, _)| current)
            != Some(epoch)
    {
        return;
    }
    gate.rendered_epoch.store(epoch, Ordering::Release);
    gate.rendered.notify_one();
}

fn show(app: &AppHandle, screen: Screen) -> Result<u64, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Update window is unavailable.")?;
    let epoch = app.state::<ScreenState>().publish(screen);
    if window.url().is_ok_and(|url| local_page(&url)) {
        window
            .eval(screen_script(app).ok_or("Update screen is unavailable.")?)
            .map_err(|_| "Could not display update screen.")?;
    } else {
        window
            .navigate(
                "tauri://localhost/index.html"
                    .parse()
                    .expect("static recovery URL"),
            )
            .map_err(|_| "Could not open embedded update screen.")?;
    }
    let _ = window.unminimize();
    window.show().map_err(|_| "Could not show update window.")?;
    window
        .set_focus()
        .map_err(|_| "Could not focus update window.")?;
    Ok(epoch)
}

async fn show_confirmed(app: &AppHandle, screen: Screen) -> Result<(), String> {
    let epoch = show(app, screen)?;
    let gate = app.state::<LaunchGate>();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let notified = gate.rendered.notified();
            if gate.rendered_epoch.load(Ordering::Acquire) == epoch {
                return;
            }
            notified.await;
        }
    })
    .await
    .map_err(|_| "Embedded update screen did not acknowledge display.".into())
}

fn trace(event: &'static str) {
    if cfg!(debug_assertions) && Binding::compiled().mode == Mode::Qa {
        eprintln!("[updater-qa:{}] {event}", std::process::id());
    }
}

fn handoff_verified_install(
    gate: &LaunchGate,
    present: impl FnOnce() -> Result<u64, String>,
    restart: impl FnOnce(),
) {
    gate.set_phase(Phase::Restarting);
    let _ = present();
    restart();
}

fn recover(app: &AppHandle, message: &str) {
    trace("recovery");
    app.state::<LaunchGate>().set_phase(Phase::Recovery);
    let _ = show(
        app,
        Screen::Recovery {
            message: message.to_owned(),
        },
    );
}

pub(crate) fn server_failed(app: &AppHandle, message: &str) -> bool {
    match app.state::<LaunchGate>().phase() {
        // A rejected Retry must not overwrite an in-flight updater document or
        // turn a live installer into a false terminal recovery state.
        Phase::Checking | Phase::Installing | Phase::Restarting | Phase::ManualRestart => true,
        Phase::AwaitingHealth | Phase::Recovery => {
            recover(app, message);
            true
        }
        Phase::Normal => false,
    }
}

pub(crate) async fn show_manual_applying(app: &AppHandle) -> Result<(), String> {
    let gate = app.state::<LaunchGate>();
    gate.phase
        .compare_exchange(
            Phase::Normal as u8,
            Phase::ManualRestart as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .map_err(|_| "Native launch state changed before restart.".to_owned())?;
    show_confirmed(app, Screen::Applying).await
}
pub(crate) fn cancel_manual_display(app: &AppHandle, return_url: &tauri::Url) {
    let gate = app.state::<LaunchGate>();
    if gate
        .phase
        .compare_exchange(
            Phase::ManualRestart as u8,
            Phase::Normal as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_ok()
    {
        app.state::<ScreenState>().clear();
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.navigate(return_url.clone());
        }
    }
}
pub(crate) fn manual_recovery(app: &AppHandle, message: &str) {
    recover(app, message);
}
pub(crate) fn request_manual_restart(app: &AppHandle) {
    app.state::<LaunchGate>().set_phase(Phase::Restarting);
    let _ = show(app, Screen::Restarting);
    app.request_restart();
}

/// The `.app` that owns the running executable: `<bundle>/Contents/MacOS/<exe>`.
fn installed_bundle() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|_| "Current executable is unavailable.")?;
    let bundle = exe
        .ancestors()
        .nth(3)
        .filter(|path| path.extension().is_some_and(|ext| ext == "app"))
        .ok_or("The running executable is not inside an app bundle.")?;
    std::fs::canonicalize(bundle).map_err(|_| "The app bundle path cannot be resolved.".to_owned())
}

fn normal_start(app: &AppHandle) {
    if app
        .state::<crate::lifecycle::SidecarLifecycle>()
        .is_shutting_down()
    {
        return;
    }
    app.state::<ScreenState>().clear();
    app.state::<LaunchGate>().set_phase(Phase::Normal);
    crate::supervisor::start(app.clone());
}

pub(crate) fn start(app: AppHandle, _qa_install: bool) {
    // Preserve the older explicit QA CLI flag for qualification tooling. A
    // matching QA build now exercises the same durable consent path as release.
    tauri::async_runtime::spawn(async move {
        if let Err(error) = start_inner(&app).await {
            recover(&app, &error);
        }
    });
}

async fn start_inner(app: &AppHandle) -> Result<(), String> {
    trace("launch-start");
    let root = crate::supervisor::desktop_data_root(app)?;
    let binding = Binding::compiled();
    let profile = app.try_state::<crate::qa_profile::QaProfile>();
    let active = cfg!(target_arch = "aarch64")
        && binding.admits_profile(
            profile.as_ref().map(|profile| profile.root()),
            !cfg!(debug_assertions),
        );
    let absent = updater_attempt::check(&root).is_ok();
    if !active {
        if !absent {
            // This build cannot produce a successor proof. If the pending
            // attempt installed exactly this app, set its record aside and
            // start; otherwise stay blocked with a user-facing explanation.
            let installed = installed_bundle()?;
            let compiled = updater_attempt::CompiledIdentity {
                desktop_version: env!("CARGO_PKG_VERSION"),
                product_version: env!("GJC_EXPECTED_PAYLOAD_VERSION"),
                runtime_manifest_sha256: env!("GJC_EXPECTED_RUNTIME_MANIFEST_SHA256"),
            };
            updater_attempt::set_aside_unverifiable(&root, &installed, &compiled).map_err(
                |detail| {
                    format!(
                        "The installed app is not the version the last update recorded, and this build cannot verify updates. Reinstall from the official installer. ({detail})"
                    )
                },
            )?;
            trace("unverifiable-attempt-set-aside");
        }
        normal_start(app);
        return Ok(());
    }
    // With no cached candidate or pending click, ordinary startup adds no
    // update I/O/network work.
    let cached = root.join("desktop-update-cache/ready.json");
    if absent
        && !cached.exists()
        && !root
            .join("desktop-update-cache/manual-intent.json")
            .exists()
    {
        normal_start(app);
        return Ok(());
    }
    show(app, Screen::Checking)?;
    let handle = app.clone();
    let runtime =
        tauri::async_runtime::spawn_blocking(move || crate::updater::initialize(&handle, binding))
            .await;
    let runtime = match runtime {
        Ok(Ok(runtime)) => runtime,
        _ if absent => {
            normal_start(app);
            return Ok(());
        }
        _ => return Err("Update successor initialization failed.".into()),
    };
    let journal = Journal::open(&root)?;
    let loaded = journal.load()?;
    let manual_request = if loaded.is_none() {
        // Only a successfully consumed explicit selection can reach preflight.
        // Missing/legacy/corrupt intent grants no authority. Existing install
        // journals retain their separate verified-successor recovery path.
        runtime.store.consume_manual().unwrap_or(None)
    } else {
        None
    };
    let location = InstallLocation::validate(
        &runtime.binding,
        &std::env::current_exe().map_err(|_| "Current executable is unavailable.")?,
    );
    let location = match location {
        Ok(location) => location,
        Err(_) if loaded.is_none() => {
            normal_start(app);
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let store = runtime.store.clone();
    let key = runtime.binding.public_key.clone();
    let archive =
        tauri::async_runtime::spawn_blocking(move || VerifiedArchive::load(&store, &key)).await;
    let archive = match archive {
        Ok(Ok(archive)) => archive,
        _ if loaded.is_none() => {
            normal_start(app);
            return Ok(());
        }
        _ => return Err("Cached archive needed for successor verification is invalid.".into()),
    };
    if let Some(loaded) = loaded {
        if loaded.phase() != AttemptPhase::AwaitingHealth {
            return Err("An interrupted installation cannot be retried automatically.".into());
        }
        let archive =
            archive.ok_or("The signed archive needed to verify the successor is missing.")?;
        let target = loaded.target().clone();
        let proof = tauri::async_runtime::spawn_blocking(move || {
            archive.verify_successor(&target, &location)
        })
        .await
        .map_err(|_| "Successor verification failed.")?
        .map_err(|_| "The running app does not match the signed update target.")?;
        let attempt = journal.resume_verified(&loaded, &proof)?;
        trace("successor-verified");
        *app.state::<LaunchGate>()
            .pending
            .lock()
            .map_err(|_| "Update successor lock failed.")? =
            Some(PendingSuccessor { attempt, proof });
        app.state::<LaunchGate>().set_phase(Phase::AwaitingHealth);
        crate::supervisor::start(app.clone());
        return Ok(());
    }
    let Some(archive) = archive else {
        normal_start(app);
        return Ok(());
    };
    if !installation_requested(manual_request.as_ref(), archive.record())
        || !crate::updater::eligible_cached(archive.manifest(), &runtime.os)
            .map_err(|error| error.code().to_owned())?
    {
        normal_start(app);
        return Ok(());
    }
    // A manual intent only selects the cached target. Actual process absence,
    // native bundle identity and signature gates are independently re-proved.
    let deadline = tokio::time::Instant::now() + PREFLIGHT_TIMEOUT;
    stored_port_is_unoccupied(&root)?;
    let owners = crate::updater_owners::prove_no_packaged_owners(location.app())?;
    if app
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(runtime.binding.public_key.clone())
                .build(),
        )
        .is_err()
    {
        // No installer or journal mutation has begun. Initialization failure is
        // a deferred update, not a reason to strand the otherwise valid old app.
        normal_start(app);
        return Ok(());
    }
    let prepared = archive
        .reconstruct(
            app,
            Reconstruction {
                client: &runtime.client,
                policy: &runtime.policy,
                location: &location,
                key: &runtime.binding.public_key,
                certificate: runtime.certificate.clone(),
                deadline,
            },
        )
        .await;
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(_) => {
            normal_start(app);
            return Ok(());
        }
    };
    show_confirmed(app, Screen::Applying).await?;
    owners.revalidate()?;
    trace("applying-visible");
    if !app
        .state::<crate::lifecycle::SidecarLifecycle>()
        .begin_startup_update(|| app.state::<LaunchGate>().begin_install())
    {
        return Ok(());
    }
    run_install(app, prepared, journal, location).await
}

fn installation_requested(
    request: Option<&crate::updater_store::ManualRequest>,
    record: &crate::updater_store::PreparedRecord,
) -> bool {
    // The persisted preference controls discovery only. Even a fully verified
    // cache cannot select an install without a matching explicit restart intent.
    request.is_some_and(|request| request.matches(record))
}

async fn run_install(
    app: &AppHandle,
    prepared: PreparedInstall,
    journal: Journal,
    location: InstallLocation,
) -> Result<(), String> {
    trace("install-begin");
    let result =
        tauri::async_runtime::spawn_blocking(move || prepared.apply(&journal, &location)).await;
    match result {
        Ok(Ok(installed)) => {
            trace("install-returned-verified");
            if installed.target().target_desktop_version == env!("CARGO_PKG_VERSION") {
                return Err("An update cannot relaunch the same desktop version.".into());
            }
            // Mutation has completed and AwaitingHealth is durable. Occluded
            // WebKit pages may stop producing animation frames: do not strand
            // a verified replacement waiting for another paint acknowledgement.
            // The strict Applying paint barrier before mutation is unchanged.
            handoff_verified_install(
                &app.state::<LaunchGate>(),
                || show(app, Screen::Restarting),
                || {
                    trace("restart-requested");
                    app.request_restart();
                },
            );
            Ok(())
        }
        Ok(Err(ApplyError::Precondition)) => {
            normal_start(app);
            Ok(())
        }
        _ => Err(
            "Installation did not prove a complete replacement. Automatic retry is blocked.".into(),
        ),
    }
}

fn stored_port_is_unoccupied(root: &Path) -> Result<(), String> {
    let port = crate::desktop_origin::DesktopOrigin::load(root.to_owned())?.requested_port();
    if port == 0 {
        return Ok(());
    }
    match std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(250),
    ) {
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => Ok(()),
        _ => Err("The desktop origin is occupied or its previous owner is uncertain.".into()),
    }
}

pub(crate) async fn revalidate_successor(app: &AppHandle) -> Result<Option<Target>, String> {
    if app.state::<LaunchGate>().phase() != Phase::AwaitingHealth {
        return Ok(None);
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let gate = app.state::<LaunchGate>();
        let pending = gate
            .pending
            .lock()
            .map_err(|_| "Update successor lock failed.")?;
        let pending = pending
            .as_ref()
            .ok_or("Verified update successor disappeared.")?;
        pending
            .proof
            .revalidate_bundle()
            .map_err(|_| "Installed update changed during startup.")?;
        pending.attempt.validate_startup(&pending.proof)?;
        Ok(Some(pending.proof.target().clone()))
    })
    .await
    .map_err(|_| "Successor verification task failed.")?
}

pub(crate) fn finish_health(
    app: &AppHandle,
    proof: &crate::supervisor::HealthyServer,
) -> Result<(), String> {
    let gate = app.state::<LaunchGate>();
    let mut pending = gate
        .pending
        .lock()
        .map_err(|_| "Update successor lock failed.")?;
    let successor = pending
        .take()
        .ok_or("Verified update successor is missing.")?;
    if let Err(error) = successor.attempt.finish(proof) {
        gate.set_phase(Phase::Recovery);
        return Err(error);
    }
    gate.set_phase(Phase::Normal);
    trace("successor-health-committed");
    app.state::<ScreenState>().clear();
    crate::resume_deep_links(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn automatic_checks_never_authorize_installation_without_matching_manual_intent() {
        use crate::updater_store::{PreparedRecord, Store};
        use std::{fs, os::unix::fs::PermissionsExt};
        struct Temp(std::path::PathBuf);
        impl Drop for Temp {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let mut random = [0; 8];
        getrandom::getrandom(&mut random).unwrap();
        let root = Temp(
            fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!(
                    "gajae-launch-policy-{:x}",
                    u64::from_ne_bytes(random)
                )),
        );
        fs::create_dir(&root.0).unwrap();
        fs::set_permissions(&root.0, fs::Permissions::from_mode(0o700)).unwrap();
        let record = PreparedRecord {
            schema: 1,
            release_id: 1,
            manifest_asset_id: 2,
            archive_asset_id: 3,
            archive_size: 4,
            archive_sha256: "a".repeat(64),
            manifest: "{}".into(),
            inventory: serde_json::json!({}),
        };
        let store = Store::open(&root.0).unwrap();
        store
            .commit(store.stage(&record, b"data").unwrap())
            .unwrap();
        assert!(store.preferences().unwrap().automatic);
        assert!(!installation_requested(
            store.consume_manual().unwrap().as_ref(),
            &record
        ));
        let intent_path = root.0.join("desktop-update-cache/manual-intent.json");
        fs::write(
            &intent_path,
            serde_json::to_vec(&serde_json::json!({
                "schema":1,"archive_sha256":record.archive_sha256,
            }))
            .unwrap(),
        )
        .unwrap();
        fs::set_permissions(&intent_path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            !installation_requested(store.consume_manual().unwrap_or(None).as_ref(), &record),
            "legacy unbound manual intent is not authority"
        );
        store
            .request_manual(&record.target_id(), &record.archive_sha256)
            .unwrap();
        drop(store);
        let store = Store::open(&root.0).unwrap();
        for automatic in [true, false] {
            store.set_automatic(automatic).unwrap();
            store
                .request_manual(&record.target_id(), &record.archive_sha256)
                .unwrap();
            let request = store.consume_manual().unwrap();
            assert!(
                installation_requested(request.as_ref(), &record),
                "matching persisted manual intent admits the install gate"
            );
            let changed = PreparedRecord {
                archive_asset_id: 4,
                ..record.clone()
            };
            assert!(!installation_requested(request.as_ref(), &changed));
            assert!(
                !installation_requested(store.consume_manual().unwrap().as_ref(), &record),
                "a later ordinary launch cannot replay this click"
            );
        }
    }
    #[test]
    fn gate_starts_closed_and_only_one_install_can_claim_it() {
        let gate = LaunchGate::default();
        assert!(gate.admit(Path::new("/does-not-exist")).is_err());
        assert!(gate.begin_install());
        assert!(!gate.begin_install());
        assert!(gate.admit(Path::new("/does-not-exist")).is_err());
        gate.set_phase(Phase::Recovery);
        assert!(!gate.begin_install());
    }
    #[test]
    fn normal_admission_retains_the_existing_presence_guard() {
        let gate = LaunchGate::default();
        gate.set_phase(Phase::Normal);
        assert!(gate.admit(Path::new("/does-not-exist")).is_ok());
        gate.set_phase(Phase::AwaitingHealth);
        assert!(gate.admit(Path::new("/does-not-exist")).is_err());
    }

    #[test]
    fn verified_install_handoff_does_not_depend_on_another_paint_success() {
        use std::cell::RefCell;
        for presentation in [Ok(4), Err("window unavailable".to_owned())] {
            let gate = LaunchGate::default();
            gate.set_phase(Phase::Installing);
            let events = RefCell::new(Vec::new());
            handoff_verified_install(
                &gate,
                || {
                    assert_eq!(gate.phase(), Phase::Restarting);
                    events.borrow_mut().push("present");
                    presentation
                },
                || {
                    assert_eq!(gate.phase(), Phase::Restarting);
                    events.borrow_mut().push("restart");
                },
            );
            assert_eq!(*events.borrow(), ["present", "restart"]);
        }
    }
}
