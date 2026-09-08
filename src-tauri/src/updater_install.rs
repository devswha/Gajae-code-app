//! Native installation input. Own one immutable, freshly verified archive buffer
//! through supported plugin reconstruction and (later) the installation attempt.
//! Cache records and network metadata are never installation consent.
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    path::PathBuf,
    time::Duration,
};

use reqwest::redirect::Policy;
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::time::Instant;

use crate::{
    updater_archive::{inspect_archive, ArchiveIdentity, ArchiveInventory},
    updater_attempt::{Journal, Target, VerifiedBundleProof},
    updater_bundle::{verify_inventory, VerifiedBundle},
    updater_discovery::{revalidate_prepared, DiscoveryPolicy, PreparedIdentity},
    updater_location::InstallLocation,
    updater_manifest::{parse_manifest, Manifest, ProductIdentity},
    updater_signature::{digest, verify_archive},
    updater_store::{PreparedRecord, Store},
    updater_transport::HttpsClient,
};

pub(crate) const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(5);

/// Native-owned reconstruction inputs, after compiled build/profile admission.
pub(crate) struct Reconstruction<'a> {
    pub(crate) client: &'a HttpsClient,
    pub(crate) policy: &'a DiscoveryPolicy,
    pub(crate) location: &'a InstallLocation,
    pub(crate) key: &'a str,
    pub(crate) certificate: Option<reqwest::Certificate>,
    pub(crate) deadline: Instant,
}

pub(crate) struct VerifiedArchive {
    record: PreparedRecord,
    manifest: Manifest,
    inventory: ArchiveInventory,
    bytes: Box<[u8]>,
    key_sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstallError {
    Cache,
    Signature,
    Archive,
    Network,
    Deadline,
    Changed,
    Configuration,
}

impl VerifiedArchive {
    pub(crate) fn load(store: &Store, key: &str) -> Result<Option<Self>, InstallError> {
        store
            .load()
            .map_err(|_| InstallError::Cache)?
            .map(|(record, bytes)| Self::verify(record, bytes, key))
            .transpose()
    }

    fn verify(record: PreparedRecord, bytes: Vec<u8>, key: &str) -> Result<Self, InstallError> {
        let manifest = parse_manifest(record.manifest.as_bytes(), &product_identity())
            .map_err(|_| InstallError::Cache)?;
        if bytes.len() as u64 != record.archive_size || digest(&bytes) != record.archive_sha256 {
            return Err(InstallError::Cache);
        }
        verify_archive(&bytes, key, &manifest.signature).map_err(|_| InstallError::Signature)?;
        let inventory = inspect_archive(&bytes, &archive_identity(&manifest))
            .map_err(|_| InstallError::Archive)?;
        if serde_json::to_value(&inventory).map_err(|_| InstallError::Archive)? != record.inventory
        {
            return Err(InstallError::Cache);
        }
        Ok(Self {
            record,
            manifest,
            inventory,
            bytes: bytes.into_boxed_slice(),
            key_sha256: digest(key.as_bytes()),
        })
    }

    pub(crate) fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub(crate) fn record(&self) -> &PreparedRecord {
        &self.record
    }
    pub(crate) fn inventory(&self) -> &ArchiveInventory {
        &self.inventory
    }

