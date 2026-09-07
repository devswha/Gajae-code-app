use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use tauri::{AppHandle, Manager, Window};
use tokio::sync::Notify;

#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    Admission(String),
    Spawn(String),
}

pub struct SidecarLifecycle {
    pid: std::sync::Mutex<Option<u32>>,
    shutting_down: AtomicBool,
    shutdown_waiting: AtomicBool,
    exited: Notify,
}

impl Default for SidecarLifecycle {
    fn default() -> Self {
        Self {
            pid: std::sync::Mutex::new(None),
            shutting_down: AtomicBool::new(false),
            shutdown_waiting: AtomicBool::new(false),
            exited: Notify::new(),
        }
    }
}

impl SidecarLifecycle {
    /// Keep spawning and PID publication in the same critical section as Quit.
    /// A repeated Retry must not replace the server whose exit we still await.
    pub fn start<T>(
        &self,
        admit: impl FnOnce() -> Result<(), String>,
        spawn: impl FnOnce() -> Result<(u32, T), String>,
    ) -> Result<Option<T>, StartError> {
        let mut pid = self.pid.lock().expect("sidecar lifecycle lock poisoned");
        if pid.is_some() || self.is_shutting_down() {
            return Ok(None);
        }
        // Admission runs while this PID/shutdown lock is held and directly
        // before spawn, so Retry and Quit cannot race a pre-server refusal.
        admit().map_err(StartError::Admission)?;
        let (started_pid, child) = spawn().map_err(StartError::Spawn)?;
        *pid = Some(started_pid);
        Ok(Some(child))
    }

    pub fn exited(&self, exited_pid: u32) {
        let mut pid = self.pid.lock().expect("sidecar lifecycle lock poisoned");
        if *pid == Some(exited_pid) {
            *pid = None;
            self.exited.notify_waiters();
        }
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }
    pub fn has_sidecar(&self) -> bool {
        self.pid
            .lock()
            .expect("sidecar lifecycle lock poisoned")
            .is_some()
    }

    /// The final app.exit() must be allowed through ExitRequested, but only
    /// after Quit has fenced off new spawns and the tracked server has exited.
    pub fn shutdown_complete(&self) -> bool {
        self.is_shutting_down() && !self.has_sidecar()
    }

    pub fn begin_shutdown(&self) -> Option<u32> {
        let pid = self.pid.lock().expect("sidecar lifecycle lock poisoned");
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return None;
        }
        *pid
    }

    /// Signal only the currently tracked child, while Retry cannot replace it.
    pub(crate) fn terminate(&self, expected_pid: u32) -> Result<(), String> {
        let pid = self.pid.lock().expect("sidecar lifecycle lock poisoned");
        if *pid == Some(expected_pid) {
            terminate_sidecar(expected_pid)
        } else {
            Ok(())
        }
    }

    async fn wait_for_exit(&self) -> Result<(), String> {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                // Register before checking the durable state: exit can happen
                // before this wait begins, or between the check and the await.
                let exited = self.exited.notified();
                if !self.has_sidecar() {
                    return;
                }
                exited.await;
            }
        })
        .await
        .map_err(|_| "desktop server did not complete its graceful shutdown".to_owned())
    }

    fn wait_for_exit_blocking(&self, pid: u32, timeout: Duration) {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if !self.has_sidecar() || !process_alive(pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

#[cfg(unix)]
pub fn terminate_sidecar(pid: u32) -> Result<(), String> {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    const SIGTERM: i32 = 15;
    let target = i32::try_from(pid)
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| format!("invalid desktop server PID {pid}"))?;
    if unsafe { kill(target, SIGTERM) } == 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        // The plugin may already have reaped the child but still be draining
        // inherited output pipes before it delivers Terminated.
        if error.raw_os_error() == Some(3) {
            Ok(()) // ESRCH: the child is already gone.
        } else {
            Err(format!(
                "could not send SIGTERM to desktop server {pid}: {error}"
            ))
        }
    }
}

#[cfg(not(unix))]
pub fn terminate_sidecar(_pid: u32) -> Result<(), String> {
    Err("graceful sidecar termination is unavailable on this platform".to_owned())
}

#[cfg(unix)]
pub(crate) fn process_alive(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let Some(target) = i32::try_from(pid).ok().filter(|pid| *pid > 0) else {
        return true; // An invalid PID must never authorize Retry or app exit.
    };
    if unsafe { kill(target, 0) } == 0 {
        true
    } else {
        // Permission and probe failures are not evidence of process exit.
        std::io::Error::last_os_error().raw_os_error() != Some(3)
    }
}

#[cfg(not(unix))]
pub(crate) fn process_alive(_pid: u32) -> bool {
    false
}

