//! Native discovery and explicitly requested archive staging. Scheduled checks
//! publish metadata only; a target-bound click permits download/verification.
//! Installation and restart remain in their separately guarded owners.
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

use crate::{
    updater_archive::{inspect_archive, ArchiveIdentity},
    updater_binding::{Binding, Mode},
    updater_discovery::{
        self, DiscoveryCompleteness, DiscoveryCursor, DiscoveryError, DiscoveryPolicy,
        SelectedRelease,
    },
    updater_install::{InstallError, VerifiedArchive},
    updater_manifest::{Channel, Manifest, ProductIdentity},
    updater_signature::verify_archive,
    updater_store::{PreparedRecord, Store},
    updater_transport::{build_client, HttpsClient},
};

const INTERVAL_SECONDS: u64 = 6 * 60 * 60;
const CONTINUATION_DELAY: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Disabled,
    Idle,
    Checking,
    Available,
    Downloading,
    Verifying,
    Ready,
    Deferred,
    Error,
    Applying,
    Restarting,
    Recovery,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub protocol_version: u8,
    pub phase: Phase,
    pub automatic: bool,
    pub product_version: &'static str,
    pub desktop_version: &'static str,
    pub target_id: Option<String>,
    pub target_product_version: Option<String>,
    pub target_desktop_version: Option<String>,
    pub discovery_incomplete: bool,
    pub reason: Option<&'static str>,
    /// A staged archive is NOT installation permission or installation proof.
    pub installation_available: bool,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub notes: Option<String>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            protocol_version: 1,
            phase: Phase::Disabled,
            automatic: false,
            product_version: env!("GJC_EXPECTED_PAYLOAD_VERSION"),
            desktop_version: env!("CARGO_PKG_VERSION"),
            target_id: None,
            target_product_version: None,
            target_desktop_version: None,
            discovery_incomplete: true,
            reason: None,
            installation_available: false,
            downloaded_bytes: None,
            total_bytes: None,
            notes: None,
        }
    }
}

fn startup_snapshot(automatic: bool) -> Snapshot {
    Snapshot {
        phase: Phase::Idle,
        automatic,
        ..Snapshot::default()
    }
}

struct Control {
    snapshot: Snapshot,
    snapshot_generation: u64,
    in_flight: bool,
    requested: bool,
    restart_requested: bool,
    next_due: Instant,
    not_before: Instant,
    failures: usize,
    store: Option<Arc<Store>>,
    verified: Option<VerifiedTarget>,
    offered: Option<SelectedRelease>,
    download_requested: Option<SelectedRelease>,
    downloading: Option<String>,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            snapshot: Snapshot::default(),
            snapshot_generation: 0,
            in_flight: false,
            requested: false,
            restart_requested: false,
            next_due: Instant::now(),
            not_before: Instant::now(),
            failures: 0,
            store: None,
            verified: None,
            offered: None,
            download_requested: None,
            downloading: None,
        }
    }
}

#[derive(Default)]
struct Coordinator {
    control: Mutex<Control>,
    changed: Notify,
    started: AtomicBool,
    // Event-thread cancellation must never wait for cache I/O or fsync.
    healthy: AtomicBool,
    generation: AtomicU64,
}

#[derive(Default)]
pub(crate) struct Preparation(Arc<Coordinator>);

impl Preparation {
    pub(crate) fn snapshot(&self, admit: impl FnOnce() -> bool) -> Result<Snapshot, &'static str> {
        let control = self.0.control.lock().map_err(|_| "updater_unavailable")?;
        if !admit() {
            return Err("updater_unauthorized");
        }
        Ok(self.0.snapshot_from(&control))
    }

    pub(crate) fn set_automatic(
        &self,
        automatic: bool,
        admit: impl FnOnce() -> bool,
    ) -> Result<Snapshot, &'static str> {
        self.0.set_automatic_if(automatic, admit)?;
        Ok(self.0.snapshot())
    }

    pub(crate) fn manual_check(
        &self,
        admit: impl FnOnce() -> bool,
    ) -> Result<Snapshot, &'static str> {
        self.0.manual_check_if(admit)?;
        Ok(self.0.snapshot())
    }

    pub(crate) fn manual_download(
        &self,
        target_id: &str,
        admit: impl FnOnce() -> bool,
    ) -> Result<Snapshot, &'static str> {
        self.0.manual_download_if(target_id, admit)?;
        Ok(self.0.snapshot())
    }
}

impl Coordinator {
    /// The only snapshot publication boundary. Raw state may have been written
    /// by a worker racing nonblocking invalidation; its epoch cannot be exposed
    /// as Ready after that epoch has retired.
    fn snapshot(&self) -> Snapshot {
        let control = self.control.lock().expect("update owner lock poisoned");
        self.snapshot_from(&control)
    }

    fn snapshot_from(&self, control: &Control) -> Snapshot {
        let mut snapshot = control.snapshot.clone();
        if snapshot.phase != Phase::Disabled && !self.valid(control.snapshot_generation) {
            snapshot.phase = Phase::Deferred;
            snapshot.reason = Some("preparation_cancelled");
        }
        snapshot
    }

    fn healthy_start(&self) -> bool {
        let mut control = self.control.lock().expect("update owner lock poisoned");
        let was_healthy = self.healthy.swap(true, Ordering::AcqRel);
        if !was_healthy {
            self.generation.fetch_add(1, Ordering::AcqRel);
            control.offered = None;
            control.download_requested = None;
        }
        control.next_due = Instant::now();
        if self.started.load(Ordering::Acquire) {
            // Retirement must consume this notification or keep its owner alive.
            control.restart_requested = true;
            self.changed.notify_one();
            return false;
        }
        self.generation.fetch_add(1, Ordering::AcqRel);
        control.restart_requested = false;
        self.started.store(true, Ordering::Release);
        self.changed.notify_one();
        true
    }

    fn valid(&self, generation: u64) -> bool {
        self.healthy.load(Ordering::Acquire)
            && self.generation.load(Ordering::Acquire) == generation
    }

    fn invalidate(&self) {
        self.healthy.store(false, Ordering::Release);
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.changed.notify_one();
        if let Ok(mut control) = self.control.try_lock() {
            control.snapshot.phase = Phase::Deferred;
            control.snapshot.reason = Some("server_not_ready");
        }
    }

    fn accept_cached(&self, generation: u64, target: VerifiedTarget) -> Result<(), PrepareError> {
        let mut control = self.control.lock().expect("update owner lock poisoned");
        if !self.valid(generation) {
            return Err(PrepareError::Cancelled);
        }
        set_target(&mut control.snapshot, &target.manifest, &target.id);
        control.snapshot.phase = Phase::Ready;
        control.snapshot_generation = generation;
        control.verified = Some(target);
        Ok(())
    }

    fn retire(&self, result: Result<(), PrepareError>) -> bool {
        let mut control = self.control.lock().expect("update owner lock poisoned");
        control.in_flight = false;
        control.store = None;
        control.verified = None;
        control.offered = None;
        control.download_requested = None;
        control.downloading = None;
        if let Err(error) = result {
            control.snapshot.phase = Phase::Error;
            control.snapshot.reason = Some(error.code());
            control.snapshot.automatic = false;
            control.snapshot_generation = self.generation.load(Ordering::Acquire);
            eprintln!("desktop updater preparation unavailable: {}", error.code());
        }
        let restart = control.restart_requested && self.healthy.load(Ordering::Acquire);
        control.restart_requested = false;
        if !restart {
            control.requested = false;
        }
        // Claiming and retirement use the same mutex. A concurrent healthy
        // callback either keeps this owner alive or claims after it retires.
        self.started.store(restart, Ordering::Release);
        restart
    }

