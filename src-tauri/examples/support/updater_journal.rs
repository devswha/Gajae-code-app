//! QA-only durability/ownership proof, not a product updater or an installer.
//!
//! A live handle is minted only after file + directory sync. Parsed records
//! never mint handles. Drop retains blockers. The private, exclusively claimed
//! fixture namespace is assumed cooperative: descriptor identity checks and an
//! exclusive rename are NOT a conditional-inode rename against an adversarial
//! same-UID writer in the final check/rename interval. Product integration needs
//! its own namespace/process proof; this module does not establish G0.

use std::{
    ffi::{CStr, CString},
    fs::{File, Metadata},
    io::{Read, Seek, SeekFrom, Write},
    marker::PhantomData,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path, PathBuf},
    rc::Rc,
};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::updater_attempt::ATTEMPT_RECORD;

pub const ROOT_PREFIX: &str = "gajae-updater-journal-";
const CLAIM: &str = ".qa-journal-owner";
const MAX_RECORD: u64 = 4096;
const MAX_TARGET: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Root,
    NotFresh,
    Ownership,
    AlreadyPresent,
    Io,
    WrongPhase,
    TargetMismatch,
    #[cfg(test)]
    Injected,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "QA journal {self:?}")
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallerReturn {
    Success,
    Failed,
    Cancelled,
    Uncertain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncPoint {
    Created,
    Truncated,
    BeforeFileSync,
    FileSynced,
    BeforeDirectorySync,
    DirectorySynced,
}

#[derive(Serialize)]
struct Record {
    schema: u8,
    purpose: &'static str,
    attempt_id: String,
    owner_pid: u32,
    root_device: u64,
    root_inode: u64,
    expected_target_sha256: String,
    state: &'static str,
}

struct Root {
    path: PathBuf,
    directory: File,
    marker: File,
    marker_bytes: Vec<u8>,
    pid: u32,
}

/// Cannot reopen a nonempty root or recover authority from a saved claim.
pub struct Journal {
    root: Rc<Root>,
}

/// Non-cloneable, non-Send live ownership; forked copies are PID-fenced too.
/// Dropping any unarchived handle intentionally leaves the blocking entry.
#[must_use = "Dropping an attempt retains its startup blocker"]
pub struct Attempt {
    root: Rc<Root>,
    file: File,
    bytes: Vec<u8>,
    record: Record,
    expected_digest: [u8; 32],
    verified_target: Option<(String, Metadata)>,
    poisoned: bool,
    _not_send: PhantomData<Rc<()>>,
}

#[derive(Debug)]
pub struct Archived {
    pub name: String,
}

impl Journal {
    pub fn claim_fresh(path: &Path) -> Result<Self> {
        let temp = std::env::temp_dir()
            .canonicalize()
            .map_err(|_| Error::Root)?;
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or(Error::Root)?;
        if path.parent() != Some(temp.as_path())
            || !name.starts_with(ROOT_PREFIX)
            || name.len() < ROOT_PREFIX.len() + 6
            || name.len() > ROOT_PREFIX.len() + 80
            || !name.bytes().all(|v| v.is_ascii_alphanumeric() || v == b'-')
            || path.canonicalize().map_err(|_| Error::Root)? != path
        {
            return Err(Error::Root);
        }
        let directory = open_root(path)?;
        private(&directory.metadata().map_err(|_| Error::Io)?, true)?;
        // Cooperative process exclusion is held by the directory descriptor.
        if unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(Error::Ownership);
        }
        if !empty_directory(&directory)? {
            return Err(Error::NotFresh);
        }
        let marker_bytes =
            format!("qa-journal-only:{}:{}\n", std::process::id(), random_id()?).into_bytes();
        let mut marker = create_at(&directory, CLAIM)?;
        marker.write_all(&marker_bytes).map_err(|_| Error::Io)?;
        marker.sync_all().map_err(|_| Error::Io)?;
        directory.sync_all().map_err(|_| Error::Io)?;
        // The explicitly fresh root's own directory entry also needs a barrier.
        open_root(&temp)?.sync_all().map_err(|_| Error::Io)?;
        let root = Rc::new(Root {
            path: path.to_owned(),
            directory,
            marker,
            marker_bytes,
            pid: std::process::id(),
        });
        root.validate()?;
        Ok(Self { root })
    }

    pub fn begin(&self, expected_digest: [u8; 32]) -> Result<Attempt> {
        self.begin_inner(expected_digest, &mut |_| Ok(()))
    }

    fn begin_inner(
        &self,
        expected_digest: [u8; 32],
        observe: &mut dyn FnMut(SyncPoint) -> Result<()>,
    ) -> Result<Attempt> {
        self.root.validate()?;
        let metadata = self.root.directory.metadata().map_err(|_| Error::Io)?;
        let record = Record {
            schema: 1,
            purpose: "isolated-qa-journal-not-install-proof",
            attempt_id: random_id()?,
            owner_pid: self.root.pid,
            root_device: metadata.dev(),
            root_inode: metadata.ino(),
            expected_target_sha256: hex(&expected_digest),
            state: "pending",
        };
        let bytes = serde_json::to_vec(&record).map_err(|_| Error::Io)?;
        let mut file = create_at(&self.root.directory, ATTEMPT_RECORD)?;
        // Any error from here retains the entry, even if empty or partial.
        observe(SyncPoint::Created)?;
        persist(&mut file, &bytes, &self.root.directory, observe)?;
        self.root.validate()?;
        named_owned(&self.root.directory, ATTEMPT_RECORD, &file, &bytes)?;
        Ok(Attempt {
            root: self.root.clone(),
            file,
            bytes,
            record,
            expected_digest,
            verified_target: None,
            poisoned: false,
            _not_send: PhantomData,
        })
    }

    #[cfg(test)]
    pub fn begin_observed(
        &self,
        expected_digest: [u8; 32],
        mut observe: impl FnMut(SyncPoint) -> Result<()>,
    ) -> Result<Attempt> {
        self.begin_inner(expected_digest, &mut observe)
    }
}