/// Last-resort synchronous shutdown for exit paths that cannot be prevented.
/// macOS delivers Quit Apple events (Cmd-Q, `osascript quit`) through
/// `applicationShouldTerminate`, which this Tauri version answers YES without
/// emitting a preventable ExitRequested — the process then exits without ever
/// signalling the sidecar, orphaning the server tree. Called from
/// `RunEvent::Exit`, this blocks the exiting thread until the sidecar's
/// graceful SIGTERM shutdown finishes (bounded at 30s).
pub fn blocking_shutdown(app: &AppHandle) {
    let lifecycle = app.state::<SidecarLifecycle>();
    match lifecycle.begin_shutdown() {
        Some(pid) => {
            let _ = terminate_sidecar(pid);
            lifecycle.wait_for_exit_blocking(pid, Duration::from_secs(30));
        }
        None => {
            // A graceful shutdown is already in flight; wait for it to settle
            // so exiting cannot outrun the sidecar's shutdown fence.
            let pid = *lifecycle
                .pid
                .lock()
                .expect("sidecar lifecycle lock poisoned");
            if let Some(pid) = pid {
                lifecycle.wait_for_exit_blocking(pid, Duration::from_secs(30));
            }
        }
    }
}

pub fn handle_close_request(window: &Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        // Keep the window alive until the server finishes: shutdown errors
        // still need a visible window, and destroying it must not skip Quit.
        api.prevent_close();

        // Linux has no macOS Reopen event (and no tray UI in this app). Hiding
        // the last window would leave the server and instance lock invisible.
        #[cfg(target_os = "linux")]
        graceful_quit(window.app_handle().clone());

        // Preserve macOS close-to-hide and its Dock/Reopen behavior.
        #[cfg(not(target_os = "linux"))]
        let _ = window.hide();
    }
}

pub fn graceful_quit(app: AppHandle) {
    // Fence spawning on the event thread, before scheduling asynchronous work.
    // Otherwise a queued Retry/startup can spawn after CloseRequested returns.
    let lifecycle = app.state::<SidecarLifecycle>();
    lifecycle.begin_shutdown();
    if lifecycle.shutdown_complete() {
        app.exit(0);
        return;
    }
    if lifecycle.shutdown_waiting.swap(true, Ordering::SeqCst) {
        return;
    }
    let pid = *lifecycle
        .pid
        .lock()
        .expect("sidecar lifecycle lock poisoned");
    let signal = pid.map_or(Ok(()), |pid| lifecycle.terminate(pid));
    tauri::async_runtime::spawn(async move {
        let lifecycle = app.state::<SidecarLifecycle>();
        let result = match signal {
            Ok(()) => lifecycle.wait_for_exit().await,
            Err(error) => Err(error),
        };
        // Keep the spawn fence, but let another Close/Quit retry a failed
        // signal or wait. Previously every subsequent Quit became a no-op.
        lifecycle.shutdown_waiting.store(false, Ordering::SeqCst);
        if let Err(error) = result {
            show_shutdown_error(&app, &error);
            return;
        }
        app.exit(0);
    });
}