    fn phase(&self, generation: u64, phase: Phase) -> Result<(), PrepareError> {
        let mut control = self.control.lock().expect("update owner lock poisoned");
        if !self.valid(generation) {
            return Err(PrepareError::Cancelled);
        }
        control.snapshot.phase = phase;
        control.snapshot_generation = generation;
        control.snapshot.reason = None;
        Ok(())
    }

    #[cfg(test)]
    fn set_automatic(&self, automatic: bool) -> Result<(), &'static str> {
        self.set_automatic_if(automatic, || true)
    }

    /// Check authority after acquiring the preference serialization lock.
    fn set_automatic_if(
        &self,
        automatic: bool,
        admit: impl FnOnce() -> bool,
    ) -> Result<(), &'static str> {
        let mut control = self.control.lock().map_err(|_| "updater_unavailable")?;
        if !admit() {
            return Err("updater_unauthorized");
        }
        let store = control.store.as_ref().ok_or("updater_inactive")?.clone();
        // Serialize the durable preference acknowledgement with ready publication.
        // Even a disk failure cancels this generation in memory, without claiming
        // the opt-out was persisted. Automatic checking cannot continue silently.
        control.snapshot_generation = self
            .generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        control.requested = false;
        control.download_requested = None;
        control.downloading = None;
        control.snapshot.automatic = false;
        if store.set_automatic(automatic).is_err() {
            control.snapshot.phase = Phase::Error;
            control.snapshot.reason = Some("preferences_not_persisted");
            self.changed.notify_one();
            return Err("preferences_not_persisted");
        }
        control.snapshot.automatic = automatic;
        restore_target(&mut control);
        control.requested = automatic;
        control.next_due = Instant::now();
        self.changed.notify_one();
        Ok(())
    }

    #[cfg(test)]
    fn manual_check(&self) -> Result<(), &'static str> {
        self.manual_check_if(|| true)
    }

    fn manual_check_if(&self, admit: impl FnOnce() -> bool) -> Result<(), &'static str> {
        let mut control = self.control.lock().map_err(|_| "updater_unavailable")?;
        if !admit() {
            return Err("updater_unauthorized");
        }
        if control.store.is_none()
            || !self.healthy.load(Ordering::Acquire)
            || !self.started.load(Ordering::Acquire)
        {
            return Err("updater_inactive");
        }
        // Coalesce repeated requests; manual checking never modifies consent.
        if !control.in_flight && control.download_requested.is_none() {
            control.requested = true;
            control.restart_requested = true;
            self.changed.notify_one();
        }
        Ok(())
    }

    fn manual_download_if(
        &self,
        target_id: &str,
        admit: impl FnOnce() -> bool,
    ) -> Result<(), &'static str> {
        let mut control = self.control.lock().map_err(|_| "updater_unavailable")?;
        if !admit() {
            return Err("updater_unauthorized");
        }
        if control.store.is_none()
            || !self.started.load(Ordering::Acquire)
            || !self.valid(control.snapshot_generation)
        {
            return Err("updater_inactive");
        }
        if !crate::updater_backend::hex_id(target_id)
            || control.snapshot.target_id.as_deref() != Some(target_id)
        {
            return Err("updater_target_changed");
        }
        // Duplicate clicks reuse a ready archive or the one already queued.
        if control.snapshot.phase == Phase::Ready
            && control
                .verified
                .as_ref()
                .is_some_and(|target| target.id == target_id)
            || control
                .download_requested
                .as_ref()
                .is_some_and(|target| target.target_id() == target_id)
            || control.downloading.as_deref() == Some(target_id)
        {
            return Ok(());
        }
        if control.in_flight {
            return Err("updater_busy");
        }
        let selected = control
            .offered
            .as_ref()
            .filter(|target| target.target_id() == target_id)
            .cloned()
            .ok_or("updater_target_changed")?;
        // A click during Retry-After fails now; it must not become a delayed
        // download after the UI has discarded its intent. Ready cache reuse and
        // coalescing an already admitted download above do not issue new I/O.
        if Instant::now() < control.not_before {
            return Err("updater_retry_later");
        }
        control.snapshot.phase = Phase::Downloading;
        control.snapshot.reason = None;
        control.snapshot.downloaded_bytes = None;
        control.snapshot.total_bytes = Some(selected.archive_asset.size);
        control.download_requested = Some(selected);
        control.restart_requested = true;
        self.changed.notify_one();
        Ok(())
    }

    fn claim_work(&self, now: Instant) -> Option<(u64, Work)> {
        let mut control = self.control.lock().expect("update owner lock poisoned");
        control.restart_requested = false;
        if !self.healthy.load(Ordering::Acquire) || control.in_flight || now < control.not_before {
            return None;
        }
        let work = if let Some(selected) = control.download_requested.take() {
            control.downloading = Some(selected.target_id());
            Work::Download(Box::new(selected))
        } else if control.requested || control.snapshot.automatic && now >= control.next_due {
            Work::Check
        } else {
            return None;
        };
        control.in_flight = true;
        control.requested = false;
        Some((self.generation.load(Ordering::Acquire), work))
    }

    /// Finish the single owned operation. True discards its discovery cursor;
    /// failures never restore a consumed manual-download request.
    fn finish_work(
        &self,
        generation: u64,
        result: Result<(bool, Option<Duration>), PrepareError>,
    ) -> bool {
        let mut control = self.control.lock().expect("update owner lock poisoned");
        control.in_flight = false;
        control.downloading = None;
        if !self.valid(generation) {
            if control.snapshot_generation == generation {
                control.snapshot.phase = Phase::Deferred;
                control.snapshot.reason = Some("preparation_cancelled");
            }
            return true;
        }
        match result {
            Ok((incomplete, delay)) => {
                control.failures = 0;
                control.snapshot.discovery_incomplete = incomplete;
                if !matches!(control.snapshot.phase, Phase::Ready | Phase::Available) {
                    restore_target(&mut control);
                }
                let minimum = delay;
                let delay = delay.unwrap_or_else(|| {
                    if incomplete {
                        CONTINUATION_DELAY
                    } else {
                        interval_delay()
                    }
                });
                control.next_due = Instant::now() + delay;
                control.not_before = Instant::now() + minimum.unwrap_or(Duration::ZERO);
            }
            Err(PrepareError::Cancelled) => {
                // A healthy/manual wake can cancel a network waiter without an
                // epoch change. Do not leave the UI polling Downloading forever.
                control.snapshot.phase = Phase::Deferred;
                control.snapshot.reason = Some("preparation_cancelled");
                return true;
            }
            Err(error) => {
                let delay = match &error {
                    PrepareError::Discovery(DiscoveryError::RetryAfter(delay)) => *delay,
                    _ => retry_delay(control.failures),
                };
                control.failures = control.failures.saturating_add(1);
                control.next_due = Instant::now() + delay;
                control.not_before = match &error {
                    PrepareError::Discovery(DiscoveryError::RetryAfter(_)) => control.next_due,
                    _ => Instant::now(),
                };
                control.snapshot.phase = Phase::Deferred;
                control.snapshot.reason = Some(error.code());
            }
        }
        false
    }
}

enum Work {
    Check,
    Download(Box<SelectedRelease>),
}

