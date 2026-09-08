//! Native-owned manual restart transaction. Browser data selects no installer,
//! path or URL. A sealed draft acknowledgement precedes backend admission;
//! only a committed idle proof may reach controlled shutdown.
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{
    updater::{Phase as UpdatePhase, Snapshot},
    updater_backend::{Backend, Control, State as BackendState},
    updater_binding::{Binding, Mode},
    updater_location::InstallLocation,
    updater_store::Store,
};

#[derive(Clone)]
pub(crate) struct Context {
    pub backend: Arc<Backend>,
    pub server_pid: u32,
    pub return_url: tauri::Url,
    pub current: Arc<dyn Fn() -> bool + Send + Sync>,
    pub same_run: Arc<dyn Fn() -> bool + Send + Sync>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Phase {
    Draft,
    Preparing,
    Navigating,
    CommitSent,
    Stopping,
    Restarting,
    Aborted,
    Recovery,
    AbortRequested,
}

struct Attempt {
    id: String,
    draft_epoch: u64,
    deadline: Instant,
    phase: AtomicU8,
    cancelled: AtomicBool,
    context: Context,
    archive_sha256: String,
    desktop_version: String,
    prepare_sent: AtomicBool,
    displayed: AtomicBool,
}
#[derive(Debug, PartialEq, Eq)]
enum Cancellation {
    Aborted,
    Pending,
    TooLate,
}
impl Attempt {
    fn phase(&self) -> Phase {
        match self.phase.load(Ordering::Acquire) {
            0 => Phase::Draft,
            1 => Phase::Preparing,
            2 => Phase::Navigating,
            3 => Phase::CommitSent,
            4 => Phase::Stopping,
            5 => Phase::Restarting,
            6 => Phase::Aborted,
            7 => Phase::Recovery,
            _ => Phase::AbortRequested,
        }
    }
    fn set(&self, phase: Phase) {
        self.phase.store(phase as u8, Ordering::Release);
    }
    fn precommit(&self) -> bool {
        matches!(
            self.phase(),
            Phase::Draft | Phase::Preparing | Phase::Navigating | Phase::AbortRequested
        )
    }
    fn current(&self) -> bool {
        !self.cancelled.load(Ordering::Acquire) && (self.context.current)()
    }
    fn request_cancel(&self) -> Cancellation {
        loop {
            let phase = self.phase();
            if phase == Phase::Aborted {
                return Cancellation::Aborted;
            }
            if !self.precommit() {
                return Cancellation::TooLate;
            }
            if phase == Phase::AbortRequested {
                return Cancellation::Pending;
            }
            let target = if phase == Phase::Draft {
                Phase::Aborted
            } else {
                Phase::AbortRequested
            };
            if self
                .phase
                .compare_exchange(
                    phase as u8,
                    target as u8,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                self.cancelled.store(true, Ordering::Release);
                return if target == Phase::Aborted {
                    Cancellation::Aborted
                } else {
                    Cancellation::Pending
                };
            }
        }
    }
}

#[derive(Default)]
pub(crate) struct Restarts {
    sequence: AtomicU64,
    current: Mutex<Option<Arc<Attempt>>>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum Reply {
    Snapshot(Snapshot),
    Challenge {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        kind: &'static str,
        #[serde(rename = "attemptId")]
        attempt_id: String,
        #[serde(rename = "draftEpoch")]
        draft_epoch: u64,
        #[serde(rename = "ttlMs")]
        ttl_ms: u64,
    },
    Disposition {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        kind: &'static str,
        #[serde(rename = "attemptId")]
        attempt_id: String,
        #[serde(rename = "draftEpoch")]
        draft_epoch: u64,
        snapshot: Snapshot,
    },
}

fn qualified(app: &AppHandle) -> bool {
    // Build/profile admission is shared with startup. Disabled builds remain
    // inert; production is enabled only by an explicit release-arm64 binding.
    // Native location/ownership and runtime/draft gates are still mandatory.
    let binding = Binding::compiled();
    let profile = app.try_state::<crate::qa_profile::QaProfile>();
    cfg!(target_arch = "aarch64")
        && binding.admits_profile(
            profile.as_ref().map(|profile| profile.root()),
            !cfg!(debug_assertions),
        )
}
fn snapshot(app: &AppHandle) -> Result<Snapshot, &'static str> {
    app.state::<crate::updater::Preparation>().snapshot(|| true)
}
fn nonce() -> Result<String, &'static str> {
    use std::fmt::Write;
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "updater_unavailable")?;
    let mut text = String::with_capacity(64);
    for byte in bytes {
        write!(text, "{byte:02x}").expect("hex");
    }
    Ok(text)
}