impl Root {
    fn validate(&self) -> Result<()> {
        // Reject copied live handles in a fork before any filesystem operation.
        if std::process::id() != self.pid {
            return Err(Error::Ownership);
        }
        let metadata = self.directory.metadata().map_err(|_| Error::Io)?;
        private(&metadata, true)?;
        let current = open_root(&self.path)?;
        if !same_inode(&metadata, &current.metadata().map_err(|_| Error::Io)?) {
            return Err(Error::Ownership);
        }
        named_owned(&self.directory, CLAIM, &self.marker, &self.marker_bytes)
    }
}

impl Attempt {
    /// Writes only a small QA sentinel, never an app bundle. Requiring the live
    /// attempt makes the simulation itself obey the pre-mutation sync barrier.
    pub fn write_qa_target(&self, bytes: &[u8]) -> Result<()> {
        self.validate()?;
        if !matches!(self.record.state, "pending" | "installer_returned_success") {
            return Err(Error::WrongPhase);
        }
        if bytes.len() as u64 > MAX_TARGET {
            return Err(Error::TargetMismatch);
        }
        let mut file = create_at(&self.root.directory, "qa-target.bin")?;
        file.write_all(bytes).map_err(|_| Error::Io)?;
        file.sync_all().map_err(|_| Error::Io)?;
        self.root.directory.sync_all().map_err(|_| Error::Io)?;
        self.root.validate()
    }

    fn validate(&self) -> Result<()> {
        if self.poisoned {
            return Err(Error::Ownership);
        }
        self.root.validate()?;
        named_owned(
            &self.root.directory,
            ATTEMPT_RECORD,
            &self.file,
            &self.bytes,
        )
    }

    /// Records what the caller says the installer RETURNED, not OS writer exit.
    /// This helper never invokes an installer; the probe uses explicit simulation.
    pub fn record_installer_returned(&mut self, outcome: InstallerReturn) -> Result<()> {
        self.returned_inner(outcome, &mut |_| Ok(()))
    }

    fn returned_inner(
        &mut self,
        outcome: InstallerReturn,
        observe: &mut dyn FnMut(SyncPoint) -> Result<()>,
    ) -> Result<()> {
        if self.record.state != "pending" {
            return Err(Error::WrongPhase);
        }
        let state = match outcome {
            InstallerReturn::Success => "installer_returned_success",
            InstallerReturn::Failed => "installer_returned_failure",
            InstallerReturn::Cancelled => "installer_returned_cancelled",
            InstallerReturn::Uncertain => "installer_returned_uncertain",
        };
        self.record_state(state, observe)
    }