pub(crate) fn unhealthy(app: &AppHandle) {
    let Some(preparation) = app.try_state::<Preparation>() else {
        return;
    };
    preparation.0.invalidate();
}

/// This hook runs only AFTER independent payload health and navigation succeed.
/// It never delays sidecar startup and never grants apply/restart authority.
pub(crate) fn after_healthy(app: &AppHandle) {
    if app
        .state::<crate::lifecycle::SidecarLifecycle>()
        .is_shutting_down()
    {
        return;
    }
    // Do not begin automatic preparation if the authenticated control path
    // failed to initialize; that would leave the user without its opt-out UI.
    if !crate::updater_bridge::available(app) {
        return;
    }
    let binding = Binding::compiled();
    let profile = app.try_state::<crate::qa_profile::QaProfile>();
    if !cfg!(target_arch = "aarch64")
        || !binding.admits_profile(profile.as_ref().map(|p| p.root()), !cfg!(debug_assertions))
    {
        return;
    }
    let owner = app.state::<Preparation>().0.clone();
    if owner.healthy_start() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let result = run(&app, owner.clone(), binding.clone()).await;
                if !owner.retire(result) {
                    break;
                }
            }
        });
    }
}

#[derive(Debug)]
pub(crate) enum PrepareError {
    Cancelled,
    Binding,
    Cache,
    Signature,
    Archive,
    Policy,
    Worker,
    Discovery(DiscoveryError),
}
impl PrepareError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Cancelled => "preparation_cancelled",
            Self::Binding => "binding_mismatch",
            Self::Cache => "cache_invalid",
            Self::Signature => "signature_rejected",
            Self::Archive => "archive_rejected",
            Self::Policy => "candidate_ineligible",
            Self::Worker => "verification_worker_failed",
            Self::Discovery(_) => "discovery_failed",
        }
    }
}

pub(crate) struct Runtime {
    pub(crate) store: Arc<Store>,
    pub(crate) client: HttpsClient,
    pub(crate) policy: DiscoveryPolicy,
    pub(crate) binding: Binding,
    pub(crate) os: String,
    pub(crate) certificate: Option<reqwest::Certificate>,
}

#[derive(Clone)]
struct VerifiedTarget {
    manifest: Manifest,
    id: String,
}
impl VerifiedTarget {
    fn matches(&self, selected: &SelectedRelease) -> bool {
        self.id == selected.target_id()
    }
}

pub(crate) fn initialize(app: &AppHandle, binding: Binding) -> Result<Runtime, PrepareError> {
    let profile = app.try_state::<crate::qa_profile::QaProfile>();
    let root = crate::supervisor::desktop_data_root(app).map_err(|_| PrepareError::Binding)?;
    let executable = std::env::current_exe().map_err(|_| PrepareError::Binding)?;
    binding
        .validate_runtime(
            profile.as_ref().map(|p| p.root()),
            &executable,
            &root,
            !cfg!(debug_assertions),
        )
        .map_err(|_| PrepareError::Binding)?;
    let os = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .map_err(|_| PrepareError::Binding)?;
    if !os.status.success() || os.stdout.len() > 128 {
        return Err(PrepareError::Binding);
    }
    let os = String::from_utf8(os.stdout)
        .map_err(|_| PrepareError::Binding)?
        .trim()
        .to_owned();
    let version = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|_| PrepareError::Policy)?;
    let channel = installed_channel()?;
    let policy = match binding.mode {
        Mode::Production => DiscoveryPolicy::production(&identity(), version, channel, &os),
        Mode::Qa => DiscoveryPolicy::qa(
            &identity(),
            version,
            channel,
            &os,
            binding
                .feed_origin
                .parse()
                .map_err(|_| PrepareError::Binding)?,
        ),
        Mode::Disabled => return Err(PrepareError::Binding),
    }
    .map_err(PrepareError::Discovery)?;
    let store = Arc::new(Store::open(&root).map_err(|_| PrepareError::Cache)?);
    // The fixture CA is compiled into QA only; never disable TLS validation or
    // accept a runtime/browser-supplied trust root.
    let certificate = if binding.mode == Mode::Qa {
        let pem = STANDARD
            .decode(env!("GJC_UPDATE_QA_CA_CERT"))
            .map_err(|_| PrepareError::Binding)?;
        Some(reqwest::Certificate::from_pem(&pem).map_err(|_| PrepareError::Binding)?)
    } else {
        None
    };
    let client = build_client(
        certificate.clone(),
        Duration::from_secs(5),
        Duration::from_secs(10 * 60),
    )
    .map_err(|_| PrepareError::Binding)?;
    Ok(Runtime {
        store,
        client,
        policy,
        binding,
        os,
        certificate,
    })
}

async fn run(
    app: &AppHandle,
    owner: Arc<Coordinator>,
    binding: Binding,
) -> Result<(), PrepareError> {
    let runtime = initialize(app, binding)?;
    let preferences = runtime
        .store
        .preferences()
        .map_err(|_| PrepareError::Cache)?;
    {
        let mut control = owner.control.lock().expect("update owner lock poisoned");
        control.store = Some(runtime.store.clone());
        // A startup invalidation may have left server_not_ready or an old
        // target behind. Healthy initialization is fresh even with auto off,
        // when no later network phase will clear that stale reason for us.
        control.snapshot = startup_snapshot(preferences.automatic);
        control.snapshot_generation = owner.generation.load(Ordering::Acquire);
    }
    // Every restart re-verifies cache bytes, even when automatic checking is off.
    // This is preparation metadata only: no startup gate or attempt is cleared.
    let store = runtime.store.clone();
    let key = runtime.binding.public_key.clone();
    let os = runtime.os.clone();
    let cache_generation = owner.generation.load(Ordering::Acquire);
    let cached = tauri::async_runtime::spawn_blocking(move || validate_cache(&store, &key, &os))
        .await
        .map_err(|_| PrepareError::Worker)??;
    if let Some(target) = cached {
        // A late read may be useful on a later check, but cannot overwrite a
        // cancellation/opt-out/health transition from a retired generation.
        let _ = owner.accept_cached(cache_generation, target);
    }
    let mut cursor = DiscoveryCursor::default();
    loop {
        let (generation, work) = {
            // This waiter must be dropped before preparation registers its own
            // cancellation waiter; Notify::notify_one cannot wake two owners.
            let notified = owner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let Some(work) = owner.claim_work(Instant::now()) else {
                // A bounded heartbeat coalesces OS wake/suspend without an event
                // listener storm. Check requests and health changes wake immediately.
                let _ = tokio::time::timeout(Duration::from_secs(30), notified).await;
                if app
                    .state::<crate::lifecycle::SidecarLifecycle>()
                    .is_shutting_down()
                {
                    return Ok(());
                }
                continue;
            };
            work
        };
        let result = match work {
            Work::Check => {
                discover(
                    &owner,
                    generation,
                    updater_discovery::discover_burst(
                        &runtime.client,
                        &runtime.policy,
                        &mut cursor,
                    ),
                )
                .await
            }
            Work::Download(selected) => download(&owner, generation, &runtime, *selected)
                .await
                .map(|()| (owner.snapshot().discovery_incomplete, None)),
        };
        if owner.finish_work(generation, result) {
            cursor = DiscoveryCursor::default();
        }
    }
}

