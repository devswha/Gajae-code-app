//! Durable desktop install attempts, plus an unchanged presence-only guard.
//!
//! The journal publishes and syncs the canonical blocker before granting a
//! process-bound live permit. Loaded records are inspection data, never permits.
//! Nothing here installs, starts a server, removes a record, or acknowledges
//! health. In particular, `check` still refuses EVERY present directory entry.
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) const ATTEMPT_RECORD: &str = "desktop-update-attempt.json";

// The standalone QA probe also includes this file, without the product bundle
// verifier. Keep the journal independent of that crate's module topology.
#[cfg(target_os = "macos")]
#[allow(unused_imports)]
pub(crate) use durable::{
    proof_seal, Journal, LiveAttempt, LoadedAttempt, Phase, Target, VerifiedBundleProof,
};

/// Admit a startup only when the update-attempt record is validated absent.
/// Any present directory entry, regardless of its contents or type, blocks.
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
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Could not validate desktop update attempt state at {}: {error}",
            record.display()
        )),
    }
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
    use super::ATTEMPT_RECORD;
    use std::{
        ffi::{CString, OsStr},
        fs::{File, Metadata},
        io::{self, Seek, SeekFrom, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::FileExt, fs::MetadataExt},
        },
        path::{Component, Path, PathBuf},
        sync::Arc,
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

    /// Native-only sealing boundary. The parent implements this solely for the
    /// inventory verifier's opaque VerifiedBundle; journal tests use a local
    /// projection. No blanket implementations or serialized-state impls exist.
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

    #[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    pub(crate) enum Phase {
        Installing,
        AwaitingHealth,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Record {
        schema: u8,
        attempt_id: String,
        owner_pid: u32,
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
            let file = match open_at(
                self.root.anchor.directory(),
                OsStr::new(ATTEMPT_RECORD),
                libc::O_RDONLY | libc::O_NONBLOCK,
                0,
            ) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    self.root.validate()?;
                    return Ok(None);
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
            Ok(Some(LoadedAttempt { record }))
        }
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
        pub(crate) fn phase(&self) -> Phase {
            self.record.phase
        }

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
        pub(crate) fn load(data_root: &Path) -> Result<Option<Self>> {
            Journal::open(data_root)?.load()
        }

        pub(crate) fn phase(&self) -> Phase {
            self.record.phase
        }

        pub(crate) fn target(&self) -> &Target {
            &self.record.target
        }

        pub(crate) fn matches_target(&self, expected: &Target) -> bool {
            expected.validate().is_ok() && self.record.target == *expected
        }

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
        root.validate()?;
        let file = open_at(
            root.anchor.directory(),
            OsStr::new(ATTEMPT_RECORD),
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
            OsStr::new(ATTEMPT_RECORD),
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
                let reopened = Journal::open(&fixture.root).unwrap();
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
                let loaded = LoadedAttempt::load(&fixture.root).unwrap().unwrap();
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
            let loaded = LoadedAttempt::load(&fixture.root).unwrap().unwrap();
            assert_eq!(loaded.phase(), Phase::AwaitingHealth);
            assert!(loaded.matches_target(&fixture.target()));
            assert!(check(&fixture.root).is_err());
            assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 1);
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
            let reopened = Journal::open(&fixture.root).unwrap();
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
