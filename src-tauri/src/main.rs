#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
use std::fs::OpenOptions;

#[cfg(target_os = "windows")]
use fs2::FileExt;
use tauri::Manager;

mod build_info;
mod desktop_deep_links;
mod desktop_origin;
use desktop_deep_links::StartupDeepLinks;
mod expected_payload;
#[cfg(target_os = "linux")]
mod instance;
mod lifecycle;
#[cfg(any(target_os = "macos", test))]
mod macos_instance;
mod navigation;
#[cfg(any(target_os = "macos", test))]
mod qa_profile;
mod supervisor;
#[cfg(target_os = "macos")]
mod updater;
#[cfg(target_os = "macos")]
mod updater_archive;
#[cfg(target_os = "macos")]
mod updater_attempt;
#[cfg(target_os = "macos")]
mod updater_backend;
#[cfg(target_os = "macos")]
mod updater_binding;
#[cfg(target_os = "macos")]
mod updater_bridge;
#[cfg(target_os = "macos")]
mod updater_bundle;
#[cfg(target_os = "macos")]
mod updater_discovery;
#[cfg(target_os = "macos")]
mod updater_install;
#[cfg(target_os = "macos")]
mod updater_launch;
#[cfg(target_os = "macos")]
mod updater_location;
#[cfg(target_os = "macos")]
mod updater_manifest;
#[cfg(target_os = "macos")]
mod updater_owners;
#[cfg(target_os = "macos")]
mod updater_restart;
#[cfg(target_os = "macos")]
mod updater_screen;
#[cfg(target_os = "macos")]
mod updater_signature;
#[cfg(target_os = "macos")]
mod updater_store;
#[cfg(target_os = "macos")]
mod updater_transport;

#[cfg(target_os = "windows")]
struct SingleInstanceLock {
    _file: std::fs::File,
}

#[cfg(target_os = "windows")]
fn acquire_single_instance_lock() -> Result<SingleInstanceLock, String> {
    let lock_path = std::env::temp_dir().join("gajae-app-desktop.lock");
    acquire_single_instance_lock_at(&lock_path)
}

#[cfg(target_os = "windows")]
fn acquire_single_instance_lock_at(
    lock_path: &std::path::Path,
) -> Result<SingleInstanceLock, String> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|error| format!("could not open desktop instance lock: {error}"))?;
    file.try_lock_exclusive()
        .map_err(|_| "Gajae Code App is already running.".to_owned())?;
    Ok(SingleInstanceLock { _file: file })
}

#[cfg(target_os = "macos")]
fn acquire_single_instance_lock() -> Result<macos_instance::InstanceLock, String> {
    let lock_path = std::env::temp_dir().join("gajae-app-desktop.lock");
    macos_instance::acquire(&lock_path).map_err(|error| {
        if error.is_contended() {
            "Gajae Code App is already running.".to_owned()
        } else {
            error.to_string()
        }
    })
}
fn is_gajae_deep_link(url: &tauri::Url) -> bool {
    url.scheme() == "gajae-app"
}

fn deep_link_route(url: &tauri::Url) -> Option<String> {
    is_gajae_deep_link(url)
        .then(|| desktop_deep_links::route(url))
        .flatten()
}

fn route_startup_deep_links(
    webview: &tauri::Webview,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    let app = webview.app_handle();
    if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
        reset_deep_link_readiness(app);
    }
    #[cfg(target_os = "macos")]
    if !updater_launch::allows_navigation_intents(app) {
        return;
    }
    if !app
        .try_state::<navigation::LoopbackOrigin>()
        .is_some_and(|origin| origin.permits(payload.url()))
    {
        return;
    }
    if let Some(startup) = app.try_state::<StartupDeepLinks>() {
        match startup.take_for_page(webview.label(), payload.url(), payload.event()) {
            Ok(Some(delivery)) => deliver_deep_links(app, delivery),
            Ok(None) => {}
            Err(_) => eprintln!("Pending desktop links could not be loaded or persisted."),
        }
    }
}

