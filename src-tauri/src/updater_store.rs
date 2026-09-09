//! Private preparation cache. Nothing in this module installs an app or owns an
//! install-attempt record. A cache hit is untrusted input and must be verified
//! again by the preparation owner before being shown as ready.
use std::{
    ffi::{CStr, CString},
    fs::{File, Metadata},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::{Component, Path},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_ARCHIVE_BYTES: usize = 250 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_PREFERENCES_BYTES: usize = 4096;
const MAX_CACHE_FILES: usize = 8;

/// Notification navigation state, separate from the updater cache. Reuse the
/// same descriptor-relative atomic I/O; these URLs grant no update authority.
pub(crate) struct LinkStore(Store);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingLinks {
    schema: u8,
    urls: Vec<String>,
}

impl LinkStore {
    pub(crate) fn open(root: &Path) -> Result<Self, String> {
        Store::open_named(root, "desktop-deep-links").map(Self)
    }

    pub(crate) fn read(&self) -> Result<Vec<String>, String> {
        let Some(bytes) = self.0.read("pending.json", 8192)? else {
            return Ok(Vec::new());
        };
        let record: PendingLinks =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid pending desktop links.")?;
        Self::validate(&record)?;
        Ok(record.urls)
    }

    pub(crate) fn write(&self, urls: Vec<String>) -> Result<(), String> {
        let record = PendingLinks { schema: 1, urls };
        Self::validate(&record)?;
        let _guard = self
            .0
            .mutation
            .lock()
            .map_err(|_| "Pending links lock failed.")?;
        self.0.atomic_json("pending.json", &record, 8192)
    }

    fn validate(record: &PendingLinks) -> Result<(), String> {
        if record.schema != 1
            || record.urls.len() > 16
            || record
                .urls
                .iter()
                .any(|url| url.is_empty() || url.len() > 256 || url.chars().any(char::is_control))
        {
            return Err("Invalid pending desktop links.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    pub schema: u8,
    /// Periodic discovery only; never permission to download or install.
    pub automatic: bool,
}

/// Durable user intent only. It never proves owner absence or authorizes an
/// installer; the next launch must independently reverify every native gate.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ManualIntent {
    schema: u8,
    target_id: String,
    archive_sha256: String,
    consumed: bool,
}

/// A consumed user selection, not an installation or owner-absence permit.
pub(crate) struct ManualRequest {
    target_id: String,
    archive_sha256: String,
}
impl ManualRequest {
    pub(crate) fn matches(&self, record: &PreparedRecord) -> bool {
        self.target_id == record.target_id() && self.archive_sha256 == record.archive_sha256
    }
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            schema: 1,
            automatic: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreparedRecord {
    pub schema: u8,
    pub release_id: u64,
    pub manifest_asset_id: u64,
    pub archive_asset_id: u64,
    pub archive_size: u64,
    pub archive_sha256: String,
    /// Only the canonical manifest is persisted, never a signed redirect URL.
    pub manifest: String,
    /// Full file/mode/hash/link inventory, compared to a fresh inspection on load.
    pub inventory: Value,
}

impl PreparedRecord {
    pub(crate) fn target_id(&self) -> String {
        crate::updater_discovery::target_id(
            self.release_id,
            self.manifest_asset_id,
            self.archive_asset_id,
            self.manifest.as_bytes(),
        )
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema != 1
            || self.release_id == 0
            || self.manifest_asset_id == 0
            || self.archive_asset_id == 0
            || self.archive_size == 0
            || self.archive_size > MAX_ARCHIVE_BYTES as u64
            || self.manifest.is_empty()
            || self.manifest.len() > MAX_MANIFEST_BYTES
            || self.archive_sha256.len() != 64
            || !self
                .archive_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !self.inventory.is_object()
        {
            return Err("Invalid prepared update record.".into());
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Pointer {
    schema: u8,
    id: String,
}

/// Anchored directory descriptors prevent path replacement or symlink traversal
/// between validation and I/O. Call only after compiled runtime admission.
pub struct Store {
    directory: File,
    // Only allocation/publication/retirement, never the large staged writes.
    // The parent still owns generation and consent admission.
    mutation: Arc<Mutex<()>>,
    #[cfg(test)]
    fail_sync: Mutex<Option<SyncPoint>>,
    #[cfg(test)]
    stage_pause: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
}

#[must_use = "commit or discard the stage; dropping it discards unpublished files"]
pub struct StagedRecord {
    pointer: Pointer,
    directory: File,
    mutation: Arc<Mutex<()>>,
    files: Vec<StagedFile>,
    keep_files: bool,
}

struct StagedFile {
    name: String,
    file: File,
    persisted: Option<Metadata>,
}

impl Drop for StagedRecord {
    fn drop(&mut self) {
        if self.keep_files {
            return;
        }
        let Ok(_mutation) = self.mutation.lock() else {
            // Retain bounded orphans rather than run uncoordinated cleanup.
            return;
        };
        for staged in &self.files {
            // Only names created by this handle, still pointing at its inode.
            // An entry replaced after staging is not ours to erase.
            if let Ok(current) = open_at_io(
                &self.directory,
                &staged.name,
                libc::O_RDONLY | libc::O_NONBLOCK,
                0,
            ) {
                if let (Ok(current), Ok(owned)) = (current.metadata(), staged.file.metadata()) {
                    if same_inode(&current, &owned) {
                        let _ = unlink_owned(&self.directory, &staged.name);
                    }
                }
            }
        }
        let _ = self.directory.sync_all();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SyncPoint {
    Stage,
    Publication,
    Retirement,
}

impl Store {
    pub fn open(data_root: &Path) -> Result<Self, String> {
        Self::open_named(data_root, "desktop-update-cache")
    }

    fn open_named(data_root: &Path, directory_name: &str) -> Result<Self, String> {
        let parent = open_root(data_root)?;
        let name = c_name(directory_name)?;
        let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
        if result != 0
            && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err("Could not create private update cache.".into());
        }
        let directory = open_at(
            &parent,
            directory_name,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        private_metadata(
            &directory
                .metadata()
                .map_err(|_| "Could not inspect update cache.")?,
            true,
        )?;
        parent
            .sync_all()
            .map_err(|_| "Could not synchronize update cache parent.")?;
        Ok(Self {
            directory,
            mutation: Arc::new(Mutex::new(())),
            #[cfg(test)]
            fail_sync: Mutex::new(None),
            #[cfg(test)]
            stage_pause: Mutex::new(None),
        })
    }

    pub fn preferences(&self) -> Result<Preferences, String> {
        let Some(bytes) = self.read("preferences.json", MAX_PREFERENCES_BYTES)? else {
            return Ok(Preferences::default());
        };
        let preferences: Preferences =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid update preferences.")?;
        if preferences.schema != 1 {
            return Err("Unknown update preference schema.".into());
        }
        Ok(preferences)
    }

    pub fn set_automatic(&self, automatic: bool) -> Result<(), String> {
        let _mutation = self
            .mutation
            .lock()
            .map_err(|_| "Update cache lock failed.")?;
        // An explicit preference write cannot silently hide malformed state.
        self.preferences()?;
        let value = Preferences {
            schema: 1,
            automatic,
        };
        self.atomic_json("preferences.json", &value, MAX_PREFERENCES_BYTES)
    }

    fn selected_record(&self) -> Result<Option<(Pointer, PreparedRecord)>, String> {
        let Some(pointer) = self.pointer()? else {
            return Ok(None);
        };
        let record = self
            .read(&format!("record-{}.json", pointer.id), MAX_RECORD_BYTES)?
            .ok_or("Prepared update metadata is missing.")?;
        let record: PreparedRecord =
            serde_json::from_slice(&record).map_err(|_| "Invalid prepared update metadata.")?;
        record.validate()?;
        Ok(Some((pointer, record)))
    }

    pub(crate) fn prepared_record(&self) -> Result<Option<PreparedRecord>, String> {
        Ok(self.selected_record()?.map(|(_, record)| record))
    }

    pub(crate) fn request_manual(
        &self,
        target_id: &str,
        archive_sha256: &str,
    ) -> Result<(), String> {
        let _mutation = self
            .mutation
            .lock()
            .map_err(|_| "Update cache lock failed.")?;
        if !self.prepared_record()?.is_some_and(|record| {
            record.target_id() == target_id && record.archive_sha256 == archive_sha256
        }) {
            return Err("Prepared update changed before recording manual intent.".into());
        }
        self.atomic_json(
            "manual-intent.json",
            &ManualIntent {
                schema: 2,
                target_id: target_id.to_owned(),
                archive_sha256: archive_sha256.to_owned(),
                consumed: false,
            },
            MAX_PREFERENCES_BYTES,
        )
    }

    fn read_manual_intent(&self) -> Result<Option<ManualIntent>, String> {
        let Some(bytes) = self.read("manual-intent.json", MAX_PREFERENCES_BYTES)? else {
            return Ok(None);
        };
        let intent: ManualIntent =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid manual update intent.")?;
        if intent.schema != 2
            || intent.target_id.len() != 64
            || !intent
                .target_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || intent.archive_sha256.len() != 64
            || !intent
                .archive_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Invalid manual update intent.".into());
        }
        Ok(Some(intent))
    }

    /// Retire the click durably before startup preflight. A failed preflight
    /// must not make the next ordinary launch retry an earlier user action.
    pub(crate) fn consume_manual(&self) -> Result<Option<ManualRequest>, String> {
        let _mutation = self
            .mutation
            .lock()
            .map_err(|_| "Update cache lock failed.")?;
        let Some(mut intent) = self.read_manual_intent()? else {
            return Ok(None);
        };
        if intent.consumed {
            return Ok(None);
        }
        intent.consumed = true;
        self.atomic_json("manual-intent.json", &intent, MAX_PREFERENCES_BYTES)?;
        Ok(Some(ManualRequest {
            target_id: intent.target_id,
            archive_sha256: intent.archive_sha256,
        }))
    }

    #[cfg(test)]
    pub(crate) fn manual_requested(
        &self,
        target_id: &str,
        archive_sha256: &str,
    ) -> Result<bool, String> {
        Ok(self.read_manual_intent()?.is_some_and(|intent| {
            !intent.consumed
                && intent.target_id == target_id
                && intent.archive_sha256 == archive_sha256
        }))
    }

    pub fn load(&self) -> Result<Option<(PreparedRecord, Vec<u8>)>, String> {
        let Some((pointer, record)) = self.selected_record()? else {
            return Ok(None);
        };
        let archive = self
            .read(&format!("archive-{}", pointer.id), MAX_ARCHIVE_BYTES)?
            .ok_or("Prepared update archive is missing.")?;
        if archive.len() as u64 != record.archive_size {
            return Err("Prepared update size changed.".into());
        }
        // Digest, real Minisign verification, manifest policy, and full archive
        // inspection belong to the caller and are mandatory, even after restart.
        Ok(Some((record, archive)))
    }

    pub fn stage(&self, record: &PreparedRecord, archive: &[u8]) -> Result<StagedRecord, String> {
        record.validate()?;
        if archive.len() as u64 != record.archive_size {
            return Err("Prepared update size does not match.".into());
        }
        let encoded =
            serde_json::to_vec(record).map_err(|_| "Could not encode prepared update.")?;
        if encoded.len() > MAX_RECORD_BYTES {
            return Err("Prepared inventory exceeds its limit.".into());
        }
        let id = random_id()?;
        let mut staged = StagedRecord {
            pointer: Pointer { schema: 1, id },
            directory: self
                .directory
                .try_clone()
                .map_err(|_| "Could not retain cache directory.")?,
            mutation: self.mutation.clone(),
            files: Vec::with_capacity(2),
            keep_files: false,
        };
        {
            let _mutation = self
                .mutation
                .lock()
                .map_err(|_| "Update cache lock failed.")?;
            // Reserve the pair with exclusive creates while capacity is locked.
            // Leave room for the eventual atomic pointer's temporary file.
            self.check_capacity(3)?;
            for name in [
                format!("archive-{}", staged.pointer.id),
                format!("record-{}.json", staged.pointer.id),
            ] {
                let file = open_at(
                    &self.directory,
                    &name,
                    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                    0o600,
                )?;
                staged.files.push(StagedFile {
                    name,
                    file,
                    persisted: None,
                });
            }
        }
        // No store or parent generation lock is held during large I/O.
        #[cfg(test)]
        if let Some((entered, resume)) = self.stage_pause.lock().unwrap().take() {
            entered.send(()).unwrap();
            resume
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
        }
        for (file, bytes) in staged.files.iter_mut().zip([archive, encoded.as_slice()]) {
            file.persisted = Some(persist_file(&mut file.file, bytes)?);
        }
        // Persist both directory entries before ready.json can refer to them,
        // including when the later pointer-directory fsync is uncertain.
        self.sync_directory(SyncPoint::Stage)?;
        Ok(staged)
    }

    /// Commit only while holding the generation/consent lock. Slow archive I/O
    /// happens in stage(), so an opt-out can cancel it without waiting for a
    /// large write. No observer sees ready until both staged files are durable.
    pub fn commit(&self, mut staged: StagedRecord) -> Result<(), String> {
        if !Arc::ptr_eq(&self.mutation, &staged.mutation) {
            return Err("Prepared update belongs to a different cache owner.".into());
        }
        let _mutation = self
            .mutation
            .lock()
            .map_err(|_| "Update cache lock failed.")?;
        // Cheap descriptor/metadata checks only; never re-read the archive while
        // the parent holds consent admission. Reload still requires crypto proof.
        for file in &staged.files {
            let current = open_at(
                &self.directory,
                &file.name,
                libc::O_RDONLY | libc::O_NONBLOCK,
                0,
            )?;
            let current = current
                .metadata()
                .map_err(|_| "Could not inspect staged update.")?;
            private_metadata(&current, false)?;
            if !file
                .persisted
                .as_ref()
                .is_some_and(|expected| same_snapshot(expected, &current))
            {
                return Err("Prepared update changed before publication.".into());
            }
        }
        let old = self.pointer()?;
        // Both files reach stable storage before the atomic pointer is published.
        // On uncertain pointer fsync failure retain files; a later load decides.
        let pointer = Pointer {
            schema: staged.pointer.schema,
            id: staged.pointer.id.clone(),
        };
        self.atomic_json_after_rename("ready.json", &pointer, MAX_PREFERENCES_BYTES, || {
            // Rename made the new pointer visible. Even if its directory fsync
            // fails, Drop must not erase files that ready.json might reference.
            staged.keep_files = true;
        })?;
        if let Some(old) = old {
            if old.id != staged.pointer.id {
                self.remove_owned(&format!("archive-{}", old.id))?;
                self.remove_owned(&format!("record-{}.json", old.id))?;
                self.sync_directory(SyncPoint::Retirement)?;
            }
        }
        Ok(())
    }

    pub fn discard(&self, staged: StagedRecord) {
        // Cleanup is anchored to the handle's originating store, not this path.
        drop(staged);
    }

    #[cfg(test)]
    fn publish(&self, record: &PreparedRecord, archive: &[u8]) -> Result<(), String> {
        self.commit(self.stage(record, archive)?)
    }

    fn pointer(&self) -> Result<Option<Pointer>, String> {
        let Some(bytes) = self.read("ready.json", MAX_PREFERENCES_BYTES)? else {
            return Ok(None);
        };
        let pointer: Pointer =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid prepared update pointer.")?;
        if pointer.schema != 1
            || pointer.id.len() != 32
            || !pointer
                .id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Invalid prepared update identifier.".into());
        }
        Ok(Some(pointer))
    }

    fn read(&self, name: &str, cap: usize) -> Result<Option<Vec<u8>>, String> {
        self.validate_directory()?;
        // O_NONBLOCK prevents a malicious FIFO from hanging before fstat.
        let mut file = match open_at_io(&self.directory, name, libc::O_RDONLY | libc::O_NONBLOCK, 0)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Could not open private update cache file.".into()),
        };
        let before = file
            .metadata()
            .map_err(|_| "Could not inspect update cache file.")?;
        private_metadata(&before, false)?;
        if before.len() > cap as u64 {
            return Err("Update cache file exceeds its limit.".into());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(cap as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read update cache file.")?;
        let after = file
            .metadata()
            .map_err(|_| "Could not recheck update cache file.")?;
        private_metadata(&after, false)?;
        if bytes.len() > cap
            || bytes.len() as u64 != before.len()
            || !same_snapshot(&before, &after)
        {
            return Err("Update cache file changed while reading.".into());
        }
        Ok(Some(bytes))
    }

    fn write_exclusive(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let mut file = open_at(
            &self.directory,
            name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        if let Err(error) = persist_file(&mut file, bytes) {
            let _ = self.remove_owned(name);
            return Err(error);
        }
        Ok(())
    }

    fn atomic_json(&self, target: &str, value: &impl Serialize, cap: usize) -> Result<(), String> {
        self.atomic_json_after_rename(target, value, cap, || {})
    }

    // Caller holds mutation (and parent generation/consent admission for ready).
    fn atomic_json_after_rename(
        &self,
        target: &str,
        value: &impl Serialize,
        cap: usize,
        after_rename: impl FnOnce(),
    ) -> Result<(), String> {
        let bytes = serde_json::to_vec(value).map_err(|_| "Could not encode updater state.")?;
        if bytes.len() > cap {
            return Err("Updater state exceeds its limit.".into());
        }
        // Refuse malformed/aliased existing files rather than hiding corruption.
        let _ = self.read(target, cap)?;
        self.check_capacity(1)?;
        let temporary = format!("pending-{}", random_id()?);
        self.write_exclusive(&temporary, &bytes)?;
        let source = c_name(&temporary)?;
        let target = c_name(target)?;
        if unsafe {
            libc::renameat(
                self.directory.as_raw_fd(),
                source.as_ptr(),
                self.directory.as_raw_fd(),
                target.as_ptr(),
            )
        } != 0
        {
            let _ = self.remove_owned(&temporary);
            return Err("Could not publish updater state.".into());
        }
        after_rename();
        self.sync_directory(SyncPoint::Publication)
    }

    fn remove_owned(&self, name: &str) -> Result<(), String> {
        unlink_owned(&self.directory, name)
    }

    fn sync_directory(&self, _point: SyncPoint) -> Result<(), String> {
        #[cfg(test)]
        {
            let mut failure = self.fail_sync.lock().unwrap();
            if *failure == Some(_point) {
                *failure = None;
                return Err("Injected cache directory synchronization failure.".into());
            }
        }
        self.directory
            .sync_all()
            .map_err(|_| "Could not synchronize update cache state.".into())
    }

    fn validate_directory(&self) -> Result<(), String> {
        private_metadata(
            &self
                .directory
                .metadata()
                .map_err(|_| "Could not inspect update cache.")?,
            true,
        )
    }

    fn check_capacity(&self, additional: usize) -> Result<(), String> {
        self.validate_directory()?;
        // Crash-orphan files are never trusted or recursively erased. Bound
        // their accumulation and fail safely until explicit cache maintenance.
        // dup/fcntl(F_DUPFD_*) share an open-file-description offset. fdopendir
        // consumes that offset, so a later capacity scan could start at EOF.
        // Open "." relative to the anchored descriptor for an independent scan.
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("Could not inspect update cache capacity.".into());
        }
        let directory = unsafe { libc::fdopendir(fd) };
        if directory.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err("Could not inspect update cache capacity.".into());
        }
        let mut count = 0;
        let result = loop {
            unsafe {
                *libc::__error() = 0;
            }
            let entry = unsafe { libc::readdir(directory) };
            if entry.is_null() {
                break if unsafe { *libc::__error() } == 0 {
                    Ok(())
                } else {
                    Err("Could not enumerate update cache.".into())
                };
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name != b"." && name != b".." {
                count += 1;
            }
            if count + additional > MAX_CACHE_FILES {
                break Err(
                    "Update cache contains too many retained files; maintenance is required."
                        .into(),
                );
            }
        };
        unsafe {
            libc::closedir(directory);
        }
        result
    }
}

fn unlink_owned(directory: &File, name: &str) -> Result<(), String> {
    // Never follows an entry or recursively erases a tree.
    let name = c_name(name)?;
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0
        && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound
    {
        return Err("Could not retire private update cache file.".into());
    }
    Ok(())
}

fn persist_file(file: &mut File, bytes: &[u8]) -> Result<Metadata, String> {
    private_metadata(
        &file
            .metadata()
            .map_err(|_| "Could not inspect staged file.")?,
        false,
    )?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "Could not persist prepared update.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Could not inspect persisted file.")?;
    private_metadata(&metadata, false)?;
    if metadata.len() != bytes.len() as u64 {
        return Err("Prepared update changed while writing.".into());
    }
    Ok(metadata)
}

fn same_inode(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

fn same_snapshot(left: &Metadata, right: &Metadata) -> bool {
    same_inode(left, right)
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn private_metadata(metadata: &Metadata, directory: bool) -> Result<(), String> {
    let right_type = if directory {
        metadata.is_dir()
    } else {
        metadata.is_file() && metadata.nlink() == 1
    };
    let mode = if directory { 0o700 } else { 0o600 };
    if !right_type
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o7777 != mode
    {
        return Err("Update cache must be owner-only, regular and unaliased.".into());
    }
    Ok(())
}

fn open_root(path: &Path) -> Result<File, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("Updater data root must be an absolute real directory.".into());
    }
    let mut current = File::open("/").map_err(|_| "Could not open updater root.")?;
    for component in path.components() {
        if let Component::Normal(name) = component {
            let name = name.to_str().ok_or("Invalid updater root component.")?;
            current = open_at(&current, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        }
    }
    let metadata = current
        .metadata()
        .map_err(|_| "Could not inspect updater data root.")?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
        return Err("Updater data root must be owned and not group/world writable.".into());
    }
    Ok(current)
}

fn c_name(name: &str) -> Result<CString, String> {
    if name.is_empty() || matches!(name, "." | "..") || name.contains('/') {
        return Err("Invalid updater cache component.".into());
    }
    CString::new(name).map_err(|_| "Invalid updater cache component.".into())
}

fn open_at_io(parent: &File, name: &str, flags: i32, mode: libc::mode_t) -> std::io::Result<File> {
    let name = c_name(name).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

fn open_at(parent: &File, name: &str, flags: i32, mode: libc::mode_t) -> Result<File, String> {
    open_at_io(parent, name, flags, mode)
        .map_err(|_| "Could not open real updater directory/file.".into())
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "Could not create updater generation.")?;
    Ok(format!("{:032x}", u128::from_be_bytes(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::{
            ffi::OsStrExt,
            fs::{symlink, PermissionsExt},
        },
        path::PathBuf,
    };

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("gajae-cache-{}", random_id().unwrap()));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            Self(root)
        }
        fn cache(&self) -> PathBuf {
            self.0.join("desktop-update-cache")
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn record() -> PreparedRecord {
        PreparedRecord {
            schema: 1,
            release_id: 1,
            manifest_asset_id: 2,
            archive_asset_id: 3,
            archive_size: 4,
            archive_sha256: "a".repeat(64),
            manifest: "{}".into(),
            inventory: serde_json::json!({"entries":[]}),
        }
    }

    #[test]
    fn manual_click_is_consumed_durably_once_and_only_a_fresh_click_rearms_it() {
        let root = Temp::new();
        let store = Store::open(&root.0).unwrap();
        let record = record();
        store
            .commit(store.stage(&record, b"data").unwrap())
            .unwrap();
        store
            .request_manual(&record.target_id(), &record.archive_sha256)
            .unwrap();
        assert!(store.consume_manual().unwrap().unwrap().matches(&record));
        drop(store);
        let store = Store::open(&root.0).unwrap();
        for automatic in [false, true] {
            store.set_automatic(automatic).unwrap();
            assert!(store.consume_manual().unwrap().is_none());
            assert!(!store
                .manual_requested(&record.target_id(), &record.archive_sha256)
                .unwrap());
        }
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(root.cache().join("manual-intent.json")).unwrap())
                .unwrap();
        assert_eq!(saved["consumed"], true);
        store
            .request_manual(&record.target_id(), &record.archive_sha256)
            .unwrap();
        assert!(store.consume_manual().unwrap().unwrap().matches(&record));
        assert!(store.consume_manual().unwrap().is_none());
    }

    #[test]
    fn concurrent_consumers_share_one_manual_click() {
        let root = Temp::new();
        let store = std::sync::Arc::new(Store::open(&root.0).unwrap());
        let record = record();
        store
            .commit(store.stage(&record, b"data").unwrap())
            .unwrap();
        store
            .request_manual(&record.target_id(), &record.archive_sha256)
            .unwrap();
        let consumers: Vec<_> = (0..2)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || usize::from(store.consume_manual().unwrap().is_some()))
            })
            .collect();
        assert_eq!(
            consumers
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .sum::<usize>(),
            1
        );
    }

    #[test]
    fn target_id_has_a_stable_domain_and_fixed_little_endian_release_asset_ids() {
        assert_eq!(
            record().target_id(),
            "1fda47fc12357e0d1dcdc71b25d7c6741934edabab89ea7019cef1484e236ce9"
        );
        let mut changed = record();
        changed.manifest.push('\n');
        assert_ne!(changed.target_id(), record().target_id());
    }

    #[test]
    fn manual_intent_is_target_specific_without_changing_automatic_consent() {
        let root = Temp::new();
        let store = Store::open(&root.0).unwrap();
        let first = record();
        store.commit(store.stage(&first, b"data").unwrap()).unwrap();
        store.set_automatic(false).unwrap();
        assert!(!store
            .manual_requested(&first.target_id(), &first.archive_sha256)
            .unwrap());
        store
            .request_manual(&first.target_id(), &first.archive_sha256)
            .unwrap();
        assert!(store
            .manual_requested(&first.target_id(), &first.archive_sha256)
            .unwrap());
        assert!(!store.preferences().unwrap().automatic);
        assert!(store
            .request_manual(&first.target_id(), &"b".repeat(64))
            .is_err());
        assert!(store
            .request_manual(&"b".repeat(64), &first.archive_sha256)
            .is_err());
        let mut next = record();
        next.archive_sha256 = "b".repeat(64);
        store.commit(store.stage(&next, b"next").unwrap()).unwrap();
        assert!(!store
            .manual_requested(&next.target_id(), &next.archive_sha256)
            .unwrap());
        assert!(!store.preferences().unwrap().automatic);
    }

    #[test]
    fn manual_intent_rejects_same_archive_with_replaced_release_or_manifest() {
        let root = Temp::new();
        let store = Store::open(&root.0).unwrap();
        let first = record();
        store.publish(&first, b"data").unwrap();
        store
            .request_manual(&first.target_id(), &first.archive_sha256)
            .unwrap();
        for replacement in [
            PreparedRecord {
                release_id: 10,
                ..first.clone()
            },
            PreparedRecord {
                manifest_asset_id: 20,
                ..first.clone()
            },
            PreparedRecord {
                archive_asset_id: 30,
                ..first.clone()
            },
            PreparedRecord {
                manifest: "{}\n".into(),
                ..first.clone()
            },
        ] {
            store.publish(&replacement, b"data").unwrap();
            assert!(!store
                .manual_requested(&replacement.target_id(), &replacement.archive_sha256)
                .unwrap());
            assert!(store
                .request_manual(&first.target_id(), &first.archive_sha256)
                .is_err());
        }
        assert!(store.preferences().unwrap().automatic);
    }

    #[test]
    fn preferences_survive_reopen_and_manual_cache_does_not_change_consent() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        assert!(store.preferences().unwrap().automatic);
        store.set_automatic(false).unwrap();
        store.publish(&record(), b"test").unwrap();
        drop(store);
        let store = Store::open(&temp.0).unwrap();
        assert!(!store.preferences().unwrap().automatic);
        let (cached, bytes) = store.load().unwrap().unwrap();
        assert_eq!(cached, record());
        assert_eq!(bytes, b"test");
    }

    #[test]
    fn publication_retires_only_the_previous_owned_pair() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        fs::write(temp.cache().join("user-sentinel"), b"keep").unwrap();
        store.publish(&record(), b"test").unwrap();
        let first = store.pointer().unwrap().unwrap().id;
        store.publish(&record(), b"next").unwrap();
        assert!(!temp.cache().join(format!("archive-{first}")).exists());
        assert_eq!(
            fs::read(temp.cache().join("user-sentinel")).unwrap(),
            b"keep"
        );
        assert_eq!(store.load().unwrap().unwrap().1, b"next");
    }

    #[test]
    fn symlinks_hardlinks_fifo_world_readable_and_truncated_state_are_rejected() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        let preferences = temp.cache().join("preferences.json");
        let target = temp.0.join("sentinel");
        fs::write(&target, b"keep").unwrap();
        symlink(&target, &preferences).unwrap();
        assert!(store.preferences().is_err());
        assert!(store.set_automatic(false).is_err());
        fs::remove_file(&preferences).unwrap();
        fs::hard_link(&target, &preferences).unwrap();
        assert!(store.preferences().is_err());
        fs::remove_file(&preferences).unwrap();
        let path = CString::new(preferences.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        assert!(store.preferences().is_err());
        fs::remove_file(&preferences).unwrap();
        store.set_automatic(false).unwrap();
        fs::set_permissions(&preferences, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(store.preferences().is_err());
        fs::set_permissions(&preferences, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&preferences, b"{").unwrap();
        assert!(store.preferences().is_err());
        assert_eq!(fs::read(target).unwrap(), b"keep");
    }

    #[test]
    fn root_alias_and_pointer_path_injection_never_reach_external_files() {
        let temp = Temp::new();
        let alias = temp.0.join("alias");
        symlink(&temp.0, &alias).unwrap();
        assert!(Store::open(&alias).is_err());
        let store = Store::open(&temp.0).unwrap();
        store
            .atomic_json(
                "ready.json",
                &serde_json::json!({"schema":1,"id":"../outside"}),
                4096,
            )
            .unwrap();
        assert!(store.load().is_err());
    }

    #[test]
    fn missing_archive_or_changed_size_cannot_be_loaded() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        store.publish(&record(), b"test").unwrap();
        let id = store.pointer().unwrap().unwrap().id;
        let archive = temp.cache().join(format!("archive-{id}"));
        fs::write(&archive, b"changed").unwrap();
        assert!(store.load().is_err());
        fs::remove_file(&archive).unwrap();
        assert!(store.load().is_err());
    }

    fn names(temp: &Temp) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(temp.cache())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    fn assert_pair(temp: &Temp, id: &str, exists: bool) {
        for name in [format!("archive-{id}"), format!("record-{id}.json")] {
            assert_eq!(temp.cache().join(name).exists(), exists);
        }
    }

    #[test]
    fn repeated_capacity_scans_see_new_crash_orphans_and_never_erase_them() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        // Exhausting one directory stream must not consume the next scan.
        store.check_capacity(3).unwrap();
        for index in 0..6 {
            fs::write(temp.cache().join(format!("crash-orphan-{index}")), b"keep").unwrap();
        }
        let before = names(&temp);
        for _ in 0..4 {
            assert!(store.check_capacity(3).is_err());
            assert!(store.stage(&record(), b"test").is_err());
            assert_eq!(names(&temp), before);
        }
        assert!(store.load().unwrap().is_none());
    }

    #[test]
    fn atomic_preferences_also_respect_the_capacity_ceiling() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        store.set_automatic(false).unwrap();
        for index in 0..MAX_CACHE_FILES - 1 {
            fs::write(temp.cache().join(format!("orphan-{index}")), b"keep").unwrap();
        }
        let before = names(&temp);
        for _ in 0..3 {
            assert!(store.set_automatic(true).is_err());
            assert!(!store.preferences().unwrap().automatic);
            assert_eq!(names(&temp), before);
        }
    }

    #[test]
    fn repeated_publications_and_preference_writes_remain_bounded() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        for index in 0..32 {
            store.set_automatic(index % 2 == 0).unwrap();
            store.publish(&record(), b"test").unwrap();
            assert_eq!(store.load().unwrap().unwrap().1, b"test");
            assert_eq!(store.preferences().unwrap().automatic, index % 2 == 0);
            assert_eq!(names(&temp).len(), 4);
            for name in names(&temp) {
                assert_eq!(
                    fs::metadata(temp.cache().join(name)).unwrap().mode() & 0o7777,
                    0o600
                );
            }
        }
    }

    #[test]
    fn dropped_and_discarded_stages_never_publish_or_accumulate() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        for explicit in [false, true] {
            let stage = store.stage(&record(), b"test").unwrap();
            assert!(store.load().unwrap().is_none());
            assert_eq!(names(&temp).len(), 2);
            if explicit {
                store.discard(stage);
            } else {
                drop(stage);
            }
            assert!(names(&temp).is_empty());
            assert!(store.load().unwrap().is_none());
        }
        store.publish(&record(), b"prev").unwrap();
        let previous = store.pointer().unwrap().unwrap().id;
        let staged = store.stage(&record(), b"next").unwrap();
        store.set_automatic(false).unwrap();
        store.discard(staged);
        assert_eq!(store.pointer().unwrap().unwrap().id, previous);
        assert_eq!(store.load().unwrap().unwrap().1, b"prev");
        assert!(!store.preferences().unwrap().automatic);
    }

    #[test]
    fn cross_store_commit_cannot_publish_or_delete_another_stores_pair() {
        let source = Temp::new();
        let target = Temp::new();
        let source_store = Store::open(&source.0).unwrap();
        let target_store = Store::open(&target.0).unwrap();
        target_store.publish(&record(), b"prev").unwrap();
        let target_before = names(&target);
        let stage = source_store.stage(&record(), b"next").unwrap();
        assert!(target_store.commit(stage).is_err());
        assert!(names(&source).is_empty());
        assert_eq!(names(&target), target_before);
        assert_eq!(target_store.load().unwrap().unwrap().1, b"prev");
    }

    #[test]
    fn stage_sync_failure_keeps_previous_pointer_and_cleans_unpublished_pair() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        store.publish(&record(), b"prev").unwrap();
        let before = names(&temp);
        *store.fail_sync.lock().unwrap() = Some(SyncPoint::Stage);
        assert!(store.stage(&record(), b"next").is_err());
        assert_eq!(names(&temp), before);
        assert_eq!(store.load().unwrap().unwrap().1, b"prev");
    }

    #[test]
    fn failure_before_pointer_rename_discards_new_stage_only() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        store.publish(&record(), b"prev").unwrap();
        let old = store.pointer().unwrap().unwrap().id;
        let stage = store.stage(&record(), b"next").unwrap();
        let new = stage.pointer.id.clone();
        for index in 0..3 {
            fs::write(temp.cache().join(format!("orphan-{index}")), b"keep").unwrap();
        }
        assert!(store.commit(stage).is_err());
        assert_eq!(store.pointer().unwrap().unwrap().id, old);
        assert_pair(&temp, &old, true);
        assert_pair(&temp, &new, false);
        assert_eq!(store.load().unwrap().unwrap().1, b"prev");
    }

    #[test]
    fn pointer_sync_failure_retains_both_pairs_and_later_publications_stay_bounded() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        store.publish(&record(), b"prev").unwrap();
        let old = store.pointer().unwrap().unwrap().id;
        let stage = store.stage(&record(), b"next").unwrap();
        let new = stage.pointer.id.clone();
        *store.fail_sync.lock().unwrap() = Some(SyncPoint::Publication);
        assert!(store.commit(stage).is_err());
        // Visible rename is not an acknowledgement of crash durability.
        assert_eq!(store.pointer().unwrap().unwrap().id, new);
        assert_pair(&temp, &old, true);
        assert_pair(&temp, &new, true);
        assert_eq!(store.load().unwrap().unwrap().1, b"next");
        for _ in 0..8 {
            store.publish(&record(), b"last").unwrap();
            assert_eq!(store.load().unwrap().unwrap().1, b"last");
            assert_pair(&temp, &old, true); // uncertain/crash orphan is not garbage-collected
            assert_eq!(names(&temp).len(), 5);
        }
        assert_pair(&temp, &new, false);
    }

    #[test]
    fn retirement_sync_failure_does_not_erase_committed_generation() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        store.publish(&record(), b"prev").unwrap();
        let staged = store.stage(&record(), b"next").unwrap();
        let next = staged.pointer.id.clone();
        *store.fail_sync.lock().unwrap() = Some(SyncPoint::Retirement);
        assert!(store.commit(staged).is_err());
        assert_pair(&temp, &next, true);
        assert_eq!(store.load().unwrap().unwrap().1, b"next");
        store.publish(&record(), b"last").unwrap();
        assert_eq!(names(&temp).len(), 3);
    }

    #[test]
    fn uncertain_preference_sync_reports_failure_without_reverting_visible_opt_out() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        store.set_automatic(true).unwrap();
        *store.fail_sync.lock().unwrap() = Some(SyncPoint::Publication);
        assert!(store.set_automatic(false).is_err());
        assert!(!store.preferences().unwrap().automatic);
        store.set_automatic(false).unwrap();
        assert_eq!(names(&temp), ["preferences.json"]);
    }

    #[test]
    fn a_pointer_already_naming_the_stage_never_retires_that_same_pair() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        let stage = store.stage(&record(), b"test").unwrap();
        store
            .atomic_json("ready.json", &stage.pointer, MAX_PREFERENCES_BYTES)
            .unwrap();
        store.commit(stage).unwrap();
        assert_eq!(store.load().unwrap().unwrap().1, b"test");
        assert_eq!(names(&temp).len(), 3);
    }

    #[test]
    fn staged_file_aliases_fifos_changes_and_replacements_cannot_publish() {
        for kind in ["archive", "record"] {
            for tamper in ["bytes", "replace", "symlink", "hardlink", "fifo", "mode"] {
                let temp = Temp::new();
                let store = Store::open(&temp.0).unwrap();
                let stage = store.stage(&record(), b"test").unwrap();
                let name = if kind == "archive" {
                    format!("archive-{}", stage.pointer.id)
                } else {
                    format!("record-{}.json", stage.pointer.id)
                };
                let path = temp.cache().join(name);
                let saved = path.with_extension("saved");
                match tamper {
                    "bytes" => {
                        fs::write(&path, b"evil").unwrap();
                    }
                    "replace" => {
                        let bytes = fs::read(&path).unwrap();
                        fs::rename(&path, &saved).unwrap();
                        fs::write(&path, bytes).unwrap();
                        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
                    }
                    "symlink" => {
                        fs::rename(&path, &saved).unwrap();
                        symlink(&saved, &path).unwrap();
                    }
                    "hardlink" => {
                        fs::hard_link(&path, &saved).unwrap();
                    }
                    "fifo" => {
                        fs::rename(&path, &saved).unwrap();
                        let name = CString::new(path.as_os_str().as_bytes()).unwrap();
                        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                    }
                    "mode" => {
                        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
                    }
                    _ => unreachable!(),
                }
                assert!(store.commit(stage).is_err(), "{kind} {tamper}");
                assert!(store.load().unwrap().is_none());
                if matches!(tamper, "replace" | "symlink" | "fifo") {
                    // A replaced entry belongs to whoever replaced it; Drop
                    // cannot erase it just because the name once belonged to us.
                    assert!(fs::symlink_metadata(path).is_ok());
                }
            }
        }
    }

    #[test]
    fn anchored_directory_and_cleanup_do_not_follow_a_replacement_cache_path() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        let saved = temp.0.join("original-cache");
        fs::rename(temp.cache(), &saved).unwrap();
        fs::create_dir(temp.cache()).unwrap();
        fs::set_permissions(temp.cache(), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(temp.cache().join("sentinel"), b"keep").unwrap();
        let stage = store.stage(&record(), b"test").unwrap();
        assert_eq!(fs::read_dir(&saved).unwrap().count(), 2);
        store.discard(stage);
        assert_eq!(fs::read_dir(&saved).unwrap().count(), 0);
        store.publish(&record(), b"next").unwrap();
        assert_eq!(store.load().unwrap().unwrap().1, b"next");
        assert_eq!(names(&temp), ["sentinel"]);
        assert_eq!(fs::read(temp.cache().join("sentinel")).unwrap(), b"keep");
    }

    #[test]
    fn changed_cache_permissions_and_malformed_preferences_are_not_hidden() {
        let temp = Temp::new();
        let store = Store::open(&temp.0).unwrap();
        fs::set_permissions(temp.cache(), fs::Permissions::from_mode(0o777)).unwrap();
        assert!(store.preferences().is_err());
        assert!(store.stage(&record(), b"test").is_err());
        assert!(store.set_automatic(false).is_err());
        fs::set_permissions(temp.cache(), fs::Permissions::from_mode(0o700)).unwrap();
        store.set_automatic(false).unwrap();
        fs::write(temp.cache().join("preferences.json"), b"{").unwrap();
        assert!(store.set_automatic(true).is_err());
        assert_eq!(
            fs::read(temp.cache().join("preferences.json")).unwrap(),
            b"{"
        );
    }

    #[test]
    fn simultaneous_stage_reservations_cannot_overrun_capacity() {
        let temp = Temp::new();
        let store = Arc::new(Store::open(&temp.0).unwrap());
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let store = store.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.stage(&record(), b"test").ok()
                })
            })
            .collect();
        let mut stages: Vec<_> = workers
            .into_iter()
            .filter_map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(stages.len(), 3);
        assert_eq!(names(&temp).len(), 6);
        store.set_automatic(false).unwrap();
        store.commit(stages.pop().unwrap()).unwrap();
        assert_eq!(names(&temp).len(), MAX_CACHE_FILES);
        drop(stages);
        assert_eq!(names(&temp).len(), 4);
        assert!(!store.preferences().unwrap().automatic);
    }

    #[test]
    fn opt_out_can_persist_while_stage_is_paused_at_large_write_boundary() {
        use std::{sync::mpsc, time::Duration};
        let temp = Temp::new();
        let store = Arc::new(Store::open(&temp.0).unwrap());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        *store.stage_pause.lock().unwrap() = Some((entered_tx, resume_rx));
        let writer_store = store.clone();
        let writer = std::thread::spawn(move || writer_store.stage(&record(), b"test"));
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let (ack_tx, ack_rx) = mpsc::channel();
        let preference_store = store.clone();
        let preference =
            std::thread::spawn(move || ack_tx.send(preference_store.set_automatic(false)).unwrap());
        let acknowledged = ack_rx.recv_timeout(Duration::from_secs(2));
        // Always unblock and join before asserting, including a regression that
        // incorrectly holds the mutation lock across the slow-write phase.
        resume_tx.send(()).unwrap();
        let stage = writer.join().unwrap().unwrap();
        preference.join().unwrap();
        assert!(acknowledged.unwrap().is_ok());
        store.discard(stage); // parent rejected this cancelled generation
        assert!(!store.preferences().unwrap().automatic);
        assert!(store.load().unwrap().is_none());
        assert_eq!(names(&temp), ["preferences.json"]);
    }
}