    /// The registered plugin uses exactly the final native-validated endpoint.
    /// Its metadata allocation remains timeout-bounded, NOT byte-bounded. No
    /// plugin download API is called and no private Update fields are fabricated.
    pub(crate) async fn reconstruct<R: Runtime>(
        self,
        app: &AppHandle<R>,
        context: Reconstruction<'_>,
    ) -> Result<PreparedInstall, InstallError> {
        let Reconstruction {
            client,
            policy,
            location,
            key,
            certificate,
            deadline,
        } = context;
        if digest(key.as_bytes()) != self.key_sha256 {
            return Err(InstallError::Configuration);
        }
        // Cap a caller-supplied budget, including the native reread and plugin
        // check. Local signature/inventory validation precedes this network timer.
        let deadline = deadline.min(Instant::now() + PREFLIGHT_TIMEOUT);
        let checked = revalidate_prepared(
            client,
            policy,
            PreparedIdentity {
                release_id: self.record.release_id,
                manifest_asset_id: self.record.manifest_asset_id,
                archive_asset_id: self.record.archive_asset_id,
                archive_size: self.record.archive_size,
                manifest_bytes: self.record.manifest.as_bytes(),
            },
            deadline,
        )
        .await
        .map_err(|_| InstallError::Network)?;
        exact_endpoint(&checked.endpoint)?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|time| !time.is_zero())
            .ok_or(InstallError::Deadline)?;
        let updater = app
            .updater_builder()
            .endpoints(vec![checked.endpoint])
            .map_err(|_| InstallError::Configuration)?
            .pubkey(key)
            .target("darwin-aarch64")
            .executable_path(location.executable())
            .timeout(remaining)
            .configure_client(move |builder| {
                let builder = builder
                    .https_only(true)
                    .redirect(Policy::none())
                    .connect_timeout(remaining.min(Duration::from_secs(2)))
                    .timeout(remaining);
                match certificate.clone() {
                    Some(certificate) => builder.add_root_certificate(certificate),
                    None => builder,
                }
            })
            .build()
            .map_err(|_| InstallError::Configuration)?;
        let update = tokio::time::timeout_at(deadline, updater.check())
            .await
            .map_err(|_| InstallError::Deadline)?
            .map_err(|_| InstallError::Network)?
            .ok_or(InstallError::Changed)?;
        validate_plugin_result(&self.manifest, &update)?;
        if checked.selected.manifest != self.manifest || Instant::now() >= deadline {
            return Err(InstallError::Changed);
        }
        Ok(PreparedInstall {
            archive: self,
            update,
            app: location.app().to_owned(),
        })
    }
}

/// No Clone and no mutable buffer accessor: the later attempt owner consumes
/// this object, never reloads a second potentially changed archive from disk.
pub(crate) struct PreparedInstall {
    archive: VerifiedArchive,
    update: Update,
    app: PathBuf,
}

impl crate::updater_attempt::proof_seal::Sealed for VerifiedBundle {}