    /// Separately hashes a small, descriptor-opened QA target, never version JSON.
    /// This is NOT verification of an installed app signature, notarization or OS support.
    pub fn verify_target(&mut self, name: &str) -> Result<()> {
        if self.record.state != "installer_returned_success" {
            return Err(Error::WrongPhase);
        }
        self.validate()?;
        let (metadata, digest) = target_digest(&self.root.directory, name)?;
        if digest != self.expected_digest {
            self.poisoned = true;
            return Err(Error::TargetMismatch);
        }
        self.verified_target = Some((name.to_owned(), metadata));
        self.record_state("target_bytes_verified", &mut |_| Ok(()))
    }

    fn record_state(
        &mut self,
        state: &'static str,
        observe: &mut dyn FnMut(SyncPoint) -> Result<()>,
    ) -> Result<()> {
        self.validate()?;
        self.poisoned = true; // Any partial write/sync failure permanently blocks this handle.
        self.record.state = state;
        let bytes = serde_json::to_vec(&self.record).map_err(|_| Error::Io)?;
        self.file.set_len(0).map_err(|_| Error::Io)?;
        self.file.seek(SeekFrom::Start(0)).map_err(|_| Error::Io)?;
        observe(SyncPoint::Truncated)?;
        persist(&mut self.file, &bytes, &self.root.directory, observe)?;
        self.root.validate()?;
        named_owned(&self.root.directory, ATTEMPT_RECORD, &self.file, &bytes)?;
        self.bytes = bytes;
        self.poisoned = false;
        Ok(())
    }

    pub fn archive_verified(mut self) -> Result<Archived> {
        self.validate()?;
        if self.record.state != "target_bytes_verified" {
            return Err(Error::WrongPhase);
        }
        let (name, expected) = self.verified_target.as_ref().ok_or(Error::WrongPhase)?;
        let (current, digest) = target_digest(&self.root.directory, name)?;
        if !same_inode(expected, &current) || digest != self.expected_digest {
            return Err(Error::TargetMismatch);
        }
        let archive = format!(
            "desktop-update-attempt.{}.verified.json",
            self.record.attempt_id
        );
        // Exclusive destination: never overwrite an unrelated archive. The
        // source was descriptor-checked; this is a cooperative QA namespace,
        // not a claim of an atomic inode-conditional rename against same-UID races.
        self.validate()?;
        rename_exclusive(&self.root.directory, ATTEMPT_RECORD, &archive)?;
        let verified = named_owned(&self.root.directory, &archive, &self.file, &self.bytes)
            .and_then(|()| self.root.directory.sync_all().map_err(|_| Error::Io));
        if verified.is_err() {
            // Best-effort no-replace restoration of the EXACT owned inode only.
            // Never overwrite a substitute that now occupies the canonical name.
            if named_owned(&self.root.directory, &archive, &self.file, &self.bytes).is_ok() {
                let _ = rename_exclusive(&self.root.directory, &archive, ATTEMPT_RECORD);
                let _ = self.root.directory.sync_all();
            }
            return Err(Error::Io);
        }
        self.poisoned = true;
        Ok(Archived { name: archive })
    }

    #[cfg(test)]
    pub fn returned_observed(
        &mut self,
        outcome: InstallerReturn,
        mut observe: impl FnMut(SyncPoint) -> Result<()>,
    ) -> Result<()> {
        self.returned_inner(outcome, &mut observe)
    }

    #[cfg(test)]
    pub fn owner_pid_matches(&self) -> bool {
        std::process::id() == self.root.pid
    }
}

fn persist(
    file: &mut File,
    bytes: &[u8],
    directory: &File,
    observe: &mut dyn FnMut(SyncPoint) -> Result<()>,
) -> Result<()> {
    if bytes.len() as u64 > MAX_RECORD {
        return Err(Error::Io);
    }
    file.write_all(bytes).map_err(|_| Error::Io)?;
    observe(SyncPoint::BeforeFileSync)?;
    file.sync_all().map_err(|_| Error::Io)?;
    observe(SyncPoint::FileSynced)?;
    observe(SyncPoint::BeforeDirectorySync)?;
    directory.sync_all().map_err(|_| Error::Io)?;
    observe(SyncPoint::DirectorySynced)
}

