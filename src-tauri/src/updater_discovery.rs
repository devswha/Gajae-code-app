//! Native preparation only: no persistence, signature verification or installer.
//! The caller owns build/QA-root admission, consent, generation and cancellation.
//! `CompleteObservedScan` means a bounded traversal was subsequently re-observed
//! unchanged, NOT an atomic GitHub snapshot or a promise of globally latest data.

use std::{
    collections::HashSet,
    future::Future,
    pin::Pin,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::Url;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::time::Instant;

use crate::updater_manifest::{parse_manifest, Channel, Manifest, ProductIdentity};
use crate::updater_transport::{fetch_response, Accept, BoundedResponse, HttpsClient};

pub const PAGE_SIZE: usize = 30;
pub const MAX_PAGES_PER_BURST: usize = 3;
pub const DISCOVERY_BURST: Duration = Duration::from_secs(30);
pub const MAX_ARCHIVE_BYTES: u64 = 250 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_PAGE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_REQUESTS: usize = 128;
const MAX_REDIRECTS: usize = 4;
// A memory ceiling, not a successful end-of-history condition. Unlike the burst
// cap this is exceptionally terminal; reaching it always reports an error.
const MAX_SCAN_PAGES: usize = 4096;
const MAX_RETRY_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_DOWNLOAD_TIME: Duration = Duration::from_secs(10 * 60);

/// Error text carries no response body, URL, Location or transient query token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiscoveryError {
    InvalidPolicy,
    UnauthorizedUrl,
    InvalidRelease,
    InvalidManifest,
    IdentityChanged,
    ConflictingVersion,
    ScanChanged,
    ScanLimit,
    Network,
    HttpStatus(u16),
    SizeMismatch,
    RedirectLimit,
    InvalidRetryAfter,
    RetryAfter(Duration),
    Deadline,
    RequestBudget,
    PageBudget,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryPolicy {
    repository: String,
    artifact_prefix: String,
    current_desktop: Version,
    channel: Channel,
    macos_version: [u16; 3],
    qa_origin: Option<Url>,
}

impl DiscoveryPolicy {
    /// Inputs must come from native compiled identity and native OS inspection,
    /// never remote UI/IPC. The caller must admit production mode before I/O.
    pub fn production(
        identity: &ProductIdentity<'_>,
        current_desktop: Version,
        channel: Channel,
        macos_version: &str,
    ) -> Result<Self, DiscoveryError> {
        let parts: Vec<_> = identity.repository.split('/').collect();
        if parts.len() != 2
            || parts.iter().any(|part| !safe_name(part))
            || !safe_name(identity.artifact_prefix)
            || !current_desktop.build.is_empty()
        {
            return Err(DiscoveryError::InvalidPolicy);
        }
        let macos_version = os_version(macos_version)?;
        if macos_version < [13, 0, 0] {
            return Err(DiscoveryError::InvalidPolicy);
        }
        Ok(Self {
            repository: identity.repository.to_owned(),
            artifact_prefix: identity.artifact_prefix.to_owned(),
            current_desktop,
            channel,
            macos_version,
            qa_origin: None,
        })
    }

    /// A local HTTPS fixture origin supplied by the admitted native QA caller.
    /// It must equal the compiled binding; a production/disabled build cannot
    /// opt into QA. The caller still verifies its compiled QA-root/profile/key
    /// binding before constructing its CA-trusting HttpsClient or calling us.
    /// Canonical URLs in release records and manifests are NEVER rewritten.
    pub fn qa(
        identity: &ProductIdentity<'_>,
        current_desktop: Version,
        channel: Channel,
        macos_version: &str,
        local_https_origin: Url,
    ) -> Result<Self, DiscoveryError> {
        let mut policy = Self::production(identity, current_desktop, channel, macos_version)?;
        validate_qa_binding(
            &local_https_origin,
            option_env!("GJC_UPDATE_MODE"),
            option_env!("GJC_UPDATE_FEED_ORIGIN"),
        )?;
        policy.qa_origin = Some(local_https_origin);
        Ok(policy)
    }

    fn identity(&self) -> ProductIdentity<'_> {
        ProductIdentity {
            repository: &self.repository,
            artifact_prefix: &self.artifact_prefix,
        }
    }

    fn api(&self, suffix: &str) -> Url {
        Url::parse(&format!(
            "https://api.github.com/repos/{}/releases{}",
            self.repository, suffix
        ))
        .expect("validated repository and internally generated suffix")
    }

    fn download(&self, tag: &str, name: &str) -> Url {
        Url::parse(&format!(
            "https://github.com/{}/releases/download/{tag}/{name}",
            self.repository
        ))
        .expect("validated tag and artifact name")
    }

    fn wire_url(&self, canonical: &Url) -> Url {
        match &self.qa_origin {
            None => canonical.clone(),
            Some(origin) => {
                let mut url = origin.clone();
                url.set_path(canonical.path());
                url.set_query(canonical.query());
                url
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseIdentity {
    pub id: u64,
    pub tag_name: String,
    pub api_url: Url,
    pub html_url: Url,
    pub prerelease: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetIdentity {
    pub id: u64,
    pub name: String,
    pub size: u64,
    pub api_url: Url,
    pub download_url: Url,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectedRelease {
    pub release: ReleaseIdentity,
    pub manifest_asset: AssetIdentity,
    pub archive_asset: AssetIdentity,
    pub manifest_bytes: Vec<u8>,
    pub manifest: Manifest,
}

/// Immutable identities from a signature-verified cache. This is not install consent.
pub struct PreparedIdentity<'a> {
    pub release_id: u64,
    pub manifest_asset_id: u64,
    pub archive_asset_id: u64,
    pub archive_size: u64,
    pub manifest_bytes: &'a [u8],
}

/// The exact final endpoint native has just validated. It can contain an
/// expiring delivery token, so never serialize, persist or debug-print it.
pub struct CheckedManifest {
    pub selected: SelectedRelease,
    pub endpoint: Url,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IncompleteReason {
    PageBudget,
    TimeBudget,
    RequestBudget,
    RetryAfter,
    ScanChanged,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiscoveryCompleteness {
    Incomplete(IncompleteReason),
    CompleteObservedScan,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryResult {
    pub selected: Option<SelectedRelease>,
    pub completeness: DiscoveryCompleteness,
    pub pages_observed: usize,
    /// Scheduler delay, not a sleep and not permission to create a new attempt.
    pub retry_after: Option<Duration>,
}

/// Ephemeral continuation. Do not serialize it or infer authority from a cache.
/// Reusing it with a different policy starts a fresh scan. A complete cursor
/// starts a new scan on the next call; the caller controls normal scheduling.
#[derive(Default)]
pub struct DiscoveryCursor {
    policy: Option<DiscoveryPolicy>,
    stamps: Vec<[u8; 32]>,
    seen_ids: HashSet<u64>,
    seen_tags: HashSet<String>,
    seen_assets: HashSet<u64>,
    pending: Option<PendingPage>,
    verify_next: Option<usize>,
    complete: bool,
    best: Option<SelectedRelease>,
    not_before: Option<Instant>,
}

struct PendingPage {
    stamp: [u8; 32],
    releases: Vec<ReleaseRecord>,
    next: usize,
}

impl DiscoveryCursor {
    fn reset_scan(&mut self) {
        let not_before = self.not_before;
        let policy = self.policy.take();
        *self = Self {
            policy,
            not_before,
            ..Self::default()
        };
    }

    fn result(
        &self,
        completeness: DiscoveryCompleteness,
        retry_after: Option<Duration>,
    ) -> DiscoveryResult {
        DiscoveryResult {
            selected: self.best.clone(),
            completeness,
            pages_observed: self.stamps.len(),
            retry_after,
        }
    }
}

/// At most three listing-page requests (including revalidation), 30 entries
/// each, 128 total native requests and 30s wall time. Continuations retain
/// progress within a page so slow manifests cannot impose a 90-release cutoff.
pub async fn discover_burst(
    client: &HttpsClient,
    policy: &DiscoveryPolicy,
    cursor: &mut DiscoveryCursor,
) -> Result<DiscoveryResult, DiscoveryError> {
    discover_with(client, policy, cursor, DISCOVERY_BURST).await
}

/// Fetch only the selected, freshly re-bound asset ID. Returns the exact bounded
/// bytes; the caller MUST verify Minisign and signed archive identity next.
/// No plugin download API is involved. Duration is capped at ten minutes, and
/// can be shortened by the caller's own remaining preparation budget.
pub async fn fetch_archive(
    client: &HttpsClient,
    policy: &DiscoveryPolicy,
    selected: &SelectedRelease,
    timeout: Duration,
) -> Result<Vec<u8>, DiscoveryError> {
    fetch_archive_with(client, policy, selected, timeout).await
}

/// Reconstruct only the staged release, not an entire discovery scan. The
/// caller shares its absolute five-second preflight deadline with plugin check.
pub async fn revalidate_prepared(
    client: &HttpsClient,
    policy: &DiscoveryPolicy,
    prepared: PreparedIdentity<'_>,
    deadline: Instant,
) -> Result<CheckedManifest, DiscoveryError> {
    revalidate_prepared_with(client, policy, prepared, deadline).await
}

async fn revalidate_prepared_with(
    transport: &impl Transport,
    policy: &DiscoveryPolicy,
    prepared: PreparedIdentity<'_>,
    deadline: Instant,
) -> Result<CheckedManifest, DiscoveryError> {
    let manifest = parse_manifest(prepared.manifest_bytes, &policy.identity())
        .map_err(|_| DiscoveryError::InvalidManifest)?;
    if prepared.release_id == 0
        || prepared.manifest_asset_id == 0
        || prepared.archive_asset_id == 0
        || prepared.archive_size == 0
        || prepared.archive_size > MAX_ARCHIVE_BYTES
    {
        return Err(DiscoveryError::IdentityChanged);
    }
    let mut budget = Budget {
        deadline,
        requests: 0,
        pages: 0,
    };
    let response = budget
        .fetch(
            transport,
            &policy.wire_url(&policy.api(&format!("/{}", prepared.release_id))),
            Accept::GithubJson,
            MAX_PAGE_BYTES,
        )
        .await?;
    require_ok(&response)?;
    let release: ReleaseRecord =
        serde_json::from_slice(&response.body).map_err(|_| DiscoveryError::InvalidRelease)?;
    let (release, manifest_asset, archive_asset) =
        release_assets(policy, &release)?.ok_or(DiscoveryError::IdentityChanged)?;
    if release.id != prepared.release_id
        || manifest_asset.id != prepared.manifest_asset_id
        || archive_asset.id != prepared.archive_asset_id
        || archive_asset.size != prepared.archive_size
        || manifest_asset.size != prepared.manifest_bytes.len() as u64
    {
        return Err(DiscoveryError::IdentityChanged);
    }
    let selected = SelectedRelease {
        release,
        manifest_asset,
        archive_asset,
        manifest,
        manifest_bytes: prepared.manifest_bytes.to_vec(),
    };
    if !eligible(policy, &selected)? {
        return Err(DiscoveryError::IdentityChanged);
    }
    // Plugin check always requests application/json, even when given a custom
    // Accept header. Start at the canonical public download URL, not GitHub's
    // asset API whose octet-stream and JSON representations can differ.
    let (bytes, endpoint) = fetch_asset_at(
        transport,
        policy,
        &mut budget,
        &selected.manifest_asset,
        policy.wire_url(&selected.manifest_asset.download_url),
    )
    .await?;
    if bytes != prepared.manifest_bytes {
        return Err(DiscoveryError::IdentityChanged);
    }
    Ok(CheckedManifest { selected, endpoint })
}

type FetchFuture<'a> =
    Pin<Box<dyn Future<Output = Result<BoundedResponse, DiscoveryError>> + Send + 'a>>;

trait Transport {
    fn fetch<'a>(&'a self, url: &'a Url, accept: Accept, limit: u64) -> FetchFuture<'a>;
}

impl Transport for HttpsClient {
    fn fetch<'a>(&'a self, url: &'a Url, accept: Accept, limit: u64) -> FetchFuture<'a> {
        Box::pin(async move {
            fetch_response(self, url, accept, limit)
                .await
                .map_err(|_| DiscoveryError::Network)
        })
    }
}

struct Budget {
    deadline: Instant,
    requests: usize,
    pages: usize,
}

impl Budget {
    fn new(duration: Duration) -> Self {
        Self {
            deadline: Instant::now() + duration,
            requests: 0,
            pages: 0,
        }
    }

    async fn fetch(
        &mut self,
        transport: &impl Transport,
        url: &Url,
        accept: Accept,
        limit: u64,
    ) -> Result<BoundedResponse, DiscoveryError> {
        if Instant::now() >= self.deadline {
            return Err(DiscoveryError::Deadline);
        }
        if self.requests == MAX_REQUESTS {
            return Err(DiscoveryError::RequestBudget);
        }
        self.requests += 1;
        let response = tokio::time::timeout_at(self.deadline, transport.fetch(url, accept, limit))
            .await
            .map_err(|_| DiscoveryError::Deadline)??;
        // Keep injection tests honest and defend against future transport edits.
        if response.body.len() as u64 > limit {
            return Err(DiscoveryError::SizeMismatch);
        }
        if let Some(header) = &response.retry_after {
            return Err(DiscoveryError::RetryAfter(retry_after(
                header,
                SystemTime::now(),
            )?));
        }
        if matches!(response.status.as_u16(), 403 | 429 | 503) {
            return Err(DiscoveryError::RetryAfter(Duration::from_secs(60)));
        }
        Ok(response)
    }
}

async fn discover_with(
    transport: &impl Transport,
    policy: &DiscoveryPolicy,
    cursor: &mut DiscoveryCursor,
    duration: Duration,
) -> Result<DiscoveryResult, DiscoveryError> {
    if cursor.policy.as_ref() != Some(policy) || cursor.complete {
        cursor.reset_scan();
        cursor.policy = Some(policy.clone());
    }
    if let Some(delay) = cursor
        .not_before
        .and_then(|until| until.checked_duration_since(Instant::now()))
    {
        return Ok(cursor.result(
            DiscoveryCompleteness::Incomplete(IncompleteReason::RetryAfter),
            Some(delay),
        ));
    }
    cursor.not_before = None;
    let result = scan(transport, policy, cursor, &mut Budget::new(duration)).await;
    let reason = match result {
        Ok(()) => {
            return Ok(cursor.result(DiscoveryCompleteness::CompleteObservedScan, None));
        }
        Err(DiscoveryError::PageBudget) => IncompleteReason::PageBudget,
        Err(DiscoveryError::Deadline) => IncompleteReason::TimeBudget,
        Err(DiscoveryError::RequestBudget) => IncompleteReason::RequestBudget,
        Err(DiscoveryError::RetryAfter(delay)) => {
            cursor.not_before = Some(Instant::now() + delay);
            return Ok(cursor.result(
                DiscoveryCompleteness::Incomplete(IncompleteReason::RetryAfter),
                Some(delay),
            ));
        }
        Err(DiscoveryError::ScanChanged) => {
            cursor.reset_scan();
            IncompleteReason::ScanChanged
        }
        Err(error) => {
            // A malformed eligible record cannot leave an older candidate ready.
            cursor.reset_scan();
            return Err(error);
        }
    };
    Ok(cursor.result(DiscoveryCompleteness::Incomplete(reason), None))
}

async fn scan(
    transport: &impl Transport,
    policy: &DiscoveryPolicy,
    cursor: &mut DiscoveryCursor,
    budget: &mut Budget,
) -> Result<(), DiscoveryError> {
    // Across bursts recheck the head AND the last observed/pending boundary.
    // An interior mutation is also caught by the full verification pass below.
    let mut checks = Vec::new();
    if let Some(stamp) = cursor.stamps.first() {
        checks.push((1, *stamp));
    }
    if let Some(pending) = &cursor.pending {
        checks.push((cursor.stamps.len() + 1, pending.stamp));
    } else if cursor.stamps.len() > 1 {
        checks.push((cursor.stamps.len(), *cursor.stamps.last().unwrap()));
    }
    for (page, stamp) in checks {
        check_page(transport, policy, budget, page, stamp).await?;
    }
    loop {
        if let Some(index) = cursor.verify_next {
            if index == cursor.stamps.len() {
                cursor.complete = true;
                return Ok(());
            }
            check_page(transport, policy, budget, index + 1, cursor.stamps[index]).await?;
            cursor.verify_next = Some(index + 1);
            continue;
        }
        if cursor.pending.is_none() {
            if cursor.stamps.len() == MAX_SCAN_PAGES {
                return Err(DiscoveryError::ScanLimit);
            }
            let (releases, stamp) =
                fetch_page(transport, policy, budget, cursor.stamps.len() + 1).await?;
            for release in &releases {
                if release.id == 0
                    || !cursor.seen_ids.insert(release.id)
                    || !cursor.seen_tags.insert(release.tag_name.clone())
                {
                    return Err(DiscoveryError::ScanChanged);
                }
                for asset in &release.assets {
                    if asset.id == 0 || !cursor.seen_assets.insert(asset.id) {
                        return Err(DiscoveryError::ScanChanged);
                    }
                }
            }
            cursor.pending = Some(PendingPage {
                stamp,
                releases,
                next: 0,
            });
        }
        let pending = cursor.pending.as_mut().unwrap();
        while let Some(release) = pending.releases.get(pending.next) {
            if let Some(candidate) = candidate(transport, policy, budget, release).await? {
                consider(&mut cursor.best, candidate)?;
            }
            pending.next += 1;
        }
        let pending = cursor.pending.take().unwrap();
        cursor.stamps.push(pending.stamp);
        if pending.releases.len() < PAGE_SIZE {
            cursor.verify_next = Some(0);
        }
    }
}

async fn check_page(
    transport: &impl Transport,
    policy: &DiscoveryPolicy,
    budget: &mut Budget,
    page: usize,
    expected: [u8; 32],
) -> Result<(), DiscoveryError> {
    let (_, stamp) = fetch_page(transport, policy, budget, page).await?;
    if stamp != expected {
        return Err(DiscoveryError::ScanChanged);
    }
    Ok(())
}

async fn fetch_page(
    transport: &impl Transport,
    policy: &DiscoveryPolicy,
    budget: &mut Budget,
    page: usize,
) -> Result<(Vec<ReleaseRecord>, [u8; 32]), DiscoveryError> {
    if budget.pages == MAX_PAGES_PER_BURST {
        return Err(DiscoveryError::PageBudget);
    }
    budget.pages += 1;
    let url = policy.wire_url(&policy.api(&format!("?per_page={PAGE_SIZE}&page={page}")));
    // No listing redirects, Link URLs, /latest shortcut or caller-supplied page URL.
    let response = budget
        .fetch(transport, &url, Accept::GithubJson, MAX_PAGE_BYTES)
        .await?;
    require_ok(&response)?;
    let releases: Vec<ReleaseRecord> =
        serde_json::from_slice(&response.body).map_err(|_| DiscoveryError::InvalidRelease)?;
    if releases.len() > PAGE_SIZE {
        return Err(DiscoveryError::InvalidRelease);
    }
    if releases.iter().any(|release| {
        release.tag_name.len() > 129
            || release.assets.len() > 128
            || release.assets.iter().any(|asset| asset.name.len() > 256)
    }) {
        return Err(DiscoveryError::InvalidRelease);
    }
    // GitHub's download_count (and unrelated descriptions) can change because
    // we fetch a manifest. Compare all parsed release/asset identity fields,
    // not volatile/unknown metadata or JSON whitespace/property order.
    let identity_bytes =
        serde_json::to_vec(&releases).map_err(|_| DiscoveryError::InvalidRelease)?;
    Ok((releases, Sha256::digest(&identity_bytes).into()))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ReleaseRecord {
    id: u64,
    tag_name: String,
    draft: bool,
    prerelease: bool,
    url: String,
    html_url: String,
    assets: Vec<AssetRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AssetRecord {
    id: u64,
    name: String,
    size: u64,
    url: String,
    browser_download_url: String,
    state: String,
}

fn release_assets(
    policy: &DiscoveryPolicy,
    release: &ReleaseRecord,
) -> Result<Option<(ReleaseIdentity, AssetIdentity, AssetIdentity)>, DiscoveryError> {
    if release.draft {
        return Ok(None);
    }
    if release.assets.len() > 128 || release.tag_name.len() > 129 {
        return Err(DiscoveryError::InvalidRelease);
    }
    let manifest_assets: Vec<_> = release
        .assets
        .iter()
        .filter(|asset| asset.name == "desktop-update.json")
        .collect();
    if manifest_assets.is_empty() {
        // Pre-updater releases have no desktop manifest, including older tags
        // that do not follow the present product version convention.
        return Ok(None);
    }
    if manifest_assets.len() != 1 {
        return Err(DiscoveryError::InvalidRelease);
    }
    let product = release
        .tag_name
        .strip_prefix('v')
        .ok_or(DiscoveryError::InvalidRelease)?;
    let version = Version::parse(product).map_err(|_| DiscoveryError::InvalidRelease)?;
    if !version.build.is_empty() || version.to_string() != product {
        return Err(DiscoveryError::InvalidRelease);
    }
    let channel = version_channel(&version)?;
    if release.prerelease != (channel == Channel::Beta) {
        return Err(DiscoveryError::InvalidRelease);
    }
    if policy.channel == Channel::Stable && channel == Channel::Beta {
        return Ok(None);
    }
    let expected_api = policy.api(&format!("/{}", release.id));
    let expected_html = format!(
        "https://github.com/{}/releases/tag/{}",
        policy.repository, release.tag_name
    );
    if release.id == 0 || release.url != expected_api.as_str() || release.html_url != expected_html
    {
        return Err(DiscoveryError::InvalidRelease);
    }
    let mut names = HashSet::new();
    let mut ids = HashSet::new();
    if release
        .assets
        .iter()
        .any(|asset| asset.id == 0 || !names.insert(&asset.name) || !ids.insert(asset.id))
    {
        return Err(DiscoveryError::InvalidRelease);
    }
    let archive_name = format!(
        "{}desktop-{product}-macos-arm64.app.tar.gz",
        policy.artifact_prefix
    );
    let archive = release
        .assets
        .iter()
        .find(|asset| asset.name == archive_name)
        .ok_or(DiscoveryError::InvalidRelease)?;
    Ok(Some((
        ReleaseIdentity {
            id: release.id,
            tag_name: release.tag_name.clone(),
            api_url: expected_api,
            html_url: Url::parse(&expected_html).map_err(|_| DiscoveryError::InvalidRelease)?,
            prerelease: release.prerelease,
        },
        asset_identity(policy, release, manifest_assets[0], MAX_MANIFEST_BYTES)?,
        asset_identity(policy, release, archive, MAX_ARCHIVE_BYTES)?,
    )))
}

fn asset_identity(
    policy: &DiscoveryPolicy,
    release: &ReleaseRecord,
    asset: &AssetRecord,
    max_bytes: u64,
) -> Result<AssetIdentity, DiscoveryError> {
    let api_url = policy.api(&format!("/assets/{}", asset.id));
    let download_url = policy.download(&release.tag_name, &asset.name);
    if asset.id == 0
        || asset.size == 0
        || asset.size > max_bytes
        || asset.state != "uploaded"
        || asset.url != api_url.as_str()
        || asset.browser_download_url != download_url.as_str()
    {
        return Err(DiscoveryError::InvalidRelease);
    }
    Ok(AssetIdentity {
        id: asset.id,
        name: asset.name.clone(),
        size: asset.size,
        api_url,
        download_url,
    })
}

async fn candidate(
    transport: &impl Transport,
    policy: &DiscoveryPolicy,
    budget: &mut Budget,
    release: &ReleaseRecord,
) -> Result<Option<SelectedRelease>, DiscoveryError> {
    let Some((release, manifest_asset, archive_asset)) = release_assets(policy, release)? else {
        return Ok(None);
    };
    let bytes = fetch_asset(transport, policy, budget, &manifest_asset).await?;
    let manifest =
        parse_manifest(&bytes, &policy.identity()).map_err(|_| DiscoveryError::InvalidManifest)?;
    let selection = SelectedRelease {
        release,
        manifest_asset,
        archive_asset,
        manifest_bytes: bytes,
        manifest,
    };
    if eligible(policy, &selection)? {
        Ok(Some(selection))
    } else {
        Ok(None)
    }
}

fn eligible(policy: &DiscoveryPolicy, selection: &SelectedRelease) -> Result<bool, DiscoveryError> {
    let manifest = &selection.manifest;
    if selection.release.tag_name != format!("v{}", manifest.product_version)
        || selection.release.prerelease != (manifest.channel == Channel::Beta)
        || manifest.archive_url != selection.archive_asset.download_url
        || version_channel(&manifest.product_version)? != manifest.channel
    {
        return Err(DiscoveryError::InvalidManifest);
    }
    // Fail inconsistent metadata even when its version would not be adopted.
    Ok(
        !(policy.channel == Channel::Stable && manifest.channel == Channel::Beta)
            && manifest
                .version
                .cmp_precedence(&policy.current_desktop)
                .is_gt()
            && manifest
                .version
                .cmp_precedence(&Version::new(0, 2, 3))
                .is_gt()
            && os_version(&manifest.minimum_system_version)? <= policy.macos_version,
    )
}

fn consider(
    best: &mut Option<SelectedRelease>,
    candidate: SelectedRelease,
) -> Result<(), DiscoveryError> {
    if let Some(previous) = best {
        match candidate
            .manifest
            .version
            .cmp_precedence(&previous.manifest.version)
        {
            std::cmp::Ordering::Less => return Ok(()),
            std::cmp::Ordering::Equal if previous == &candidate => return Ok(()),
            std::cmp::Ordering::Equal => return Err(DiscoveryError::ConflictingVersion),
            std::cmp::Ordering::Greater => {}
        }
    }
    *best = Some(candidate);
    Ok(())
}

async fn fetch_archive_with(
    transport: &impl Transport,
    policy: &DiscoveryPolicy,
    selected: &SelectedRelease,
    timeout: Duration,
) -> Result<Vec<u8>, DiscoveryError> {
    // SelectedRelease is a transparent staging contract, not a bearer token.
    // Reparse it and reconstruct all URLs before issuing even one request.
    let manifest = parse_manifest(&selected.manifest_bytes, &policy.identity())
        .map_err(|_| DiscoveryError::InvalidManifest)?;
    if manifest != selected.manifest || !eligible(policy, selected)? {
        return Err(DiscoveryError::IdentityChanged);
    }
    let expected_api = policy.api(&format!("/{}", selected.release.id));
    if selected.release.id == 0 || selected.release.api_url != expected_api {
        return Err(DiscoveryError::IdentityChanged);
    }
    let mut budget = Budget::new(timeout.min(MAX_DOWNLOAD_TIME));
    let response = budget
        .fetch(
            transport,
            &policy.wire_url(&expected_api),
            Accept::GithubJson,
            MAX_PAGE_BYTES,
        )
        .await?;
    require_ok(&response)?;
    let release: ReleaseRecord =
        serde_json::from_slice(&response.body).map_err(|_| DiscoveryError::InvalidRelease)?;
    let Some((identity, manifest_asset, archive_asset)) = release_assets(policy, &release)? else {
        return Err(DiscoveryError::IdentityChanged);
    };
    if identity != selected.release
        || manifest_asset != selected.manifest_asset
        || archive_asset != selected.archive_asset
    {
        return Err(DiscoveryError::IdentityChanged);
    }
    let bytes = fetch_asset(transport, policy, &mut budget, &manifest_asset).await?;
    if bytes != selected.manifest_bytes {
        return Err(DiscoveryError::IdentityChanged);
    }
    fetch_asset(transport, policy, &mut budget, &archive_asset).await
}

async fn fetch_asset(
    transport: &impl Transport,
    policy: &DiscoveryPolicy,
    budget: &mut Budget,
    asset: &AssetIdentity,
) -> Result<Vec<u8>, DiscoveryError> {
    fetch_asset_at(
        transport,
        policy,
        budget,
        asset,
        policy.wire_url(&asset.api_url),
    )
    .await
    .map(|(bytes, _endpoint)| bytes)
}

async fn fetch_asset_at(
    transport: &impl Transport,
    policy: &DiscoveryPolicy,
    budget: &mut Budget,
    asset: &AssetIdentity,
    mut url: Url,
) -> Result<(Vec<u8>, Url), DiscoveryError> {
    let mut visited = HashSet::new();
    for redirects in 0..=MAX_REDIRECTS {
        // URLs with query tokens are ephemeral, not included in any result,
        // state, error or log. Hashing here avoids retaining them for loop checks.
        if !visited.insert(<[u8; 32]>::from(Sha256::digest(url.as_str().as_bytes()))) {
            return Err(DiscoveryError::RedirectLimit);
        }
        let response = budget
            .fetch(transport, &url, Accept::Archive, asset.size)
            .await?;
        if response.status.as_u16() == 200 {
            if response.location.is_some() || response.body.len() as u64 != asset.size {
                return Err(DiscoveryError::SizeMismatch);
            }
            return Ok((response.body, url));
        }
        if !matches!(response.status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            return Err(DiscoveryError::HttpStatus(response.status.as_u16()));
        }
        if redirects == MAX_REDIRECTS {
            return Err(DiscoveryError::RedirectLimit);
        }
        let location = response.location.ok_or(DiscoveryError::UnauthorizedUrl)?;
        url = authorize_redirect(policy, asset, &url, &location)?;
    }
    Err(DiscoveryError::RedirectLimit)
}

fn authorize_redirect(
    policy: &DiscoveryPolicy,
    asset: &AssetIdentity,
    current: &Url,
    location: &str,
) -> Result<Url, DiscoveryError> {
    if location.is_empty()
        || location.len() > 4096
        || location
            .bytes()
            .any(|b| b <= 0x20 || b == 0x7f || b == b'\\')
    {
        return Err(DiscoveryError::UnauthorizedUrl);
    }
    // Absolute, canonical serialization only. Relative and encoded path tricks
    // are unnecessary for GitHub release delivery and are rejected fail-closed.
    let next = Url::parse(location).map_err(|_| DiscoveryError::UnauthorizedUrl)?;
    if !clean_https(&next) || next.as_str() != location {
        return Err(DiscoveryError::UnauthorizedUrl);
    }
    let start = policy.wire_url(&asset.api_url);
    let download = policy.wire_url(&asset.download_url);
    if let Some(origin) = &policy.qa_origin {
        // QA stays on the exact compile-bound loopback origin and asset path.
        // It cannot redirect to production, unrelated fixture paths or tokens.
        if (current != &start && current != &download)
            || next.origin() != origin.origin()
            || next.query().is_some()
            || (next != start && next != download)
        {
            return Err(DiscoveryError::UnauthorizedUrl);
        }
    } else {
        if current != &start && current != &download && !delivery_url(current) {
            return Err(DiscoveryError::UnauthorizedUrl);
        }
        if next == download {
            if current != &start {
                return Err(DiscoveryError::UnauthorizedUrl);
            }
        } else if !delivery_url(&next) {
            return Err(DiscoveryError::UnauthorizedUrl);
        }
    }
    Ok(next)
}

fn delivery_url(url: &Url) -> bool {
    if !clean_https(url)
        || url.port_or_known_default() != Some(443)
        || !matches!(
            url.host_str(),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
        )
    {
        return false;
    }
    let segments: Vec<_> = url.path().split('/').collect();
    segments.len() == 4
        && segments[0].is_empty()
        && matches!(
            segments[1],
            "github-production-release-asset" | "github-production-release-asset-2e65be"
        )
        && !segments[2].is_empty()
        && segments[2].bytes().all(|b| b.is_ascii_digit())
        && !segments[3].is_empty()
        && segments[3]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn clean_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.host_str().is_some()
}

fn validate_qa_binding(
    origin: &Url,
    compiled_mode: Option<&str>,
    compiled_origin: Option<&str>,
) -> Result<(), DiscoveryError> {
    let normalized = compiled_origin.and_then(|text| Url::parse(text).ok());
    if compiled_mode != Some("qa")
        || normalized.as_ref() != Some(origin)
        || !clean_https(origin)
        || origin.host_str() != Some("127.0.0.1")
        || origin.port().is_none()
        || origin.path() != "/"
        || origin.query().is_some()
    {
        return Err(DiscoveryError::InvalidPolicy);
    }
    Ok(())
}

fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn version_channel(version: &Version) -> Result<Channel, DiscoveryError> {
    match version.pre.as_str().split('.').next() {
        Some("") => Ok(Channel::Stable),
        Some("beta") => Ok(Channel::Beta),
        _ => Err(DiscoveryError::InvalidManifest),
    }
}

fn os_version(value: &str) -> Result<[u16; 3], DiscoveryError> {
    let parts: Vec<_> = value.split('.').collect();
    if !(2..=3).contains(&parts.len()) {
        return Err(DiscoveryError::InvalidPolicy);
    }
    let mut version = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty()
            || part.len() > 3
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(DiscoveryError::InvalidPolicy);
        }
        version[i] = part.parse().map_err(|_| DiscoveryError::InvalidPolicy)?;
    }
    Ok(version)
}

fn require_ok(response: &BoundedResponse) -> Result<(), DiscoveryError> {
    if response.status.as_u16() != 200 || response.location.is_some() {
        return Err(DiscoveryError::HttpStatus(response.status.as_u16()));
    }
    Ok(())
}

/// Accept bounded delta-seconds or IMF-fixdate. An out-of-policy long delay is
/// rejected, NOT shortened (which would violate the server's requested delay).
/// Invalid/oversized header text is never reflected into the error.
fn retry_after(value: &str, now: SystemTime) -> Result<Duration, DiscoveryError> {
    if value.is_empty() || value.len() > 128 {
        return Err(DiscoveryError::InvalidRetryAfter);
    }
    let seconds = if value.bytes().all(|b| b.is_ascii_digit()) {
        value
            .parse::<u64>()
            .map_err(|_| DiscoveryError::InvalidRetryAfter)?
    } else {
        let timestamp = http_date(value)?;
        timestamp
            .duration_since(now)
            .unwrap_or_default()
            .as_secs()
            .saturating_add(1)
    };
    if seconds > MAX_RETRY_AFTER.as_secs() {
        return Err(DiscoveryError::InvalidRetryAfter);
    }
    Ok(Duration::from_secs(seconds.max(1)))
}

fn http_date(value: &str) -> Result<SystemTime, DiscoveryError> {
    let b = value.as_bytes();
    if b.len() != 29
        || !value.is_ascii()
        || &b[3..5] != b", "
        || b[7] != b' '
        || b[11] != b' '
        || b[16] != b' '
        || b[19] != b':'
        || b[22] != b':'
        || &b[25..] != b" GMT"
    {
        return Err(DiscoveryError::InvalidRetryAfter);
    }
    let number = |text: &str| -> Result<u64, DiscoveryError> {
        if !text.bytes().all(|b| b.is_ascii_digit()) {
            return Err(DiscoveryError::InvalidRetryAfter);
        }
        text.parse().map_err(|_| DiscoveryError::InvalidRetryAfter)
    };
    let day = number(&value[5..7])?;
    let year = number(&value[12..16])?;
    let hour = number(&value[17..19])?;
    let minute = number(&value[20..22])?;
    let second = number(&value[23..25])?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|name| *name == &value[8..11])
    .ok_or(DiscoveryError::InvalidRetryAfter)?;
    let leap = |y: u64| y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let lengths = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1970..=9999).contains(&year)
        || day == 0
        || day > lengths[month]
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(DiscoveryError::InvalidRetryAfter);
    }
    let days = (1970..year)
        .map(|y| if leap(y) { 366 } else { 365 })
        .sum::<u64>()
        + lengths[..month].iter().sum::<u64>()
        + day
        - 1;
    if ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][(days % 7) as usize] != &value[..3] {
        return Err(DiscoveryError::InvalidRetryAfter);
    }
    Ok(UNIX_EPOCH + Duration::from_secs(days * 86400 + hour * 3600 + minute * 60 + second))
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;
    use serde_json::{json, Value};
    use std::{
        collections::{HashMap, VecDeque},
        sync::Mutex,
    };

    #[derive(Clone)]
    struct Reply {
        status: u16,
        body: Vec<u8>,
        location: Option<String>,
        retry_after: Option<String>,
    }

    impl Reply {
        fn ok(body: impl Into<Vec<u8>>) -> Self {
            Self {
                status: 200,
                body: body.into(),
                location: None,
                retry_after: None,
            }
        }

        fn redirect(location: &str) -> Self {
            Self {
                status: 302,
                body: vec![],
                location: Some(location.into()),
                retry_after: None,
            }
        }
    }

    #[derive(Default)]
    struct FakeState {
        routes: HashMap<String, VecDeque<Reply>>,
        calls: Vec<String>,
    }

    #[derive(Default)]
    struct Fake(Mutex<FakeState>);

    impl Fake {
        fn set(&self, url: &Url, reply: Reply) {
            self.0
                .lock()
                .unwrap()
                .routes
                .insert(url.to_string(), VecDeque::from([reply]));
        }

        fn calls(&self) -> Vec<String> {
            self.0.lock().unwrap().calls.clone()
        }

        fn page(&self, policy: &DiscoveryPolicy, page: usize, values: Value) {
            let url = policy.wire_url(&policy.api(&format!("?per_page=30&page={page}")));
            self.set(&url, Reply::ok(serde_json::to_vec(&values).unwrap()));
        }

        fn release(&self, policy: &DiscoveryPolicy, value: &Value, bytes: &[u8]) {
            let record: ReleaseRecord = serde_json::from_value(value.clone()).unwrap();
            self.set(
                &policy.wire_url(&policy.api(&format!("/{}", record.id))),
                Reply::ok(serde_json::to_vec(value).unwrap()),
            );
            let (_, manifest, _) = release_assets(policy, &record).unwrap().unwrap();
            self.set(
                &policy.wire_url(&manifest.api_url),
                Reply::ok(bytes.to_vec()),
            );
        }
    }

    impl Transport for Fake {
        fn fetch<'a>(&'a self, url: &'a Url, _: Accept, _: u64) -> FetchFuture<'a> {
            Box::pin(async move {
                let mut state = self.0.lock().unwrap();
                state.calls.push(url.to_string());
                let replies = state
                    .routes
                    .get_mut(url.as_str())
                    .expect("missing injected route; no network fallback");
                let reply = if replies.len() > 1 {
                    replies.pop_front().unwrap()
                } else {
                    replies.front().unwrap().clone()
                };
                Ok(BoundedResponse {
                    status: StatusCode::from_u16(reply.status).unwrap(),
                    body: reply.body,
                    location: reply.location,
                    retry_after: reply.retry_after,
                })
            })
        }
    }

    fn policy(channel: Channel) -> DiscoveryPolicy {
        DiscoveryPolicy::production(
            &ProductIdentity {
                repository: "devswha/gajae-code-app",
                artifact_prefix: "gajae-app-",
            },
            Version::new(0, 2, 3),
            channel,
            "13.6.1",
        )
        .unwrap()
    }

    fn release(
        policy: &DiscoveryPolicy,
        id: u64,
        product: &str,
        desktop: &str,
        os: &str,
    ) -> (Value, Vec<u8>) {
        let mut manifest: Value = serde_json::from_str(include_str!(
            "../../shared/fixtures/desktop-update-manifest.json"
        ))
        .unwrap();
        let tag = format!("v{product}");
        let name = format!(
            "{}desktop-{product}-macos-arm64.app.tar.gz",
            policy.artifact_prefix
        );
        let beta = !Version::parse(product).unwrap().pre.is_empty();
        manifest["version"] = json!(desktop);
        manifest["productVersion"] = json!(product);
        manifest["channel"] = json!(if beta { "beta" } else { "stable" });
        manifest["minimumSystemVersion"] = json!(os);
        manifest["platforms"]["darwin-aarch64"]["url"] =
            json!(policy.download(&tag, &name).as_str());
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let asset = |asset_id: u64, name: &str, size: u64| {
            json!({
                "id": asset_id, "name": name, "size": size, "state": "uploaded",
                "url": policy.api(&format!("/assets/{asset_id}")).as_str(),
                "browser_download_url": policy.download(&tag, name).as_str(),
            })
        };
        (
            json!({
                "id": id, "tag_name": tag, "draft": false, "prerelease": beta,
                "url": policy.api(&format!("/{id}")).as_str(),
                "html_url": format!("https://github.com/{}/releases/tag/{tag}", policy.repository),
                "assets": [asset(id * 10 + 1, "desktop-update.json", bytes.len() as u64), asset(id * 10 + 2, &name, 4)],
            }),
            bytes,
        )
    }

    fn old_page(policy: &DiscoveryPolicy, start: u64, count: usize) -> Value {
        Value::Array((start..start + count as u64).map(|id| json!({
            "id": id, "tag_name": format!("legacy-{id}"), "draft": false, "prerelease": false,
            "url": policy.api(&format!("/{id}")).as_str(),
            "html_url": format!("https://github.com/{}/releases/tag/legacy-{id}", policy.repository),
            "assets": [],
        })).collect())
    }

    fn burst(
        fake: &Fake,
        policy: &DiscoveryPolicy,
        cursor: &mut DiscoveryCursor,
    ) -> DiscoveryResult {
        tauri::async_runtime::block_on(discover_with(fake, policy, cursor, DISCOVERY_BURST))
            .unwrap()
    }

    fn complete(
        fake: &Fake,
        policy: &DiscoveryPolicy,
        cursor: &mut DiscoveryCursor,
    ) -> DiscoveryResult {
        for _ in 0..30 {
            let before = fake.calls().len();
            let result = burst(fake, policy, cursor);
            let calls = fake.calls();
            assert!(
                calls[before..]
                    .iter()
                    .filter(|url| url.contains("?per_page="))
                    .count()
                    <= 3
            );
            if result.completeness == DiscoveryCompleteness::CompleteObservedScan {
                return result;
            }
        }
        panic!("injected finite scan did not complete")
    }

    fn prepared<'a>(release: &Value, bytes: &'a [u8]) -> PreparedIdentity<'a> {
        let id = release["id"].as_u64().unwrap();
        PreparedIdentity {
            release_id: id,
            manifest_asset_id: id * 10 + 1,
            archive_asset_id: id * 10 + 2,
            archive_size: 4,
            manifest_bytes: bytes,
        }
    }

    #[test]
    fn reconstruction_revalidates_ids_and_returns_only_the_final_delivery_endpoint() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        let (release, bytes) = release(&policy, 7, "2.0.0-beta.11", "0.2.5", "13.0");
        fake.release(&policy, &release, &bytes);
        let public = policy.download("v2.0.0-beta.11", "desktop-update.json");
        let delivery: Url = "https://release-assets.githubusercontent.com/github-production-release-asset/123/abcdef?token=ephemeral".parse().unwrap();
        fake.set(&public, Reply::redirect(delivery.as_str()));
        fake.set(&delivery, Reply::ok(bytes.clone()));
        let checked = tauri::async_runtime::block_on(revalidate_prepared_with(
            &fake,
            &policy,
            prepared(&release, &bytes),
            Instant::now() + Duration::from_secs(5),
        ))
        .unwrap();
        assert_eq!(checked.endpoint, delivery);
        assert_eq!(checked.selected.manifest_bytes, bytes);
        assert_eq!(fake.calls().len(), 3);
        assert_eq!(fake.calls()[1], public.as_str());
        assert!(fake
            .calls()
            .iter()
            .all(|url| !url.contains("per_page") && !url.ends_with("tar.gz")));
    }

    #[test]
    fn reconstruction_refuses_replaced_assets_metadata_and_download_redirects() {
        for alteration in [
            "manifest-id",
            "archive-id",
            "archive-size",
            "bytes",
            "redirect",
        ] {
            let policy = policy(Channel::Beta);
            let fake = Fake::default();
            let (release, bytes) = release(&policy, 3, "2.0.0-beta.11", "0.2.5", "13.0");
            fake.release(&policy, &release, &bytes);
            let public = policy.download("v2.0.0-beta.11", "desktop-update.json");
            let mut source = prepared(&release, &bytes);
            match alteration {
                "manifest-id" => source.manifest_asset_id += 9,
                "archive-id" => source.archive_asset_id += 9,
                "archive-size" => source.archive_size += 1,
                "bytes" => {
                    let mut altered = bytes.clone();
                    let i = altered.iter().position(|byte| *byte == b'2').unwrap();
                    altered[i] = b'3';
                    fake.set(&public, Reply::ok(altered));
                }
                "redirect" => {
                    fake.set(&public, Reply::redirect("https://evil.invalid/update.json"))
                }
                _ => unreachable!(),
            }
            assert!(
                tauri::async_runtime::block_on(revalidate_prepared_with(
                    &fake,
                    &policy,
                    source,
                    Instant::now() + Duration::from_secs(5)
                ))
                .is_err(),
                "{alteration}"
            );
            assert!(fake.calls().len() <= 2);
        }
    }

    #[test]
    fn expired_reconstruction_budget_and_invalid_cache_issue_no_requests() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        let (release, bytes) = release(&policy, 3, "2.0.0-beta.11", "0.2.5", "13.0");
        let result = tauri::async_runtime::block_on(revalidate_prepared_with(
            &fake,
            &policy,
            prepared(&release, &bytes),
            Instant::now(),
        ));
        assert!(matches!(result, Err(DiscoveryError::Deadline)));
        let mut invalid = prepared(&release, &bytes);
        invalid.archive_asset_id = 0;
        assert!(tauri::async_runtime::block_on(revalidate_prepared_with(
            &fake,
            &policy,
            invalid,
            Instant::now() + Duration::from_secs(5)
        ))
        .is_err());
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn maximum_desktop_not_product_or_release_order_and_exact_identity() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        let (newer_product, first_bytes) = release(&policy, 1, "2.0.0-beta.11", "0.2.4", "13.0");
        let (backfill, maximum_bytes) = release(&policy, 2, "2.0.0-beta.10", "0.3.0", "13.0");
        fake.release(&policy, &newer_product, &first_bytes);
        fake.release(&policy, &backfill, &maximum_bytes);
        fake.page(&policy, 1, json!([newer_product, backfill]));
        let result = complete(&fake, &policy, &mut DiscoveryCursor::default());
        let selected = result.selected.unwrap();
        assert_eq!(selected.release.id, 2);
        assert_eq!(selected.manifest_asset.id, 21);
        assert_eq!(selected.archive_asset.id, 22);
        assert_eq!(selected.archive_asset.size, 4);
        assert_eq!(selected.release.tag_name, "v2.0.0-beta.10");
        assert_eq!(selected.manifest_bytes, maximum_bytes);
        assert_eq!(selected.manifest.version, Version::new(0, 3, 0));
        assert_eq!(
            selected.manifest_asset.download_url,
            policy.download("v2.0.0-beta.10", "desktop-update.json")
        );
    }

    #[test]
    fn channel_floor_current_and_os_policies() {
        for (channel, product, desktop, os, accepted) in [
            (Channel::Beta, "2.0.0", "0.2.4", "13.0", true),
            (Channel::Beta, "2.0.0-beta.10", "0.2.4", "13.0", true),
            (Channel::Stable, "2.0.0-beta.10", "0.2.4", "13.0", false),
            (Channel::Stable, "2.0.0", "0.2.4", "13.6.1", true),
            (Channel::Beta, "2.0.0", "0.2.3", "13.0", false),
            (Channel::Beta, "2.0.0", "0.2.2", "13.0", false),
            (Channel::Beta, "2.0.0", "0.2.4", "13.6.2", false),
            (Channel::Beta, "2.0.0", "0.2.4", "14.0", false),
        ] {
            let policy = policy(channel);
            let fake = Fake::default();
            let (record, bytes) = release(&policy, 1, product, desktop, os);
            if !(channel == Channel::Stable && product.contains("beta")) {
                fake.release(&policy, &record, &bytes);
            }
            fake.page(&policy, 1, json!([record]));
            let result = complete(&fake, &policy, &mut DiscoveryCursor::default());
            assert_eq!(
                result.selected.is_some(),
                accepted,
                "{channel:?} {product} {desktop} {os}"
            );
        }
        let mut policy = policy(Channel::Beta);
        let fake = Fake::default();
        policy.current_desktop = Version::new(0, 1, 0);
        let (record, bytes) = release(&policy, 1, "2.0.0", "0.2.3", "13.0");
        fake.release(&policy, &record, &bytes);
        fake.page(&policy, 1, json!([record]));
        assert!(complete(&fake, &policy, &mut DiscoveryCursor::default())
            .selected
            .is_none());
        policy.current_desktop = Version::new(0, 9, 0);
        assert!(complete(&fake, &policy, &mut DiscoveryCursor::default())
            .selected
            .is_none());
    }

    #[test]
    fn resumes_beyond_ninety_and_never_calls_partial_scan_latest() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        for page in 1..=3 {
            fake.page(&policy, page, old_page(&policy, page as u64 * 30, 30));
        }
        let (record, bytes) = release(&policy, 999, "2.0.0-beta.10", "0.3.0", "13.0");
        fake.release(&policy, &record, &bytes);
        fake.page(&policy, 4, json!([record]));
        let mut cursor = DiscoveryCursor::default();
        let first = burst(&fake, &policy, &mut cursor);
        assert_eq!(first.pages_observed, 3);
        assert_eq!(
            first.completeness,
            DiscoveryCompleteness::Incomplete(IncompleteReason::PageBudget)
        );
        assert!(first.selected.is_none());
        let second = burst(&fake, &policy, &mut cursor);
        assert_eq!(second.selected.unwrap().release.id, 999);
        assert!(matches!(
            second.completeness,
            DiscoveryCompleteness::Incomplete(_)
        ));
        let result = complete(&fake, &policy, &mut cursor);
        assert_eq!(result.pages_observed, 4);
        assert_eq!(result.selected.unwrap().release.id, 999);
        assert!(fake.calls().iter().all(|url| !url.contains("/latest")));
    }

    #[test]
    fn changed_head_boundary_or_interior_invalidates_scan_and_candidate() {
        for changed_page in [1, 2, 3] {
            let policy = policy(Channel::Beta);
            let fake = Fake::default();
            for page in 1..=3 {
                fake.page(&policy, page, old_page(&policy, page as u64 * 30, 30));
            }
            fake.page(&policy, 4, json!([]));
            let mut cursor = DiscoveryCursor::default();
            burst(&fake, &policy, &mut cursor);
            fake.page(&policy, changed_page, old_page(&policy, 900, 30));
            let mut changed = false;
            for _ in 0..10 {
                let result = burst(&fake, &policy, &mut cursor);
                if result.completeness
                    == DiscoveryCompleteness::Incomplete(IncompleteReason::ScanChanged)
                {
                    assert_eq!(result.pages_observed, 0);
                    assert!(result.selected.is_none());
                    changed = true;
                    break;
                }
                assert_ne!(
                    result.completeness,
                    DiscoveryCompleteness::CompleteObservedScan
                );
            }
            assert!(changed);
        }
    }

    #[test]
    fn identity_stamps_ignore_download_counters_but_detect_asset_changes() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        let (record, bytes) = release(&policy, 1, "2.0.0-beta.10", "0.2.4", "13.0");
        fake.release(&policy, &record, &bytes);
        let mut first = old_page(&policy, 2, 29);
        first.as_array_mut().unwrap().push(record);
        fake.page(&policy, 1, first.clone());
        fake.page(&policy, 2, old_page(&policy, 31, 30));
        fake.page(&policy, 3, old_page(&policy, 61, 30));
        fake.page(&policy, 4, json!([]));
        let mut cursor = DiscoveryCursor::default();
        burst(&fake, &policy, &mut cursor);
        first[29]["assets"][0]["download_count"] = json!(99999);
        first[29]["body"] = json!("An unrelated release description changed.");
        fake.page(&policy, 1, first.clone());
        let result = complete(&fake, &policy, &mut cursor);
        assert_eq!(result.selected.unwrap().release.id, 1);

        cursor = DiscoveryCursor::default();
        burst(&fake, &policy, &mut cursor);
        first[29]["assets"][0]["size"] = json!(bytes.len() + 1);
        fake.page(&policy, 1, first);
        let result = burst(&fake, &policy, &mut cursor);
        assert_eq!(
            result.completeness,
            DiscoveryCompleteness::Incomplete(IncompleteReason::ScanChanged)
        );
        assert!(result.selected.is_none());
    }

    #[test]
    fn duplicate_boundary_release_and_policy_change_cannot_certify_completion() {
        let mut policy = policy(Channel::Beta);
        let fake = Fake::default();
        fake.page(&policy, 1, old_page(&policy, 1, 30));
        fake.page(&policy, 2, old_page(&policy, 30, 1));
        let mut cursor = DiscoveryCursor::default();
        let result = burst(&fake, &policy, &mut cursor);
        assert_eq!(
            result.completeness,
            DiscoveryCompleteness::Incomplete(IncompleteReason::ScanChanged)
        );
        assert!(cursor.seen_ids.is_empty());
        fake.page(&policy, 1, old_page(&policy, 1, 0));
        policy.channel = Channel::Stable;
        let result = burst(&fake, &policy, &mut cursor);
        assert_eq!(
            result.completeness,
            DiscoveryCompleteness::CompleteObservedScan
        );
        assert_eq!(cursor.policy, Some(policy));
    }

    #[test]
    fn malformed_eligible_metadata_is_not_silently_skipped() {
        let policy = policy(Channel::Beta);
        for mutate in 0..9 {
            let fake = Fake::default();
            let (mut record, bytes) = release(&policy, 1, "2.0.0-beta.10", "0.2.4", "13.0");
            match mutate {
                0 => record["url"] = json!("https://api.github.com/repos/foreign/repo/releases/1"),
                1 => {
                    record["assets"][0]["browser_download_url"] =
                        json!("https://example.com/desktop-update.json")
                }
                2 => record["assets"][1]["size"] = json!(MAX_ARCHIVE_BYTES + 1),
                3 => record["assets"][1]["name"] = json!("wrong-archive.app.tar.gz"),
                4 => record["prerelease"] = json!(false),
                5 => record["assets"][0]["size"] = json!(0),
                6 => {
                    record["assets"].as_array_mut().unwrap().pop();
                }
                7 => record["assets"][1]["state"] = json!("new"),
                _ => {
                    fake.set(
                        &policy.api("/assets/11"),
                        Reply::ok(vec![b'x'; bytes.len()]),
                    );
                }
            }
            fake.page(&policy, 1, json!([record]));
            let mut cursor = DiscoveryCursor::default();
            assert!(tauri::async_runtime::block_on(discover_with(
                &fake,
                &policy,
                &mut cursor,
                DISCOVERY_BURST
            ))
            .is_err());
            assert!(cursor.best.is_none());
        }
    }

    #[test]
    fn manifest_tag_and_archive_crosschecks_fail_even_when_old_or_os_ineligible() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        let (record, _) = release(&policy, 1, "2.0.0-beta.10", "0.2.4", "13.0");
        let (_, mismatched_bytes) = release(&policy, 2, "2.0.0-beta.11", "0.2.2", "99.0");
        let mut record = record;
        record["assets"][0]["size"] = json!(mismatched_bytes.len());
        fake.release(&policy, &record, &mismatched_bytes);
        fake.page(&policy, 1, json!([record]));
        assert_eq!(
            tauri::async_runtime::block_on(discover_with(
                &fake,
                &policy,
                &mut DiscoveryCursor::default(),
                DISCOVERY_BURST
            )),
            Err(DiscoveryError::InvalidManifest)
        );
    }

    #[test]
    fn equal_desktop_versions_with_distinct_identities_fail_closed() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        let (one, bytes_one) = release(&policy, 1, "2.0.0-beta.10", "0.2.4", "13.0");
        let (two, bytes_two) = release(&policy, 2, "2.0.0-beta.11", "0.2.4", "13.0");
        fake.release(&policy, &one, &bytes_one);
        fake.release(&policy, &two, &bytes_two);
        fake.page(&policy, 1, json!([one, two]));
        assert_eq!(
            tauri::async_runtime::block_on(discover_with(
                &fake,
                &policy,
                &mut DiscoveryCursor::default(),
                DISCOVERY_BURST
            )),
            Err(DiscoveryError::ConflictingVersion)
        );
    }

    #[test]
    fn retry_after_is_bounded_honored_without_sleep_and_preserves_pending_position() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        let (record, bytes) = release(&policy, 1, "2.0.0-beta.10", "0.2.4", "13.0");
        fake.page(&policy, 1, json!([record]));
        let mut reply = Reply::ok(vec![]);
        reply.status = 429;
        reply.retry_after = Some("120".into());
        fake.set(&policy.api("/assets/11"), reply);
        let mut cursor = DiscoveryCursor::default();
        let result = burst(&fake, &policy, &mut cursor);
        assert_eq!(result.retry_after, Some(Duration::from_secs(120)));
        assert_eq!(cursor.pending.as_ref().unwrap().next, 0);
        let calls = fake.calls().len();
        burst(&fake, &policy, &mut cursor);
        assert_eq!(fake.calls().len(), calls);
        cursor.not_before = None; // advance scheduler in the fixture, never sleep
        fake.set(&policy.api("/assets/11"), Reply::ok(bytes));
        let result = complete(&fake, &policy, &mut cursor);
        assert!(result.selected.is_some());
        let now = http_date("Mon, 07 Sep 2026 00:00:00 GMT").unwrap();
        assert_eq!(
            retry_after("Mon, 07 Sep 2026 00:02:00 GMT", now),
            Ok(Duration::from_secs(121))
        );
        assert_eq!(retry_after("0", now), Ok(Duration::from_secs(1)));
        for invalid in [
            "86401",
            "-1",
            "1.5",
            "18446744073709551616",
            "not-a-date",
            "Tue, 07 Sep 2026 00:02:00 GMT",
            "Mon, 31 Feb 2026 00:00:00 GMT",
        ] {
            assert_eq!(
                retry_after(invalid, now),
                Err(DiscoveryError::InvalidRetryAfter)
            );
        }
    }

    #[test]
    fn interrupted_manifest_page_resumes_without_restarting_completed_assets() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        let (one, bytes_one) = release(&policy, 1, "2.0.0-beta.10", "0.2.4", "13.0");
        let (two, bytes_two) = release(&policy, 2, "2.0.0-beta.11", "0.2.5", "13.0");
        fake.release(&policy, &one, &bytes_one);
        fake.release(&policy, &two, &bytes_two);
        fake.page(&policy, 1, json!([one, two]));
        fake.set(
            &policy.api("/assets/21"),
            Reply {
                status: 503,
                body: vec![],
                location: None,
                retry_after: Some("10".into()),
            },
        );
        let mut cursor = DiscoveryCursor::default();
        let result = burst(&fake, &policy, &mut cursor);
        assert_eq!(cursor.pending.as_ref().unwrap().next, 1);
        assert_eq!(result.selected.unwrap().release.id, 1);
        assert_eq!(result.retry_after, Some(Duration::from_secs(10)));
        cursor.not_before = None;
        fake.set(&policy.api("/assets/21"), Reply::ok(bytes_two));
        let result = complete(&fake, &policy, &mut cursor);
        assert_eq!(result.selected.unwrap().release.id, 2);
        assert_eq!(
            fake.calls()
                .iter()
                .filter(|url| url.ends_with("/assets/11"))
                .count(),
            1
        );
    }

    #[test]
    fn pending_transport_and_total_request_count_are_bounded() {
        struct Pending;
        impl Transport for Pending {
            fn fetch<'a>(&'a self, _: &'a Url, _: Accept, _: u64) -> FetchFuture<'a> {
                Box::pin(std::future::pending())
            }
        }
        let policy = policy(Channel::Beta);
        let start = std::time::Instant::now();
        let result = tauri::async_runtime::block_on(discover_with(
            &Pending,
            &policy,
            &mut DiscoveryCursor::default(),
            Duration::from_millis(5),
        ))
        .unwrap();
        assert_eq!(
            result.completeness,
            DiscoveryCompleteness::Incomplete(IncompleteReason::TimeBudget)
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        let fake = Fake::default();
        let url = policy.api("/assets/11");
        fake.set(&url, Reply::ok(b"data".to_vec()));
        tauri::async_runtime::block_on(async {
            let mut budget = Budget::new(DISCOVERY_BURST);
            budget.requests = MAX_REQUESTS - 1;
            budget.fetch(&fake, &url, Accept::Archive, 4).await.unwrap();
            assert!(matches!(
                budget.fetch(&fake, &url, Accept::Archive, 4).await,
                Err(DiscoveryError::RequestBudget)
            ));
        });
        assert_eq!(fake.calls().len(), 1);
    }

    #[test]
    fn listing_redirects_duplicate_json_keys_and_identity_limits_fail_closed() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        let url = policy.api("?per_page=30&page=1");
        fake.set(
            &url,
            Reply::redirect("https://api.github.com/repos/foreign/repo/releases"),
        );
        assert_eq!(
            tauri::async_runtime::block_on(discover_with(
                &fake,
                &policy,
                &mut DiscoveryCursor::default(),
                DISCOVERY_BURST
            )),
            Err(DiscoveryError::HttpStatus(302))
        );
        let json = format!(
            "[{{\"id\":1,{}]",
            &serde_json::to_string(&old_page(&policy, 1, 1)[0]).unwrap()[1..]
        );
        fake.set(&url, Reply::ok(json.into_bytes()));
        assert_eq!(
            tauri::async_runtime::block_on(discover_with(
                &fake,
                &policy,
                &mut DiscoveryCursor::default(),
                DISCOVERY_BURST
            )),
            Err(DiscoveryError::InvalidRelease)
        );
        let mut oversized = old_page(&policy, 1, 1);
        oversized[0]["tag_name"] = json!("v".repeat(130));
        fake.page(&policy, 1, oversized);
        assert_eq!(
            tauri::async_runtime::block_on(discover_with(
                &fake,
                &policy,
                &mut DiscoveryCursor::default(),
                DISCOVERY_BURST
            )),
            Err(DiscoveryError::InvalidRelease)
        );
    }

    #[test]
    fn zero_deadline_and_page_body_caps_are_explicit() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        let result = tauri::async_runtime::block_on(discover_with(
            &fake,
            &policy,
            &mut DiscoveryCursor::default(),
            Duration::ZERO,
        ))
        .unwrap();
        assert_eq!(
            result.completeness,
            DiscoveryCompleteness::Incomplete(IncompleteReason::TimeBudget)
        );
        assert!(fake.calls().is_empty());
        fake.page(&policy, 1, old_page(&policy, 1, 31));
        assert_eq!(
            tauri::async_runtime::block_on(discover_with(
                &fake,
                &policy,
                &mut DiscoveryCursor::default(),
                DISCOVERY_BURST
            )),
            Err(DiscoveryError::InvalidRelease)
        );
        fake.set(
            &policy.api("?per_page=30&page=1"),
            Reply::ok(vec![b' '; MAX_PAGE_BYTES as usize + 1]),
        );
        assert_eq!(
            tauri::async_runtime::block_on(discover_with(
                &fake,
                &policy,
                &mut DiscoveryCursor::default(),
                DISCOVERY_BURST
            )),
            Err(DiscoveryError::SizeMismatch)
        );
    }

    #[test]
    fn canonical_redirects_allow_only_bound_asset_then_release_delivery() {
        let policy = policy(Channel::Beta);
        let (record, _) = release(&policy, 1, "2.0.0-beta.10", "0.2.4", "13.0");
        let record: ReleaseRecord = serde_json::from_value(record).unwrap();
        let (_, asset, _) = release_assets(&policy, &record).unwrap().unwrap();
        assert_eq!(
            authorize_redirect(&policy, &asset, &asset.api_url, asset.download_url.as_str()),
            Ok(asset.download_url.clone())
        );
        for host in [
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
        ] {
            let location = format!("https://{host}/github-production-release-asset-2e65be/123/abc-456?token=TOKEN_SENTINEL");
            let allowed =
                authorize_redirect(&policy, &asset, &asset.download_url, &location).unwrap();
            assert_eq!(allowed.query(), Some("token=TOKEN_SENTINEL"));
        }
        for bad in [
            "http://release-assets.githubusercontent.com/github-production-release-asset/123/abc",
            "https://secret@release-assets.githubusercontent.com/github-production-release-asset/123/abc",
            "https://release-assets.githubusercontent.com.evil.test/github-production-release-asset/123/abc",
            "https://github.com/foreign/repo/releases/download/v2.0.0-beta.10/desktop-update.json",
            "https://api.github.com/repos/devswha/gajae-code-app/releases/assets/99",
            "https://release-assets.githubusercontent.com:8443/github-production-release-asset/123/abc",
            "https://release-assets.githubusercontent.com/arbitrary?token=TOKEN_SENTINEL",
            "https://raw.githubusercontent.com/github-production-release-asset/123/abc",
            "https://objects.githubusercontent.com/github-production-release-asset/123/abc#fragment",
            "https://objects.githubusercontent.com/github-production-release-asset/123/%61bc",
            "/relative", " https://objects.githubusercontent.com/github-production-release-asset/123/abc",
        ] {
            let error = authorize_redirect(&policy, &asset, &asset.api_url, bad).unwrap_err();
            assert_eq!(error, DiscoveryError::UnauthorizedUrl);
            assert!(!format!("{error:?}").contains("TOKEN_SENTINEL"));
        }
        let token_on_canonical = format!("{}?token=TOKEN_SENTINEL", asset.download_url);
        assert!(authorize_redirect(&policy, &asset, &asset.api_url, &token_on_canonical).is_err());
        let foreign = Url::parse("https://evil.test/").unwrap();
        assert!(
            authorize_redirect(&policy, &asset, &foreign, asset.download_url.as_str()).is_err()
        );
    }

    #[test]
    fn qa_requires_compile_binding_and_cannot_escape_local_policy() {
        let origin = Url::parse("https://127.0.0.1:9443/").unwrap();
        assert!(validate_qa_binding(&origin, Some("qa"), Some("https://127.0.0.1:9443")).is_ok());
        for mode in [None, Some("disabled"), Some("production")] {
            assert!(validate_qa_binding(&origin, mode, Some(origin.as_str())).is_err());
        }
        assert!(validate_qa_binding(&origin, Some("qa"), Some("https://127.0.0.1:9444/")).is_err());
        for bad in [
            "http://127.0.0.1:9443/",
            "https://localhost:9443/",
            "https://127.0.0.1:9443/path",
            "https://user@127.0.0.1:9443/",
            "https://api.github.com/",
        ] {
            assert!(validate_qa_binding(&Url::parse(bad).unwrap(), Some("qa"), Some(bad)).is_err());
        }
        let mut policy = policy(Channel::Beta);
        policy.qa_origin = Some(origin);
        let (record, bytes) = release(&policy, 1, "2.0.0-beta.10", "0.2.4", "13.0");
        let fake = Fake::default();
        fake.release(&policy, &record, &bytes);
        fake.page(&policy, 1, json!([record]));
        let selected = complete(&fake, &policy, &mut DiscoveryCursor::default())
            .selected
            .unwrap();
        assert_eq!(selected.manifest.archive_url.host_str(), Some("github.com"));
        assert!(fake
            .calls()
            .iter()
            .all(|url| url.starts_with("https://127.0.0.1:9443/")));
        let asset = &selected.manifest_asset;
        let start = policy.wire_url(&asset.api_url);
        let download = policy.wire_url(&asset.download_url);
        assert!(authorize_redirect(&policy, asset, &start, download.as_str()).is_ok());
        for bad in [
            asset.download_url.to_string(),
            "https://127.0.0.1:9443/unrelated".into(),
            format!("{download}?token=secret"),
        ] {
            assert!(authorize_redirect(&policy, asset, &start, &bad).is_err());
        }
    }

    #[test]
    fn archive_rebinds_release_and_manifest_then_fetches_exact_asset_bytes() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        let (record, bytes) = release(&policy, 1, "2.0.0-beta.10", "0.2.4", "13.0");
        fake.release(&policy, &record, &bytes);
        fake.page(&policy, 1, json!([record]));
        let selected = complete(&fake, &policy, &mut DiscoveryCursor::default())
            .selected
            .unwrap();
        let delivery = "https://release-assets.githubusercontent.com/github-production-release-asset/123/abc?token=TOKEN_SENTINEL";
        fake.set(&selected.archive_asset.api_url, Reply::redirect(delivery));
        fake.set(&Url::parse(delivery).unwrap(), Reply::ok(b"data".to_vec()));
        let fetched = tauri::async_runtime::block_on(fetch_archive_with(
            &fake,
            &policy,
            &selected,
            DISCOVERY_BURST,
        ))
        .unwrap();
        assert_eq!(fetched, b"data");
        fake.set(&Url::parse(delivery).unwrap(), Reply::ok(b"data!".to_vec()));
        assert_eq!(
            tauri::async_runtime::block_on(fetch_archive_with(
                &fake,
                &policy,
                &selected,
                DISCOVERY_BURST
            )),
            Err(DiscoveryError::SizeMismatch)
        );
        let mut changed = record.clone();
        changed["assets"][1]["id"] = json!(999);
        changed["assets"][1]["url"] = json!(policy.api("/assets/999").as_str());
        fake.set(
            &selected.release.api_url,
            Reply::ok(serde_json::to_vec(&changed).unwrap()),
        );
        assert_eq!(
            tauri::async_runtime::block_on(fetch_archive_with(
                &fake,
                &policy,
                &selected,
                DISCOVERY_BURST
            )),
            Err(DiscoveryError::IdentityChanged)
        );
        fake.release(&policy, &record, &bytes);
        let mut changed_bytes = bytes;
        let index = changed_bytes.iter().position(|byte| *byte == b'A').unwrap();
        changed_bytes[index] = b'B';
        fake.set(&selected.manifest_asset.api_url, Reply::ok(changed_bytes));
        assert_eq!(
            tauri::async_runtime::block_on(fetch_archive_with(
                &fake,
                &policy,
                &selected,
                DISCOVERY_BURST
            )),
            Err(DiscoveryError::IdentityChanged)
        );
    }

    #[test]
    fn archive_never_accepts_forged_release_url_or_unbounded_redirects() {
        let policy = policy(Channel::Beta);
        let fake = Fake::default();
        let (record, bytes) = release(&policy, 1, "2.0.0-beta.10", "0.2.4", "13.0");
        fake.release(&policy, &record, &bytes);
        fake.page(&policy, 1, json!([record]));
        let mut selected = complete(&fake, &policy, &mut DiscoveryCursor::default())
            .selected
            .unwrap();
        let original = selected.release.api_url.clone();
        selected.release.api_url = Url::parse("https://evil.test/?token=TOKEN_SENTINEL").unwrap();
        let before = fake.calls().len();
        assert_eq!(
            tauri::async_runtime::block_on(fetch_archive_with(
                &fake,
                &policy,
                &selected,
                DISCOVERY_BURST
            )),
            Err(DiscoveryError::IdentityChanged)
        );
        assert_eq!(before, fake.calls().len());
        selected.release.api_url = original;
        let delivery = "https://objects.githubusercontent.com/github-production-release-asset/123/abc?token=TOKEN_SENTINEL";
        fake.set(&selected.archive_asset.api_url, Reply::redirect(delivery));
        fake.set(&Url::parse(delivery).unwrap(), Reply::redirect(delivery));
        let error = tauri::async_runtime::block_on(fetch_archive_with(
            &fake,
            &policy,
            &selected,
            DISCOVERY_BURST,
        ))
        .unwrap_err();
        assert_eq!(error, DiscoveryError::RedirectLimit);
        assert!(!format!("{error:?}").contains("TOKEN_SENTINEL"));
    }
}