impl VerifiedBundleProof for VerifiedBundle {
    fn root(&self) -> &std::path::Path {
        self.root()
    }
    fn inventory_sha256(&self) -> &str {
        self.inventory_sha256()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ApplyError {
    /// No installer was invoked; the old app may continue only after launch gates revalidate.
    Precondition,
    /// An attempt exists or mutation may have begun. Never start a server or automatically retry.
    RecoveryRequired,
}

/// Successful install return + full B inventory + durable awaiting-health record.
/// It is not successor health, and exposes no ability to erase the attempt.
pub(crate) struct InstalledTarget {
    target: Target,
}

impl InstalledTarget {
    pub(crate) fn target(&self) -> &Target {
        &self.target
    }
}

impl PreparedInstall {
    /// Blocking: invoke off the event thread, and only after the native owner
    /// has proven startup/manual-restart admission and G0 installation eligibility.
    /// There is intentionally NO timeout around an active official installer.
    pub(crate) fn apply(
        self,
        journal: &Journal,
        location: &InstallLocation,
    ) -> Result<InstalledTarget, ApplyError> {
        if self.app != location.app() {
            return Err(ApplyError::Precondition);
        }
        location
            .revalidate()
            .map_err(|_| ApplyError::Precondition)?;
        let target = Target {
            app_path: self.app.clone(),
            source_desktop_version: env!("CARGO_PKG_VERSION").into(),
            target_desktop_version: self.archive.manifest.version.to_string(),
            target_product_version: self.archive.manifest.product_version.to_string(),
            archive_sha256: self.archive.inventory.archive_sha256.clone(),
            inventory_sha256: self.archive.inventory.inventory_sha256.clone(),
            runtime_manifest_sha256: self.archive.inventory.runtime_manifest_sha256.clone(),
        };
        let mut attempt = journal
            .begin(target.clone())
            .map_err(|_| ApplyError::RecoveryRequired)?;
        location
            .revalidate()
            .map_err(|_| ApplyError::RecoveryRequired)?;
        attempt
            .validate_install_permit()
            .map_err(|_| ApplyError::RecoveryRequired)?;
        // This is exactly the immutable allocation signature/inventory verified
        // by VerifiedArchive; no disk reload and no plugin-owned download.
        match catch_unwind(AssertUnwindSafe(|| {
            self.update.install(self.archive.bytes.as_ref())
        })) {
            Ok(Ok(())) => {}
            // Even PermissionDenied does not distinguish cancellation from a
            // privileged move failure in updater 2.6. Preserve the blocker.
            _ => return Err(ApplyError::RecoveryRequired),
        }
        let proof = verify_inventory(&self.app, &self.archive.inventory)
            .map_err(|_| ApplyError::RecoveryRequired)?;
        attempt
            .record_installed(&proof)
            .map_err(|_| ApplyError::RecoveryRequired)?;
        Ok(InstalledTarget { target })
    }
}

fn validate_plugin_result(expected: &Manifest, update: &Update) -> Result<(), InstallError> {
    let parsed = parse_plugin_manifest(&update.raw_json)?;
    if &parsed != expected
        || update.version != expected.version.to_string()
        || update.current_version != env!("CARGO_PKG_VERSION")
        || update.download_url != expected.archive_url
        || update.signature != expected.signature
        || update.target != "darwin-aarch64"
    {
        return Err(InstallError::Changed);
    }
    Ok(())
}

fn parse_plugin_manifest(value: &serde_json::Value) -> Result<Manifest, InstallError> {
    // The plugin already allocated raw_json under its documented timeout-only
    // contract. Do not allocate another unbounded copy in the native validator.
    struct Bounded(Vec<u8>);
    impl std::io::Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > (64 * 1024usize).saturating_sub(self.0.len()) {
                return Err(std::io::Error::other("manifest size limit"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut bytes = Bounded(Vec::new());
    serde_json::to_writer(&mut bytes, value).map_err(|_| InstallError::Changed)?;
    parse_manifest(&bytes.0, &product_identity()).map_err(|_| InstallError::Changed)
}

fn exact_endpoint(url: &reqwest::Url) -> Result<(), InstallError> {
    // updater 2.6 substitutes template tokens even in a supplied final endpoint.
    // Such a query/path would no longer be the endpoint we actually prefetched.
    let lower = url.as_str().to_ascii_lowercase();
    if lower.contains("{{") || lower.contains("%7b%7b") {
        return Err(InstallError::Changed);
    }
    Ok(())
}

pub(crate) fn product_identity() -> ProductIdentity<'static> {
    ProductIdentity {
        repository: env!("GJC_UPDATE_REPOSITORY"),
        artifact_prefix: env!("GJC_UPDATE_ARTIFACT_PREFIX"),
    }
}

pub(crate) fn archive_identity(manifest: &Manifest) -> ArchiveIdentity {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_parsed_metadata_is_revalidated_without_an_unbounded_second_copy() {
        let valid: serde_json::Value = serde_json::from_str(include_str!(
            "../../shared/fixtures/desktop-update-manifest.json"
        ))
        .unwrap();
        assert!(parse_plugin_manifest(&valid).is_ok());
        let mut oversized = valid.clone();
        oversized["notes"] = serde_json::json!("x".repeat(64 * 1024));
        assert_eq!(
            parse_plugin_manifest(&oversized),
            Err(InstallError::Changed)
        );
        let mut foreign = valid;
        foreign["repository"] = serde_json::json!("other/repository");
        assert_eq!(parse_plugin_manifest(&foreign), Err(InstallError::Changed));
    }

    #[test]
    fn plugin_cannot_rewrite_the_prefetched_endpoint_through_template_substitution() {
        for query in [
            "{{arch}}",
            "{{target}}",
            "{{current_version}}",
            "%7B%7Barch%7D%7D",
            "%7b%7btarget%7d%7d",
        ] {
            let endpoint =
                format!("https://release-assets.githubusercontent.com/path?token={query}")
                    .parse()
                    .unwrap();
            assert_eq!(exact_endpoint(&endpoint), Err(InstallError::Changed));
        }
        assert!(exact_endpoint(
            &"https://release-assets.githubusercontent.com/path?token=abc-123"
                .parse()
                .unwrap()
        )
        .is_ok());
    }
}