fn target_digest(directory: &File, name: &str) -> Result<(Metadata, [u8; 32])> {
    if name == ATTEMPT_RECORD || name == CLAIM {
        return Err(Error::TargetMismatch);
    }
    let file = open_at(directory, name, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
    let before = file.metadata().map_err(|_| Error::Io)?;
    private(&before, false)?;
    if before.len() > MAX_TARGET {
        return Err(Error::TargetMismatch);
    }
    let bytes = read_bounded(&file, MAX_TARGET)?;
    let after = file.metadata().map_err(|_| Error::Io)?;
    private(&after, false)?;
    if before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
    {
        return Err(Error::TargetMismatch);
    }
    Ok((after, Sha256::digest(bytes).into()))
}

fn named_owned(directory: &File, name: &str, owned: &File, expected: &[u8]) -> Result<()> {
    let current = open_at(directory, name, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
    let metadata = current.metadata().map_err(|_| Error::Io)?;
    let original = owned.metadata().map_err(|_| Error::Io)?;
    private(&metadata, false)?;
    private(&original, false)?;
    if !same_inode(&metadata, &original) || read_bounded(&current, MAX_RECORD)? != expected {
        return Err(Error::Ownership);
    }
    Ok(())
}

fn read_bounded(file: &File, limit: u64) -> Result<Vec<u8>> {
    let mut file = file.try_clone().map_err(|_| Error::Io)?;
    file.seek(SeekFrom::Start(0)).map_err(|_| Error::Io)?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Io)?;
    if bytes.len() as u64 > limit {
        return Err(Error::Ownership);
    }
    Ok(bytes)
}

fn private(metadata: &Metadata, directory: bool) -> Result<()> {
    if metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o7777 != if directory { 0o700 } else { 0o600 }
        || (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || metadata.nlink() != 1))
    {
        return Err(Error::Ownership);
    }
    Ok(())
}

fn same_inode(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}
fn component(name: &str) -> Result<CString> {
    if name.is_empty() || name.len() > 255 || name == "." || name == ".." || name.contains('/') {
        return Err(Error::Root);
    }
    CString::new(name).map_err(|_| Error::Root)
}
fn open_at(directory: &File, name: &str, flags: i32, mode: libc::mode_t) -> Result<File> {
    let name = component(name)?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::AlreadyExists {
                Error::AlreadyPresent
            } else {
                Error::Io
            },
        );
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn create_at(directory: &File, name: &str) -> Result<File> {
    let file = open_at(
        directory,
        name,
        libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
        0o600,
    )?;
    private(&file.metadata().map_err(|_| Error::Io)?, false)?;
    Ok(file)
}
fn open_root(path: &Path) -> Result<File> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
    {
        return Err(Error::Root);
    }
    let mut directory = File::open("/").map_err(|_| Error::Root)?;
    for part in path.components() {
        if let Component::Normal(name) = part {
            directory = open_at(
                &directory,
                name.to_str().ok_or(Error::Root)?,
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
            )?;
        }
    }
    Ok(directory)
}
fn empty_directory(directory: &File) -> Result<bool> {
    let fd = unsafe { libc::dup(directory.as_raw_fd()) };
    if fd < 0 {
        return Err(Error::Io);
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe { libc::close(fd) };
        return Err(Error::Io);
    }
    let mut empty = true;
    let mut failed = false;
    loop {
        #[cfg(target_os = "macos")]
        let errno = unsafe { libc::__error() };
        #[cfg(target_os = "linux")]
        let errno = unsafe { libc::__errno_location() };
        unsafe { *errno = 0 };
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            failed = unsafe { *errno != 0 };
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name != b"." && name != b".." {
            empty = false;
            break;
        }
    }
    if unsafe { libc::closedir(stream) } != 0 || failed {
        Err(Error::Io)
    } else {
        Ok(empty)
    }
}
fn rename_exclusive(directory: &File, from: &str, to: &str) -> Result<()> {
    let from = component(from)?;
    let to = component(to)?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            directory.as_raw_fd(),
            from.as_ptr(),
            directory.as_raw_fd(),
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            directory.as_raw_fd(),
            from.as_ptr(),
            directory.as_raw_fd(),
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        ) as i32
    };
    if result != 0 {
        return Err(Error::Io);
    }
    Ok(())
}
fn random_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| Error::Io)?;
    Ok(hex(&bytes))
}
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(DIGITS[(byte >> 4) as usize] as char);
        value.push(DIGITS[(byte & 15) as usize] as char);
    }
    value
}

/// Tests/probe callers create the NEW root explicitly, never load an existing one.
pub fn create_fresh_temp_root() -> Result<PathBuf> {
    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| Error::Root)?;
    let mut template = temp
        .join(format!("{ROOT_PREFIX}XXXXXX"))
        .as_os_str()
        .as_bytes()
        .to_vec();
    template.push(0);
    let created = unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) };
    if created.is_null() {
        return Err(Error::Io);
    }
    let bytes = unsafe { CStr::from_ptr(created) }.to_bytes();
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}