fn show_shutdown_error(app: &AppHandle, error: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let escaped =
            serde_json::to_string(error).unwrap_or_else(|_| "\"Shutdown failed\"".to_owned());
        let _ = window.eval(format!("document.body.innerHTML='<main style=\"font:16px system-ui;padding:3rem\"><h1>Gajae Code App could not quit safely</h1><pre></pre></main>';document.querySelector('pre').textContent={escaped};"));
        let _ = window.show();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_is_started_once() {
        let lifecycle = SidecarLifecycle::default();
        lifecycle.start(|| Ok(()), || Ok((42, ()))).unwrap();
        assert_eq!(lifecycle.begin_shutdown(), Some(42));
        assert_eq!(lifecycle.begin_shutdown(), None);
    }

    #[test]
    fn shell_exit_requires_shutdown_even_before_the_server_starts() {
        let lifecycle = SidecarLifecycle::default();
        assert!(!lifecycle.shutdown_complete());
        assert_eq!(lifecycle.begin_shutdown(), None);
        assert!(lifecycle.shutdown_complete());
        assert_eq!(
            lifecycle.start::<()>(
                || panic!("closing during startup must prevent admission"),
                || panic!("closing during startup must prevent a late spawn"),
            ),
            Ok(None)
        );
    }

    #[test]
    fn repeated_close_cannot_release_the_shutdown_fence_early() {
        let lifecycle = SidecarLifecycle::default();
        lifecycle.start(|| Ok(()), || Ok((42, ()))).unwrap();
        assert!(!lifecycle.shutdown_complete());
        assert_eq!(lifecycle.begin_shutdown(), Some(42));
        assert!(!lifecycle.shutdown_complete());
        assert_eq!(lifecycle.begin_shutdown(), None);
        assert!(!lifecycle.shutdown_complete());

        lifecycle.exited(43);
        assert!(!lifecycle.shutdown_complete());
        lifecycle.exited(42);
        assert!(
            lifecycle.shutdown_complete(),
            "the final app.exit() must proceed"
        );
        assert_eq!(
            lifecycle.start::<()>(
                || panic!("a completed shutdown must still reject admission"),
                || panic!("a completed shutdown must still reject Retry"),
            ),
            Ok(None)
        );
    }

    #[test]
    fn unexpected_server_exit_does_not_count_as_a_requested_shutdown() {
        let lifecycle = SidecarLifecycle::default();
        lifecycle.start(|| Ok(()), || Ok((42, ()))).unwrap();
        lifecycle.exited(42);
        assert!(!lifecycle.shutdown_complete());
        assert_eq!(lifecycle.begin_shutdown(), None);
        assert!(lifecycle.shutdown_complete());
    }

    #[test]
    fn exit_before_waiting_completes_shutdown_immediately() {
        let lifecycle = SidecarLifecycle::default();
        lifecycle.start(|| Ok(()), || Ok((42, ()))).unwrap();
        assert_eq!(lifecycle.begin_shutdown(), Some(42));
        lifecycle.exited(42);
        tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_millis(100), lifecycle.wait_for_exit())
                .await
                .expect("an already exited server must not wait for another notification")
                .unwrap();
        });
    }

    #[test]
    fn retry_does_not_spawn_another_server_until_the_previous_one_exits() {
        let lifecycle = SidecarLifecycle::default();
        assert_eq!(
            lifecycle.start(|| Ok(()), || Ok((42, "first"))).unwrap(),
            Some("first")
        );
        assert_eq!(
            lifecycle.start::<()>(
                || panic!("the previous server is still tracked"),
                || panic!("the previous server is still tracked"),
            ),
            Ok(None)
        );
        lifecycle.exited(42);
        assert_eq!(
            lifecycle.start(|| Ok(()), || Ok((43, "retry"))).unwrap(),
            Some("retry")
        );
        lifecycle.exited(42);
        assert_eq!(lifecycle.begin_shutdown(), Some(43));
    }

    #[test]
    fn failed_spawn_can_retry_but_shutdown_cannot_spawn() {
        let lifecycle = SidecarLifecycle::default();
        assert!(lifecycle
            .start::<()>(|| Ok(()), || Err("spawn failed".to_owned()))
            .is_err());
        assert_eq!(
            lifecycle.start(|| Ok(()), || Ok((42, ()))).unwrap(),
            Some(())
        );
        assert_eq!(lifecycle.begin_shutdown(), Some(42));
        lifecycle.exited(42);
        assert_eq!(
            lifecycle.start::<()>(
                || panic!("Quit already began"),
                || panic!("Quit already began"),
            ),
            Ok(None)
        );
    }

    #[test]
    fn denied_admission_never_invokes_spawn() {
        let lifecycle = SidecarLifecycle::default();
        let spawned = std::sync::atomic::AtomicBool::new(false);
        assert_eq!(
            lifecycle.start::<()>(
                || Err("pending update attempt".to_owned()),
                || {
                    spawned.store(true, Ordering::SeqCst);
                    Ok((42, ()))
                },
            ),
            Err(StartError::Admission("pending update attempt".to_owned()))
        );
        assert!(!spawned.load(Ordering::SeqCst));
        assert!(!lifecycle.has_sidecar());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn repeated_retry_cannot_bypass_the_same_update_attempt_record() {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "gajae-lifecycle-update-attempt-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir(&root).unwrap();
        assert!(crate::updater_attempt::check(&root).is_ok());
        std::fs::write(root.join("desktop-update-attempt.json"), b"pending").unwrap();
        let lifecycle = SidecarLifecycle::default();
        for _ in 0..2 {
            let result = lifecycle.start::<()>(
                || crate::updater_attempt::check(&root),
                || panic!("a present update attempt must deny every retry"),
            );
            match result {
                Err(StartError::Admission(reason)) => {
                    assert!(reason.contains("desktop-update-attempt.json"))
                }
                result => panic!("expected record admission refusal, got {result:?}"),
            }
            assert!(!lifecycle.has_sidecar());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn quit_cannot_miss_a_spawn_whose_pid_is_not_yet_published() {
        use std::sync::{Arc, Barrier};

        let lifecycle = SidecarLifecycle::default();
        let spawning = Arc::new(Barrier::new(2));
        std::thread::scope(|threads| {
            let spawn_barrier = Arc::clone(&spawning);
            let starting_lifecycle = &lifecycle;
            let start = threads.spawn(move || {
                starting_lifecycle.start(
                    || Ok(()),
                    || {
                        spawn_barrier.wait();
                        Ok((42, ()))
                    },
                )
            });
            spawning.wait();
            assert_eq!(lifecycle.begin_shutdown(), Some(42));
            assert_eq!(start.join().unwrap().unwrap(), Some(()));
        });
    }

    #[test]
    fn shutdown_waits_for_the_tracked_server_to_exit() {
        let lifecycle = SidecarLifecycle::default();
        lifecycle.start(|| Ok(()), || Ok((42, ()))).unwrap();
        assert_eq!(lifecycle.begin_shutdown(), Some(42));
        tauri::async_runtime::block_on(async {
            let mut waiting = Box::pin(lifecycle.wait_for_exit());
            assert!(
                tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                    .await
                    .is_err()
            );
            lifecycle.exited(43);
            assert!(lifecycle.has_sidecar());
            assert!(
                tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                    .await
                    .is_err()
            );
            lifecycle.exited(42);
            tokio::time::timeout(Duration::from_millis(100), waiting)
                .await
                .expect("the existing shutdown waiter must wake when the tracked server exits")
                .unwrap();
            assert!(lifecycle.shutdown_complete());
        });
    }
}