fn trace(event: &'static str) {
    if cfg!(debug_assertions) && Binding::compiled().mode == Mode::Qa {
        eprintln!("[restart-qa:{}] {event}", std::process::id());
    }
}

impl Restarts {
    fn attempt(&self) -> Option<Arc<Attempt>> {
        self.current.lock().ok().and_then(|value| value.clone())
    }
    fn active(&self) -> bool {
        let Some(attempt) = self.attempt() else {
            return false;
        };
        if attempt.phase() == Phase::Draft && Instant::now() >= attempt.deadline {
            let _ = attempt.phase.compare_exchange(
                Phase::Draft as u8,
                Phase::Aborted as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
        !matches!(attempt.phase(), Phase::Aborted)
    }
    pub(crate) fn decorate(
        &self,
        app: &AppHandle,
        backend: Option<&Arc<Backend>>,
        mut state: Snapshot,
    ) -> Snapshot {
        state.installation_available =
            qualified(app) && backend.is_some_and(|backend| backend.available()) && !self.active();
        clear_satisfied_installation_gate(&mut state);
        if let Some(attempt) = self.attempt() {
            match attempt.phase() {
                Phase::Navigating | Phase::CommitSent | Phase::Stopping => {
                    state.phase = UpdatePhase::Applying
                }
                Phase::Restarting => state.phase = UpdatePhase::Restarting,
                Phase::Recovery => state.phase = UpdatePhase::Recovery,
                _ => {}
            }
        }
        state
    }
    pub(crate) fn begin(&self, app: &AppHandle, context: Context) -> Result<Reply, &'static str> {
        if !qualified(app) {
            return Err("updater_installation_unavailable");
        }
        if self.active() {
            return Err("updater_busy");
        }
        let state = snapshot(app)?;
        if !matches!(state.phase, UpdatePhase::Ready) || !context.current.as_ref()() {
            return Err("updater_unavailable");
        }
        let idle = context
            .backend
            .request(Control::Status, Instant::now() + Duration::from_secs(1))?;
        if !idle.ok || idle.state != BackendState::Open {
            return Err("updater_busy");
        }
        let root = crate::supervisor::desktop_data_root(app).map_err(|_| "updater_unavailable")?;
        let store = Store::open(&root).map_err(|_| "updater_unavailable")?;
        let record = store
            .prepared_record()
            .map_err(|_| "updater_unavailable")?
            .ok_or("updater_unavailable")?;
        let manifest = crate::updater_manifest::parse_manifest(
            record.manifest.as_bytes(),
            &crate::updater_install::product_identity(),
        )
        .map_err(|_| "updater_unavailable")?;
        if state.target_desktop_version.as_deref() != Some(manifest.version.to_string().as_str())
            || state.target_product_version.as_deref()
                != Some(manifest.product_version.to_string().as_str())
        {
            return Err("updater_unavailable");
        }
        InstallLocation::validate(
            &Binding::compiled(),
            &std::env::current_exe().map_err(|_| "updater_unavailable")?,
        )
        .map_err(|_| "updater_installation_unavailable")?;
        if !(context.current)() {
            return Err("updater_unauthorized");
        }
        let epoch = self
            .sequence
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                (value < 9_007_199_254_740_991).then_some(value + 1)
            })
            .map_err(|_| "updater_unavailable")?
            + 1;
        let attempt = Arc::new(Attempt {
            id: nonce()?,
            draft_epoch: epoch,
            deadline: Instant::now() + Duration::from_secs(5),
            phase: AtomicU8::new(Phase::Draft as u8),
            cancelled: AtomicBool::new(false),
            context,
            archive_sha256: record.archive_sha256,
            desktop_version: manifest.version.to_string(),
            prepare_sent: AtomicBool::new(false),
            displayed: AtomicBool::new(false),
        });
        let mut slot = self.current.lock().map_err(|_| "updater_unavailable")?;
        if slot
            .as_ref()
            .is_some_and(|current| current.phase() != Phase::Aborted)
        {
            return Err("updater_busy");
        }
        *slot = Some(attempt.clone());
        trace("draft-challenge");
        let expiry = attempt.clone();
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if expiry
                .phase
                .compare_exchange(
                    Phase::Draft as u8,
                    Phase::Aborted as u8,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                crate::updater_bridge::notify_restart_aborted(
                    &handle,
                    &expiry.id,
                    expiry.draft_epoch,
                );
            }
        });
        Ok(Reply::Challenge {
            protocol_version: 1,
            kind: "restartChallenge",
            attempt_id: attempt.id.clone(),
            draft_epoch: epoch,
            ttl_ms: 5_000,
        })
    }

    fn matching(&self, id: &str, epoch: u64) -> Result<Arc<Attempt>, &'static str> {
        self.attempt()
            .filter(|attempt| attempt.id == id && attempt.draft_epoch == epoch)
            .ok_or("updater_stale_restart")
    }

    pub(crate) fn cancel(
        &self,
        app: &AppHandle,
        id: &str,
        epoch: u64,
    ) -> Result<Reply, &'static str> {
        let attempt = self.matching(id, epoch)?;
        match attempt.request_cancel() {
            Cancellation::Aborted => {
                crate::updater_bridge::notify_restart_aborted(
                    app,
                    &attempt.id,
                    attempt.draft_epoch,
                );
                return disposition(app, &attempt, true, "updater_restart_cancelled");
            }
            Cancellation::TooLate => {
                return disposition(app, &attempt, false, "updater_restart_uncertain")
            }
            Cancellation::Pending => {}
        }
        // The active owner performs ordered backend cancellation after its
        // in-flight read; an explicit cancel never races an independent commit.
        if attempt.phase() == Phase::Aborted {
            crate::updater_bridge::notify_restart_aborted(app, &attempt.id, attempt.draft_epoch);
            return disposition(app, &attempt, true, "updater_restart_cancelled");
        }
        Err("updater_restart_cancelling")
    }

    pub(crate) fn prepared(
        &self,
        app: &AppHandle,
        id: &str,
        epoch: u64,
    ) -> Result<Reply, &'static str> {
        let attempt = self.matching(id, epoch)?;
        if attempt.phase() == Phase::Aborted {
            return disposition(app, &attempt, true, "updater_restart_cancelled");
        }
        if attempt
            .phase
            .compare_exchange(
                Phase::Draft as u8,
                Phase::Preparing as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            return Err("updater_busy");
        }
        tauri::async_runtime::block_on(prepare_restart(app, attempt))
    }
}