async fn cancellable<T>(
    owner: &Coordinator,
    generation: u64,
    future: impl Future<Output = Result<T, DiscoveryError>>,
) -> Result<T, PrepareError> {
    let changed = owner.changed.notified();
    tokio::pin!(changed);
    changed.as_mut().enable();
    if !owner.valid(generation) {
        return Err(PrepareError::Cancelled);
    }
    match futures_util::future::select(Box::pin(future), changed).await {
        futures_util::future::Either::Left((result, _)) => result.map_err(PrepareError::Discovery),
        futures_util::future::Either::Right(_) => Err(PrepareError::Cancelled),
    }
}

async fn discover(
    owner: &Coordinator,
    generation: u64,
    discovery: impl Future<Output = Result<updater_discovery::DiscoveryResult, DiscoveryError>>,
) -> Result<(bool, Option<Duration>), PrepareError> {
    owner.phase(generation, Phase::Checking)?;
    let result = cancellable(owner, generation, discovery).await?;
    let incomplete = !matches!(
        result.completeness,
        DiscoveryCompleteness::CompleteObservedScan
    );
    let Some(selected) = result.selected else {
        let mut control = owner.control.lock().expect("update owner lock poisoned");
        if !owner.valid(generation) {
            return Err(PrepareError::Cancelled);
        }
        restore_target(&mut control);
        return Ok((incomplete, result.retry_after));
    };
    offer(owner, generation, selected)?;
    Ok((incomplete, result.retry_after))
}

fn offer(
    owner: &Coordinator,
    generation: u64,
    selected: SelectedRelease,
) -> Result<(), PrepareError> {
    let mut control = owner.control.lock().expect("update owner lock poisoned");
    if !owner.valid(generation) {
        return Err(PrepareError::Cancelled);
    }
    // Retain the complete native candidate; a later click never runs discovery.
    control.offered = Some(selected);
    restore_target(&mut control);
    control.snapshot_generation = generation;
    Ok(())
}

fn restore_target(control: &mut Control) {
    if let Some(selected) = &control.offered {
        set_target(
            &mut control.snapshot,
            &selected.manifest,
            &selected.target_id(),
        );
        control.snapshot.phase = if control
            .verified
            .as_ref()
            .is_some_and(|verified| verified.matches(selected))
        {
            Phase::Ready
        } else {
            Phase::Available
        };
        control.snapshot.downloaded_bytes = None;
        control.snapshot.total_bytes = Some(selected.archive_asset.size);
    } else if let Some(verified) = &control.verified {
        set_target(&mut control.snapshot, &verified.manifest, &verified.id);
        control.snapshot.phase = Phase::Ready;
    } else {
        control.snapshot.phase = Phase::Idle;
    }
}

async fn download(
    owner: &Coordinator,
    generation: u64,
    runtime: &Runtime,
    selected: SelectedRelease,
) -> Result<(), PrepareError> {
    owner.phase(generation, Phase::Downloading)?;
    {
        let mut control = owner.control.lock().expect("update owner lock poisoned");
        if !owner.valid(generation) {
            return Err(PrepareError::Cancelled);
        }
        // The transport is not progress-reporting. Do not synthesize a percent
        // until the complete, bounded response has actually arrived.
        control.snapshot.downloaded_bytes = None;
        control.snapshot.total_bytes = Some(selected.archive_asset.size);
    }
    let bytes = cancellable(
        owner,
        generation,
        updater_discovery::fetch_archive(
            &runtime.client,
            &runtime.policy,
            &selected,
            Duration::from_secs(10 * 60),
        ),
    )
    .await?;
    {
        let mut control = owner.control.lock().expect("update owner lock poisoned");
        if !owner.valid(generation) {
            return Err(PrepareError::Cancelled);
        }
        control.snapshot.downloaded_bytes = Some(bytes.len() as u64);
    }
    owner.phase(generation, Phase::Verifying)?;
    let key = runtime.binding.public_key.clone();
    let manifest = selected.manifest.clone();
    let target = VerifiedTarget {
        manifest: manifest.clone(),
        id: selected.target_id(),
    };
    let store = runtime.store.clone();
    // Never drop this blocking worker on cancellation. It has no installer
    // authority; await completion, then discard this generation's private files.
    let staged = tauri::async_runtime::spawn_blocking(move || {
        let record = record_for(&selected, &bytes, &key)?;
        store
            .stage(&record, &bytes)
            .map_err(|_| PrepareError::Cache)
    })
    .await
    .map_err(|_| PrepareError::Worker)??;
    let mut control = owner.control.lock().expect("update owner lock poisoned");
    if !owner.valid(generation) {
        runtime.store.discard(staged);
        return Err(PrepareError::Cancelled);
    }
    runtime
        .store
        .commit(staged)
        .map_err(|_| PrepareError::Cache)?;
    // A non-mutating preparation commit already in flight may finish during
    // Quit. It never owns install authority and must not restore Ready state.
    if !owner.valid(generation) {
        return Err(PrepareError::Cancelled);
    }
    set_target(&mut control.snapshot, &manifest, &target.id);
    control.snapshot.phase = Phase::Ready;
    control.snapshot_generation = generation;
    control.verified = Some(target);
    Ok(())
}

fn identity() -> ProductIdentity<'static> {
    ProductIdentity {
        repository: env!("GJC_UPDATE_REPOSITORY"),
        artifact_prefix: env!("GJC_UPDATE_ARTIFACT_PREFIX"),
    }
}

fn archive_identity(manifest: &Manifest) -> ArchiveIdentity {
    ArchiveIdentity {
        product_name: env!("GJC_UPDATE_PRODUCT_NAME").into(),
        executable: env!("CARGO_PKG_NAME").into(),
        bundle_identifier: env!("GJC_UPDATE_BUNDLE_IDENTIFIER").into(),
        package_name: env!("GJC_UPDATE_PACKAGE_NAME").into(),
        desktop_version: manifest.version.to_string(),
        product_version: manifest.product_version.to_string(),
        minimum_system_version: manifest.minimum_system_version.clone(),
    }
}

fn record_for(
    selected: &SelectedRelease,
    bytes: &[u8],
    key: &str,
) -> Result<PreparedRecord, PrepareError> {
    let sha = verify_archive(bytes, key, &selected.manifest.signature)
        .map_err(|_| PrepareError::Signature)?;
    let inventory = inspect_archive(bytes, &archive_identity(&selected.manifest))
        .map_err(|_| PrepareError::Archive)?;
    Ok(PreparedRecord {
        schema: 1,
        release_id: selected.release.id,
        manifest_asset_id: selected.manifest_asset.id,
        archive_asset_id: selected.archive_asset.id,
        archive_size: bytes.len() as u64,
        archive_sha256: sha,
        manifest: String::from_utf8(selected.manifest_bytes.clone())
            .map_err(|_| PrepareError::Policy)?,
        inventory: serde_json::to_value(inventory).map_err(|_| PrepareError::Archive)?,
    })
}

fn validate_cache(
    store: &Store,
    key: &str,
    os: &str,
) -> Result<Option<VerifiedTarget>, PrepareError> {
    let Some(archive) = VerifiedArchive::load(store, key).map_err(|error| match error {
        InstallError::Signature => PrepareError::Signature,
        InstallError::Archive => PrepareError::Archive,
        _ => PrepareError::Cache,
    })?
    else {
        return Ok(None);
    };
    let manifest = archive.manifest();
    let record = archive.record();
    if !eligible_cached(manifest, os)? {
        return Ok(None);
    }
    Ok(Some(VerifiedTarget {
        manifest: manifest.clone(),
        id: record.target_id(),
    }))
}