fn desktop_page_load(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    #[cfg(target_os = "macos")]
    updater_bridge::page_load(webview, payload);
    if payload.event() == tauri::webview::PageLoadEvent::Finished {
        #[cfg(target_os = "macos")]
        if updater_launch::restore_screen(webview) {
            return;
        }
        supervisor::restore_recovery(webview);
    }
    route_startup_deep_links(webview, payload);
}

fn receive_deep_links(app: &tauri::AppHandle, urls: Vec<tauri::Url>) -> bool {
    let count = urls
        .iter()
        .filter(|url| deep_link_route(url).is_some())
        .count();
    #[cfg(target_os = "macos")]
    if !updater_launch::allows_navigation_intents(app) {
        reset_deep_link_readiness(app);
    }
    match app.state::<StartupDeepLinks>().receive(urls) {
        Ok(Some(delivery)) => {
            trace_deep_links(app, "accepted", count);
            deliver_deep_links(app, delivery);
            true
        }
        Ok(None) => {
            trace_deep_links(app, "queued", count);
            true
        }
        Err(_) => {
            eprintln!("Desktop link deferred: its bounded durable queue is unavailable.");
            false
        }
    }
}

fn trace_deep_links(app: &tauri::AppHandle, event: &str, count: usize) {
    #[cfg(target_os = "macos")]
    if cfg!(debug_assertions)
        && updater_binding::Binding::compiled().mode == updater_binding::Mode::Qa
        && app.try_state::<qa_profile::QaProfile>().is_some()
    {
        eprintln!("[links-qa:{}] {event} count={count}", std::process::id());
    }
    let _ = (app, event, count);
}

fn deliver_deep_links(app: &tauri::AppHandle, delivery: desktop_deep_links::Delivery) {
    for url in &delivery.urls {
        if !route_deep_link(app, url.clone()) {
            app.state::<StartupDeepLinks>().release(&delivery);
            return;
        }
    }
    // eval() only accepts a script. Retain the durable record until native
    // observes the requested root URL in this delivery's document epoch.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            let app = handle.clone();
            let current = delivery.clone();
            let (sent, reply) = tokio::sync::oneshot::channel();
            if handle
                .run_on_main_thread(move || {
                    let _ = sent.send(acknowledge_deep_links(&app, current));
                })
                .is_err()
            {
                break;
            }
            match tokio::time::timeout_at(deadline, reply).await {
                Ok(Ok(true)) => return,
                Ok(Ok(false)) => {}
                _ => break,
            }
        }
        handle.state::<StartupDeepLinks>().release(&delivery);
    });
}