fn clear_satisfied_installation_gate(state: &mut Snapshot) {
    if state.installation_available && state.reason == Some("installation_safety_gate_pending") {
        state.reason = None;
    }
}

fn disposition(
    app: &AppHandle,
    attempt: &Attempt,
    aborted: bool,
    reason: &'static str,
) -> Result<Reply, &'static str> {
    let mut state = snapshot(app)?;
    state.phase = if aborted {
        UpdatePhase::Deferred
    } else {
        UpdatePhase::Recovery
    };
    state.reason = Some(reason);
    state.installation_available = false;
    Ok(Reply::Disposition {
        protocol_version: 1,
        kind: if aborted {
            "restartAborted"
        } else {
            "restartUncertain"
        },
        attempt_id: attempt.id.clone(),
        draft_epoch: attempt.draft_epoch,
        snapshot: state,
    })
}

async fn abort(
    app: &AppHandle,
    attempt: &Attempt,
    reason: &'static str,
) -> Result<Reply, &'static str> {
    trace(reason);
    if !attempt.precommit() {
        return recover(app, attempt, "updater_restart_uncertain");
    }
    if attempt.prepare_sent.load(Ordering::Acquire) {
        // Even a failed cancellation cannot cause a later commit: this native
        // owner will issue none, and channel retirement revokes its Node epoch.
        match attempt.context.backend.request(
            Control::Cancel {
                attempt_id: attempt.id.clone(),
            },
            Instant::now() + Duration::from_secs(2),
        ) {
            Ok(value) if value.state == BackendState::Open => {}
            Ok(_) => return recover(app, attempt, "updater_abort_uncertain"),
            Err(_) => attempt.context.backend.retire(),
        }
    }
    let displayed = attempt.displayed.load(Ordering::Acquire);
    attempt.set(Phase::Aborted);
    if displayed {
        crate::updater_launch::cancel_manual_display(app, &attempt.context.return_url);
    }
    crate::updater_bridge::notify_restart_aborted(app, &attempt.id, attempt.draft_epoch);
    disposition(app, attempt, true, reason)
}