fn installed_channel() -> Result<Channel, PrepareError> {
    let version =
        Version::parse(env!("GJC_EXPECTED_PAYLOAD_VERSION")).map_err(|_| PrepareError::Policy)?;
    match version.pre.as_str().split('.').next() {
        Some("") => Ok(Channel::Stable),
        Some("beta") => Ok(Channel::Beta),
        _ => Err(PrepareError::Policy),
    }
}

pub(crate) fn eligible_cached(manifest: &Manifest, os: &str) -> Result<bool, PrepareError> {
    let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|_| PrepareError::Policy)?;
    let floor = Version::new(0, 2, 3);
    let parse_os = |value: &str| -> Result<[u16; 3], PrepareError> {
        let values: Vec<_> = value.split('.').collect();
        if !(2..=3).contains(&values.len()) {
            return Err(PrepareError::Policy);
        }
        let mut result = [0; 3];
        for (i, value) in values.iter().enumerate() {
            result[i] = value.parse().map_err(|_| PrepareError::Policy)?;
        }
        Ok(result)
    };
    Ok(manifest.version.cmp_precedence(&current).is_gt()
        && manifest.version.cmp_precedence(&floor).is_gt()
        && (installed_channel()? != Channel::Stable || manifest.channel == Channel::Stable)
        && parse_os(&manifest.minimum_system_version)? <= parse_os(os)?)
}

fn set_target(snapshot: &mut Snapshot, manifest: &Manifest, target_id: &str) {
    snapshot.target_id = Some(target_id.to_owned());
    snapshot.target_product_version = Some(manifest.product_version.to_string());
    snapshot.target_desktop_version = Some(manifest.version.to_string());
    let mut notes: String = manifest.notes.chars().take(4096).collect();
    if notes.len() < manifest.notes.len() {
        notes.push('…');
    }
    snapshot.notes = Some(notes);
    snapshot.reason = Some("installation_safety_gate_pending");
}