fn acknowledge_deep_links(app: &tauri::AppHandle, delivery: desktop_deep_links::Delivery) -> bool {
    let count = delivery.urls.len();
    #[cfg(target_os = "macos")]
    if !updater_launch::allows_navigation_intents(app) {
        return false;
    }
    if app
        .state::<lifecycle::SidecarLifecycle>()
        .is_shutting_down()
    {
        return false;
    }
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    if !window.url().is_ok_and(|url| {
        url.scheme() == "http"
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && app.state::<navigation::LoopbackOrigin>().permits(&url)
    }) {
        return false;
    }
    if app
        .state::<StartupDeepLinks>()
        .acknowledge(delivery)
        .is_err()
    {
        return false;
    }
    trace_deep_links(app, "delivered", count);
    if let Ok(Some(next)) = app.state::<StartupDeepLinks>().receive(Vec::new()) {
        deliver_deep_links(app, next);
    }
    true
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn reset_deep_link_readiness(app: &tauri::AppHandle) {
    if let Some(links) = app.try_state::<StartupDeepLinks>() {
        links.reset();
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn flush_deep_links(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<StartupDeepLinks>().flush()
}

#[cfg(target_os = "macos")]
pub(crate) fn resume_deep_links(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !updater_launch::allows_navigation_intents(&handle) {
            return;
        }
        if let Some(window) = handle.get_webview_window("main") {
            if let Ok(url) = window.url() {
                if !handle.state::<navigation::LoopbackOrigin>().permits(&url) {
                    return;
                }
                if let Ok(Some(delivery)) = handle.state::<StartupDeepLinks>().take_for_page(
                    "main",
                    &url,
                    tauri::webview::PageLoadEvent::Finished,
                ) {
                    deliver_deep_links(&handle, delivery);
                }
            }
        }
    });
}

fn route_deep_link(app: &tauri::AppHandle, url: tauri::Url) -> bool {
    use tauri::{Emitter, Manager};

    if deep_link_route(&url).is_none() {
        return false;
    }
    #[cfg(target_os = "macos")]
    if !updater_launch::allows_navigation_intents(app) {
        return false;
    }
    if app
        .state::<lifecycle::SidecarLifecycle>()
        .is_shutting_down()
    {
        return false;
    }
    if let Some(window) = app.get_webview_window("main") {
        if !window.url().is_ok_and(|current| {
            current.scheme() == "http"
                && app.state::<navigation::LoopbackOrigin>().permits(&current)
                && !current.path().starts_with("/api/")
                && !current.path().starts_with("/desktop/")
        }) {
            return false;
        }
        // The served UI is a remote loopback origin where Tauri IPC event
        // injection is not guaranteed, so navigate the SPA directly; the id
        // is validated above and contains no characters needing escaping.
        if let Some(path) = deep_link_route(&url) {
            if window.eval(format!(
                "window.history.pushState({{}},'','{path}');window.dispatchEvent(new PopStateEvent('popstate'));"
            )).is_err() { return false; }
        }
        let _ = app.emit_to("main", "desktop://deep-link", url.as_str());
        focus_main_window(app);
        return true;
    }
    false
}

#[tauri::command]
fn retry_desktop_server(app: tauri::AppHandle) {
    supervisor::start(app);
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn ack_updater_screen(app: tauri::AppHandle, window: tauri::WebviewWindow, epoch: u64) {
    updater_launch::acknowledge_screen(&app, &window, epoch);
}

fn main() {
    match build_info::handle_cli(std::env::args_os().skip(1)) {
        Ok(Some(info)) => {
            println!("{info}");
            return;
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
    use tauri_plugin_deep_link::DeepLinkExt;

    #[cfg(target_os = "macos")]
    let qa_profile = (|| -> Result<Option<qa_profile::QaProfile>, String> {
        let requested = qa_profile::requested_root(std::env::args().skip(1))?;
        updater_binding::Binding::compiled().validate_launch_profile(requested.as_deref())?;
        let Some(root) = requested else {
            return Ok(None);
        };
        let version = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .map_err(|error| format!("Could not check macOS QA support: {error}"))?;
        if !version.status.success() {
            return Err("Could not check macOS QA support.".into());
        }
        qa_profile::require_supported_os(&String::from_utf8_lossy(&version.stdout))?;
        qa_profile::QaProfile::open(&root).map(Some)
    })()
    .unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(1);
    });
    #[cfg(target_os = "macos")]
    let qa_install = {
        let count = std::env::args()
            .filter(|arg| arg == "--qa-update-install")
            .count();
        if count > 1
            || (count == 1
                && (qa_profile.is_none()
                    || updater_binding::Binding::compiled().mode != updater_binding::Mode::Qa))
        {
            eprintln!("--qa-update-install requires one compile-bound isolated QA profile.");
            std::process::exit(2);
        }
        count == 1
    };
    #[cfg(not(target_os = "macos"))]
    if std::env::args().any(|arg| arg == "--qa-profile" || arg.starts_with("--qa-profile=")) {
        eprintln!("--qa-profile is currently supported only on macOS 14 or newer.");
        std::process::exit(1);
    }
    let context = tauri::generate_context!();
    #[cfg(target_os = "macos")]
    let (context, qa_windows) = {
        let mut context = context;
        if cfg!(target_arch = "aarch64") {
            updater_binding::Binding::compiled().configure_plugin(
                context.config_mut(),
                qa_profile.as_ref().map(|profile| profile.root()),
                !cfg!(debug_assertions),
            );
        }
        let windows = qa_profile
            .as_ref()
            .map(|profile| profile.configure(context.config_mut()))
            .unwrap_or_default();
        (context, windows)
    };

    #[cfg(target_os = "linux")]
    let (instance, activation) = {
        let activation = instance::Activation::from_args(std::env::args().skip(1));
        match instance::Instance::acquire(&activation) {
            Ok(Some(instance)) => (instance, activation),
            Ok(None) => return,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    };

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(navigation::plugin())
        .on_page_load(desktop_page_load)
        .on_window_event(lifecycle::handle_close_request);
    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        retry_desktop_server,
        ack_updater_screen
    ]);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.invoke_handler(tauri::generate_handler![retry_desktop_server]);
    let builder = builder.setup(move |app| {
        // A held lock means another instance is running. Setup errors
        // abort inside did_finish_launching (panic_cannot_unwind ->
        // SIGABRT -> crash-reporter dialog), so report the bounded
        // ownership failure and exit with a nonzero status instead;
        // macOS LaunchServices focuses the running instance on reopen.
        // A failed bounded handoff is still a failed launch: never report
        // success when this process did not acquire ownership.
        #[cfg(not(target_os = "linux"))]
        let lock_result = {
            #[cfg(target_os = "macos")]
            {
                if qa_profile.is_some() {
                    // QaProfile already owns its lock, before window
                    // creation.
                    Ok(None)
                } else {
                    acquire_single_instance_lock().map(Some)
                }
            }
            #[cfg(target_os = "windows")]
            {
                acquire_single_instance_lock().map(Some)
            }
        };
        #[cfg(not(target_os = "linux"))]
        let lock = match lock_result {
            Ok(lock) => lock,
            Err(message) => {
                eprintln!("{message}");
                std::process::exit(1);
            }
        };
        #[cfg(not(target_os = "linux"))]
        if let Some(lock) = lock {
            app.manage(lock);
        }
        #[cfg(target_os = "macos")]
        if let Some(profile) = qa_profile {
            app.manage(profile);
        }
        app.manage(navigation::LoopbackOrigin::default());
        app.manage(lifecycle::SidecarLifecycle::default());
        app.manage(supervisor::RecoveryScreen::default());
        #[cfg(target_os = "macos")]
        app.manage(StartupDeepLinks::persistent(supervisor::desktop_data_root(
            app.handle(),
        )?));
        #[cfg(target_os = "windows")]
        app.manage(StartupDeepLinks::new(Vec::new()));
        #[cfg(target_os = "macos")]
        app.manage(updater_launch::LaunchGate::default());
        #[cfg(target_os = "macos")]
        app.manage(updater_screen::ScreenState::default());
        #[cfg(target_os = "macos")]
        app.manage(updater::Preparation::default());
        #[cfg(target_os = "macos")]
        app.manage(updater_bridge::Bridge::default());
        #[cfg(target_os = "macos")]
        app.manage(updater_restart::Restarts::default());
        #[cfg(target_os = "macos")]
        if let Some(profile) = app.try_state::<qa_profile::QaProfile>() {
            profile.create_windows(app, &qa_windows)?;
        }
        #[cfg(target_os = "linux")]
        {
            app.manage(StartupDeepLinks::new(
                activation
                    .urls
                    .into_iter()
                    .filter_map(|url| url.parse().ok())
                    .collect(),
            ));
            let app_handle = app.handle().clone();
            app.manage(instance.listen(move |activation| {
                if app_handle
                    .state::<lifecycle::SidecarLifecycle>()
                    .is_shutting_down()
                {
                    return false;
                }
                let app = app_handle.clone();
                let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                if app_handle
                    .run_on_main_thread(move || {
                        if app
                            .state::<lifecycle::SidecarLifecycle>()
                            .is_shutting_down()
                        {
                            let _ = sender.send(false);
                            return;
                        }
                        let accepted = receive_deep_links(
                            &app,
                            activation
                                .urls
                                .into_iter()
                                .filter_map(|url| url.parse().ok())
                                .collect(),
                        );
                        focus_main_window(&app);
                        let _ = sender.send(accepted);
                    })
                    .is_err()
                {
                    return false;
                }
                // Acknowledge only once the UI thread accepted the request;
                // Close may fence activations while this callback is queued.
                receiver
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .unwrap_or(false)
            })?);
        }
        let app_handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            let handle = app_handle.clone();
            let urls = event.urls();
            let _ = app_handle.run_on_main_thread(move || {
                receive_deep_links(&handle, urls);
            });
        });
        #[cfg(target_os = "macos")]
        if let Some(urls) = app.deep_link().get_current()? {
            receive_deep_links(app.handle(), urls);
        }
        #[cfg(target_os = "macos")]
        updater_launch::start(app.handle().clone(), qa_install);
        #[cfg(not(target_os = "macos"))]
        supervisor::start(app.handle().clone());
        Ok(())
    });
    let app = builder
        .build(context)
        .expect("failed to run Gajae Code App desktop shell");
    app.run(
        |app: &tauri::AppHandle<tauri::Wry>, event: tauri::RunEvent| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                #[cfg(target_os = "macos")]
                if updater_launch::expected_restart(app, code) {
                    if flush_deep_links(app).is_err() {
                        api.prevent_exit();
                        updater_launch::manual_recovery(
                            app,
                            "Pending notification links could not be saved. Restart was deferred.",
                        );
                    }
                    return;
                }
                #[cfg(target_os = "macos")]
                if updater_launch::holds_exit(app) {
                    api.prevent_exit();
                    return;
                }
                #[cfg(not(target_os = "macos"))]
                let _ = code;
                #[cfg(target_os = "macos")]
                updater::unhealthy(app);
                // graceful_quit finishes with app.exit(), which requests exit
                // again on Linux. Let that request through only after the
                // sidecar is gone; otherwise closing can never release the
                // single-instance lock for the next launch.
                if !app
                    .state::<lifecycle::SidecarLifecycle>()
                    .shutdown_complete()
                {
                    api.prevent_exit();
                    lifecycle::graceful_quit(app.clone());
                }
            }
            tauri::RunEvent::Exit => {
                #[cfg(target_os = "macos")]
                if flush_deep_links(app).is_err() {
                    eprintln!("Pending desktop links could not be saved during exit.");
                }
                #[cfg(target_os = "macos")]
                updater_bridge::retire(app);
                #[cfg(target_os = "macos")]
                updater::unhealthy(app);
                // macOS Quit Apple events (Cmd-Q, AppleScript quit) bypass a
                // preventable ExitRequested in this Tauri version; guarantee
                // the sidecar's graceful shutdown on every exit path.
                lifecycle::blocking_shutdown(app);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        },
    );
}
#[cfg(test)]
mod tests {
    use super::*;

