//! Durable desktop install attempts and cross-process completion admission.
//!
//! The journal publishes and syncs the canonical blocker before granting a
//! process-bound live permit. Loaded records are inspection data, never permits.
//! Nothing here installs or starts a server. Only sealed native successor and
//! health proofs can retire a blocker; parsed state can never do so. `check`
//! still refuses EVERY present canonical entry. With that entry absent, a
//! pending/invalid completion receipt also blocks; only schema-2 Committed can
//! dispose of a completed transaction. Legacy "success" is never sufficient.
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) const ATTEMPT_RECORD: &str = "desktop-update-attempt.json";
const COMPLETED_RECORD: &str = "desktop-update-completed.json";
const COMPLETION_STAGE: &str = "desktop-update-completed.next.json";

// The standalone QA probe also includes this file, without the product bundle
// verifier. Keep the journal independent of that crate's module topology.
#[cfg(target_os = "macos")]
#[allow(unused_imports)]
pub(crate) use durable::{
    proof_seal, Journal, LiveAttempt, LoadedAttempt, Phase, SuccessorAttempt, Target,
    VerifiedBundleProof, VerifiedHealthProof, VerifiedSuccessorProof,
};

/// Every present canonical entry blocks, regardless of contents/type. Absence
/// alone is insufficient when persistent completion state exists.
pub(crate) fn check(desktop_data_root: &Path) -> Result<(), String> {
    let root = normalize_absolute(desktop_data_root)?;
    if !validate_real_directory_ancestors(&root)? {
        return Ok(());
    }
    let record = root.join(ATTEMPT_RECORD);
    match fs::symlink_metadata(&record) {
        Ok(_) => Err(format!(
            "Desktop update attempt state is present at {}; startup is blocked.",
            record.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Preserve the old no-record/no-I/O behavior for fresh data roots,
            // including roots that have not yet been made journal-private.
            for name in [COMPLETION_STAGE, COMPLETED_RECORD] {
                match fs::symlink_metadata(root.join(name)) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(_) => return Err("Could not validate desktop completion state.".into()),
                    Ok(_) => {
                        #[cfg(target_os = "macos")]
                        return durable::check_completion(&root);
                        #[cfg(not(target_os = "macos"))]
                        return Err("Desktop completion state requires native verification.".into());
                    }
                }
            }
            Ok(())
        }
        Err(error) => Err(format!(
            "Could not validate desktop update attempt state at {}: {error}",
            record.display()
        )),
    }
}

/// A build compiled without an updater can never mint the sealed successor
/// proof that retires a blocker, so a journal left by the previous app would
/// block it forever (beta.13). When the pending attempt targets exactly this
/// binary's compiled identity, the bundle is at the recorded path and the app
/// evidently launched, the installation demonstrably produced this app. Set the
/// canonical entries aside under an attempt-specific name (never delete: a
/// later updater-enabled build can still inspect them) and let the user work.
/// Any other state stays blocked. This is a one-way concession for a build
/// that cannot verify; it is not a startup permit for updater-enabled builds.
#[cfg(target_os = "macos")]
pub(crate) fn set_aside_unverifiable(
    desktop_data_root: &Path,
    installed_app: &Path,
    compiled: &CompiledIdentity,
) -> Result<PathBuf, String> {
    let root = normalize_absolute(desktop_data_root)?;
    let loaded = Journal::open(&root)?
        .load()?
        .ok_or_else(|| "No pending update attempt to set aside.".to_owned())?;
    if loaded.phase() != Phase::AwaitingHealth {
        return Err(
            "An interrupted installation cannot be retried by a build without an updater.".into(),
        );
    }
    let target = loaded.target();
    if target.app_path != installed_app
        || target.target_desktop_version != compiled.desktop_version
        || target.target_product_version != compiled.product_version
        || target.runtime_manifest_sha256 != compiled.runtime_manifest_sha256
    {
        return Err("The running app is not the version this update installed.".into());
    }
    let attempt_id = loaded.attempt_id().to_owned();
    drop(loaded);
    let mut moved = None;
    for name in [ATTEMPT_RECORD, COMPLETION_STAGE, COMPLETED_RECORD] {
        let source = root.join(name);
        match fs::symlink_metadata(&source) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not inspect {name}: {error}")),
            Ok(_) => {}
        }
        let stem = name.strip_suffix(".json").unwrap_or(name);
        let aside = root.join(format!("{stem}.unverified-{attempt_id}.json"));
        if fs::symlink_metadata(&aside).is_ok() {
            return Err(format!("{} already exists.", aside.display()));
        }
        fs::rename(&source, &aside)
            .map_err(|error| format!("Could not set {name} aside: {error}"))?;
        moved.get_or_insert(aside);
    }
    check(&root)?;
    moved.ok_or_else(|| "No update attempt state was present.".to_owned())
}

/// Compile-time identity of the running binary, supplied by the caller so this
/// module keeps no `env!` dependency of its own.
#[cfg(target_os = "macos")]
pub(crate) struct CompiledIdentity {
    pub(crate) desktop_version: &'static str,
    pub(crate) product_version: &'static str,
    pub(crate) runtime_manifest_sha256: &'static str,
}

fn normalize_absolute(path: &Path) -> Result<PathBuf, String> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Desktop data root contains an unsafe parent component.".to_owned());
    }
    let normalized: PathBuf = path.components().collect();
    if !normalized.is_absolute() {
        return Err("Desktop data root must be an absolute directory.".to_owned());
    }
    Ok(normalized)
}

/// Walk only real directory ancestors. A missing tail is a validated absence,
/// but a symlink, non-directory, permission error, or other unknown result is
/// unsafe and refuses startup rather than masquerading as ENOENT.
fn validate_real_directory_ancestors(root: &Path) -> Result<bool, String> {
    let mut current = PathBuf::new();
    for component in root.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {
                current.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("Desktop data root contains an unsafe parent component.".to_owned())
            }
            Component::Normal(name) => {
                current.push(name);
                match fs::symlink_metadata(&current) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        return Err(format!(
                            "Desktop data root contains a symlink ancestor: {}",
                            current.display()
                        ))
                    }
                    Ok(metadata) if !metadata.is_dir() => {
                        return Err(format!(
                            "Desktop data root ancestor is not a directory: {}",
                            current.display()
                        ))
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
                    Err(error) => {
                        return Err(format!(
                            "Could not validate desktop data root ancestor {}: {error}",
                            current.display()
                        ))
                    }
                }
            }
        }
    }
    Ok(true)
}