fn recover(
    app: &AppHandle,
    attempt: &Attempt,
    reason: &'static str,
) -> Result<Reply, &'static str> {
    trace(reason);
    attempt.set(Phase::Recovery);
    crate::updater_launch::manual_recovery(
        app,
        "Restart ownership could not be confirmed. The application was not automatically retried.",
    );
    disposition(app, attempt, false, reason)
}

async fn prepare_restart(app: &AppHandle, attempt: Arc<Attempt>) -> Result<Reply, &'static str> {
    if !attempt.current() || Instant::now() >= attempt.deadline {
        return abort(app, &attempt, "updater_restart_cancelled").await;
    }
    crate::reset_deep_link_readiness(app);
    if crate::flush_deep_links(app).is_err() {
        return abort(app, &attempt, "updater_pending_links_unavailable").await;
    }
    let state = match snapshot(app) {
        Ok(state) => state,
        Err(_) => return abort(app, &attempt, "updater_unavailable").await,
    };
    if !matches!(state.phase, UpdatePhase::Ready)
        || state.target_desktop_version.as_deref() != Some(&attempt.desktop_version)
        || !attempt.current()
    {
        return abort(app, &attempt, "updater_restart_cancelled").await;
    }
    if attempt
        .phase
        .compare_exchange(
            Phase::Preparing as u8,
            Phase::Navigating as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_err()
    {
        return abort(app, &attempt, "updater_restart_cancelled").await;
    }
    attempt.displayed.store(true, Ordering::Release);
    if crate::updater_launch::show_manual_applying(app)
        .await
        .is_err()
    {
        return abort(app, &attempt, "updater_display_unavailable").await;
    }
    trace("applying-visible");
    // Dispose the sealed document before taking runtime evidence. Its expected
    // WebSocket/HTTP disconnects are activity changes, not an exception to the
    // authority's generation checks. This stage installs/stops nothing: busy or
    // unknown owners still cancel and restore the saved page.
    let remaining = attempt
        .deadline
        .saturating_duration_since(Instant::now())
        .as_millis() as u64;
    if remaining == 0 || attempt.cancelled.load(Ordering::Acquire) || !(attempt.context.same_run)()
    {
        return abort(app, &attempt, "updater_restart_cancelled").await;
    }
    attempt.prepare_sent.store(true, Ordering::Release);
    trace("backend-prepare");
    let prepared = attempt.context.backend.request(
        Control::Prepare {
            attempt_id: attempt.id.clone(),
            draft_epoch: attempt.draft_epoch,
            remaining_ms: remaining.min(5_000),
        },
        attempt.deadline,
    );
    let prepared = match prepared {
        Ok(value)
            if value.ok
                && value.state == BackendState::Prepared
                && value.attempt_id.as_deref() == Some(&attempt.id)
                && value.token.is_some()
                && value.expires_in_ms.is_some() =>
        {
            value
        }
        _ => return abort(app, &attempt, "updater_runtime_busy").await,
    };
    let token_deadline =
        Instant::now() + Duration::from_millis(prepared.expires_in_ms.unwrap_or(0));
    trace("backend-prepared");
    if attempt.cancelled.load(Ordering::Acquire)
        || !(attempt.context.same_run)()
        || Instant::now() >= attempt.deadline
    {
        return abort(app, &attempt, "updater_restart_cancelled").await;
    }
    let tree = match crate::updater_owners::capture_owned_server(
        attempt.context.server_pid,
        std::process::id(),
    ) {
        Ok(tree) => tree,
        Err(error) => {
            trace_owner_failure(&error);
            return abort(app, &attempt, "updater_owner_unknown").await;
        }
    };
    let state = match snapshot(app) {
        Ok(state) => state,
        Err(_) => return abort(app, &attempt, "updater_unavailable").await,
    };
    if !matches!(state.phase, UpdatePhase::Ready)
        || state.target_desktop_version.as_deref() != Some(&attempt.desktop_version)
        || attempt.cancelled.load(Ordering::Acquire)
        || !(attempt.context.same_run)()
    {
        return abort(app, &attempt, "updater_restart_cancelled").await;
    }
    if attempt.cancelled.load(Ordering::Acquire)
        || !(attempt.context.same_run)()
        || Instant::now() >= token_deadline
    {
        return abort(app, &attempt, "updater_restart_cancelled").await;
    }
    if let Err(error) = tree.revalidate() {
        trace_owner_failure(&error);
        return abort(app, &attempt, "updater_owner_changed").await;
    }
    // Cancellation and commit elect one winner at this final synchronous point.
    if attempt
        .phase
        .compare_exchange(
            Phase::Navigating as u8,
            Phase::CommitSent as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_err()
    {
        return abort(app, &attempt, "updater_restart_cancelled").await;
    }
    let committed = attempt.context.backend.request(
        Control::Commit {
            attempt_id: attempt.id.clone(),
            token: prepared.token.unwrap_or_default(),
        },
        token_deadline.min(Instant::now() + Duration::from_secs(5)),
    );
    match committed {
        Ok(value)
            if value.ok
                && value.state == BackendState::Committed
                && value.attempt_id.as_deref() == Some(&attempt.id) => {}
        Ok(value) if !value.ok && value.state != BackendState::Committed => {
            attempt.set(Phase::Navigating);
            return abort(app, &attempt, "updater_runtime_changed").await;
        }
        _ => return recover(app, &attempt, "updater_commit_uncertain"),
    }
    attempt.set(Phase::Stopping);
    trace("backend-committed");
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result: Result<(), String> = async {
            let lifecycle = handle.state::<crate::lifecycle::SidecarLifecycle>();
            if lifecycle.begin_shutdown() != Some(attempt.context.server_pid) {
                return Err("Restart lost its owned server.".into());
            }
            lifecycle.terminate(attempt.context.server_pid)?;
            trace("server-stop-requested");
            lifecycle.wait_for_exit().await?;
            trace("server-exited");
            let deadline = Instant::now() + Duration::from_secs(5);
            while !tree.all_gone()? {
                if Instant::now() >= deadline {
                    return Err("Owned server descendants did not finish shutdown.".into());
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let root = crate::supervisor::desktop_data_root(&handle)?;
            trace("owned-tree-exited");
            Store::open(&root)?.request_manual(&attempt.archive_sha256)?;
            trace("manual-intent-saved");
            attempt.set(Phase::Restarting);
            crate::updater_launch::request_manual_restart(&handle);
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = recover(&handle, &attempt, "updater_shutdown_unconfirmed");
        }
    });
    Ok(Reply::Snapshot(snapshot(app)?))
}

fn trace_owner_failure(error: &str) {
    if cfg!(debug_assertions) && Binding::compiled().mode == Mode::Qa {
        // The owner scanner returns static reason descriptions, not process
        // argv, user content, or authentication material.
        eprintln!("[restart-qa:{}] {error}", std::process::id());
    }
}

pub(crate) fn blocks_start(app: &AppHandle) -> bool {
    app.try_state::<Restarts>()
        .is_some_and(|state| state.active())
}
pub(crate) fn holds_exit(app: &AppHandle) -> bool {
    app.try_state::<Restarts>()
        .and_then(|state| state.attempt())
        .is_some_and(|attempt| {
            matches!(
                attempt.phase(),
                Phase::CommitSent | Phase::Stopping | Phase::Restarting
            )
        })
}
pub(crate) fn permits_navigation(app: &AppHandle, url: &tauri::Url) -> bool {
    let Some(attempt) = app
        .try_state::<Restarts>()
        .and_then(|state| state.attempt())
    else {
        return true;
    };
    if matches!(
        attempt.phase(),
        Phase::Navigating
            | Phase::CommitSent
            | Phase::Stopping
            | Phase::Restarting
            | Phase::Recovery
    ) || (attempt.phase() == Phase::AbortRequested && attempt.displayed.load(Ordering::Acquire))
    {
        return url.scheme() == "tauri"
            && url.host_str() == Some("localhost")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && matches!(url.path(), "/" | "/index.html")
            && url.query().is_none()
            && url.fragment().is_none();
    }
    true
}
pub(crate) fn view_lost(app: &AppHandle) {
    if let Some(attempt) = app
        .try_state::<Restarts>()
        .and_then(|state| state.attempt())
    {
        loop {
            let phase = attempt.phase();
            let next = match phase {
                Phase::Draft => Phase::Aborted,
                Phase::Preparing => Phase::AbortRequested,
                _ => break,
            };
            if attempt
                .phase
                .compare_exchange(phase as u8, next as u8, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                attempt.cancelled.store(true, Ordering::Release);
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    #[test]
    fn enabled_installation_does_not_display_a_satisfied_gate_as_pending() {
        let mut state = Snapshot {
            reason: Some("installation_safety_gate_pending"),
            ..Snapshot::default()
        };
        clear_satisfied_installation_gate(&mut state);
        assert!(state.reason.is_some());
        state.installation_available = true;
        clear_satisfied_installation_gate(&mut state);
        assert_eq!(state.reason, None);
        state.reason = Some("updater_runtime_busy");
        clear_satisfied_installation_gate(&mut state);
        assert_eq!(state.reason, Some("updater_runtime_busy"));
    }

    fn attempt(phase: Phase) -> (Arc<Attempt>, UnixStream) {
        let (native, peer) = UnixStream::pair().unwrap();
        (
            Arc::new(Attempt {
                id: "a".repeat(64),
                draft_epoch: 1,
                deadline: Instant::now() + Duration::from_secs(5),
                phase: AtomicU8::new(phase as u8),
                cancelled: AtomicBool::new(false),
                context: Context {
                    backend: Arc::new(Backend::new(native, "b".repeat(64)).unwrap()),
                    server_pid: 42,
                    return_url: "http://127.0.0.1:43123/".parse().unwrap(),
                    current: Arc::new(|| true),
                    same_run: Arc::new(|| true),
                },
                archive_sha256: "c".repeat(64),
                desktop_version: "0.2.5".into(),
                prepare_sent: AtomicBool::new(false),
                displayed: AtomicBool::new(false),
            }),
            peer,
        )
    }

    #[test]
    fn draft_cancel_is_final_but_committed_paths_never_acknowledge_rollback() {
        let (draft, _peer) = attempt(Phase::Draft);
        assert_eq!(draft.request_cancel(), Cancellation::Aborted);
        assert_eq!(draft.request_cancel(), Cancellation::Aborted);
        assert!(draft
            .phase
            .compare_exchange(
                Phase::Draft as u8,
                Phase::Preparing as u8,
                Ordering::AcqRel,
                Ordering::Acquire
            )
            .is_err());
        for phase in [
            Phase::CommitSent,
            Phase::Stopping,
            Phase::Restarting,
            Phase::Recovery,
        ] {
            let (current, _peer) = attempt(phase);
            assert_eq!(current.request_cancel(), Cancellation::TooLate);
            assert!(!current.cancelled.load(Ordering::Acquire));
        }
    }

    #[test]
    fn cancellation_and_commit_have_one_atomic_winner() {
        for _ in 0..100 {
            let (current, _peer) = attempt(Phase::Navigating);
            let cancel = current.clone();
            let worker = std::thread::spawn(move || cancel.request_cancel());
            let committed = current
                .phase
                .compare_exchange(
                    Phase::Navigating as u8,
                    Phase::CommitSent as u8,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok();
            let cancelled = worker.join().unwrap() == Cancellation::Pending;
            assert_ne!(committed, cancelled);
        }
    }
}