    fn deliver_page(
        links: &StartupDeepLinks,
        label: &str,
        url: &tauri::Url,
        event: tauri::webview::PageLoadEvent,
    ) -> Vec<tauri::Url> {
        let Some(delivery) = links.take_for_page(label, url, event).unwrap() else {
            return Vec::new();
        };
        let urls = delivery.urls.clone();
        links.acknowledge(delivery).unwrap();
        urls
    }

    #[test]
    fn forwarded_links_queue_during_startup_and_retry_then_route_immediately_when_ready() {
        let link: tauri::Url = "gajae-app://open/job/job-forwarded".parse().unwrap();
        let app_url = "http://127.0.0.1:43123/".parse().unwrap();
        let links = StartupDeepLinks::new(Vec::new());
        assert!(links.receive(vec![link.clone()]).unwrap().is_none());
        assert_eq!(
            deliver_page(
                &links,
                "main",
                &app_url,
                tauri::webview::PageLoadEvent::Finished
            ),
            vec![link.clone()]
        );
        let immediate = links.receive(vec![link.clone()]).unwrap().unwrap();
        assert_eq!(immediate.urls, vec![link.clone()]);
        links.acknowledge(immediate).unwrap();
        links.reset();
        assert!(links.receive(vec![link.clone()]).unwrap().is_none());
        assert!(links
            .take_for_page(
                "main",
                &"tauri://localhost/".parse().unwrap(),
                tauri::webview::PageLoadEvent::Finished
            )
            .unwrap()
            .is_none());
        assert_eq!(
            deliver_page(
                &links,
                "main",
                &app_url,
                tauri::webview::PageLoadEvent::Finished
            ),
            vec![link]
        );
    }