fn retry_delay(failures: usize) -> Duration {
    Duration::from_secs(match failures {
        0 => 60,
        1 => 300,
        2 => 1800,
        _ => INTERVAL_SECONDS,
    })
}
fn interval_delay() -> Duration {
    let mut random = [0; 2];
    if getrandom::getrandom(&mut random).is_err() {
        return Duration::from_secs(INTERVAL_SECONDS);
    }
    Duration::from_secs(INTERVAL_SECONDS - 600 + u16::from_ne_bytes(random) as u64 % 1201)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{updater_manifest::parse_manifest, updater_signature::digest};
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let mut bytes = [0; 8];
            getrandom::getrandom(&mut bytes).unwrap();
            let path = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("gajae-preparation-{:x}", u64::from_ne_bytes(bytes)));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn candidate() -> SelectedRelease {
        use crate::updater_discovery::{AssetIdentity, ReleaseIdentity};
        let bytes = include_bytes!("../../shared/fixtures/desktop-update-manifest.json").to_vec();
        let manifest = parse_manifest(&bytes, &identity()).unwrap();
        let base = format!(
            "https://api.github.com/repos/{}/releases",
            identity().repository
        );
        let tag = format!("v{}", manifest.product_version);
        let archive_name = manifest
            .archive_url
            .path_segments()
            .unwrap()
            .next_back()
            .unwrap()
            .to_owned();
        SelectedRelease {
            release: ReleaseIdentity {
                id: 1,
                tag_name: tag.clone(),
                api_url: format!("{base}/1").parse().unwrap(),
                html_url: format!(
                    "https://github.com/{}/releases/tag/{tag}",
                    identity().repository
                )
                .parse()
                .unwrap(),
                prerelease: true,
            },
            manifest_asset: AssetIdentity {
                id: 2,
                name: "desktop-update.json".into(),
                size: bytes.len() as u64,
                api_url: format!("{base}/assets/2").parse().unwrap(),
                download_url: manifest.archive_url.join("desktop-update.json").unwrap(),
            },
            archive_asset: AssetIdentity {
                id: 3,
                name: archive_name,
                size: 4,
                api_url: format!("{base}/assets/3").parse().unwrap(),
                download_url: manifest.archive_url.clone(),
            },
            manifest,
            manifest_bytes: bytes,
        }
    }

    fn active_owner(automatic: bool) -> (Temp, Arc<Coordinator>) {
        let temp = Temp::new();
        let store = Arc::new(Store::open(&temp.0).unwrap());
        store.set_automatic(automatic).unwrap();
        let owner = Arc::new(Coordinator::default());
        owner.healthy.store(true, Ordering::Release);
        owner.started.store(true, Ordering::Release);
        {
            let mut control = owner.control.lock().unwrap();
            control.store = Some(store);
            control.snapshot = startup_snapshot(automatic);
        }
        (temp, owner)
    }

    #[test]
    fn scheduled_and_manual_discovery_publish_available_without_downloading_or_staging() {
        for automatic in [true, false] {
            let (_temp, owner) = active_owner(automatic);
            if !automatic {
                owner.manual_check().unwrap();
            }
            let (generation, work) = owner.claim_work(Instant::now()).unwrap();
            assert!(matches!(work, Work::Check));
            let selected = candidate();
            let target_id = selected.target_id();
            tauri::async_runtime::block_on(discover(&owner, generation, async {
                Ok(updater_discovery::DiscoveryResult {
                    selected: Some(selected),
                    completeness: DiscoveryCompleteness::CompleteObservedScan,
                    pages_observed: 1,
                    retry_after: None,
                })
            }))
            .unwrap();
            let snapshot = owner.snapshot();
            assert_eq!(snapshot.phase, Phase::Available);
            assert_eq!(snapshot.target_id.as_deref(), Some(target_id.as_str()));
            assert_eq!(snapshot.downloaded_bytes, None);
            let control = owner.control.lock().unwrap();
            assert!(control.download_requested.is_none());
            assert!(control.downloading.is_none());
            assert!(control.verified.is_none());
            assert!(control
                .store
                .as_ref()
                .unwrap()
                .prepared_record()
                .unwrap()
                .is_none());
            assert_eq!(
                control
                    .store
                    .as_ref()
                    .unwrap()
                    .preferences()
                    .unwrap()
                    .automatic,
                automatic
            );
        }
    }

    #[test]
    fn download_admission_is_prompt_bound_coalesced_and_preserves_check_consent() {
        let (_temp, owner) = active_owner(false);
        let selected = candidate();
        let target_id = selected.target_id();
        offer(&owner, 0, selected.clone()).unwrap();
        let before = Instant::now();
        let state = Preparation(owner.clone())
            .manual_download(&target_id, || true)
            .unwrap();
        assert!(before.elapsed() < Duration::from_secs(1));
        assert_eq!(state.phase, Phase::Downloading);
        assert_eq!(state.target_id.as_deref(), Some(target_id.as_str()));
        owner.manual_download_if(&target_id, || true).unwrap();
        owner.manual_check().unwrap();
        let (generation, work) = owner.claim_work(Instant::now()).unwrap();
        let Work::Download(queued) = work else {
            panic!("click must not rediscover")
        };
        assert_eq!(*queued, selected);
        owner.manual_download_if(&target_id, || true).unwrap();
        assert!(owner.control.lock().unwrap().download_requested.is_none());
        assert!(owner.claim_work(Instant::now()).is_none());
        // A verified completion preserves the exact offered identity. Repeated
        // clicks on that ready target must not queue another archive request.
        owner
            .accept_cached(
                generation,
                VerifiedTarget {
                    id: target_id.clone(),
                    manifest: selected.manifest,
                },
            )
            .unwrap();
        {
            let mut control = owner.control.lock().unwrap();
            control.in_flight = false;
            control.downloading = None;
        }
        owner.manual_download_if(&target_id, || true).unwrap();
        assert_eq!(owner.snapshot().phase, Phase::Ready);
        assert_eq!(
            owner.snapshot().target_id.as_deref(),
            Some(target_id.as_str())
        );
        assert!(owner.claim_work(Instant::now()).is_none());
        assert!(
            !owner
                .control
                .lock()
                .unwrap()
                .store
                .as_ref()
                .unwrap()
                .preferences()
                .unwrap()
                .automatic
        );
    }

    #[test]
    fn wrong_stale_unoffered_or_retired_download_targets_are_rejected_without_queueing() {
        let (_temp, owner) = active_owner(false);
        let selected = candidate();
        let target_id = selected.target_id();
        assert_eq!(
            owner.manual_download_if(&target_id, || true),
            Err("updater_target_changed")
        );
        offer(&owner, 0, selected.clone()).unwrap();
        for wrong in ["", "not-a-target", &"f".repeat(64)] {
            assert_eq!(
                owner.manual_download_if(wrong, || true),
                Err("updater_target_changed")
            );
        }
        let mut replacement = selected.clone();
        replacement.manifest_bytes.push(b'\n');
        offer(&owner, 0, replacement).unwrap();
        assert_eq!(
            owner.manual_download_if(&target_id, || true),
            Err("updater_target_changed")
        );
        assert!(owner.control.lock().unwrap().download_requested.is_none());
        offer(&owner, 0, selected).unwrap();
        owner.invalidate();
        assert_eq!(
            owner.manual_download_if(&target_id, || true),
            Err("updater_inactive")
        );
        assert!(owner.control.lock().unwrap().download_requested.is_none());
    }

    #[test]
    fn rate_limited_manual_download_rejects_without_queueing_or_changing_phase() {
        for automatic in [false, true] {
            for phase in [Phase::Available, Phase::Deferred] {
                let (_temp, owner) = active_owner(automatic);
                let selected = candidate();
                let target_id = selected.target_id();
                offer(&owner, 0, selected).unwrap();
                let not_before = Instant::now() + Duration::from_secs(24 * 60 * 60);
                {
                    let mut control = owner.control.lock().unwrap();
                    control.snapshot.phase = phase;
                    control.not_before = not_before;
                    control.next_due = not_before;
                }
                let original = serde_json::to_value(owner.snapshot()).unwrap();
                let preparation = Preparation(owner.clone());
                let before = Instant::now();
                for _ in 0..3 {
                    assert_eq!(
                        preparation
                            .manual_download(&target_id, || true)
                            .unwrap_err(),
                        "updater_retry_later"
                    );
                }
                assert!(before.elapsed() < Duration::from_secs(1));
                assert_eq!(serde_json::to_value(owner.snapshot()).unwrap(), original);
                {
                    let control = owner.control.lock().unwrap();
                    assert!(control.download_requested.is_none());
                    assert!(control.downloading.is_none());
                    assert!(!control.requested);
                    assert!(!control.restart_requested);
                    assert!(!control.in_flight);
                    assert!(control
                        .store
                        .as_ref()
                        .unwrap()
                        .prepared_record()
                        .unwrap()
                        .is_none());
                }
                assert!(owner.claim_work(Instant::now()).is_none());
                let later = owner.claim_work(not_before);
                if automatic {
                    assert!(matches!(later, Some((_, Work::Check))));
                } else {
                    assert!(later.is_none());
                }
            }
        }
    }

    #[test]
    fn expired_retry_after_requires_a_new_explicit_download_click() {
        let (_temp, owner) = active_owner(false);
        let selected = candidate();
        let target_id = selected.target_id();
        offer(&owner, 0, selected).unwrap();
        owner.control.lock().unwrap().not_before = Instant::now() + Duration::from_secs(60);
        assert_eq!(
            owner.manual_download_if(&target_id, || true),
            Err("updater_retry_later")
        );
        owner.control.lock().unwrap().not_before = Instant::now();
        assert!(owner.claim_work(Instant::now()).is_none());
        owner.manual_download_if(&target_id, || true).unwrap();
        assert_eq!(owner.snapshot().phase, Phase::Downloading);
        assert!(matches!(
            owner.claim_work(Instant::now()),
            Some((_, Work::Download(_)))
        ));
    }

    #[test]
    fn rate_limit_does_not_prevent_verified_ready_cache_reuse() {
        let (_temp, owner) = active_owner(false);
        let selected = candidate();
        let target_id = selected.target_id();
        owner
            .accept_cached(
                0,
                VerifiedTarget {
                    id: target_id.clone(),
                    manifest: selected.manifest,
                },
            )
            .unwrap();
        owner.control.lock().unwrap().not_before =
            Instant::now() + Duration::from_secs(24 * 60 * 60);
        owner.manual_download_if(&target_id, || true).unwrap();
        assert_eq!(owner.snapshot().phase, Phase::Ready);
        assert!(owner.control.lock().unwrap().download_requested.is_none());
    }

    #[test]
    fn opt_out_cancels_queued_download_without_later_auto_download() {
        let (_temp, owner) = active_owner(true);
        let selected = candidate();
        let target_id = selected.target_id();
        offer(&owner, 0, selected).unwrap();
        owner.manual_download_if(&target_id, || true).unwrap();
        assert_eq!(owner.snapshot().phase, Phase::Downloading);
        owner.set_automatic(false).unwrap();
        assert!(owner.claim_work(Instant::now()).is_none());
        assert!(owner.control.lock().unwrap().download_requested.is_none());
        owner.set_automatic(true).unwrap();
        assert!(matches!(
            owner.claim_work(Instant::now()),
            Some((_, Work::Check))
        ));
    }

    #[test]
    fn retained_verified_cache_remains_ready_on_discovery_but_not_for_same_version_substitution() {
        let (_temp, owner) = active_owner(true);
        let selected = candidate();
        owner
            .accept_cached(
                0,
                VerifiedTarget {
                    id: selected.target_id(),
                    manifest: selected.manifest.clone(),
                },
            )
            .unwrap();
        offer(&owner, 0, selected.clone()).unwrap();
        assert_eq!(owner.snapshot().phase, Phase::Ready);
        let mut replaced = selected;
        replaced.archive_asset.id += 1;
        offer(&owner, 0, replaced).unwrap();
        assert_eq!(owner.snapshot().phase, Phase::Available);
        assert!(owner.control.lock().unwrap().download_requested.is_none());
    }

    #[test]
    fn download_authority_is_rechecked_after_waiting_for_the_coordinator_lock() {
        let (_temp, owner) = active_owner(false);
        let selected = candidate();
        let target_id = selected.target_id();
        offer(&owner, 0, selected).unwrap();
        let admission = Arc::new(AtomicBool::new(true));
        let lock = owner.control.lock().unwrap();
        let (entered, waiting) = std::sync::mpsc::sync_channel(1);
        let worker = {
            let owner = owner.clone();
            let admission = admission.clone();
            std::thread::spawn(move || {
                entered.send(()).unwrap();
                owner.manual_download_if(&target_id, || admission.load(Ordering::Acquire))
            })
        };
        waiting.recv().unwrap();
        admission.store(false, Ordering::Release);
        drop(lock);
        assert_eq!(worker.join().unwrap(), Err("updater_unauthorized"));
        assert!(owner.control.lock().unwrap().download_requested.is_none());
    }

    #[test]
    fn status_reads_do_not_queue_download_or_check_work() {
        let (_temp, owner) = active_owner(false);
        offer(&owner, 0, candidate()).unwrap();
        let preparation = Preparation(owner.clone());
        for _ in 0..5 {
            assert_eq!(
                preparation.snapshot(|| true).unwrap().phase,
                Phase::Available
            );
        }
        let control = owner.control.lock().unwrap();
        assert!(!control.requested);
        assert!(!control.in_flight);
        assert!(control.download_requested.is_none());
        assert!(control
            .store
            .as_ref()
            .unwrap()
            .prepared_record()
            .unwrap()
            .is_none());
    }

    #[test]
    fn failed_or_cancelled_manual_downloads_never_retry_automatically() {
        for automatic in [false, true] {
            for error in [
                PrepareError::Cancelled,
                PrepareError::Discovery(DiscoveryError::Network),
                PrepareError::Discovery(DiscoveryError::RetryAfter(Duration::from_secs(120))),
                PrepareError::Signature,
                PrepareError::Archive,
            ] {
                let (_temp, owner) = active_owner(automatic);
                let selected = candidate();
                let target_id = selected.target_id();
                offer(&owner, 0, selected).unwrap();
                owner.manual_download_if(&target_id, || true).unwrap();
                let (generation, work) = owner.claim_work(Instant::now()).unwrap();
                assert!(matches!(work, Work::Download(_)));
                owner.finish_work(generation, Err(error));
                assert_eq!(owner.snapshot().phase, Phase::Deferred);
                assert!(owner.snapshot().reason.is_some());
                assert_eq!(
                    owner.snapshot().target_id.as_deref(),
                    Some(target_id.as_str())
                );
                let due = {
                    let control = owner.control.lock().unwrap();
                    control.next_due.max(control.not_before).max(Instant::now())
                };
                let next = owner.claim_work(due);
                if automatic {
                    assert!(matches!(next, Some((_, Work::Check))));
                } else {
                    assert!(next.is_none());
                }
                assert!(owner.control.lock().unwrap().download_requested.is_none());
            }
        }
    }

    #[test]
    fn retiring_owner_drops_queued_target_and_cannot_resume_it_on_a_new_generation() {
        let (_temp, owner) = active_owner(false);
        let selected = candidate();
        let target_id = selected.target_id();
        offer(&owner, 0, selected).unwrap();
        owner.manual_download_if(&target_id, || true).unwrap();
        owner.invalidate();
        assert!(!owner.retire(Ok(())));
        assert_eq!(
            owner.manual_download_if(&target_id, || true),
            Err("updater_inactive")
        );
        owner.healthy_start();
        let control = owner.control.lock().unwrap();
        assert!(control.download_requested.is_none());
        assert!(control.offered.is_none());
    }

    #[test]
    fn healthy_startup_with_automatic_off_does_not_keep_a_stale_server_error() {
        let snapshot = startup_snapshot(false);
        assert_eq!(snapshot.phase, Phase::Idle);
        assert!(!snapshot.automatic);
        assert_eq!(snapshot.reason, None);
        assert_eq!(snapshot.target_desktop_version, None);
        assert!(
            snapshot.discovery_incomplete,
            "no new discovery was performed"
        );
        assert!(!snapshot.installation_available);
    }

    #[test]
    fn native_snapshot_keys_match_the_shared_frontend_fixture() {
        let native = serde_json::to_value(Snapshot::default()).unwrap();
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../shared/fixtures/desktop-update-status.json"
        ))
        .unwrap();
        assert_eq!(
            native.as_object().unwrap().keys().collect::<Vec<_>>(),
            fixture.as_object().unwrap().keys().collect::<Vec<_>>()
        );
        assert_eq!(native["protocolVersion"], fixture["protocolVersion"]);
        assert_eq!(native["installationAvailable"], false);
        assert!(native.as_object().unwrap().contains_key("targetId"));
        assert!(native["targetId"].is_null());
        assert_eq!(serde_json::to_value(Phase::Available).unwrap(), "available");
    }

    #[test]
    fn revoked_authority_is_rechecked_after_waiting_for_the_preference_lock() {
        let temp = Temp::new();
        let owner = Arc::new(Coordinator::default());
        let store = Arc::new(Store::open(&temp.0).unwrap());
        owner.control.lock().unwrap().store = Some(store.clone());
        let admission = Arc::new(AtomicBool::new(true));
        let lock = owner.control.lock().unwrap();
        let (entered, waiting) = std::sync::mpsc::sync_channel(1);
        let worker = {
            let owner = owner.clone();
            let admission = admission.clone();
            std::thread::spawn(move || {
                entered.send(()).unwrap();
                owner.set_automatic_if(false, || admission.load(Ordering::Acquire))
            })
        };
        waiting.recv().unwrap();
        admission.store(false, Ordering::Release);
        drop(lock);
        assert_eq!(worker.join().unwrap(), Err("updater_unauthorized"));
        assert!(store.preferences().unwrap().automatic);
    }

    #[test]
    fn manual_check_does_not_grant_consent_and_busy_requests_coalesce() {
        let temp = Temp::new();
        let owner = Coordinator::default();
        {
            let mut control = owner.control.lock().unwrap();
            owner.healthy.store(true, Ordering::Release);
            owner.started.store(true, Ordering::Release);
            control.store = Some(Arc::new(Store::open(&temp.0).unwrap()));
        }
        owner.set_automatic(false).unwrap();
        owner.manual_check().unwrap();
        let mut control = owner.control.lock().unwrap();
        assert!(control.requested);
        assert!(!control.snapshot.automatic);
        assert!(
            !control
                .store
                .as_ref()
                .unwrap()
                .preferences()
                .unwrap()
                .automatic
        );
        control.in_flight = true;
        control.requested = false;
        drop(control);
        owner.manual_check().unwrap();
        assert!(!owner.control.lock().unwrap().requested);
    }

    #[test]
    fn opt_out_invalidates_the_active_generation_before_acknowledgement() {
        let temp = Temp::new();
        let owner = Coordinator::default();
        {
            let mut control = owner.control.lock().unwrap();
            owner.healthy.store(true, Ordering::Release);
            control.store = Some(Arc::new(Store::open(&temp.0).unwrap()));
        }
        let generation = owner.generation.load(Ordering::Acquire);
        assert!(owner.valid(generation));
        owner.set_automatic(false).unwrap();
        assert!(!owner.valid(generation));
        assert!(owner.phase(generation, Phase::Ready).is_err());
        assert!(
            !owner
                .control
                .lock()
                .unwrap()
                .snapshot
                .installation_available
        );
    }

    #[test]
    fn timers_are_bounded_and_cached_manifest_obeys_version_and_os_policy() {
        assert_eq!(retry_delay(0).as_secs(), 60);
        assert_eq!(retry_delay(1).as_secs(), 300);
        assert_eq!(retry_delay(2).as_secs(), 1800);
        for _ in 0..50 {
            assert!((21000..=22200).contains(&interval_delay().as_secs()));
        }
        let mut manifest = parse_manifest(
            include_bytes!("../../shared/fixtures/desktop-update-manifest.json"),
            &identity(),
        )
        .unwrap();
        let current = Version::parse(env!("CARGO_PKG_VERSION")).unwrap();
        manifest.version = Version::new(current.major, current.minor, current.patch + 1);
        assert!(eligible_cached(&manifest, "26.0").unwrap());
        assert!(!eligible_cached(&manifest, "12.0").unwrap());
        manifest.version = Version::new(0, 2, 3);
        assert!(!eligible_cached(&manifest, "26.0").unwrap());
    }

    #[test]
    fn fabricated_cached_signature_never_becomes_ready() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        let mut fixture: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../shared/fixtures/desktop-update-manifest.json"
        ))
        .unwrap();
        let current = Version::parse(env!("CARGO_PKG_VERSION")).unwrap();
        fixture["version"] = Version::new(current.major, current.minor, current.patch + 1)
            .to_string()
            .into();
        let record = PreparedRecord {
            schema: 1,
            release_id: 1,
            manifest_asset_id: 2,
            archive_asset_id: 3,
            archive_size: 4,
            archive_sha256: digest(b"test"),
            manifest: serde_json::to_string(&fixture).unwrap(),
            inventory: serde_json::json!({"fabricated":true}),
        };
        store
            .commit(store.stage(&record, b"test").unwrap())
            .unwrap();
        assert!(matches!(
            validate_cache(&store, "ZmFrZQ==", "26.0"),
            Err(PrepareError::Signature)
        ));
    }

    #[test]
    fn opt_out_wakes_and_cancels_a_pending_network_operation() {
        let temp = Temp::new();
        let owner = Arc::new(Coordinator::default());
        {
            let mut control = owner.control.lock().unwrap();
            owner.healthy.store(true, Ordering::Release);
            control.store = Some(Arc::new(Store::open(&temp.0).unwrap()));
        }
        let generation = owner.generation.load(Ordering::Acquire);
        tauri::async_runtime::block_on(async {
            let (started, ready) = tokio::sync::oneshot::channel();
            let background = owner.clone();
            let task = tauri::async_runtime::spawn(async move {
                let _ = started.send(());
                cancellable(
                    &background,
                    generation,
                    std::future::pending::<Result<(), DiscoveryError>>(),
                )
                .await
            });
            ready.await.unwrap();
            owner.set_automatic(false).unwrap();
            let outcome = tokio::time::timeout(Duration::from_millis(500), task)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(outcome, Err(PrepareError::Cancelled)));
        });
    }

    #[test]
    fn failed_preference_write_cancels_memory_state_without_claiming_durable_success() {
        let temp = Temp::new();
        let owner = Coordinator::default();
        let store = Arc::new(Store::open(&temp.0).unwrap());
        store.set_automatic(true).unwrap();
        {
            let mut control = owner.control.lock().unwrap();
            owner.healthy.store(true, Ordering::Release);
            control.snapshot.automatic = true;
            control.store = Some(store);
        }
        let path = temp.0.join("desktop-update-cache/preferences.json");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        assert_eq!(owner.set_automatic(false), Err("preferences_not_persisted"));
        let control = owner.control.lock().unwrap();
        assert!(!control.snapshot.automatic);
        assert_eq!(control.snapshot.phase, Phase::Error);
        assert_eq!(control.snapshot.reason, Some("preferences_not_persisted"));
    }

    #[test]
    fn lifecycle_cancellation_never_waits_for_the_persistence_mutex() {
        let owner = Coordinator::default();
        owner.healthy.store(true, Ordering::Release);
        let generation = owner.generation.load(Ordering::Acquire);
        // Model a stalled fsync with its generation lock held on this thread.
        // invalidate() must return without trying to acquire that mutex.
        let _stalled_writer = owner.control.lock().unwrap();
        let before = Instant::now();
        owner.invalidate();
        assert!(before.elapsed() < Duration::from_millis(100));
        assert!(!owner.valid(generation));
    }

    #[test]
    fn late_cache_validation_cannot_restore_ready_after_cancellation() {
        let owner = Coordinator::default();
        owner.healthy.store(true, Ordering::Release);
        let generation = owner.generation.load(Ordering::Acquire);
        let manifest = parse_manifest(
            include_bytes!("../../shared/fixtures/desktop-update-manifest.json"),
            &identity(),
        )
        .unwrap();
        owner.invalidate();
        assert!(matches!(
            owner.accept_cached(
                generation,
                VerifiedTarget {
                    manifest,
                    id: "a".repeat(64),
                }
            ),
            Err(PrepareError::Cancelled)
        ));
        let control = owner.control.lock().unwrap();
        assert_eq!(control.snapshot.phase, Phase::Deferred);
        assert!(control.verified.is_none());
    }

    #[test]
    fn retired_failed_owner_releases_restart_claim_and_refuses_unconsumed_requests() {
        let temp = Temp::new();
        let owner = Coordinator::default();
        owner.started.store(true, Ordering::Release);
        owner.healthy.store(true, Ordering::Release);
        {
            let mut control = owner.control.lock().unwrap();
            control.store = Some(Arc::new(Store::open(&temp.0).unwrap()));
            control.in_flight = true;
        }
        owner.retire(Err(PrepareError::Cache));
        assert!(!owner.started.load(Ordering::Acquire));
        assert_eq!(owner.manual_check(), Err("updater_inactive"));
        assert!(owner.control.lock().unwrap().store.is_none());
        // Same claim used by a new after_healthy callback following repair/Retry.
        assert!(!owner.started.swap(true, Ordering::AcqRel));
    }

    #[test]
    fn epoch_aware_snapshot_hides_ready_written_after_nonblocking_invalidation() {
        let owner = Coordinator::default();
        owner.healthy_start();
        let generation = owner.generation.load(Ordering::Acquire);
        {
            let mut control = owner.control.lock().unwrap();
            assert!(owner.valid(generation));
            // Exact check/write interleaving: invalidation cannot take the lock,
            // then the old worker writes Ready after its previous valid check.
            owner.invalidate();
            control.snapshot.phase = Phase::Ready;
            control.snapshot_generation = generation;
        }
        assert_eq!(owner.snapshot().phase, Phase::Deferred);
        assert_eq!(owner.snapshot().reason, Some("preparation_cancelled"));
    }

    #[test]
    fn healthy_callback_during_retirement_is_consumed_by_exactly_one_owner() {
        let owner = Coordinator::default();
        assert!(owner.healthy_start());
        // Old run has returned but has not retired. The new healthy callback
        // must not spawn concurrently or disappear when old retirement finishes.
        assert!(!owner.healthy_start());
        assert!(owner.retire(Err(PrepareError::Binding)));
        assert!(owner.started.load(Ordering::Acquire));
        // No further callback: the failed replacement now retires normally.
        assert!(!owner.retire(Err(PrepareError::Binding)));
        assert!(owner.healthy_start());
    }

    #[test]
    fn manual_intent_survives_retirement_while_auto_is_off() {
        let temp = Temp::new();
        let owner = Coordinator::default();
        owner.healthy_start();
        {
            let mut control = owner.control.lock().unwrap();
            control.store = Some(Arc::new(Store::open(&temp.0).unwrap()));
        }
        owner.set_automatic(false).unwrap();
        owner.manual_check().unwrap();
        assert!(owner.retire(Err(PrepareError::Cache)));
        let control = owner.control.lock().unwrap();
        assert!(control.requested);
        assert!(!control.snapshot.automatic);
    }
}