#[cfg(target_os = "macos")]
mod durable {
    use super::{ATTEMPT_RECORD, COMPLETED_RECORD, COMPLETION_STAGE};
    use std::{
        cell::Cell,
        ffi::{CString, OsStr},
        fs::{File, Metadata},
        io::{self, Seek, SeekFrom, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::FileExt, fs::MetadataExt},
        },
        path::{Component, Path, PathBuf},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
    };

    use serde::{Deserialize, Serialize};

    const MAX_RECORD_BYTES: usize = 16 * 1024;
    const MAX_PATH_BYTES: usize = 4096;
    const MAX_VERSION_BYTES: usize = 128;
    type Result<T> = std::result::Result<T, String>;

    /// Closed, bounded install identity. Public fields allow construction from
    /// the parent's freshly signature-checked archive; begin validates EVERY
    /// field. Deserialization/versions alone never establish install authority.
    /// Strict upgrade ordering/channel/OS eligibility is revalidated by the
    /// parent's revalidate_prepared/eligible immediately before reconstruction.
    #[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
    #[serde(deny_unknown_fields)]
    pub(crate) struct Target {
        pub(crate) app_path: PathBuf,
        pub(crate) source_desktop_version: String,
        pub(crate) target_desktop_version: String,
        pub(crate) target_product_version: String,
        pub(crate) archive_sha256: String,
        pub(crate) inventory_sha256: String,
        pub(crate) runtime_manifest_sha256: String,
    }

    impl Target {
        fn validate(&self) -> Result<()> {
            canonical_path(&self.app_path)?;
            let name = self.app_path.file_name().and_then(OsStr::to_str);
            require(
                name.is_some_and(|name| name.len() > 4 && name.ends_with(".app")),
                "target must be a canonical .app directory",
            )?;
            for version in [
                &self.source_desktop_version,
                &self.target_desktop_version,
                &self.target_product_version,
            ] {
                require(
                    !version.is_empty() && version.len() <= MAX_VERSION_BYTES,
                    "version length limit",
                )?;
                let parsed = semver::Version::parse(version)
                    .map_err(|_| error("invalid semantic version"))?;
                require(parsed.to_string() == *version, "noncanonical version")?;
            }
            for digest in [
                &self.archive_sha256,
                &self.inventory_sha256,
                &self.runtime_manifest_sha256,
            ] {
                require(lower_hex(digest, 64), "invalid SHA-256")?;
            }
            Ok(())
        }
    }

    /// Native-only sealing boundary. Implement only for opaque inventory,
    /// successor-verification, and supervisor-owned health proofs. Journal tests
    /// use local projections. No blanket or serialized-state impls exist.
    pub(crate) mod proof_seal {
        pub(crate) trait Sealed {}
    }

    /// Implement ONLY for the inventory verifier's opaque VerifiedBundle.
    /// The adapter belongs alongside that type/the parent installer, not the
    /// standalone probe. Never implement for Target, JSON, strings, or booleans.
    /// This evidence says a full inventory matched at verification time; it is
    /// neither installer-return evidence nor runtime-health evidence.
    pub(crate) trait VerifiedBundleProof: proof_seal::Sealed {
        fn root(&self) -> &Path;
        fn inventory_sha256(&self) -> &str;
    }

    /// Parent-owned live proof of cached Minisign verification, full installed
    /// target inventory, compiled payload identity and old-owner exit. The
    /// parent must hold its instance/startup gate throughout this handoff.
    pub(crate) trait VerifiedSuccessorProof: proof_seal::Sealed {
        fn target(&self) -> &Target;
    }

    /// Implement ONLY on a supervisor-owned HealthyServer retaining ownership
    /// of this child: owned ready + real health, full installed-B re-verification,
    /// a second independent health check, then stable-port persistence. Mint it
    /// BEFORE SPA navigation/exposure so new work cannot mutate the app before
    /// journal completion. GUI acceptance is separate G5 evidence, not this proof.
    /// A PID alone proves neither child ownership nor health. Never reconstruct
    /// this proof from a receipt, a version, or a previously observed PID.
    pub(crate) trait VerifiedHealthProof: proof_seal::Sealed {
        fn target(&self) -> &Target;
        fn server_pid(&self) -> u32;
    }

    #[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    pub(crate) enum Phase {
        Installing,
        AwaitingHealth,
    }

    #[derive(Clone, Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Record {
        schema: u8,
        attempt_id: String,
        owner_pid: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery_owner_pid: Option<u32>,
        data_root: PathBuf,
        root_device: u64,
        root_inode: u64,
        record_device: u64,
        record_inode: u64,
        phase: Phase,
        target: Target,
    }

    /// Opens an EXISTING, canonical, owner-private (0700) data root. Does not
    /// create/chmod ancestors or claim a QA marker. A directory-descriptor flock
    /// excludes cooperating journal owners for this handle's entire lifetime.
    /// All writes use its anchored directory and exclusively-created 0600 file.
    ///
    /// Descriptor/snapshot rechecks refuse observed substitutions; they are not
    /// an atomic filesystem snapshot against a hostile concurrent same-UID
    /// writer. The caller must also own the admitted namespace/process lifetime.
    pub(crate) struct Journal {
        root: Arc<Root>,
    }

    struct Root {
        anchor: Anchor,
        pid: u32,
        successor_claimed: AtomicBool,
    }

    /// Not Clone/Deserialize. Copies inherited across fork cannot validate or
    /// mutate. There is intentionally no cleanup Drop: failure, unwind, process
    /// death, or an abandoned handle leaves the canonical entry blocking.
    #[must_use = "An abandoned live attempt retains its startup blocker"]
    pub(crate) struct LiveAttempt {
        root: Arc<Root>,
        source_app: Anchor,
        file: File,
        bytes: Vec<u8>,
        snapshot: Metadata,
        record: Record,
        poisoned: bool,
    }

    /// Read-only snapshot, explicitly NOT a resumable LiveAttempt. Even a full
    /// target match cannot install, admit startup, or remove/archive the record.
    #[derive(Debug)]
    pub(crate) struct LoadedAttempt {
        record: Record,
        bytes: Vec<u8>,
        snapshot: Metadata,
        from_completion: bool,
        completion: Option<CompletionSnapshot>,
    }

    /// Non-Clone, non-deserializable, PID-bound startup/finish capability. Drop
    /// before successful finish retains the blocker. It grants no install API.
    #[must_use = "An unfinished successor retains its startup blocker"]
    pub(crate) struct SuccessorAttempt {
        root: Arc<Root>,
        installed_app: Anchor,
        file: File,
        record: Record,
        bytes: Vec<u8>,
        snapshot: Metadata,
        poisoned: Cell<bool>,
    }

    #[derive(Clone, Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct CompletedRecord {
        schema: u8,
        state: CompletionState,
        completed_by_pid: u32,
        server_pid: u32,
        archive_device: u64,
        archive_inode: u64,
        attempt: Record,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
    #[serde(rename_all = "snake_case")]
    enum CompletionState {
        PreparedSuccess,
        Committed,
        // v1 published this BEFORE retirement. Always treat it as pending.
        VerifiedSuccess,
    }

    #[derive(Debug)]
    struct CompletionSnapshot {
        receipt: CompletedRecord,
        bytes: Vec<u8>,
        snapshot: Metadata,
    }

    /// Reader only: no flock acquisition, file creation, or repair. Normal
    /// startup still owns the parent's instance/lifecycle admission gate.
    pub(super) fn check_completion(data_root: &Path) -> Result<()> {
        let root = Root {
            anchor: Anchor::open(data_root)?,
            pid: std::process::id(),
            successor_claimed: AtomicBool::new(false),
        };
        root.validate()?;
        require_absent(&root, ATTEMPT_RECORD)?;
        completion_allows_absence(&root)?;
        require_absent(&root, ATTEMPT_RECORD)
    }

    fn completion_is_committed(receipt: &CompletedRecord) -> bool {
        receipt.schema == 2 && receipt.state == CompletionState::Committed
    }

    fn completion_allows_absence(root: &Root) -> Result<()> {
        require_absent(root, COMPLETION_STAGE)?;
        if let Some(completion) = read_completion(root, COMPLETED_RECORD)? {
            require(
                completion_is_committed(&completion.receipt),
                "pending or legacy completion requires verified successor recovery",
            )?;
            verify_completion_snapshot(root, COMPLETED_RECORD, &completion)?;
        }
        require_absent(root, COMPLETION_STAGE)
    }

    fn entry_absent(root: &Root, name: &str) -> Result<bool> {
        root.validate()?;
        let name = CString::new(name).map_err(|_| error("invalid journal entry name"))?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                root.anchor.directory().as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        let absent = match (result, io::Error::last_os_error().raw_os_error()) {
            (0, _) => false,
            (-1, Some(libc::ENOENT)) => true,
            _ => return Err(error("journal entry absence is uncertain")),
        };
        root.validate()?;
        Ok(absent)
    }

    fn require_absent(root: &Root, name: &str) -> Result<()> {
        require(
            entry_absent(root, name)?,
            "journal entry is present; startup remains blocked",
        )
    }

    fn validate_completion_record(
        root: &Root,
        receipt: &CompletedRecord,
        snapshot: &Metadata,
    ) -> Result<()> {
        root.validate()?;
        private(snapshot, false)?;
        receipt.attempt.target.validate()?;
        let directory = metadata(root.anchor.directory())?;
        require(
            matches!(
                (receipt.schema, receipt.state),
                (
                    2,
                    CompletionState::PreparedSuccess | CompletionState::Committed
                ) | (1, CompletionState::VerifiedSuccess)
            ) && receipt.attempt.schema == 1
                && receipt.attempt.phase == Phase::AwaitingHealth
                && lower_hex(&receipt.attempt.attempt_id, 32)
                && valid_pid(receipt.attempt.owner_pid)
                && receipt.attempt.recovery_owner_pid.is_none_or(valid_pid)
                && valid_pid(receipt.completed_by_pid)
                && valid_pid(receipt.server_pid)
                && receipt.completed_by_pid != receipt.attempt.owner_pid
                && receipt.server_pid != receipt.completed_by_pid
                && receipt.server_pid != receipt.attempt.owner_pid
                && Some(receipt.server_pid) != receipt.attempt.recovery_owner_pid
                && receipt.archive_device == snapshot.dev()
                && receipt.archive_inode == snapshot.ino()
                && receipt.attempt.data_root.as_os_str() == root.anchor.path.as_os_str()
                && receipt.attempt.root_device == directory.dev()
                && receipt.attempt.root_inode == directory.ino()
                && receipt.attempt.record_device == directory.dev()
                && receipt.attempt.record_inode != 0,
            "invalid completion schema, phase, ownership, or fingerprint",
        )?;
        let source = semver::Version::parse(&receipt.attempt.target.source_desktop_version)
            .map_err(|_| error("invalid completion source version"))?;
        let target = semver::Version::parse(&receipt.attempt.target.target_desktop_version)
            .map_err(|_| error("invalid completion target version"))?;
        require(
            target.cmp_precedence(&source).is_gt(),
            "completion does not describe a strict upgrade",
        )
    }

    fn read_completion(root: &Root, name: &str) -> Result<Option<CompletionSnapshot>> {
        root.validate()?;
        let file = match open_at(
            root.anchor.directory(),
            OsStr::new(name),
            libc::O_RDONLY | libc::O_NONBLOCK,
            0,
        ) {
            Ok(file) => file,
            Err(cause) if cause.kind() == io::ErrorKind::NotFound => {
                require_absent(root, name)?;
                return Ok(None);
            }
            Err(_) => return Err(error("completion receipt is inaccessible or aliased")),
        };
        let snapshot = metadata(&file)?;
        private(&snapshot, false)?;
        let bytes = read_bounded(&file)?;
        named_owned_at(root, name, &file, &bytes, &snapshot)?;
        let receipt: CompletedRecord = serde_json::from_slice(&bytes)
            .map_err(|_| error("malformed completion receipt; startup remains blocked"))?;
        validate_completion_record(root, &receipt, &snapshot)?;
        named_owned_at(root, name, &file, &bytes, &snapshot)?;
        Ok(Some(CompletionSnapshot {
            receipt,
            bytes,
            snapshot,
        }))
    }

    fn verify_completion_snapshot(
        root: &Root,
        name: &str,
        completion: &CompletionSnapshot,
    ) -> Result<()> {
        root.validate()?;
        let file = open_at(
            root.anchor.directory(),
            OsStr::new(name),
            libc::O_RDONLY | libc::O_NONBLOCK,
            0,
        )
        .map_err(|_| error("inspected completion receipt disappeared or changed"))?;
        validate_completion_record(root, &completion.receipt, &completion.snapshot)?;
        named_owned_at(root, name, &file, &completion.bytes, &completion.snapshot)
    }

    fn loaded_owners_gone(loaded: &LoadedAttempt) -> Result<()> {
        old_owner_gone(loaded.record.owner_pid)?;
        if let Some(pid) = loaded.record.recovery_owner_pid {
            old_owner_gone(pid)?;
        }
        if let Some(completion) = &loaded.completion {
            old_owner_gone(completion.receipt.completed_by_pid)?;
            require(
                process_status(completion.receipt.server_pid)? == ProcessStatus::Gone,
                "previous completion server is still alive",
            )?;
        }
        Ok(())
    }

    impl Journal {
        pub(crate) fn open(data_root: &Path) -> Result<Self> {
            let anchor = Anchor::open(data_root)?;
            private(&metadata(anchor.directory())?, true)?;
            // Never explicitly unlock on Drop: forked copies share the open
            // description and must not unlock the parent's lifetime ownership.
            if unsafe {
                libc::flock(
                    anchor.directory().as_raw_fd(),
                    libc::LOCK_EX | libc::LOCK_NB,
                )
            } != 0
            {
                return Err(error("another journal owner holds this data root"));
            }
            let root = Arc::new(Root {
                anchor,
                pid: std::process::id(),
                successor_claimed: AtomicBool::new(false),
            });
            root.validate()?;
            Ok(Self { root })
        }

        pub(crate) fn begin(&self, target: Target) -> Result<LiveAttempt> {
            self.begin_inner(target, &mut |_| Ok(()))
        }

        fn begin_inner(
            &self,
            target: Target,
            observe: &mut dyn FnMut(SyncPoint) -> Result<()>,
        ) -> Result<LiveAttempt> {
            self.root.validate()?;
            require(
                !self.root.successor_claimed.load(Ordering::Acquire),
                "successor owns startup admission",
            )?;
            completion_allows_absence(&self.root)?;
            target.validate()?;
            // Read-only: no app files are created or modified by this module.
            let source_app = Anchor::open(&target.app_path)?;
            let root_metadata = metadata(self.root.anchor.directory())?;
            let attempt_id = random_id()?;
            self.root.validate()?;
            let mut file = open_at(
                self.root.anchor.directory(),
                OsStr::new(ATTEMPT_RECORD),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
                0o600,
            )
            .map_err(|_| error("cannot exclusively create attempt; present state blocks"))?;
            // EVERY exit after create retains the entry, including zero bytes.
            observe(SyncPoint::Created)?;
            let file_metadata = metadata(&file)?;
            private(&file_metadata, false)?;
            let record = Record {
                schema: 1,
                attempt_id,
                owner_pid: self.root.pid,
                recovery_owner_pid: None,
                data_root: self.root.anchor.path.clone(),
                root_device: root_metadata.dev(),
                root_inode: root_metadata.ino(),
                record_device: file_metadata.dev(),
                record_inode: file_metadata.ino(),
                phase: Phase::Installing,
                target,
            };
            let bytes = encode(&record)?;
            // Recheck the exclusive name before writing, including test-injected
            // substitutions at the creation boundary.
            self.root.validate()?;
            named_owned(&self.root, &file, &[], &file_metadata)?;
            persist(&self.root, &mut file, &bytes, observe)?;
            let snapshot = metadata(&file)?;
            let attempt = LiveAttempt {
                root: self.root.clone(),
                source_app,
                file,
                bytes,
                snapshot,
                record,
                poisoned: false,
            };
            attempt.validate_install_permit()?;
            Ok(attempt)
        }

        pub(crate) fn load(&self) -> Result<Option<LoadedAttempt>> {
            self.root.validate()?;
            require(
                !self.root.successor_claimed.load(Ordering::Acquire),
                "successor owns startup admission",
            )?;
            let completion = read_completion(&self.root, COMPLETED_RECORD)?;
            let file = match open_at(
                self.root.anchor.directory(),
                OsStr::new(ATTEMPT_RECORD),
                libc::O_RDONLY | libc::O_NONBLOCK,
                0,
            ) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    self.root.validate()?;
                    require_absent(&self.root, ATTEMPT_RECORD)?;
                    return match completion {
                        Some(completion)
                            if !completion_is_committed(&completion.receipt)
                                || !entry_absent(&self.root, COMPLETION_STAGE)? =>
                        {
                            Ok(Some(LoadedAttempt {
                                record: completion.receipt.attempt.clone(),
                                bytes: Vec::new(),
                                snapshot: completion.snapshot.clone(),
                                from_completion: true,
                                completion: Some(completion),
                            }))
                        }
                        _ => {
                            require_absent(&self.root, COMPLETION_STAGE)?;
                            Ok(None)
                        }
                    };
                }
                Err(_) => return Err(error("cannot safely open present attempt")),
            };
            let snapshot = metadata(&file)?;
            private(&snapshot, false)?;
            let bytes = read_bounded(&file)?;
            named_owned(&self.root, &file, &bytes, &snapshot)?;
            let record: Record = serde_json::from_slice(&bytes)
                .map_err(|_| error("malformed attempt; startup remains blocked"))?;
            record.target.validate()?;
            let root_metadata = metadata(self.root.anchor.directory())?;
            require(
                record.schema == 1
                    && lower_hex(&record.attempt_id, 32)
                    && record.owner_pid > 0
                    && record.owner_pid <= i32::MAX as u32
                    && record.recovery_owner_pid.is_none_or(valid_pid)
                    && record.data_root.as_os_str() == self.root.anchor.path.as_os_str()
                    && record.root_device == root_metadata.dev()
                    && record.root_inode == root_metadata.ino()
                    && record.record_device == snapshot.dev()
                    && record.record_inode == snapshot.ino(),
                "attempt identity/schema mismatch",
            )?;
            // Do not require a surviving .app: interrupted installs may leave it
            // missing. This is inspection only, not target or health verification.
            named_owned(&self.root, &file, &bytes, &snapshot)?;
            let completion = match completion {
                Some(completion)
                    if completion.receipt.attempt.attempt_id == record.attempt_id
                        && completion.receipt.attempt.target == record.target =>
                {
                    Some(completion)
                }
                Some(completion) if !completion_is_committed(&completion.receipt) => {
                    return Err(error("conflicting pending completion state"));
                }
                _ => None,
            };
            Ok(Some(LoadedAttempt {
                record,
                bytes,
                snapshot,
                from_completion: false,
                completion,
            }))
        }

        /// Canonical handoff is read-only. A pending receipt with no canonical
        /// entry can recreate ONLY AwaitingHealth, after this opaque proof and
        /// all recorded writer/server exits are verified. Never mints an install
        /// permit. ESRCH is the ONLY accepted exit status; uncertainty blocks.
        pub(crate) fn resume_verified(
            &self,
            loaded: &LoadedAttempt,
            proof: &impl VerifiedSuccessorProof,
        ) -> Result<SuccessorAttempt> {
            self.root.validate()?;
            require(
                loaded.phase() == Phase::AwaitingHealth,
                "successor requires awaiting health",
            )?;
            match_target(&loaded.record.target, proof.target())?;
            loaded_owners_gone(loaded)?;
            if loaded.from_completion {
                return self.recover_completion(loaded, proof);
            }
            let file = open_at(
                self.root.anchor.directory(),
                OsStr::new(ATTEMPT_RECORD),
                libc::O_RDONLY | libc::O_NONBLOCK,
                0,
            )
            .map_err(|_| error("cannot open exact successor attempt"))?;
            named_owned(&self.root, &file, &loaded.bytes, &loaded.snapshot)?;
            let root_metadata = metadata(self.root.anchor.directory())?;
            require(
                loaded.record.data_root.as_os_str() == self.root.anchor.path.as_os_str()
                    && loaded.record.root_device == root_metadata.dev()
                    && loaded.record.root_inode == root_metadata.ino(),
                "successor root differs from inspected attempt",
            )?;
            let installed_app = Anchor::open(&loaded.record.target.app_path)?;
            loaded_owners_gone(loaded)?;
            if let Some(completion) = &loaded.completion {
                verify_completion_snapshot(&self.root, COMPLETED_RECORD, completion)?;
            }
            named_owned(&self.root, &file, &loaded.bytes, &loaded.snapshot)?;
            // Even two callers using the SAME Journal cannot mint duplicate
            // startup permits. The flock also excludes other Journal objects.
            require(
                self.root
                    .successor_claimed
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok(),
                "successor already claimed",
            )?;
            Ok(SuccessorAttempt {
                root: self.root.clone(),
                installed_app,
                file,
                record: loaded.record.clone(),
                bytes: loaded.bytes.clone(),
                snapshot: loaded.snapshot.clone(),
                poisoned: Cell::new(false),
            })
        }

        fn recover_completion(
            &self,
            loaded: &LoadedAttempt,
            proof: &impl VerifiedSuccessorProof,
        ) -> Result<SuccessorAttempt> {
            let completion = loaded
                .completion
                .as_ref()
                .ok_or_else(|| error("missing pending receipt"))?;
            self.root.validate()?;
            match_target(&loaded.record.target, proof.target())?;
            loaded_owners_gone(loaded)?;
            verify_completion_snapshot(&self.root, COMPLETED_RECORD, completion)?;
            require_absent(&self.root, ATTEMPT_RECORD)?;
            let installed_app = Anchor::open(&loaded.record.target.app_path)?;
            require(
                self.root
                    .successor_claimed
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok(),
                "successor already claimed",
            )?;
            let recovered = (|| {
                self.root.validate()?;
                verify_completion_snapshot(&self.root, COMPLETED_RECORD, completion)?;
                loaded_owners_gone(loaded)?;
                let mut file = open_at(
                    self.root.anchor.directory(),
                    OsStr::new(ATTEMPT_RECORD),
                    libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
                    0o600,
                )
                .map_err(|_| error("cannot exclusively restore awaiting-health journal"))?;
                let snapshot = metadata(&file)?;
                private(&snapshot, false)?;
                let mut record = loaded.record.clone();
                record.record_device = snapshot.dev();
                record.record_inode = snapshot.ino();
                record.recovery_owner_pid = Some(self.root.pid);
                record.phase = Phase::AwaitingHealth;
                let bytes = encode(&record)?;
                named_owned(&self.root, &file, &[], &snapshot)?;
                persist(&self.root, &mut file, &bytes, &mut |_| Ok(()))?;
                let snapshot = metadata(&file)?;
                named_owned(&self.root, &file, &bytes, &snapshot)?;
                installed_app.validate()?;
                Ok(SuccessorAttempt {
                    root: self.root.clone(),
                    installed_app,
                    file,
                    record,
                    bytes,
                    snapshot,
                    poisoned: Cell::new(false),
                })
            })();
            if recovered.is_err() {
                self.root.successor_claimed.store(false, Ordering::Release);
            }
            recovered
        }
    }

    impl SuccessorAttempt {
        #[cfg(test)]
        pub(crate) fn target(&self) -> &Target {
            &self.record.target
        }

        /// Explicit exception under the parent's startup gate, never a change
        /// to check(). Any failed validation poisons THIS live capability.
        pub(crate) fn validate_startup(&self, proof: &impl VerifiedSuccessorProof) -> Result<()> {
            let result = self
                .validate()
                .and_then(|()| match_target(&self.record.target, proof.target()));
            if result.is_err() {
                self.poisoned.set(true);
            }
            result
        }

        fn validate(&self) -> Result<()> {
            require(!self.poisoned.get(), "successor is poisoned")?;
            self.validate_bound()
        }

        fn validate_bound(&self) -> Result<()> {
            self.root.validate()?;
            require(
                self.record.phase == Phase::AwaitingHealth,
                "successor phase changed",
            )?;
            old_owner_gone(self.record.owner_pid)?;
            if let Some(pid) = self.record.recovery_owner_pid {
                if pid != self.root.pid {
                    old_owner_gone(pid)?;
                }
            }
            self.installed_app.validate()?;
            named_owned(&self.root, &self.file, &self.bytes, &self.snapshot)
        }

        fn validate_health(&self, proof: &impl VerifiedHealthProof) -> Result<HealthyIdentity> {
            self.root.validate()?;
            match_target(&self.record.target, proof.target())?;
            let pid = proof.server_pid();
            require(
                valid_pid(pid) && pid != self.root.pid && pid != self.record.owner_pid,
                "invalid healthy server PID",
            )?;
            require(
                process_status(pid)? == ProcessStatus::Alive,
                "healthy server is no longer alive",
            )?;
            // The sealed supervisor proof certifies the pre-exposure ready,
            // re-verification, second-health, and stable-port checks above.
            // Also require a current direct child with our UID, and pin its
            // birth time across barriers rather than trusting a reusable PID.
            owned_server_identity(pid, self.root.pid)
        }

        /// Persist PreparedSuccess BEFORE retirement; publish schema-2 Committed
        /// only AFTER retirement fsync and another live health/identity check.
        /// The fixed receipt and bounded staging slot are cross-process barriers:
        /// Drop/in-memory recovery is never relied on for next-launch admission.
        /// Any error requires recovery in this process. A publication/cleanup
        /// fsync error can have an uncertain commit outcome; next launch resolves
        /// the strict receipt state, NEVER canonical absence or the old Result.
        pub(crate) fn finish(mut self, proof: &impl VerifiedHealthProof) -> Result<()> {
            self.finish_inner(proof, &mut |_| Ok(()))
        }

        fn finish_inner(
            &mut self,
            proof: &impl VerifiedHealthProof,
            observe: &mut dyn FnMut(FinishPoint) -> Result<()>,
        ) -> Result<()> {
            let initial = self.validate();
            self.poisoned.set(true);
            let result = initial.and_then(|()| self.finish_owned(proof, observe));
            match result {
                Ok(()) => Ok(()),
                Err(cause) => Err(format!("Desktop update completion requires recovery: {cause} Resolve persistent completion state; canonical absence is not admission.")),
            }
        }

        fn finish_owned(
            &mut self,
            proof: &impl VerifiedHealthProof,
            observe: &mut dyn FnMut(FinishPoint) -> Result<()>,
        ) -> Result<()> {
            let server = self.validate_health(proof)?;
            self.validate_bound()?;
            let (mut archive, old_bytes, old_snapshot) = self.open_completion()?;
            observe(FinishPoint::ArchiveOpened)?;
            let receipt = CompletedRecord {
                schema: 2,
                state: CompletionState::PreparedSuccess,
                completed_by_pid: self.root.pid,
                server_pid: server.pid,
                archive_device: old_snapshot.dev(),
                archive_inode: old_snapshot.ino(),
                attempt: self.record.clone(),
            };
            let bytes =
                serde_json::to_vec(&receipt).map_err(|_| error("cannot encode completion"))?;
            require(
                bytes.len() <= MAX_RECORD_BYTES,
                "completed receipt byte limit",
            )?;
            self.validate_bound()?;
            named_owned_at(
                &self.root,
                COMPLETED_RECORD,
                &archive,
                &old_bytes,
                &old_snapshot,
            )?;
            archive
                .set_len(0)
                .map_err(|_| error("cannot truncate owned completed receipt"))?;
            archive
                .seek(SeekFrom::Start(0))
                .map_err(|_| error("cannot rewind completed receipt"))?;
            observe(FinishPoint::ArchiveTruncated)?;
            self.validate_bound()?;
            named_owned_at(
                &self.root,
                COMPLETED_RECORD,
                &archive,
                &[],
                &metadata(&archive)?,
            )?;
            archive
                .write_all(&bytes)
                .map_err(|_| error("cannot write completed receipt"))?;
            let snapshot = metadata(&archive)?;
            observe(FinishPoint::BeforeArchiveSync)?;
            named_owned_at(&self.root, COMPLETED_RECORD, &archive, &bytes, &snapshot)?;
            archive
                .sync_all()
                .map_err(|_| error("cannot synchronize completed receipt"))?;
            observe(FinishPoint::ArchiveFileSynced)?;
            self.root
                .anchor
                .directory()
                .sync_all()
                .map_err(|_| error("cannot synchronize completed receipt directory"))?;
            observe(FinishPoint::ArchiveDirectorySynced)?;
            // This durable PENDING receipt remains a startup veto even if unlink
            // succeeds but retirement fsync fails. It is not success evidence.
            self.validate_bound()?;
            require(
                self.validate_health(proof)? == server,
                "healthy server identity changed",
            )?;
            named_owned_at(&self.root, COMPLETED_RECORD, &archive, &bytes, &snapshot)?;
            observe(FinishPoint::BeforeRetirement)?;
            self.validate_bound()?;
            require(
                self.validate_health(proof)? == server,
                "healthy server identity changed",
            )?;
            named_owned_at(&self.root, COMPLETED_RECORD, &archive, &bytes, &snapshot)?;
            let name = CString::new(ATTEMPT_RECORD).expect("literal");
            if unsafe { libc::unlinkat(self.root.anchor.directory().as_raw_fd(), name.as_ptr(), 0) }
                != 0
            {
                return Err(error("cannot retire owned canonical attempt"));
            }
            observe(FinishPoint::Retired)?;
            self.validate_retired(proof, server, &archive, &bytes, &snapshot)?;
            observe(FinishPoint::BeforeRetirementSync)?;
            self.root
                .anchor
                .directory()
                .sync_all()
                .map_err(|_| error("cannot synchronize attempt retirement"))?;
            observe(FinishPoint::RetirementSynced)?;
            self.validate_retired(proof, server, &archive, &bytes, &snapshot)?;
            self.publish_commit(proof, server, &archive, &bytes, &snapshot, observe)
        }

        fn publish_commit(
            &self,
            proof: &impl VerifiedHealthProof,
            server: HealthyIdentity,
            prepared: &File,
            prepared_bytes: &[u8],
            prepared_snapshot: &Metadata,
            observe: &mut dyn FnMut(FinishPoint) -> Result<()>,
        ) -> Result<()> {
            self.validate_retired(proof, server, prepared, prepared_bytes, prepared_snapshot)?;
            let (mut stage, previous, stage_snapshot) = self.open_receipt_slot(COMPLETION_STAGE)?;
            observe(FinishPoint::CommitOpened)?;
            let committed = CompletedRecord {
                schema: 2,
                state: CompletionState::Committed,
                completed_by_pid: self.root.pid,
                server_pid: server.pid,
                archive_device: stage_snapshot.dev(),
                archive_inode: stage_snapshot.ino(),
                attempt: self.record.clone(),
            };
            let bytes = serde_json::to_vec(&committed)
                .map_err(|_| error("cannot encode committed receipt"))?;
            require(
                bytes.len() <= MAX_RECORD_BYTES,
                "committed receipt byte limit",
            )?;
            named_owned_at(
                &self.root,
                COMPLETION_STAGE,
                &stage,
                &previous,
                &stage_snapshot,
            )?;
            stage
                .set_len(0)
                .map_err(|_| error("cannot truncate owned commit stage"))?;
            stage
                .seek(SeekFrom::Start(0))
                .map_err(|_| error("cannot rewind commit stage"))?;
            stage
                .write_all(&bytes)
                .map_err(|_| error("cannot write commit stage"))?;
            let written = metadata(&stage)?;
            observe(FinishPoint::BeforeCommitFileSync)?;
            named_owned_at(&self.root, COMPLETION_STAGE, &stage, &bytes, &written)?;
            stage
                .sync_all()
                .map_err(|_| error("cannot synchronize commit stage"))?;
            self.root
                .anchor
                .directory()
                .sync_all()
                .map_err(|_| error("cannot synchronize commit staging entry"))?;
            observe(FinishPoint::CommitFileSynced)?;
            observe(FinishPoint::BeforeCommitPublication)?;
            self.validate_retired(proof, server, prepared, prepared_bytes, prepared_snapshot)?;
            named_owned_at(&self.root, COMPLETION_STAGE, &stage, &bytes, &written)?;
            let from = CString::new(COMPLETION_STAGE).expect("literal");
            let to = CString::new(COMPLETED_RECORD).expect("literal");
            // Exchange retains the displaced inode until it is checked: never
            // blindly overwrite/delete a substituted archive. Both fixed slots
            // remain guard-visible if publication or its fsync is uncertain.
            let result = unsafe {
                libc::renameatx_np(
                    self.root.anchor.directory().as_raw_fd(),
                    from.as_ptr(),
                    self.root.anchor.directory().as_raw_fd(),
                    to.as_ptr(),
                    libc::RENAME_SWAP,
                )
            };
            require(result == 0, "cannot atomically publish committed receipt")?;
            observe(FinishPoint::CommitPublished)?;
            let committed_snapshot = metadata(&stage)?;
            let displaced_snapshot = metadata(prepared)?;
            require(
                same_inode(&written, &committed_snapshot)
                    && same_inode(prepared_snapshot, &displaced_snapshot),
                "commit exchange changed owned inodes",
            )?;
            named_owned_at(
                &self.root,
                COMPLETED_RECORD,
                &stage,
                &bytes,
                &committed_snapshot,
            )?;
            named_owned_at(
                &self.root,
                COMPLETION_STAGE,
                prepared,
                prepared_bytes,
                &displaced_snapshot,
            )?;
            require_absent(&self.root, ATTEMPT_RECORD)?;
            observe(FinishPoint::BeforeCommitDirectorySync)?;
            self.root
                .anchor
                .directory()
                .sync_all()
                .map_err(|_| error("committed receipt publication is uncertain"))?;
            observe(FinishPoint::CommitDirectorySynced)?;
            require(
                self.validate_health(proof)? == server,
                "healthy server identity changed",
            )?;
            self.installed_app.validate()?;
            named_owned_at(
                &self.root,
                COMPLETED_RECORD,
                &stage,
                &bytes,
                &committed_snapshot,
            )?;
            named_owned_at(
                &self.root,
                COMPLETION_STAGE,
                prepared,
                prepared_bytes,
                &displaced_snapshot,
            )?;
            require_absent(&self.root, ATTEMPT_RECORD)?;
            // Committed is now durable. Retire only the checked displaced
            // PreparedSuccess slot. A leftover slot causes conservative recovery.
            require(
                unsafe {
                    libc::unlinkat(self.root.anchor.directory().as_raw_fd(), from.as_ptr(), 0)
                } == 0,
                "cannot retire checked commit staging entry",
            )?;
            observe(FinishPoint::CommitStageRetired)?;
            self.root
                .anchor
                .directory()
                .sync_all()
                .map_err(|_| error("commit staging cleanup durability is uncertain"))?;
            require(
                metadata(prepared)?.nlink() == 0,
                "displaced receipt acquired another link",
            )?;
            require_absent(&self.root, COMPLETION_STAGE)?;
            require_absent(&self.root, ATTEMPT_RECORD)?;
            named_owned_at(
                &self.root,
                COMPLETED_RECORD,
                &stage,
                &bytes,
                &committed_snapshot,
            )
        }

        fn validate_retired(
            &self,
            proof: &impl VerifiedHealthProof,
            server: HealthyIdentity,
            archive: &File,
            bytes: &[u8],
            snapshot: &Metadata,
        ) -> Result<()> {
            self.root.validate()?;
            self.installed_app.validate()?;
            require(
                metadata(&self.file)?.nlink() == 0,
                "retired attempt acquired another link",
            )?;
            // Any new entry, including a dangling symlink, is recovery, not success.
            let name = CString::new(ATTEMPT_RECORD).expect("literal");
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            let result = unsafe {
                libc::fstatat(
                    self.root.anchor.directory().as_raw_fd(),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            require(
                result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT),
                "canonical attempt name is not validated absent",
            )?;
            require(
                self.validate_health(proof)? == server,
                "healthy server identity changed",
            )?;
            named_owned_at(&self.root, COMPLETED_RECORD, archive, bytes, snapshot)
        }

        fn open_completion(&self) -> Result<(File, Vec<u8>, Metadata)> {
            self.validate_bound()?;
            self.open_receipt_slot(COMPLETED_RECORD)
        }

        fn open_receipt_slot(&self, name: &str) -> Result<(File, Vec<u8>, Metadata)> {
            self.root.validate()?;
            let created = open_at(
                self.root.anchor.directory(),
                OsStr::new(name),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
                0o600,
            );
            let (file, existing) = match created {
                Ok(file) => (file, false),
                Err(cause) if cause.kind() == io::ErrorKind::AlreadyExists => (
                    open_at(
                        self.root.anchor.directory(),
                        OsStr::new(name),
                        libc::O_RDWR | libc::O_NONBLOCK,
                        0,
                    )
                    .map_err(|_| error("completed receipt is inaccessible or aliased"))?,
                    true,
                ),
                Err(_) => return Err(error("cannot exclusively create completed receipt")),
            };
            let snapshot = metadata(&file)?;
            private(&snapshot, false)?;
            let bytes = read_bounded(&file)?;
            named_owned_at(&self.root, name, &file, &bytes, &snapshot)?;
            if existing {
                let prior: CompletedRecord = serde_json::from_slice(&bytes).map_err(|_| {
                    error("alien or malformed completed receipt; will not overwrite")
                })?;
                validate_completion_record(&self.root, &prior, &snapshot)?;
                require(
                    prior.attempt.target.app_path.as_os_str()
                        == self.record.target.app_path.as_os_str(),
                    "completed receipt ownership/identity mismatch",
                )?;
                // Rotation is authorized by THIS live health proof, never by the
                // old receipt. Do not overwrite a different/future update chain.
                let previous = semver::Version::parse(&prior.attempt.target.target_desktop_version)
                    .map_err(|_| error("invalid previous completed version"))?;
                let source = semver::Version::parse(&self.record.target.source_desktop_version)
                    .map_err(|_| error("invalid source version"))?;
                require(
                    previous.cmp_precedence(&source).is_le()
                        || (prior.attempt.attempt_id == self.record.attempt_id
                            && prior.attempt.target == self.record.target),
                    "completed receipt belongs to a different update chain",
                )?;
            } else {
                require(
                    bytes.is_empty(),
                    "new completed receipt changed before write",
                )?;
            }
            Ok((file, bytes, snapshot))
        }
    }

    impl Drop for SuccessorAttempt {
        fn drop(&mut self) {
            if !self.root.owns_pid() {
                return;
            }
            self.root.successor_claimed.store(false, Ordering::Release);
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum ProcessStatus {
        Alive,
        Gone,
    }

    fn valid_pid(pid: u32) -> bool {
        pid > 1 && pid <= i32::MAX as u32
    }

    fn process_status(pid: u32) -> Result<ProcessStatus> {
        require(valid_pid(pid), "invalid process PID")?;
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        classify_process_status(result, io::Error::last_os_error().raw_os_error())
    }

    fn classify_process_status(result: i32, errno: Option<i32>) -> Result<ProcessStatus> {
        match (result, errno) {
            (0, _) => Ok(ProcessStatus::Alive),
            (-1, Some(libc::ESRCH)) => Ok(ProcessStatus::Gone),
            _ => Err(error("process status is unknown; startup remains blocked")),
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct HealthyIdentity {
        pid: u32,
        started_seconds: u64,
        started_microseconds: u64,
    }

    fn owned_server_identity(pid: u32, owner: u32) -> Result<HealthyIdentity> {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = std::mem::size_of::<libc::proc_bsdinfo>();
        let read = unsafe {
            libc::proc_pidinfo(
                pid as libc::pid_t,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size as libc::c_int,
            )
        };
        require(
            read == size as i32,
            "cannot establish healthy server ownership",
        )?;
        let info = unsafe { info.assume_init() };
        require(
            info.pbi_pid == pid
                && info.pbi_ppid == owner
                && info.pbi_uid == unsafe { libc::geteuid() }
                && info.pbi_status != libc::SZOMB
                && info.pbi_start_tvsec != 0,
            "healthy server is not our live owned child",
        )?;
        Ok(HealthyIdentity {
            pid,
            started_seconds: info.pbi_start_tvsec,
            started_microseconds: info.pbi_start_tvusec,
        })
    }

    fn old_owner_gone(pid: u32) -> Result<()> {
        require(pid != std::process::id(), "old attempt owner is this PID")?;
        require(
            process_status(pid)? == ProcessStatus::Gone,
            "old attempt owner is still alive",
        )
    }

    fn match_target(expected: &Target, proof: &Target) -> Result<()> {
        proof.validate()?;
        require(
            expected == proof,
            "live proof target does not match the complete attempt target",
        )
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum FinishPoint {
        ArchiveOpened,
        ArchiveTruncated,
        BeforeArchiveSync,
        ArchiveFileSynced,
        ArchiveDirectorySynced,
        BeforeRetirement,
        Retired,
        BeforeRetirementSync,
        RetirementSynced,
        CommitOpened,
        BeforeCommitFileSync,
        CommitFileSynced,
        BeforeCommitPublication,
        CommitPublished,
        BeforeCommitDirectorySync,
        CommitDirectorySynced,
        CommitStageRetired,
    }

    impl Root {
        fn owns_pid(&self) -> bool {
            std::process::id() == self.pid
        }

        fn validate(&self) -> Result<()> {
            // This MUST precede even a metadata call in copied live handles.
            require(self.owns_pid(), "attempt belongs to another PID")?;
            self.anchor.validate()?;
            private(&metadata(self.anchor.directory())?, true)
        }
    }

    impl LiveAttempt {
        #[cfg(test)]
        pub(crate) fn phase(&self) -> Phase {
            self.record.phase
        }

        #[cfg(test)]
        pub(crate) fn target(&self) -> &Target {
            &self.record.target
        }

        /// Parent MUST call immediately before its official install invocation.
        /// It does not establish G0, consent, archive verification, or OS writer
        /// termination; those are separate parent-owned gates.
        pub(crate) fn validate_install_permit(&self) -> Result<()> {
            self.validate()?;
            require(
                self.record.phase == Phase::Installing,
                "attempt is not installing",
            )?;
            self.source_app.validate()
        }

        fn validate(&self) -> Result<()> {
            require(!self.poisoned, "attempt is poisoned")?;
            named_owned(&self.root, &self.file, &self.bytes, &self.snapshot)
        }

        /// Call ONLY after the official installer has returned success AND a
        /// fresh full verification of the installed bundle. The narrow proof
        /// adapter is implemented only for the real verifier's VerifiedBundle.
        /// A successful return durably records AwaitingHealth, not completion.
        /// No bool/status/version-only overload or disk-to-live conversion exists.
        pub(crate) fn record_installed(&mut self, proof: &impl VerifiedBundleProof) -> Result<()> {
            self.installed_inner(proof, &mut |_| Ok(()))
        }

        fn installed_inner(
            &mut self,
            proof: &impl VerifiedBundleProof,
            observe: &mut dyn FnMut(SyncPoint) -> Result<()>,
        ) -> Result<()> {
            self.validate()?;
            require(
                self.record.phase == Phase::Installing,
                "attempt is not installing",
            )?;
            // The official installer legitimately replaces the source .app.
            // Do NOT compare its old inode here: freshly verified target bytes
            // are the required evidence after the caller's successful return.
            // Poison even a rejected verification. It cannot later be replaced
            // with a different claimed outcome on the same live handle.
            self.poisoned = true;
            require(
                proof.root().as_os_str() == self.record.target.app_path.as_os_str()
                    && proof.inventory_sha256() == self.record.target.inventory_sha256,
                "verified installed bundle does not match the full target inventory/path",
            )?;
            Anchor::open(proof.root())?.validate()?;
            let old_phase = self.record.phase;
            self.record.phase = Phase::AwaitingHealth;
            let bytes = encode(&self.record)?;
            self.record.phase = old_phase;
            named_owned(&self.root, &self.file, &self.bytes, &self.snapshot)?;
            // Rewrite the SAME owned inode. A crash can leave malformed JSON,
            // but never removes/replaces the canonical blocker. There is no
            // unlink/rename cleanup or authority reconstructed from that JSON.
            self.file
                .set_len(0)
                .map_err(|_| error("cannot truncate owned attempt"))?;
            self.file
                .seek(SeekFrom::Start(0))
                .map_err(|_| error("cannot rewind attempt"))?;
            observe(SyncPoint::Truncated)?;
            // Catch a substituted name/hardlink before the subsequent write.
            let truncated = metadata(&self.file)?;
            named_owned(&self.root, &self.file, &[], &truncated)?;
            persist(&self.root, &mut self.file, &bytes, observe)?;
            let snapshot = metadata(&self.file)?;
            named_owned(&self.root, &self.file, &bytes, &snapshot)?;
            self.record.phase = Phase::AwaitingHealth;
            self.bytes = bytes;
            self.snapshot = snapshot;
            self.poisoned = false;
            Ok(())
        }
    }

    impl LoadedAttempt {
        #[cfg(test)]
        pub(crate) fn load(data_root: &Path) -> Result<Option<Self>> {
            Journal::open(data_root)?.load()
        }

        pub(crate) fn phase(&self) -> Phase {
            self.record.phase
        }

        pub(crate) fn target(&self) -> &Target {
            &self.record.target
        }

        #[cfg(test)]
        pub(crate) fn matches_target(&self, expected: &Target) -> bool {
            expected.validate().is_ok() && self.record.target == *expected
        }

        #[cfg(test)]
        pub(crate) fn owner_pid(&self) -> u32 {
            self.record.owner_pid
        }

        pub(crate) fn attempt_id(&self) -> &str {
            &self.record.attempt_id
        }
    }

    /// Full descriptor chain, not just a final path check: an exchanged ancestor
    /// also fails, even if someone subsequently moves the same leaf back under it.
    struct Anchor {
        path: PathBuf,
        directories: Vec<File>,
    }

    impl Anchor {
        fn open(path: &Path) -> Result<Self> {
            canonical_path(path)?;
            let root = CString::new("/").expect("literal");
            let fd = unsafe {
                libc::open(
                    root.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                )
            };
            require(fd >= 0, "cannot open filesystem root")?;
            let mut directories = vec![unsafe { File::from_raw_fd(fd) }];
            for part in path.components() {
                if let Component::Normal(name) = part {
                    let next = open_at(
                        directories.last().expect("root descriptor"),
                        name,
                        libc::O_RDONLY | libc::O_DIRECTORY,
                        0,
                    )
                    .map_err(|_| error("directory path is missing, inaccessible, or aliased"))?;
                    directories.push(next);
                }
            }
            let anchor = Self {
                path: path.to_owned(),
                directories,
            };
            anchor.validate()?;
            Ok(anchor)
        }

        fn directory(&self) -> &File {
            self.directories.last().expect("root descriptor")
        }

        fn validate(&self) -> Result<()> {
            let names = self.path.components().filter_map(|part| match part {
                Component::Normal(name) => Some(name),
                _ => None,
            });
            for (name, pair) in names.zip(self.directories.windows(2)) {
                let current = open_at(&pair[0], name, libc::O_RDONLY | libc::O_DIRECTORY, 0)
                    .map_err(|_| error("directory anchor was replaced"))?;
                require(
                    same_inode(&metadata(&current)?, &metadata(&pair[1])?),
                    "directory anchor inode changed",
                )?;
            }
            Ok(())
        }
    }

    fn canonical_path(path: &Path) -> Result<()> {
        let text = path.to_str().ok_or_else(|| error("path must be UTF-8"))?;
        let normalized: PathBuf = path.components().collect();
        require(
            path.is_absolute()
                && text.len() <= MAX_PATH_BYTES
                && !text.chars().any(char::is_control)
                && path.as_os_str() == normalized.as_os_str()
                && !path
                    .components()
                    .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
                && path
                    .components()
                    .filter(|part| matches!(part, Component::Normal(_)))
                    .count()
                    <= 128,
            "path must be bounded, absolute and canonical",
        )
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum SyncPoint {
        Created,
        Truncated,
        BeforeWrite,
        BeforeFileSync,
        FileSynced,
        BeforeDirectorySync,
        DirectorySynced,
    }

    fn persist(
        root: &Root,
        file: &mut File,
        bytes: &[u8],
        observe: &mut dyn FnMut(SyncPoint) -> Result<()>,
    ) -> Result<()> {
        observe(SyncPoint::BeforeWrite)?;
        root.validate()?;
        // Revalidate the still-empty owned inode immediately before mutation.
        let empty = metadata(file)?;
        named_owned(root, file, &[], &empty)?;
        file.write_all(bytes)
            .map_err(|_| error("cannot write attempt"))?;
        observe(SyncPoint::BeforeFileSync)?;
        let written = metadata(file)?;
        named_owned(root, file, bytes, &written)?;
        file.sync_all()
            .map_err(|_| error("cannot synchronize attempt file"))?;
        observe(SyncPoint::FileSynced)?;
        observe(SyncPoint::BeforeDirectorySync)?;
        named_owned(root, file, bytes, &written)?;
        root.anchor
            .directory()
            .sync_all()
            .map_err(|_| error("cannot synchronize attempt directory"))?;
        observe(SyncPoint::DirectorySynced)?;
        named_owned(root, file, bytes, &written)
    }

    fn named_owned(root: &Root, owned: &File, expected: &[u8], snapshot: &Metadata) -> Result<()> {
        named_owned_at(root, ATTEMPT_RECORD, owned, expected, snapshot)
    }

    fn named_owned_at(
        root: &Root,
        name: &str,
        owned: &File,
        expected: &[u8],
        snapshot: &Metadata,
    ) -> Result<()> {
        root.validate()?;
        let file = open_at(
            root.anchor.directory(),
            OsStr::new(name),
            libc::O_RDONLY | libc::O_NONBLOCK,
            0,
        )
        .map_err(|_| error("attempt name is missing, inaccessible, or aliased"))?;
        let current = metadata(&file)?;
        let original = metadata(owned)?;
        private(&current, false)?;
        private(&original, false)?;
        require(
            same_snapshot(snapshot, &original) && same_snapshot(&original, &current),
            "attempt inode or metadata changed",
        )?;
        require(read_bounded(&file)? == expected, "attempt bytes changed")?;
        require(
            same_snapshot(&current, &metadata(&file)?),
            "attempt changed during read",
        )?;
        let final_name = open_at(
            root.anchor.directory(),
            OsStr::new(name),
            libc::O_RDONLY | libc::O_NONBLOCK,
            0,
        )
        .map_err(|_| error("attempt name changed during read"))?;
        require(
            same_snapshot(&current, &metadata(&final_name)?)
                && same_snapshot(&current, &metadata(owned)?),
            "attempt name or owned inode changed during read",
        )?;
        root.validate()
    }

    fn read_bounded(file: &File) -> Result<Vec<u8>> {
        require(
            metadata(file)?.len() <= MAX_RECORD_BYTES as u64,
            "attempt byte limit",
        )?;
        // Positional reads never share or change the live writer's file offset.
        let mut bytes = vec![0; MAX_RECORD_BYTES + 1];
        let mut used = 0;
        while used < bytes.len() {
            match file.read_at(&mut bytes[used..], used as u64) {
                Ok(0) => break,
                Ok(read) => used += read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(error("cannot read attempt")),
            }
        }
        require(used <= MAX_RECORD_BYTES, "attempt byte limit")?;
        bytes.truncate(used);
        Ok(bytes)
    }

    fn open_at(parent: &File, name: &OsStr, flags: i32, mode: libc::mode_t) -> io::Result<File> {
        let bytes = name.as_bytes();
        if bytes.is_empty()
            || bytes.len() > 255
            || bytes == b"."
            || bytes == b".."
            || bytes.contains(&b'/')
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let name = CString::new(bytes).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                mode as libc::c_uint,
            )
        };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }

    fn private(metadata: &Metadata, directory: bool) -> Result<()> {
        require(
            metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o7777 == if directory { 0o700 } else { 0o600 }
                && if directory {
                    metadata.is_dir()
                } else {
                    metadata.is_file() && metadata.nlink() == 1
                },
            "journal must be owner-private, regular and unaliased",
        )
    }

    fn same_inode(a: &Metadata, b: &Metadata) -> bool {
        a.dev() == b.dev() && a.ino() == b.ino()
    }

    fn same_snapshot(a: &Metadata, b: &Metadata) -> bool {
        same_inode(a, b)
            && a.len() == b.len()
            && a.mode() == b.mode()
            && a.nlink() == b.nlink()
            && a.uid() == b.uid()
            && a.gid() == b.gid()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    }

    fn metadata(file: &File) -> Result<Metadata> {
        file.metadata()
            .map_err(|_| error("cannot inspect journal descriptor"))
    }

    fn encode(record: &Record) -> Result<Vec<u8>> {
        let bytes = serde_json::to_vec(record).map_err(|_| error("cannot encode attempt"))?;
        require(bytes.len() <= MAX_RECORD_BYTES, "attempt byte limit")?;
        Ok(bytes)
    }

    fn lower_hex(text: &str, length: usize) -> bool {
        text.len() == length
            && text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    fn random_id() -> Result<String> {
        let mut bytes = [0; 16];
        getrandom::getrandom(&mut bytes).map_err(|_| error("cannot allocate attempt identity"))?;
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut id = String::with_capacity(32);
        for byte in bytes {
            id.push(HEX[(byte >> 4) as usize] as char);
            id.push(HEX[(byte & 15) as usize] as char);
        }
        Ok(id)
    }

    fn error(message: &str) -> String {
        format!("Desktop update attempt: {message}.")
    }

    fn require(condition: bool, message: &str) -> Result<()> {
        if condition {
            Ok(())
        } else {
            Err(error(message))
        }
    }

    #[cfg(test)]
    mod journal_tests {
        use super::*;
        use crate::updater_attempt::check;
        use std::{
            fs::{self, DirBuilder, OpenOptions},
            os::unix::{
                fs::{symlink, DirBuilderExt, OpenOptionsExt, PermissionsExt},
                net::UnixListener,
            },
            panic::{catch_unwind, AssertUnwindSafe},
            process::{Command, ExitStatus, Stdio},
            time::{Duration, Instant},
        };

        struct Fixture {
            temp: PathBuf,
            root: PathBuf,
            app: PathBuf,
        }

        impl Fixture {
            fn new() -> Self {
                // Keep AF_UNIX fixture paths below macOS's small sun_path limit.
                let temp = fs::canonicalize("/tmp").unwrap().join(format!(
                    "gjc-attempt-{}-{}",
                    std::process::id(),
                    &random_id().unwrap()[..16]
                ));
                private_dir(&temp);
                let root = temp.join("data");
                let app = temp.join("Fixture.app");
                private_dir(&root);
                private_dir(&app);
                write_private(
                    &app.join("untouched-fixture"),
                    b"not an installed application",
                );
                Self { temp, root, app }
            }

            fn target(&self) -> Target {
                target_for(&self.app)
            }

            fn record(&self) -> PathBuf {
                self.root.join(ATTEMPT_RECORD)
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                // Only this test's randomly allocated temp tree, after joining
                // all children. Never an installed application or real data root.
                let _ = fs::remove_dir_all(&self.temp);
            }
        }

        fn private_dir(path: &Path) {
            DirBuilder::new().mode(0o700).create(path).unwrap();
        }

        fn write_private(path: &Path, bytes: &[u8]) {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .unwrap();
            file.write_all(bytes).unwrap();
        }

        fn after_descriptor_release<T>(mut operation: impl FnMut() -> Result<T>) -> T {
            // A parallel fork/posix_spawn can briefly retain our just-dropped
            // flock until exec closes its CLOEXEC descriptor. Product APIs
            // remain nonblocking and fail closed; only this test helper waits.
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                match operation() {
                    Ok(value) => return value,
                    Err(message)
                        if message.contains("another journal owner")
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(message) => panic!("{message}"),
                }
            }
        }

        fn target_for(app: &Path) -> Target {
            Target {
                app_path: app.to_owned(),
                source_desktop_version: "1.0.0".into(),
                target_desktop_version: "1.1.0".into(),
                target_product_version: "2.0.0-beta.10".into(),
                archive_sha256: "a".repeat(64),
                inventory_sha256: "b".repeat(64),
                runtime_manifest_sha256: "c".repeat(64),
            }
        }

        // Unit-only proof projection exercises the journal's state/ownership
        // boundary, NOT inventory verification or official installation. Product
        // callers implement the trait only for the real opaque VerifiedBundle;
        // its full-tree verification is tested in updater_bundle.rs.
        struct ProofProjection {
            path: PathBuf,
            digest: String,
        }

        impl ProofProjection {
            fn for_target(target: &Target) -> Self {
                Self {
                    path: target.app_path.clone(),
                    digest: target.inventory_sha256.clone(),
                }
            }
        }

        impl VerifiedBundleProof for ProofProjection {
            fn root(&self) -> &Path {
                &self.path
            }
            fn inventory_sha256(&self) -> &str {
                &self.digest
            }
        }

        impl proof_seal::Sealed for ProofProjection {}

        #[test]
        fn permit_follows_both_sync_barriers_and_only_mutates_canonical_journal() {
            let fixture = Fixture::new();
            write_private(&fixture.root.join("unrelated"), b"keep me");
            let journal = Journal::open(&fixture.root).unwrap();
            assert!(journal.load().unwrap().is_none());
            assert!(check(&fixture.root).is_ok());
            let mut stages = Vec::new();
            let attempt = journal
                .begin_inner(fixture.target(), &mut |point| {
                    stages.push(point);
                    assert!(check(&fixture.root).is_err());
                    Ok(())
                })
                .unwrap();
            assert_eq!(
                stages,
                [
                    SyncPoint::Created,
                    SyncPoint::BeforeWrite,
                    SyncPoint::BeforeFileSync,
                    SyncPoint::FileSynced,
                    SyncPoint::BeforeDirectorySync,
                    SyncPoint::DirectorySynced
                ]
            );
            attempt.validate_install_permit().unwrap();
            assert_eq!(attempt.phase(), Phase::Installing);
            assert_eq!(attempt.target(), &fixture.target());
            assert_eq!(journal.load().unwrap().unwrap().target(), &fixture.target());
            let metadata = fs::metadata(fixture.record()).unwrap();
            assert_eq!(metadata.mode() & 0o7777, 0o600);
            assert_eq!(metadata.nlink(), 1);
            assert_eq!(
                fs::read(fixture.root.join("unrelated")).unwrap(),
                b"keep me"
            );
            assert_eq!(
                fs::read(fixture.app.join("untouched-fixture")).unwrap(),
                b"not an installed application"
            );
            assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 2);
        }

        #[test]
        fn sync_errors_and_partial_publication_never_return_a_permit_or_remove_blocker() {
            for fail in [
                SyncPoint::Created,
                SyncPoint::BeforeWrite,
                SyncPoint::BeforeFileSync,
                SyncPoint::FileSynced,
                SyncPoint::BeforeDirectorySync,
                SyncPoint::DirectorySynced,
            ] {
                let fixture = Fixture::new();
                let journal = Journal::open(&fixture.root).unwrap();
                assert!(
                    journal
                        .begin_inner(fixture.target(), &mut |point| {
                            if point == fail {
                                Err(error("injected sync failure"))
                            } else {
                                Ok(())
                            }
                        })
                        .is_err(),
                    "{fail:?}"
                );
                let before = fs::read(fixture.record()).unwrap();
                assert!(check(&fixture.root).is_err());
                assert!(journal.begin(fixture.target()).is_err());
                drop(journal);
                let reopened = after_descriptor_release(|| Journal::open(&fixture.root));
                assert!(reopened.begin(fixture.target()).is_err());
                assert_eq!(fs::read(fixture.record()).unwrap(), before);
            }
        }

        #[test]
        fn drop_and_unwind_leave_inspectable_installing_without_resumption() {
            for panic in [false, true] {
                let fixture = Fixture::new();
                let journal = Journal::open(&fixture.root).unwrap();
                let result = catch_unwind(AssertUnwindSafe(|| {
                    let _attempt = journal.begin(fixture.target()).unwrap();
                    assert!(!panic, "injected abandoned install");
                }));
                assert_eq!(result.is_err(), panic);
                drop(journal);
                let loaded =
                    after_descriptor_release(|| LoadedAttempt::load(&fixture.root)).unwrap();
                assert_eq!(loaded.phase(), Phase::Installing);
                assert_eq!(loaded.owner_pid(), std::process::id());
                assert_eq!(loaded.attempt_id().len(), 32);
                assert!(loaded.matches_target(&fixture.target()));
                assert!(check(&fixture.root).is_err());
                assert!(Journal::open(&fixture.root)
                    .unwrap()
                    .begin(fixture.target())
                    .is_err());
            }
        }

        #[test]
        fn installed_transition_is_durable_but_never_acknowledges_health_or_clears() {
            let fixture = Fixture::new();
            let journal = Journal::open(&fixture.root).unwrap();
            let mut attempt = journal.begin(fixture.target()).unwrap();
            let inode = fs::metadata(fixture.record()).unwrap().ino();
            let proof = ProofProjection::for_target(&fixture.target());
            let mut stages = Vec::new();
            attempt
                .installed_inner(&proof, &mut |point| {
                    stages.push(point);
                    Ok(())
                })
                .unwrap();
            assert_eq!(
                stages,
                [
                    SyncPoint::Truncated,
                    SyncPoint::BeforeWrite,
                    SyncPoint::BeforeFileSync,
                    SyncPoint::FileSynced,
                    SyncPoint::BeforeDirectorySync,
                    SyncPoint::DirectorySynced
                ]
            );
            assert_eq!(attempt.phase(), Phase::AwaitingHealth);
            assert!(attempt.validate_install_permit().is_err());
            assert!(attempt.record_installed(&proof).is_err());
            assert_eq!(fs::metadata(fixture.record()).unwrap().ino(), inode);
            assert_eq!(
                journal.load().unwrap().unwrap().phase(),
                Phase::AwaitingHealth
            );
            drop(attempt);
            drop(journal);
            let loaded = after_descriptor_release(|| LoadedAttempt::load(&fixture.root)).unwrap();
            assert_eq!(loaded.phase(), Phase::AwaitingHealth);
            assert!(loaded.matches_target(&fixture.target()));
            assert!(check(&fixture.root).is_err());
            assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 1);
        }

        #[test]
        fn a_build_without_an_updater_sets_aside_only_the_attempt_that_installed_it() {
            let fixture = Fixture::new();
            let compiled = |desktop: &'static str| super::super::CompiledIdentity {
                desktop_version: desktop,
                product_version: "2.0.0-beta.10",
                runtime_manifest_sha256:
                    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            };
            // Nothing pending: nothing to set aside, nothing changes.
            assert!(super::super::set_aside_unverifiable(
                &fixture.root,
                &fixture.app,
                &compiled("1.1.0")
            )
            .is_err());
            let journal = after_descriptor_release(|| Journal::open(&fixture.root));
            let mut attempt = journal.begin(fixture.target()).unwrap();
            // An install permit (not yet installed) must stay blocked.
            assert!(super::super::set_aside_unverifiable(
                &fixture.root,
                &fixture.app,
                &compiled("1.1.0")
            )
            .is_err());
            assert!(check(&fixture.root).is_err());
            attempt
                .record_installed(&ProofProjection::for_target(&fixture.target()))
                .unwrap();
            drop(attempt);
            drop(journal);
            // A different binary, bundle path or payload cannot claim the attempt.
            for (app, identity) in [
                (fixture.app.clone(), compiled("1.0.0")),
                (fixture.temp.join("Other.app"), compiled("1.1.0")),
                (
                    fixture.app.clone(),
                    super::super::CompiledIdentity {
                        runtime_manifest_sha256:
                            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                        ..compiled("1.1.0")
                    },
                ),
            ] {
                let error =
                    after_descriptor_release(|| {
                        match super::super::set_aside_unverifiable(&fixture.root, &app, &identity) {
                            Err(message) if message.contains("another journal owner") => {
                                Err(message)
                            }
                            other => Ok(other),
                        }
                    });
                assert!(error.is_err(), "{app:?}");
                assert!(check(&fixture.root).is_err());
            }
            // The exact installed successor: the record is renamed, not deleted,
            // startup is admitted, and a second call has nothing to do.
            let aside = after_descriptor_release(|| {
                match super::super::set_aside_unverifiable(
                    &fixture.root,
                    &fixture.app,
                    &compiled("1.1.0"),
                ) {
                    Err(message) if message.contains("another journal owner") => Err(message),
                    other => Ok(other),
                }
            })
            .unwrap();
            assert!(check(&fixture.root).is_ok());
            assert!(!fixture.record().exists());
            assert!(aside
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("desktop-update-attempt.unverified-"));
            assert!(fs::metadata(&aside).unwrap().len() > 0);
            assert!(super::super::set_aside_unverifiable(
                &fixture.root,
                &fixture.app,
                &compiled("1.1.0")
            )
            .is_err());
            assert!(after_descriptor_release(|| Journal::open(&fixture.root))
                .load()
                .unwrap()
                .is_none());
        }

        #[test]
        fn transition_sync_failures_and_panics_poison_handle_and_retain_blocker() {
            for panic in [false, true] {
                for fail in [
                    SyncPoint::Truncated,
                    SyncPoint::BeforeWrite,
                    SyncPoint::BeforeFileSync,
                    SyncPoint::FileSynced,
                    SyncPoint::BeforeDirectorySync,
                    SyncPoint::DirectorySynced,
                ] {
                    let fixture = Fixture::new();
                    let journal = Journal::open(&fixture.root).unwrap();
                    let mut attempt = journal.begin(fixture.target()).unwrap();
                    let proof = ProofProjection::for_target(&fixture.target());
                    let result = catch_unwind(AssertUnwindSafe(|| {
                        attempt.installed_inner(&proof, &mut |point| {
                            if point == fail {
                                assert!(!panic, "injected transition unwind");
                                Err(error("injected transition sync failure"))
                            } else {
                                Ok(())
                            }
                        })
                    }));
                    assert!(result.is_err() || result.unwrap().is_err());
                    let before = fs::read(fixture.record()).unwrap();
                    assert!(attempt.validate_install_permit().is_err());
                    assert!(attempt.record_installed(&proof).is_err());
                    assert!(check(&fixture.root).is_err());
                    assert_eq!(fs::read(fixture.record()).unwrap(), before);
                }
            }
        }

        #[test]
        fn mismatched_bundle_path_or_inventory_never_records_installed() {
            for path in [false, true] {
                let fixture = Fixture::new();
                let journal = Journal::open(&fixture.root).unwrap();
                let mut attempt = journal.begin(fixture.target()).unwrap();
                let mut proof = ProofProjection::for_target(&fixture.target());
                if path {
                    proof.path = fixture.temp.join("Different.app");
                } else {
                    proof.digest = "d".repeat(64);
                }
                let before = fs::read(fixture.record()).unwrap();
                assert!(attempt.record_installed(&proof).is_err());
                assert!(attempt
                    .record_installed(&ProofProjection::for_target(&fixture.target()))
                    .is_err());
                assert_eq!(fs::read(fixture.record()).unwrap(), before);
                assert_eq!(journal.load().unwrap().unwrap().phase(), Phase::Installing);
            }
        }

        #[test]
        fn inspection_matches_every_target_field_not_just_versions_and_tolerates_missing_app() {
            let fixture = Fixture::new();
            let journal = Journal::open(&fixture.root).unwrap();
            drop(journal.begin(fixture.target()).unwrap());
            let loaded = journal.load().unwrap().unwrap();
            for field in 0..7 {
                let mut other = fixture.target();
                match field {
                    0 => other.app_path = fixture.temp.join("Other.app"),
                    1 => other.source_desktop_version = "0.9.0".into(),
                    2 => other.target_desktop_version = "9.0.0".into(),
                    3 => other.target_product_version = "9.0.0".into(),
                    4 => other.archive_sha256 = "d".repeat(64),
                    5 => other.inventory_sha256 = "d".repeat(64),
                    _ => other.runtime_manifest_sha256 = "d".repeat(64),
                }
                assert!(!loaded.matches_target(&other), "field {field}");
            }
            fs::rename(&fixture.app, fixture.temp.join("missing-fixture-app")).unwrap();
            assert!(journal
                .load()
                .unwrap()
                .unwrap()
                .matches_target(&fixture.target()));
            assert!(check(&fixture.root).is_err());
        }

        #[test]
        fn target_bounds_types_versions_and_canonical_app_paths_are_enforced_before_create() {
            let fixture = Fixture::new();
            let journal = Journal::open(&fixture.root).unwrap();
            symlink(&fixture.app, fixture.temp.join("Alias.app")).unwrap();
            write_private(&fixture.temp.join("File.app"), b"not directory");
            for case in 0..19 {
                let mut target = fixture.target();
                match case {
                    0 => target.app_path = PathBuf::from("relative.app"),
                    1 => target.app_path = fixture.temp.join("Alias.app"),
                    2 => target.app_path = fixture.temp.join("File.app"),
                    3 => target.app_path = fixture.temp.join("Missing.app"),
                    4 => target.app_path = fixture.root.clone(),
                    5 => target.app_path = fixture.temp.join("../Fixture.app"),
                    6 => target.app_path = fixture.temp.join("./Fixture.app"),
                    7 => {
                        target.app_path =
                            PathBuf::from(format!("{}//Fixture.app", fixture.temp.display()))
                    }
                    8 => target.app_path = fixture.temp.join("Nul\0.app"),
                    9 => {
                        target.app_path = fixture
                            .temp
                            .join(format!("{}.app", "a".repeat(MAX_PATH_BYTES)))
                    }
                    10 => target.source_desktop_version = "1.0".into(),
                    11 => target.target_desktop_version = "01.0.0".into(),
                    12 => target.target_product_version = "bad".into(),
                    13 => {
                        target.target_product_version =
                            format!("1.0.0-{}", "a".repeat(MAX_VERSION_BYTES))
                    }
                    14 => target.archive_sha256 = "A".repeat(64),
                    15 => target.inventory_sha256 = "b".repeat(63),
                    16 => target.runtime_manifest_sha256 = "g".repeat(64),
                    17 => target.app_path = fixture.temp.join(".app"),
                    _ => target.app_path = PathBuf::from(format!("{}/", fixture.app.display())),
                }
                assert!(journal.begin(target).is_err(), "case {case}");
                assert!(!fixture.record().exists());
            }
        }

        #[test]
        fn open_never_creates_or_repairs_roots_and_rejects_unsafe_ancestors() {
            let fixture = Fixture::new();
            let missing = fixture.temp.join("absent/data");
            assert!(Journal::open(&missing).is_err());
            assert!(!fixture.temp.join("absent").exists());
            assert!(Journal::open(Path::new("relative")).is_err());
            assert!(Journal::open(&fixture.root.join("..")).is_err());
            symlink(&fixture.root, fixture.temp.join("alias")).unwrap();
            assert!(Journal::open(&fixture.temp.join("alias")).is_err());
            assert!(Journal::open(&fixture.temp.join("alias/absent")).is_err());
            for mode in [0o755, 0o750, 0o770, 0o1700] {
                fs::set_permissions(&fixture.root, fs::Permissions::from_mode(mode)).unwrap();
                assert!(Journal::open(&fixture.root).is_err());
                assert_eq!(fs::metadata(&fixture.root).unwrap().mode() & 0o7777, mode);
            }
            fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o700)).unwrap();
            assert!(Journal::open(&fixture.root).is_ok());
            assert!(fs::read_dir(&fixture.root).unwrap().next().is_none());
        }

        #[test]
        fn malformed_oversized_unknown_and_forged_identity_records_remain_untouched() {
            for case in 0..14 {
                let fixture = Fixture::new();
                let journal = Journal::open(&fixture.root).unwrap();
                drop(journal.begin(fixture.target()).unwrap());
                let mut value: serde_json::Value =
                    serde_json::from_slice(&fs::read(fixture.record()).unwrap()).unwrap();
                match case {
                    0 => value["schema"] = 2.into(),
                    1 => value["extra"] = true.into(),
                    2 => value["phase"] = "archive_verified_success".into(),
                    3 => value["phase"] = "relaunch".into(),
                    4 => value["root_inode"] = 0.into(),
                    5 => value["record_inode"] = 0.into(),
                    6 => value["attempt_id"] = "forged".into(),
                    7 => value["owner_pid"] = 0.into(),
                    8 => value["data_root"] = "/wrong-root".into(),
                    9 => value["target"]["archive_sha256"] = 7.into(),
                    10 => value["target"]["extra"] = true.into(),
                    _ => {}
                }
                let body = match case {
                    11 => vec![],
                    12 => b"not json".to_vec(),
                    13 => vec![b' '; MAX_RECORD_BYTES + 1],
                    _ => serde_json::to_vec(&value).unwrap(),
                };
                fs::write(fixture.record(), &body).unwrap();
                assert!(journal.load().is_err(), "case {case}");
                assert!(journal.begin(fixture.target()).is_err());
                assert!(check(&fixture.root).is_err());
                assert_eq!(fs::read(fixture.record()).unwrap(), body);
            }
        }

        #[test]
        fn present_symlink_hardlink_directory_fifo_socket_and_public_file_refuse_without_hanging() {
            for kind in 0..7 {
                let fixture = Fixture::new();
                let journal = Journal::open(&fixture.root).unwrap();
                let outside = fixture.temp.join("outside-data-root");
                write_private(&outside, b"do not modify");
                let _socket = match kind {
                    0 => {
                        symlink(&outside, fixture.record()).unwrap();
                        None
                    }
                    1 => {
                        symlink(fixture.temp.join("missing"), fixture.record()).unwrap();
                        None
                    }
                    2 => {
                        fs::hard_link(&outside, fixture.record()).unwrap();
                        None
                    }
                    3 => {
                        private_dir(&fixture.record());
                        None
                    }
                    4 => {
                        let name = CString::new(fixture.record().as_os_str().as_bytes()).unwrap();
                        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                        None
                    }
                    5 => Some(UnixListener::bind(fixture.record()).unwrap()),
                    _ => {
                        write_private(&fixture.record(), b"public");
                        fs::set_permissions(fixture.record(), fs::Permissions::from_mode(0o644))
                            .unwrap();
                        None
                    }
                };
                let start = Instant::now();
                assert!(journal.load().is_err());
                assert!(journal.begin(fixture.target()).is_err());
                assert!(check(&fixture.root).is_err());
                assert!(start.elapsed() < Duration::from_secs(1));
                assert_eq!(fs::read(outside).unwrap(), b"do not modify");
            }
        }

        #[test]
        fn live_inode_bytes_link_and_mode_substitutions_refuse_without_mutating_either_file() {
            for kind in 0..6 {
                let fixture = Fixture::new();
                let journal = Journal::open(&fixture.root).unwrap();
                let mut attempt = journal.begin(fixture.target()).unwrap();
                let bytes = fs::read(fixture.record()).unwrap();
                let saved = fixture.root.join("saved-owned.json");
                match kind {
                    0 => {
                        fs::rename(fixture.record(), &saved).unwrap();
                        write_private(&fixture.record(), &bytes);
                    }
                    1 => {
                        fs::rename(fixture.record(), &saved).unwrap();
                        symlink(&saved, fixture.record()).unwrap();
                    }
                    2 => {
                        fs::hard_link(fixture.record(), &saved).unwrap();
                    }
                    3 => {
                        fs::write(fixture.record(), b"changed").unwrap();
                    }
                    4 => {
                        fs::set_permissions(fixture.record(), fs::Permissions::from_mode(0o640))
                            .unwrap();
                    }
                    _ => {
                        fs::rename(fixture.record(), &saved).unwrap();
                        private_dir(&fixture.record());
                    }
                }
                let before = read_bounded(&attempt.file).unwrap();
                assert!(attempt.validate_install_permit().is_err());
                assert!(attempt
                    .record_installed(&ProofProjection::for_target(&fixture.target()))
                    .is_err());
                assert_eq!(read_bounded(&attempt.file).unwrap(), before);
                assert!(check(&fixture.root).is_err());
                if kind == 0 {
                    assert!(journal.load().is_err());
                }
            }
        }

        #[test]
        fn root_and_ancestor_swaps_refuse_including_same_leaf_moved_under_replacement_parent() {
            for ancestor in [false, true] {
                let fixture = Fixture::new();
                let parent = fixture.root.join("parent");
                private_dir(&parent);
                let root = parent.join("private-data");
                private_dir(&root);
                let journal = Journal::open(&root).unwrap();
                let mut attempt = journal.begin(fixture.target()).unwrap();
                let before = read_bounded(&attempt.file).unwrap();
                if ancestor {
                    let moved = fixture.root.join("moved-parent");
                    fs::rename(&parent, &moved).unwrap();
                    private_dir(&parent);
                    fs::rename(moved.join("private-data"), &root).unwrap();
                } else {
                    fs::rename(&root, parent.join("moved-root")).unwrap();
                    private_dir(&root);
                }
                assert!(attempt.validate_install_permit().is_err());
                assert!(attempt
                    .record_installed(&ProofProjection::for_target(&fixture.target()))
                    .is_err());
                assert!(journal.begin(fixture.target()).is_err());
                assert!(journal.load().is_err());
                assert_eq!(read_bounded(&attempt.file).unwrap(), before);
            }
        }

        #[test]
        fn publication_boundary_swaps_never_grant_permit_or_touch_an_outside_target() {
            for point in [
                SyncPoint::Created,
                SyncPoint::BeforeWrite,
                SyncPoint::BeforeFileSync,
                SyncPoint::BeforeDirectorySync,
                SyncPoint::DirectorySynced,
            ] {
                let fixture = Fixture::new();
                let journal = Journal::open(&fixture.root).unwrap();
                let outside = fixture.temp.join("outside");
                write_private(&outside, b"untouched outside bytes");
                assert!(journal
                    .begin_inner(fixture.target(), &mut |current| {
                        if current == point {
                            fs::rename(fixture.record(), fixture.root.join("saved-owned")).unwrap();
                            symlink(&outside, fixture.record()).unwrap();
                        }
                        Ok(())
                    })
                    .is_err());
                assert_eq!(fs::read(outside).unwrap(), b"untouched outside bytes");
                assert!(check(&fixture.root).is_err());
            }
        }

        #[test]
        fn transition_boundary_substitution_never_writes_through_an_outside_alias() {
            for point in [
                SyncPoint::Truncated,
                SyncPoint::BeforeWrite,
                SyncPoint::BeforeFileSync,
                SyncPoint::BeforeDirectorySync,
                SyncPoint::DirectorySynced,
            ] {
                let fixture = Fixture::new();
                let journal = Journal::open(&fixture.root).unwrap();
                let mut attempt = journal.begin(fixture.target()).unwrap();
                let proof = ProofProjection::for_target(&fixture.target());
                let outside = fixture.temp.join("outside");
                write_private(&outside, b"untouched outside bytes");
                assert!(attempt
                    .installed_inner(&proof, &mut |current| {
                        if current == point {
                            fs::rename(fixture.record(), fixture.root.join("saved-owned")).unwrap();
                            symlink(&outside, fixture.record()).unwrap();
                        }
                        Ok(())
                    })
                    .is_err());
                assert!(attempt.record_installed(&proof).is_err());
                assert_eq!(fs::read(outside).unwrap(), b"untouched outside bytes");
                assert!(check(&fixture.root).is_err());
            }
        }

        #[test]
        fn app_path_swaps_refuse_pre_apply_but_legitimate_replacement_can_await_health() {
            for symlink_replacement in [false, true] {
                let fixture = Fixture::new();
                let journal = Journal::open(&fixture.root).unwrap();
                let mut attempt = journal.begin(fixture.target()).unwrap();
                let old = fixture.temp.join("old-Fixture.app");
                fs::rename(&fixture.app, &old).unwrap();
                if symlink_replacement {
                    symlink(&old, &fixture.app).unwrap();
                } else {
                    private_dir(&fixture.app);
                }
                assert!(attempt.validate_install_permit().is_err());
                let proof = ProofProjection::for_target(&fixture.target());
                let result = attempt.record_installed(&proof);
                if symlink_replacement {
                    assert!(result.is_err());
                } else {
                    // Unit-level projection of the legitimate post-install path;
                    // no installer was called and no real app was touched.
                    result.unwrap();
                    assert_eq!(attempt.phase(), Phase::AwaitingHealth);
                }
                assert!(check(&fixture.root).is_err());
            }
        }

        #[test]
        fn copied_record_in_a_different_root_never_becomes_a_loaded_or_live_permit() {
            let fixture = Fixture::new();
            let other = fixture.temp.join("other-data");
            private_dir(&other);
            let journal = Journal::open(&fixture.root).unwrap();
            drop(journal.begin(fixture.target()).unwrap());
            write_private(
                &other.join(ATTEMPT_RECORD),
                &fs::read(fixture.record()).unwrap(),
            );
            let copied = Journal::open(&other).unwrap();
            assert!(copied.load().is_err());
            assert!(copied.begin(fixture.target()).is_err());
            assert!(check(&other).is_err());
        }

        #[test]
        fn exclusive_directory_lock_survives_journal_drop_while_permit_is_live() {
            let fixture = Fixture::new();
            let journal = Journal::open(&fixture.root).unwrap();
            assert!(Journal::open(&fixture.root).is_err());
            let attempt = journal.begin(fixture.target()).unwrap();
            drop(journal);
            assert!(Journal::open(&fixture.root).is_err());
            drop(attempt);
            let reopened = after_descriptor_release(|| Journal::open(&fixture.root));
            assert!(reopened.load().unwrap().is_some());
            assert!(reopened.begin(fixture.target()).is_err());
        }

        #[test]
        fn copied_pid_refuses_all_live_operations_before_filesystem_checks() {
            let fixture = Fixture::new();
            let mut journal = Journal::open(&fixture.root).unwrap();
            Arc::get_mut(&mut journal.root).unwrap().pid = std::process::id() + 1;
            assert!(journal.load().unwrap_err().contains("another PID"));
            assert!(journal.begin(fixture.target()).is_err());
            assert!(!fixture.record().exists());
            Arc::get_mut(&mut journal.root).unwrap().pid = std::process::id();
            let mut attempt = journal.begin(fixture.target()).unwrap();
            drop(journal);
            Arc::get_mut(&mut attempt.root).unwrap().pid = std::process::id() + 1;
            let before = fs::read(fixture.record()).unwrap();
            assert!(attempt
                .validate_install_permit()
                .unwrap_err()
                .contains("another PID"));
            assert!(attempt
                .record_installed(&ProofProjection::for_target(&fixture.target()))
                .is_err());
            assert_eq!(fs::read(fixture.record()).unwrap(), before);
        }

        #[test]
        fn actual_fork_copy_fails_the_same_pid_fence_used_by_every_operation() {
            let fixture = Fixture::new();
            // Isolate the fork from parallel tests' directory-lock descriptors.
            assert_eq!(child(&fixture, "fork").code(), Some(75));
            assert!(check(&fixture.root).is_err());
        }

        fn child(fixture: &Fixture, scenario: &str) -> ExitStatus {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "updater_attempt::durable::journal_tests::process_fault_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("GJC_DURABLE_ATTEMPT_TEST_ROOT", &fixture.root)
                .env("GJC_DURABLE_ATTEMPT_TEST_APP", &fixture.app)
                .env("GJC_DURABLE_ATTEMPT_TEST_FAULT", scenario)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    return status;
                }
                if Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("owned journal test child timed out");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        #[test]
        fn crash_orphans_before_after_sync_and_during_transition_always_block_successor() {
            for scenario in [
                "created",
                "before-file-sync",
                "file-synced",
                "directory-synced",
                "live",
                "truncated",
                "installed",
            ] {
                let fixture = Fixture::new();
                assert_eq!(child(&fixture, scenario).code(), Some(73), "{scenario}");
                assert!(check(&fixture.root).is_err());
                let journal = Journal::open(&fixture.root).unwrap();
                assert!(journal.begin(fixture.target()).is_err());
                if scenario == "installed" {
                    assert_eq!(
                        journal.load().unwrap().unwrap().phase(),
                        Phase::AwaitingHealth
                    );
                }
                assert_eq!(
                    fs::read(fixture.app.join("untouched-fixture")).unwrap(),
                    b"not an installed application"
                );
            }
        }

        #[test]
        fn another_process_cannot_open_live_journal() {
            let fixture = Fixture::new();
            let _journal = Journal::open(&fixture.root).unwrap();
            assert_eq!(child(&fixture, "duplicate").code(), Some(74));
            assert!(!fixture.record().exists());
        }

        mod successor_tests {
            use super::*;
            use std::io::Read;

            struct SuccessorProjection(Target);
            impl proof_seal::Sealed for SuccessorProjection {}
            impl VerifiedSuccessorProof for SuccessorProjection {
                fn target(&self) -> &Target {
                    &self.0
                }
            }

            struct HealthProjection {
                target: Target,
                pid: u32,
            }
            impl proof_seal::Sealed for HealthProjection {}
            impl VerifiedHealthProof for HealthProjection {
                fn target(&self) -> &Target {
                    &self.target
                }
                fn server_pid(&self) -> u32 {
                    self.pid
                }
            }

            // These projections exercise only journal authority/state handling.
            // A pipe-bound cat is an owned PID fixture, NOT an application server
            // or evidence of real ready/health/persistence, install or G0/G5 success.
            struct OwnedChild(std::process::Child);
            impl OwnedChild {
                fn server() -> Self {
                    Self(
                        Command::new("/bin/cat")
                            .stdin(Stdio::piped())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .spawn()
                            .unwrap(),
                    )
                }
                fn proof(&self, target: &Target) -> HealthProjection {
                    HealthProjection {
                        target: target.clone(),
                        pid: self.0.id(),
                    }
                }
                fn wait(&mut self) -> ExitStatus {
                    let deadline = Instant::now() + Duration::from_secs(10);
                    loop {
                        if let Some(status) = self.0.try_wait().unwrap() {
                            return status;
                        }
                        assert!(
                            Instant::now() < deadline,
                            "owned successor test child timed out"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }
            impl Drop for OwnedChild {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }

            fn spawn_role(fixture: &Fixture, target: &Target, role: &str) -> OwnedChild {
                OwnedChild(Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "updater_attempt::durable::journal_tests::successor_tests::process_successor_child",
                        "--ignored", "--nocapture"])
                    .env("GJC_SUCCESSOR_TEST_ROOT", &fixture.root)
                    .env("GJC_SUCCESSOR_TEST_TARGET", serde_json::to_string(target).unwrap())
                    .env("GJC_SUCCESSOR_TEST_ROLE", role)
                    .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                    .spawn().unwrap())
            }

            fn publish(fixture: &Fixture, target: &Target, role: &str) {
                assert_eq!(spawn_role(fixture, target, role).wait().code(), Some(81));
            }

            fn prepared(fixture: &Fixture) -> (Journal, LoadedAttempt, SuccessorProjection) {
                publish(fixture, &fixture.target(), "publish");
                let journal = after_descriptor_release(|| Journal::open(&fixture.root));
                let loaded = journal.load().unwrap().unwrap();
                let proof = SuccessorProjection(fixture.target());
                (journal, loaded, proof)
            }

            #[test]
            fn real_process_exit_resume_is_read_only_and_requires_an_independent_live_proof() {
                let fixture = Fixture::new();
                let (journal, loaded, proof) = prepared(&fixture);
                let before = fs::read(fixture.record()).unwrap();
                let before_stat = fs::metadata(fixture.record()).unwrap();
                assert_ne!(loaded.owner_pid(), std::process::id());
                assert_eq!(
                    process_status(loaded.owner_pid()).unwrap(),
                    ProcessStatus::Gone
                );
                let successor = journal.resume_verified(&loaded, &proof).unwrap();
                successor.validate_startup(&proof).unwrap();
                assert_eq!(successor.target(), &fixture.target());
                assert_eq!(fs::read(fixture.record()).unwrap(), before);
                assert!(same_snapshot(
                    &before_stat,
                    &fs::metadata(fixture.record()).unwrap()
                ));
                assert!(!fixture.root.join(COMPLETED_RECORD).exists());
                assert!(journal.resume_verified(&loaded, &proof).is_err());
                assert!(journal.load().is_err());
                assert!(journal.begin(fixture.target()).is_err());
                assert!(check(&fixture.root).is_err());
                drop(successor);
                assert!(check(&fixture.root).is_err());
                journal
                    .resume_verified(&loaded, &proof)
                    .unwrap()
                    .validate_startup(&proof)
                    .unwrap();
            }

            #[test]
            fn installing_same_pid_live_old_pid_and_unknown_process_status_refuse() {
                let fixture = Fixture::new();
                publish(&fixture, &fixture.target(), "publish-installing");
                let journal = Journal::open(&fixture.root).unwrap();
                let loaded = journal.load().unwrap().unwrap();
                assert!(journal
                    .resume_verified(&loaded, &SuccessorProjection(fixture.target()))
                    .is_err());
                let other = Fixture::new();
                let same = Journal::open(&other.root).unwrap();
                let mut attempt = same.begin(other.target()).unwrap();
                attempt
                    .record_installed(&ProofProjection::for_target(&other.target()))
                    .unwrap();
                drop(attempt);
                assert!(same
                    .resume_verified(
                        &same.load().unwrap().unwrap(),
                        &SuccessorProjection(other.target())
                    )
                    .is_err());

                let live = Fixture::new();
                let owner = spawn_role(&live, &live.target(), "publish-live");
                let deadline = Instant::now() + Duration::from_secs(10);
                let (journal, loaded) = loop {
                    if let Ok(bytes) = fs::read(live.record()) {
                        if serde_json::from_slice::<Record>(&bytes)
                            .is_ok_and(|r| r.phase == Phase::AwaitingHealth)
                        {
                            if let Ok(journal) = Journal::open(&live.root) {
                                let loaded = journal.load().unwrap().unwrap();
                                break (journal, loaded);
                            }
                        }
                    }
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(5));
                };
                assert_eq!(loaded.owner_pid(), owner.0.id());
                assert!(journal
                    .resume_verified(&loaded, &SuccessorProjection(live.target()))
                    .is_err());
                drop(owner);
                assert!(journal
                    .resume_verified(&loaded, &SuccessorProjection(live.target()))
                    .is_ok());
                for errno in [Some(libc::EPERM), Some(libc::EINVAL), Some(libc::EIO), None] {
                    assert!(classify_process_status(-1, errno).is_err());
                }
                assert_eq!(
                    classify_process_status(-1, Some(libc::ESRCH)).unwrap(),
                    ProcessStatus::Gone
                );
                assert_eq!(
                    classify_process_status(0, Some(libc::ESRCH)).unwrap(),
                    ProcessStatus::Alive
                );
                assert!(classify_process_status(1, Some(libc::ESRCH)).is_err());
            }

            #[test]
            fn wrong_successor_target_and_changed_loaded_bytes_inode_or_root_are_not_resumable() {
                for case in 0..5 {
                    let fixture = Fixture::new();
                    let (journal, loaded, proof) = prepared(&fixture);
                    let mut wrong = SuccessorProjection(fixture.target());
                    wrong.0.runtime_manifest_sha256 = "d".repeat(64);
                    assert!(journal.resume_verified(&loaded, &wrong).is_err());
                    let before = fs::read(fixture.record()).unwrap();
                    match case {
                        0 => fs::write(fixture.record(), b"stale content").unwrap(),
                        1 => {
                            fs::rename(fixture.record(), fixture.root.join("saved.json")).unwrap();
                            write_private(&fixture.record(), &before);
                        }
                        2 => fs::hard_link(fixture.record(), fixture.temp.join("alias")).unwrap(),
                        3 => fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o750))
                            .unwrap(),
                        _ => {
                            fs::rename(&fixture.root, fixture.temp.join("old-root")).unwrap();
                            private_dir(&fixture.root);
                        }
                    }
                    assert!(journal.resume_verified(&loaded, &proof).is_err());
                    if case == 3 {
                        fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o700))
                            .unwrap();
                    }
                }
            }

            #[test]
            fn bad_startup_proof_or_changed_live_record_poison_the_successor() {
                for stale in [false, true] {
                    let fixture = Fixture::new();
                    let (journal, loaded, proof) = prepared(&fixture);
                    let successor = journal.resume_verified(&loaded, &proof).unwrap();
                    let mut wrong = SuccessorProjection(fixture.target());
                    wrong.0.archive_sha256 = "d".repeat(64);
                    if stale {
                        fs::write(fixture.record(), b"changed after resume").unwrap();
                    }
                    assert!(successor
                        .validate_startup(if stale { &proof } else { &wrong })
                        .is_err());
                    assert!(successor.validate_startup(&proof).is_err());
                    let server = OwnedChild::server();
                    assert!(successor
                        .finish(&server.proof(&fixture.target()))
                        .unwrap_err()
                        .contains("requires recovery"));
                    assert!(check(&fixture.root).is_err());
                    assert!(!fixture.root.join(COMPLETED_RECORD).exists());
                }
            }

            #[test]
            fn healthy_finish_is_durable_bounded_and_allows_the_next_real_update_attempt() {
                let fixture = Fixture::new();
                for iteration in 0..2 {
                    let mut target = fixture.target();
                    if iteration == 1 {
                        target.source_desktop_version = "1.1.0".into();
                        target.target_desktop_version = "1.2.0".into();
                    }
                    publish(&fixture, &target, "publish");
                    let journal = Journal::open(&fixture.root).unwrap();
                    let loaded = journal.load().unwrap().unwrap();
                    let proof = SuccessorProjection(target.clone());
                    let mut successor = journal.resume_verified(&loaded, &proof).unwrap();
                    successor.validate_startup(&proof).unwrap();
                    let server = OwnedChild::server();
                    let mut points = Vec::new();
                    successor
                        .finish_inner(&server.proof(&target), &mut |point| {
                            points.push(point);
                            if point != FinishPoint::CommitStageRetired {
                                assert!(check(&fixture.root).is_err());
                            }
                            Ok(())
                        })
                        .unwrap();
                    assert_eq!(points, finish_points());
                    assert!(successor.validate_startup(&proof).is_err());
                    drop(successor);
                    assert!(journal.load().unwrap().is_none());
                    assert!(check(&fixture.root).is_ok());
                    let receipt_path = fixture.root.join(COMPLETED_RECORD);
                    let receipt: CompletedRecord =
                        serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
                    assert!(completion_is_committed(&receipt));
                    assert_eq!(receipt.attempt.target, target);
                    assert_eq!(receipt.server_pid, server.0.id());
                    assert_eq!(receipt.completed_by_pid, std::process::id());
                    assert_eq!(
                        receipt.archive_inode,
                        fs::metadata(receipt_path).unwrap().ino()
                    );
                    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 1);
                }
                assert_eq!(
                    fs::read(fixture.app.join("untouched-fixture")).unwrap(),
                    b"not an installed application"
                );
            }

            #[test]
            fn wrong_dead_self_foreign_or_invalid_health_pid_cannot_clear() {
                let fixture = Fixture::new();
                let (journal, loaded, proof) = prepared(&fixture);
                let mut dead = OwnedChild::server();
                dead.0.kill().unwrap();
                dead.wait();
                let live = OwnedChild::server();
                for pid in [
                    0,
                    1,
                    u32::MAX,
                    std::process::id(),
                    loaded.owner_pid(),
                    dead.0.id(),
                    unsafe { libc::getppid() } as u32,
                ] {
                    let successor = journal.resume_verified(&loaded, &proof).unwrap();
                    let bad = HealthProjection {
                        target: fixture.target(),
                        pid,
                    };
                    assert!(successor.finish(&bad).is_err(), "PID {pid}");
                    assert!(check(&fixture.root).is_err());
                    assert!(!fixture.root.join(COMPLETED_RECORD).exists());
                }
                let successor = journal.resume_verified(&loaded, &proof).unwrap();
                let mut wrong = live.proof(&fixture.target());
                wrong.target.target_product_version = "9.0.0".into();
                assert!(successor.finish(&wrong).is_err());
                assert!(check(&fixture.root).is_err());
                journal
                    .resume_verified(&loaded, &proof)
                    .unwrap()
                    .finish(&live.proof(&fixture.target()))
                    .unwrap();
                assert!(check(&fixture.root).is_ok());
            }

            fn finish_points() -> [FinishPoint; 17] {
                [
                    FinishPoint::ArchiveOpened,
                    FinishPoint::ArchiveTruncated,
                    FinishPoint::BeforeArchiveSync,
                    FinishPoint::ArchiveFileSynced,
                    FinishPoint::ArchiveDirectorySynced,
                    FinishPoint::BeforeRetirement,
                    FinishPoint::Retired,
                    FinishPoint::BeforeRetirementSync,
                    FinishPoint::RetirementSynced,
                    FinishPoint::CommitOpened,
                    FinishPoint::BeforeCommitFileSync,
                    FinishPoint::CommitFileSynced,
                    FinishPoint::BeforeCommitPublication,
                    FinishPoint::CommitPublished,
                    FinishPoint::BeforeCommitDirectorySync,
                    FinishPoint::CommitDirectorySynced,
                    FinishPoint::CommitStageRetired,
                ]
            }

            #[test]
            fn precommit_failures_persist_a_barrier_and_postcommit_outcomes_require_receipt_disposition(
            ) {
                for fail in finish_points() {
                    let fixture = Fixture::new();
                    let (journal, loaded, proof) = prepared(&fixture);
                    let mut successor = journal.resume_verified(&loaded, &proof).unwrap();
                    let server = OwnedChild::server();
                    let message = successor
                        .finish_inner(&server.proof(&fixture.target()), &mut |point| {
                            if point == fail {
                                Err(error("injected completion I/O failure"))
                            } else {
                                Ok(())
                            }
                        })
                        .unwrap_err();
                    assert!(message.contains("requires recovery"), "{fail:?}");
                    assert!(successor.validate_startup(&proof).is_err());
                    assert_eq!(
                        check(&fixture.root).is_ok(),
                        fail == FinishPoint::CommitStageRetired,
                        "{fail:?}"
                    );
                    drop(successor);
                    assert_eq!(
                        check(&fixture.root).is_ok(),
                        fail == FinishPoint::CommitStageRetired
                    );
                }
            }

            #[test]
            fn unwind_during_retirement_retains_persistent_barrier_and_never_overwrites_replacements(
            ) {
                for replacement in [false, true] {
                    let fixture = Fixture::new();
                    let (journal, loaded, proof) = prepared(&fixture);
                    let successor = journal.resume_verified(&loaded, &proof).unwrap();
                    let server = OwnedChild::server();
                    assert!(catch_unwind(AssertUnwindSafe(|| {
                        let mut owned = successor;
                        owned
                            .finish_inner(&server.proof(&fixture.target()), &mut |point| {
                                if point == FinishPoint::Retired {
                                    if replacement {
                                        write_private(
                                            &fixture.record(),
                                            b"replacement must survive",
                                        );
                                    }
                                    panic!("injected retirement unwind");
                                }
                                Ok(())
                            })
                            .unwrap();
                    }))
                    .is_err());
                    assert!(check(&fixture.root).is_err());
                    if replacement {
                        assert_eq!(
                            fs::read(fixture.record()).unwrap(),
                            b"replacement must survive"
                        );
                    }
                }
            }

            #[test]
            fn archive_collision_types_and_alien_receipts_are_never_overwritten() {
                for kind in 0..6 {
                    let fixture = Fixture::new();
                    let (journal, loaded, proof) = prepared(&fixture);
                    let successor = journal.resume_verified(&loaded, &proof).unwrap();
                    let outside = fixture.temp.join("outside");
                    write_private(&outside, b"alien bytes");
                    let archive = fixture.root.join(COMPLETED_RECORD);
                    match kind {
                        0 => symlink(&outside, &archive).unwrap(),
                        1 => fs::hard_link(&outside, &archive).unwrap(),
                        2 => private_dir(&archive),
                        3 => write_private(&archive, b"not a completed receipt"),
                        4 => {
                            let name = CString::new(archive.as_os_str().as_bytes()).unwrap();
                            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                        }
                        _ => {
                            write_private(&archive, b"private-looking but wrong mode");
                            fs::set_permissions(&archive, fs::Permissions::from_mode(0o644))
                                .unwrap();
                        }
                    }
                    let server = OwnedChild::server();
                    assert!(successor.finish(&server.proof(&fixture.target())).is_err());
                    assert_eq!(fs::read(outside).unwrap(), b"alien bytes");
                    assert!(check(&fixture.root).is_err());
                    if kind == 3 {
                        assert_eq!(fs::read(archive).unwrap(), b"not a completed receipt");
                    }
                }
            }

            #[test]
            fn archive_or_canonical_substitution_and_health_loss_at_commit_never_succeed() {
                for kind in 0..3 {
                    let fixture = Fixture::new();
                    let (journal, loaded, proof) = prepared(&fixture);
                    let mut successor = journal.resume_verified(&loaded, &proof).unwrap();
                    let mut server = OwnedChild::server();
                    let health = server.proof(&fixture.target());
                    let outside = fixture.temp.join("outside");
                    write_private(&outside, b"untouched");
                    assert!(successor
                        .finish_inner(&health, &mut |point| {
                            if point == FinishPoint::BeforeRetirement {
                                match kind {
                                    0 => {
                                        let archive = fixture.root.join(COMPLETED_RECORD);
                                        fs::rename(&archive, fixture.root.join("saved-completed"))
                                            .unwrap();
                                        symlink(&outside, &archive).unwrap();
                                    }
                                    1 => {
                                        fs::rename(
                                            fixture.record(),
                                            fixture.root.join("saved-attempt"),
                                        )
                                        .unwrap();
                                        symlink(&outside, fixture.record()).unwrap();
                                    }
                                    _ => {
                                        server.0.kill().unwrap();
                                        server.wait();
                                    }
                                }
                            }
                            Ok(())
                        })
                        .is_err());
                    assert_eq!(fs::read(outside).unwrap(), b"untouched");
                    assert!(check(&fixture.root).is_err());
                }
            }

            #[test]
            fn root_swap_after_retirement_reports_explicit_uncertainty_without_mutating_new_root() {
                let fixture = Fixture::new();
                let (journal, loaded, proof) = prepared(&fixture);
                let mut successor = journal.resume_verified(&loaded, &proof).unwrap();
                let server = OwnedChild::server();
                let message = successor
                    .finish_inner(&server.proof(&fixture.target()), &mut |point| {
                        if point == FinishPoint::Retired {
                            fs::rename(&fixture.root, fixture.temp.join("moved-root")).unwrap();
                            private_dir(&fixture.root);
                        }
                        Ok(())
                    })
                    .unwrap_err();
                assert!(message.contains("requires recovery"));
                drop(successor);
                assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 0);
            }

            #[test]
            fn copied_successor_pid_is_fenced_before_startup_finish_or_drop_mutation() {
                let fixture = Fixture::new();
                let (journal, loaded, proof) = prepared(&fixture);
                let mut successor = journal.resume_verified(&loaded, &proof).unwrap();
                drop(journal);
                Arc::get_mut(&mut successor.root).unwrap().pid = std::process::id() + 1;
                let before = fs::read(fixture.record()).unwrap();
                assert!(successor
                    .validate_startup(&proof)
                    .unwrap_err()
                    .contains("another PID"));
                let server = OwnedChild::server();
                assert!(successor.finish(&server.proof(&fixture.target())).is_err());
                assert_eq!(fs::read(fixture.record()).unwrap(), before);
                assert!(!fixture.root.join(COMPLETED_RECORD).exists());
            }

            #[test]
            fn serialized_state_and_booleans_cannot_satisfy_either_proof_or_clone_a_successor() {
                trait NotSuccessorProof<A> {
                    fn check() {}
                }
                impl<T> NotSuccessorProof<()> for T {}
                impl<T: VerifiedSuccessorProof> NotSuccessorProof<u8> for T {}
                let _ = <Target as NotSuccessorProof<_>>::check;
                let _ = <LoadedAttempt as NotSuccessorProof<_>>::check;
                let _ = <bool as NotSuccessorProof<_>>::check;
                trait NotHealthProof<A> {
                    fn check() {}
                }
                impl<T> NotHealthProof<()> for T {}
                impl<T: VerifiedHealthProof> NotHealthProof<u8> for T {}
                let _ = <Target as NotHealthProof<_>>::check;
                let _ = <CompletedRecord as NotHealthProof<_>>::check;
                let _ = <bool as NotHealthProof<_>>::check;
                trait NotCloneOrDeserialize<A> {
                    fn check() {}
                }
                impl<T> NotCloneOrDeserialize<()> for T {}
                impl<T: Clone> NotCloneOrDeserialize<u8> for T {}
                impl<T: serde::de::DeserializeOwned> NotCloneOrDeserialize<u16> for T {}
                let _ = <SuccessorAttempt as NotCloneOrDeserialize<_>>::check;
            }

            #[test]
            fn subprocess_crashes_preserve_precommit_blockers_and_postcommit_durable_receipts() {
                for role in [
                    "successor-drop",
                    "successor-fork",
                    "crash-archive",
                    "crash-before-retirement",
                    "crash-retired",
                ] {
                    let fixture = Fixture::new();
                    publish(&fixture, &fixture.target(), "publish");
                    let code = spawn_role(&fixture, &fixture.target(), role).wait().code();
                    assert_eq!(code, Some(82), "{role}");
                    if role == "crash-retired" {
                        // The old unsafe implementation admitted this absence.
                        // PreparedSuccess is now a durable, cross-process veto.
                        assert!(check(&fixture.root).is_err());
                        let receipt: CompletedRecord = serde_json::from_slice(
                            &fs::read(fixture.root.join(COMPLETED_RECORD)).unwrap(),
                        )
                        .unwrap();
                        assert_eq!(receipt.attempt.target, fixture.target());
                        assert_eq!(receipt.state, CompletionState::PreparedSuccess);
                    } else {
                        assert!(check(&fixture.root).is_err(), "{role}");
                    }
                }
            }

            fn wait_for_loaded_owners(loaded: &LoadedAttempt) {
                let deadline = Instant::now() + Duration::from_secs(10);
                while loaded_owners_gone(loaded).is_err() {
                    assert!(
                        Instant::now() < deadline,
                        "owned fixture processes did not exit"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
            }

            #[test]
            fn fresh_process_blocks_after_retirement_sync_and_restoration_fail_then_recovers_only_with_proof(
            ) {
                let fixture = Fixture::new();
                publish(&fixture, &fixture.target(), "publish");
                assert_eq!(
                    spawn_role(&fixture, &fixture.target(), "fail-retirement-unrestorable")
                        .wait()
                        .code(),
                    Some(84)
                );
                assert!(!fixture.record().exists());
                // This child has a fresh LaunchGate/address space/resource limit.
                // No in-memory latch or Drop from the failed owner survives.
                assert_eq!(
                    spawn_role(&fixture, &fixture.target(), "probe-pending")
                        .wait()
                        .code(),
                    Some(83)
                );
                assert!(check(&fixture.root).is_err());
                assert_eq!(
                    spawn_role(&fixture, &fixture.target(), "recover-drop")
                        .wait()
                        .code(),
                    Some(85)
                );
                let restored: Record =
                    serde_json::from_slice(&fs::read(fixture.record()).unwrap()).unwrap();
                assert_eq!(restored.phase, Phase::AwaitingHealth);
                assert!(restored.recovery_owner_pid.is_some());
                assert!(check(&fixture.root).is_err());
                assert_eq!(
                    spawn_role(&fixture, &fixture.target(), "recover-finish")
                        .wait()
                        .code(),
                    Some(86)
                );
                assert!(check(&fixture.root).is_ok());
                assert!(Journal::open(&fixture.root)
                    .unwrap()
                    .load()
                    .unwrap()
                    .is_none());
                assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 1);
            }

            #[test]
            fn pending_recovery_is_read_only_until_proof_and_requires_completion_writer_exit() {
                let fixture = Fixture::new();
                publish(&fixture, &fixture.target(), "publish");
                let writer = spawn_role(&fixture, &fixture.target(), "fail-retirement-live");
                let deadline = Instant::now() + Duration::from_secs(10);
                let (journal, loaded) = loop {
                    if !fixture.record().exists() && fixture.root.join(COMPLETED_RECORD).exists() {
                        if let Ok(journal) = Journal::open(&fixture.root) {
                            if let Ok(Some(loaded)) = journal.load() {
                                break (journal, loaded);
                            }
                        }
                    }
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(5));
                };
                assert!(loaded.from_completion);
                let before = fs::read(fixture.root.join(COMPLETED_RECORD)).unwrap();
                let proof = SuccessorProjection(fixture.target());
                assert!(journal.resume_verified(&loaded, &proof).is_err());
                assert!(journal.begin(fixture.target()).is_err());
                assert!(!fixture.record().exists());
                assert_eq!(
                    fs::read(fixture.root.join(COMPLETED_RECORD)).unwrap(),
                    before
                );
                drop(writer);
                wait_for_loaded_owners(&loaded);
                let mut wrong = SuccessorProjection(fixture.target());
                wrong.0.inventory_sha256 = "d".repeat(64);
                assert!(journal.resume_verified(&loaded, &wrong).is_err());
                assert!(!fixture.record().exists());
                let successor = journal.resume_verified(&loaded, &proof).unwrap();
                successor.validate_startup(&proof).unwrap();
                assert!(check(&fixture.root).is_err());
                drop(successor);
                // The new canonical record names the process that restored it;
                // dropping the capability cannot manufacture a second successor.
                let restored = journal.load().unwrap().unwrap();
                assert_eq!(restored.record.recovery_owner_pid, Some(std::process::id()));
                assert!(journal.resume_verified(&restored, &proof).is_err());
            }

            #[test]
            fn strict_committed_reader_rejects_legacy_pending_malformed_aliases_and_staging_orphans(
            ) {
                for case in 0..12 {
                    let fixture = Fixture::new();
                    publish(&fixture, &fixture.target(), "publish");
                    assert_eq!(
                        spawn_role(&fixture, &fixture.target(), "recover-finish")
                            .wait()
                            .code(),
                        Some(86)
                    );
                    assert!(check(&fixture.root).is_ok());
                    let path = fixture.root.join(COMPLETED_RECORD);
                    let original = fs::read(&path).unwrap();
                    let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
                    match case {
                        0 => {
                            value["schema"] = 1.into();
                            value["state"] = "verified_success".into();
                        }
                        1 => value["state"] = "prepared_success".into(),
                        2 => value["state"] = "verified_success".into(),
                        3 => value["attempt"]["root_inode"] = 0.into(),
                        4 => value["attempt"]["target"]["archive_sha256"] = "not a hash".into(),
                        5 => value["unexpected"] = true.into(),
                        6 => value["attempt"]["target"]["target_desktop_version"] = "1.0.0".into(),
                        7 => {
                            fs::rename(&path, fixture.root.join("saved-receipt")).unwrap();
                            write_private(&path, &original);
                        }
                        8 => fs::hard_link(&path, fixture.temp.join("hardlink")).unwrap(),
                        9 => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
                        10 => write_private(
                            &fixture.root.join(COMPLETION_STAGE),
                            b"unresolved staging entry",
                        ),
                        _ => fs::write(&path, b"{").unwrap(),
                    }
                    if case <= 6 {
                        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
                    }
                    assert!(check(&fixture.root).is_err(), "case {case}");
                    assert!(!fixture.record().exists());
                    let journal = Journal::open(&fixture.root).unwrap();
                    assert!(
                        !matches!(journal.load(), Ok(None)),
                        "unsafe None in case {case}"
                    );
                    assert!(journal.begin(fixture.target()).is_err());
                }
                let fixture = Fixture::new();
                write_private(
                    &fixture.root.join(COMPLETION_STAGE),
                    b"orphan with no receipt",
                );
                assert!(check(&fixture.root).is_err());
                assert!(Journal::open(&fixture.root).unwrap().load().is_err());
            }

            #[test]
            #[ignore = "Re-executed only by owned, bounded successor process fixtures"]
            fn process_successor_child() {
                let root =
                    PathBuf::from(std::env::var_os("GJC_SUCCESSOR_TEST_ROOT").expect("test root"));
                let target: Target = serde_json::from_str(
                    &std::env::var("GJC_SUCCESSOR_TEST_TARGET").expect("test target"),
                )
                .unwrap();
                let role = std::env::var("GJC_SUCCESSOR_TEST_ROLE").expect("test role");
                let journal = Journal::open(&root).unwrap();
                if role == "probe-pending" {
                    assert!(check(&root).is_err());
                    let loaded = journal
                        .load()
                        .unwrap()
                        .expect("pending state must never be None");
                    assert!(loaded.from_completion);
                    assert_eq!(loaded.phase(), Phase::AwaitingHealth);
                    assert_eq!(loaded.target(), &target);
                    assert!(!root.join(ATTEMPT_RECORD).exists());
                    assert!(journal.begin(target).is_err());
                    unsafe { libc::_exit(83) };
                }
                if role.starts_with("publish") {
                    let mut attempt = journal.begin(target.clone()).unwrap();
                    if role != "publish-installing" {
                        attempt
                            .record_installed(&ProofProjection::for_target(&target))
                            .unwrap();
                    }
                    drop(attempt);
                    drop(journal);
                    if role == "publish-live" {
                        let _ = std::io::stdin().read(&mut [0u8; 1]);
                    }
                    unsafe { libc::_exit(81) };
                }
                let proof = SuccessorProjection(target.clone());
                let loaded = journal.load().unwrap().unwrap();
                wait_for_loaded_owners(&loaded);
                let mut successor = journal.resume_verified(&loaded, &proof).unwrap();
                successor.validate_startup(&proof).unwrap();
                if role == "recover-drop" {
                    assert!(root.join(ATTEMPT_RECORD).exists());
                    assert!(check(&root).is_err());
                    unsafe { libc::_exit(85) };
                }
                if role == "recover-finish" {
                    let server = OwnedChild::server();
                    successor.finish(&server.proof(&target)).unwrap();
                    assert!(check(&root).is_ok());
                    drop(server);
                    unsafe { libc::_exit(86) };
                }
                if role == "successor-drop" {
                    unsafe { libc::_exit(82) };
                }
                if role == "successor-fork" {
                    let pid = unsafe { libc::fork() };
                    assert!(pid >= 0);
                    if pid == 0 {
                        unsafe { libc::_exit(if successor.root.owns_pid() { 1 } else { 0 }) };
                    }
                    let mut status = 0;
                    assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
                    assert!(libc::WIFEXITED(status));
                    assert_eq!(libc::WEXITSTATUS(status), 0);
                    successor.validate_startup(&proof).unwrap();
                    unsafe { libc::_exit(82) };
                }
                let server = OwnedChild::server();
                if role.starts_with("fail-retirement-") {
                    assert!(successor
                        .finish_inner(&server.proof(&target), &mut |point| {
                            if point == FinishPoint::BeforeRetirementSync {
                                Err(error("injected retirement fsync failure"))
                            } else {
                                Ok(())
                            }
                        })
                        .is_err());
                    drop(successor);
                    assert!(!root.join(ATTEMPT_RECORD).exists());
                    assert!(check(&root).is_err());
                    if role == "fail-retirement-live" {
                        drop(journal);
                        let _ = std::io::stdin().read(&mut [0_u8; 1]);
                    } else {
                        drop(server);
                        // Isolated child only: make restoration genuinely fail
                        // with EMFILE without changing the root or its receipts.
                        let limit = libc::rlimit {
                            rlim_cur: 0,
                            rlim_max: 0,
                        };
                        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);
                        assert_eq!(
                            open_at(
                                journal.root.anchor.directory(),
                                OsStr::new(ATTEMPT_RECORD),
                                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
                                0o600
                            )
                            .unwrap_err()
                            .raw_os_error(),
                            Some(libc::EMFILE)
                        );
                    }
                    unsafe { libc::_exit(84) };
                }
                successor
                    .finish_inner(&server.proof(&target), &mut |point| {
                        if matches!(
                            (role.as_str(), point),
                            ("crash-archive", FinishPoint::ArchiveDirectorySynced)
                                | ("crash-before-retirement", FinishPoint::BeforeRetirement)
                                | ("crash-retired", FinishPoint::Retired)
                        ) {
                            unsafe { libc::_exit(82) };
                        }
                        Ok(())
                    })
                    .unwrap();
                panic!("unknown fixture role");
            }
        }

        #[test]
        #[ignore = "Re-executed only with a fresh isolated journal fixture by process fault tests"]
        fn process_fault_child() {
            let root = PathBuf::from(
                std::env::var_os("GJC_DURABLE_ATTEMPT_TEST_ROOT").expect("test root"),
            );
            let app =
                PathBuf::from(std::env::var_os("GJC_DURABLE_ATTEMPT_TEST_APP").expect("test app"));
            let scenario = std::env::var("GJC_DURABLE_ATTEMPT_TEST_FAULT").expect("fault scenario");
            if scenario == "duplicate" {
                unsafe { libc::_exit(if Journal::open(&root).is_err() { 74 } else { 1 }) };
            }
            let journal = Journal::open(&root).unwrap();
            let target = target_for(&app);
            let proof = ProofProjection::for_target(&target);
            let mut attempt = journal
                .begin_inner(target, &mut |point| {
                    if matches!(
                        (scenario.as_str(), point),
                        ("created", SyncPoint::Created)
                            | ("before-file-sync", SyncPoint::BeforeFileSync)
                            | ("file-synced", SyncPoint::FileSynced)
                            | ("directory-synced", SyncPoint::DirectorySynced)
                    ) {
                        unsafe { libc::_exit(73) };
                    }
                    Ok(())
                })
                .unwrap();
            if scenario == "live" {
                unsafe { libc::_exit(73) };
            }
            if scenario == "fork" {
                let pid = unsafe { libc::fork() };
                assert!(pid >= 0);
                if pid == 0 {
                    // No allocation, locks, or filesystem access after fork.
                    unsafe { libc::_exit(if attempt.root.owns_pid() { 1 } else { 0 }) };
                }
                let mut status = 0;
                assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
                assert!(libc::WIFEXITED(status));
                assert_eq!(libc::WEXITSTATUS(status), 0);
                attempt.validate_install_permit().unwrap();
                assert!(Journal::open(&root).is_err());
                unsafe { libc::_exit(75) };
            }
            attempt
                .installed_inner(&proof, &mut |point| {
                    if scenario == "truncated" && point == SyncPoint::Truncated {
                        unsafe { libc::_exit(73) };
                    }
                    Ok(())
                })
                .unwrap();
            assert_eq!(scenario, "installed");
            unsafe { libc::_exit(73) };
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        ffi::OsStr,
        fs,
        os::unix::{
            ffi::OsStrExt,
            fs::{symlink, PermissionsExt},
        },
        process::Command,
        time::Duration,
    };

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            let mut entropy = [0; 16];
            getrandom::getrandom(&mut entropy).unwrap();
            let id = u128::from_ne_bytes(entropy);
            let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
            let path = temp.join(format!("gajae-updater-attempt-{}-{id}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_root_and_record_are_admitted_without_creation() {
        let temp = Temp::new();
        let missing = temp.0.join("missing").join(".gajae-app");
        assert!(check(&missing).is_ok());
        assert!(!missing.exists());

        let root = temp.0.join("existing");
        fs::create_dir(&root).unwrap();
        assert!(check(&root).is_ok());
        assert!(!root.join(ATTEMPT_RECORD).exists());
    }

    #[test]
    fn any_present_record_blocks_without_reading_or_mutating_it() {
        let temp = Temp::new();
        let root = temp.0.join("root");
        fs::create_dir(&root).unwrap();
        let record = root.join(ATTEMPT_RECORD);
        let matching_version = format!(
            "{{\"state\":\"relaunch\",\"target_desktop_version\":\"{}\",\"target_payload_version\":\"{}\"}}",
            env!("CARGO_PKG_VERSION"),
            env!("GJC_EXPECTED_PAYLOAD_VERSION")
        );
        for body in [
            b"".as_slice(),
            b"not json".as_slice(),
            matching_version.as_bytes(),
        ] {
            fs::write(&record, body).unwrap();
            let before = fs::read(&record).unwrap();
            assert!(check(&root).is_err());
            assert_eq!(fs::read(&record).unwrap(), before);
        }
    }

    #[test]
    fn inaccessible_record_parent_never_authorizes_startup() {
        let temp = Temp::new();
        let root = temp.0.join("restricted");
        fs::create_dir(&root).unwrap();
        fs::write(root.join(ATTEMPT_RECORD), b"pending").unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o0)).unwrap();
        let result = check(&root);
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let error = result.expect_err("inaccessible or present records must block");
        if unsafe { libc::geteuid() } != 0 {
            assert!(error.starts_with("Could not validate desktop update attempt state"));
        }
    }

    #[test]
    fn symlink_dangling_parent_and_fifo_are_refused() {
        let temp = Temp::new();
        let root = temp.0.join("root");
        fs::create_dir(&root).unwrap();
        let target = root.join("target");
        fs::write(&target, b"record").unwrap();
        let record = root.join(ATTEMPT_RECORD);
        symlink(&target, &record).unwrap();
        assert!(check(&root).is_err());
        fs::remove_file(&record).unwrap();

        let link = temp.0.join("dangling");
        symlink(temp.0.join("does-not-exist"), &link).unwrap();
        assert!(check(&link.join("root")).is_err());

        assert!(Command::new("/usr/bin/mkfifo")
            .arg(&record)
            .status()
            .unwrap()
            .success());
        let started = std::time::Instant::now();
        assert!(check(&root).is_err());
        assert!(started.elapsed() < Duration::from_millis(250));
    }

    #[test]
    fn unsafe_type_and_invalid_io_roots_are_refused() {
        let temp = Temp::new();
        let root_file = temp.0.join("root-file");
        fs::write(&root_file, b"not a directory").unwrap();
        assert!(check(&root_file).is_err());

        let invalid = Path::new("relative").join("desktop");
        assert!(check(&invalid).is_err());
        // Absolute paths containing NUL produce an unknown metadata I/O
        // result; they must not be treated as a missing record.
        let invalid_component = OsStr::from_bytes(b"invalid\0desktop-data-root");
        assert!(check(&temp.0.join(invalid_component)).is_err());
    }
}