    #[test]
    fn page_reload_fences_new_activations_and_queue_is_bounded() {
        let link: tauri::Url = "gajae-app://open/job/job-forwarded".parse().unwrap();
        let app_url = "http://127.0.0.1:43123/".parse().unwrap();
        let links = StartupDeepLinks::new(Vec::new());
        links
            .take_for_page("main", &app_url, tauri::webview::PageLoadEvent::Finished)
            .unwrap();
        links
            .take_for_page("main", &app_url, tauri::webview::PageLoadEvent::Started)
            .unwrap();
        for _ in 0..16 {
            assert!(links.receive(vec![link.clone()]).unwrap().is_none());
        }
        assert!(links.receive(vec![link]).is_err());
        assert_eq!(
            deliver_page(
                &links,
                "main",
                &app_url,
                tauri::webview::PageLoadEvent::Finished
            )
            .len(),
            16
        );
    }

    #[test]
    fn startup_deep_links_wait_for_the_main_app_after_bootstrap_and_are_consumed_once() {
        use tauri::webview::PageLoadEvent::{Finished, Started};

        let link: tauri::Url = "gajae-app://open/job/job-123".parse().unwrap();
        let startup = StartupDeepLinks::new(vec![link.clone()]);
        for (label, url, event) in [
            ("main", "tauri://localhost/", Finished),
            (
                "main",
                "http://127.0.0.1:43123/desktop/bootstrap?nonce=test",
                Finished,
            ),
            ("main", "https://example.com/", Finished),
            ("other", "http://127.0.0.1:43123/", Finished),
            ("main", "http://127.0.0.1:43123/", Started),
        ] {
            assert!(startup
                .take_for_page(label, &url.parse().unwrap(), event)
                .unwrap()
                .is_none());
        }
        let app_url = "http://127.0.0.1:43123/".parse().unwrap();
        assert_eq!(
            deliver_page(&startup, "main", &app_url, Finished),
            vec![link]
        );
        assert!(startup
            .take_for_page("main", &app_url, Finished)
            .unwrap()
            .is_none());
    }

    #[test]
    fn startup_deep_links_validate_cli_urls_before_queueing() {
        let startup = StartupDeepLinks::new(
            [
                "https://example.com/",
                "gajae-app://other/job/123",
                "gajae-app://open/job/bad%20id",
                "gajae-app://open/job/job-123",
            ]
            .into_iter()
            .map(|url| url.parse().unwrap())
            .collect(),
        );
        assert_eq!(
            deliver_page(
                &startup,
                "main",
                &"http://127.0.0.1:43123/".parse().unwrap(),
                tauri::webview::PageLoadEvent::Finished,
            ),
            vec!["gajae-app://open/job/job-123"
                .parse::<tauri::Url>()
                .unwrap()]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn single_instance_lock_is_released_for_a_fresh_launch() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let lock_path = std::env::temp_dir().join(format!(
            "gajae-app-desktop-test-{}-{unique}.lock",
            std::process::id()
        ));
        let first = acquire_single_instance_lock_at(&lock_path).unwrap();
        assert!(acquire_single_instance_lock_at(&lock_path).is_err());
        drop(first);

        // The lock file persists after shutdown; its presence alone must not
        // stop the next launch once the previous shell releases its handle.
        assert!(lock_path.exists());
        let relaunched = acquire_single_instance_lock_at(&lock_path)
            .expect("a stopped shell must not prevent relaunch");
        drop(relaunched);
        std::fs::remove_file(lock_path).unwrap();
    }

    #[test]
    fn deep_link_router_accepts_only_the_registered_scheme() {
        assert!(is_gajae_deep_link(
            &"gajae-app://open/job/123".parse().unwrap()
        ));
        assert!(!is_gajae_deep_link(
            &"https://example.com/".parse().unwrap()
        ));
    }

    #[test]
    fn deep_link_route_returns_validated_job_urls_to_the_root_shell() {
        assert_eq!(
            deep_link_route(&"gajae-app://open/job/job-7fb9426de036".parse().unwrap()),
            Some("/".to_owned())
        );
        for rejected in [
            "gajae-app://open/job/",
            "gajae-app://open/session/x",
            "gajae-app://other/job/x",
            "gajae-app://open/job/bad%20id",
            "gajae-app://open/job/a/b",
            "https://example.com/open/job/x",
        ] {
            assert_eq!(
                deep_link_route(&rejected.parse().unwrap()),
                None,
                "{rejected}"
            );
        }
    }
}
