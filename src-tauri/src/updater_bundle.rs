//! Read-only, macOS installed-bundle comparison against an archive inventory.
//!
//! The caller MUST obtain `expected` by inspecting the same bytes whose updater
//! signature it has verified. An inventory digest is not a signature. Matching
//! every member also binds the Info.plist/payload/runtime fields independently
//! checked by `updater_archive`; this module does not parse them again.
//!
//! No extraction, installation, explicit filesystem writes, process execution,
//! Apple code-signature or notarization verification happens here. Descriptor-
//! relative no-follow reads, before/after metadata and a second complete walk
//! detect substitutions, but are not an atomic filesystem snapshot or absolute
//! protection against a hostile process with the same UID. Evidence expires as
//! soon as the tree changes; the installer/journal owns subsequent decisions.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    ffi::{CStr, CString},
    fs::File,
    io::Read,
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd, IntoRawFd},
        unix::ffi::OsStrExt,
    },
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use crate::updater_archive::{
    ArchiveEntry, ArchiveEntryKind, ArchiveInventory, MAX_COMPRESSED_BYTES, MAX_EXPANDED_BYTES,
};

const MAX_ENTRIES: usize = 100_000;
const MAX_PATH_BYTES: usize = 4096;
const MAX_DEPTH: usize = 128;
const MAX_METADATA_BYTES: usize = 32 * 1024 * 1024;
const MAX_LINK_DEREFERENCES: usize = 64;

/// Evidence of a complete inventory match at verification time, not a durable
/// authorization to install or relaunch. Intentionally not deserializable and
/// not constructible through public fields.
#[derive(Debug)]
pub(crate) struct VerifiedBundle {
    root: PathBuf,
    inventory_sha256: String,
}

impl VerifiedBundle {
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn inventory_sha256(&self) -> &str {
        &self.inventory_sha256
    }
}

pub(crate) fn verify_inventory(
    app_dir: &Path,
    expected: &ArchiveInventory,
) -> Result<VerifiedBundle, String> {
    verify_with_limits(app_dir, expected, Limits::default(), || Ok(()))
}

#[derive(Clone, Copy)]
struct Limits {
    entries: usize,
    bytes: u64,
    depth: usize,
    metadata: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            entries: MAX_ENTRIES,
            bytes: MAX_EXPANDED_BYTES,
            depth: MAX_DEPTH,
            metadata: MAX_METADATA_BYTES,
        }
    }
}

fn require(ok: bool, message: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(format!("Installed bundle inventory: {message}"))
    }
}

fn io_error(operation: &str) -> String {
    format!(
        "Installed bundle inventory: {operation}: {}",
        std::io::Error::last_os_error()
    )
}

fn verify_with_limits(
    app_dir: &Path,
    expected: &ArchiveInventory,
    limits: Limits,
    between_walks: impl FnOnce() -> Result<(), String>,
) -> Result<VerifiedBundle, String> {
    let entries = validate_inventory(expected, limits)?;
    let anchor = RootAnchor::open(app_dir, &expected.root)?;
    let root = anchor.directory();
    let root_before = stat_fd(root)?;
    let mut first = Walk::new(&entries, limits, root_before.dev, None);
    first.visit_directory(root, &expected.root, root_before, 1)?;
    require(first.seen.len() == entries.len(), "missing members")?;
    require(
        first.bytes == expected.total_file_bytes,
        "total file bytes differ",
    )?;

    // Private hook makes mutation tests deterministic without introducing a
    // callback into the public verification API.
    between_walks()?;
    anchor.revalidate()?;
    let mut second = Walk::new(&entries, limits, root_before.dev, Some(&first.seen));
    second.visit_directory(root, &expected.root, stat_fd(root)?, 1)?;
    require(
        second.seen == first.seen,
        "tree changed after content reads",
    )?;
    require(
        stat_fd(root)? == root_before,
        "app root changed during reads",
    )?;
    anchor.revalidate()?;
    Ok(VerifiedBundle {
        root: app_dir.to_path_buf(),
        inventory_sha256: expected.inventory_sha256.clone(),
    })
}

fn ascii_path(text: &str) -> Result<(), String> {
    require(
        !text.is_empty() && text.len() <= MAX_PATH_BYTES,
        "path length limit",
    )?;
    require(
        text.bytes()
            .all(|b| (0x20..0x7f).contains(&b) && b != b'\\' && b != b':'),
        "unsupported path character (ASCII paths only)",
    )
}

fn member_path(text: &str, depth: usize) -> Result<(), String> {
    ascii_path(text)?;
    require(text.split('/').count() <= depth, "path depth limit")?;
    for part in text.split('/') {
        require(
            !part.is_empty()
                && part.len() <= 255
                && part != "."
                && part != ".."
                && !part.starts_with("._"),
            "noncanonical path component",
        )?;
    }
    Ok(())
}

fn digest_text(text: &str) -> Result<(), String> {
    require(
        text.len() == 64
            && text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid SHA-256",
    )
}

fn charge_metadata(total: &mut usize, amount: usize, limits: Limits) -> Result<(), String> {
    *total = total
        .checked_add(amount)
        .ok_or("Inventory metadata overflow")?;
    require(*total <= limits.metadata, "metadata byte limit")
}

/// ArchiveInventory is public/serializable, so reject invalid shapes before any
/// filesystem access. Keep the framing/path policy in sync with updater_archive.
/// This is NOT a replacement for the caller's signature and archive inspection.
fn validate_inventory(
    expected: &ArchiveInventory,
    limits: Limits,
) -> Result<BTreeMap<&str, &ArchiveEntry>, String> {
    require(
        !expected.entries.is_empty() && expected.entries.len() <= limits.entries,
        "entry count limit",
    )?;
    member_path(&expected.root, 1)?;
    for component in [
        &expected.identity.product_name,
        &expected.identity.executable,
        &expected.identity.bundle_identifier,
        &expected.identity.package_name,
    ] {
        member_path(component, 1)?;
    }
    for version in [
        &expected.identity.desktop_version,
        &expected.identity.product_version,
    ] {
        require(version.len() <= 128, "identity version length limit")?;
        let version =
            semver::Version::parse(version).map_err(|_| "Invalid inventory identity version")?;
        require(version.build.is_empty(), "identity version build metadata")?;
    }
    let os = &expected.identity.minimum_system_version;
    require(os.len() <= 32, "identity OS version length limit")?;
    let parts: Vec<_> = os.split('.').collect();
    require(matches!(parts.len(), 2 | 3), "invalid identity OS version")?;
    for (index, part) in parts.iter().enumerate() {
        require(
            !part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
                && part
                    .parse::<u32>()
                    .is_ok_and(|value| value <= if index == 0 { 65535 } else { 255 }),
            "invalid identity OS version component",
        )?;
    }
    require(
        expected.root == format!("{}.app", expected.identity.product_name),
        "app root does not match archive identity",
    )?;
    require(
        expected.compressed_bytes > 0
            && expected.compressed_bytes <= MAX_COMPRESSED_BYTES as u64
            && expected.expanded_bytes <= MAX_EXPANDED_BYTES
            && expected.expanded_bytes % 512 == 0
            && expected.total_file_bytes <= limits.bytes,
        "archive byte limits",
    )?;
    for digest in [
        &expected.archive_sha256,
        &expected.inventory_sha256,
        &expected.runtime_manifest_sha256,
    ] {
        digest_text(digest)?;
    }
    let mut entries = BTreeMap::new();
    let mut aliases = BTreeSet::new();
    let mut metadata = 0;
    let mut total_bytes = 0_u64;
    let mut minimum_expanded = 1024 + 512 * expected.entries.len() as u64;
    let mut previous: Option<&str> = None;
    for entry in &expected.entries {
        member_path(&entry.path, limits.depth)?;
        require(
            entry.path == expected.root
                || entry
                    .path
                    .strip_prefix(&expected.root)
                    .is_some_and(|tail| tail.starts_with('/')),
            "foreign inventory root",
        )?;
        require(
            previous.is_none_or(|path| path < entry.path.as_str()),
            "duplicate or unsorted inventory paths",
        )?;
        previous = Some(&entry.path);
        require(
            aliases.insert(entry.path.to_ascii_lowercase()),
            "case-alias inventory paths",
        )?;
        require(entry.mode <= 0o777, "special or invalid mode bits")?;
        charge_metadata(&mut metadata, entry.path.len(), limits)?;
        match &entry.kind {
            ArchiveEntryKind::File { size, sha256 } => {
                digest_text(sha256)?;
                total_bytes = total_bytes.checked_add(*size).ok_or("File size overflow")?;
                require(total_bytes <= limits.bytes, "file byte limit")?;
                minimum_expanded = minimum_expanded
                    .checked_add(size.checked_add(511).ok_or("File size overflow")? & !511)
                    .ok_or("Expanded size overflow")?;
            }
            ArchiveEntryKind::Directory => {}
            ArchiveEntryKind::Symlink { target } => {
                ascii_path(target)?;
                require(
                    !target.starts_with('/')
                        && !target.contains("//")
                        && target.split('/').count() <= limits.depth,
                    "absolute or noncanonical link target",
                )?;
                charge_metadata(&mut metadata, target.len(), limits)?;
            }
        }
        entries.insert(entry.path.as_str(), entry);
    }
    require(
        total_bytes == expected.total_file_bytes && minimum_expanded <= expected.expanded_bytes,
        "inconsistent inventory byte totals",
    )?;
    require(
        entries
            .get(expected.root.as_str())
            .is_some_and(|entry| matches!(entry.kind, ArchiveEntryKind::Directory)),
        "explicit app directory root is required",
    )?;
    for entry in entries.values() {
        if entry.path != expected.root {
            let parent = entry.path.rsplit_once('/').ok_or("Missing parent")?.0;
            require(
                entries
                    .get(parent)
                    .is_some_and(|entry| matches!(entry.kind, ArchiveEntryKind::Directory)),
                "member beneath missing, file or symlink parent",
            )?;
        }
        if let ArchiveEntryKind::Symlink { target } = &entry.kind {
            validate_link(entry, target, &entries, &expected.root, limits)?;
        }
    }
    require(
        inventory_hash(&expected.entries) == expected.inventory_sha256,
        "inventory digest mismatch",
    )?;
    Ok(entries)
}

fn validate_link<'a>(
    entry: &'a ArchiveEntry,
    target: &'a str,
    entries: &BTreeMap<&str, &'a ArchiveEntry>,
    root: &str,
    limits: Limits,
) -> Result<(), String> {
    let mut stack: Vec<_> = entry
        .path
        .rsplit_once('/')
        .ok_or("Symlink root")?
        .0
        .split('/')
        .collect();
    let mut pending: VecDeque<_> = target.split('/').collect();
    let mut dereferences = 0;
    while let Some(part) = pending.pop_front() {
        require(
            entries
                .get(stack.join("/").as_str())
                .is_some_and(|entry| matches!(entry.kind, ArchiveEntryKind::Directory)),
            "link traverses a non-directory",
        )?;
        match part {
            "" | "." => {}
            ".." => {
                require(stack.len() > 1, "link escapes app root")?;
                stack.pop();
            }
            part => {
                stack.push(part);
                require(stack.len() <= limits.depth, "resolved link depth limit")?;
                let resolved = stack.join("/");
                let next = entries
                    .get(resolved.as_str())
                    .ok_or("Link target missing or aliased")?;
                if let ArchiveEntryKind::Symlink { target } = &next.kind {
                    dereferences += 1;
                    require(
                        dereferences <= MAX_LINK_DEREFERENCES,
                        "link cycle or hop limit",
                    )?;
                    stack.pop();
                    for part in target.split('/').rev() {
                        pending.push_front(part);
                    }
                }
            }
        }
    }
    require(
        stack.first().copied() == Some(root),
        "link escapes app root",
    )
}

fn inventory_hash(entries: &[ArchiveEntry]) -> String {
    fn field(hash: &mut Sha256, bytes: &[u8]) {
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    let mut hash = Sha256::new();
    hash.update(b"gajae-updater-inventory-v1\0");
    hash.update((entries.len() as u64).to_be_bytes());
    for entry in entries {
        field(&mut hash, entry.path.as_bytes());
        hash.update(entry.mode.to_be_bytes());
        match &entry.kind {
            ArchiveEntryKind::Directory => hash.update([0]),
            ArchiveEntryKind::File { size, sha256 } => {
                hash.update([1]);
                hash.update(size.to_be_bytes());
                field(&mut hash, sha256.as_bytes());
            }
            ArchiveEntryKind::Symlink { target } => {
                hash.update([2]);
                field(&mut hash, target.as_bytes());
            }
        }
    }
    format!("{:x}", hash.finalize())
}

/// Ignore atime: reading can legitimately change it. ctime catches same-length
/// rewrites even if the writer restores mtime. No timestamp is a same-UID proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Snapshot {
    dev: libc::dev_t,
    ino: libc::ino_t,
    mode: libc::mode_t,
    links: libc::nlink_t,
    uid: libc::uid_t,
    gid: libc::gid_t,
    size: libc::off_t,
    modified: (libc::time_t, libc::c_long),
    changed: (libc::time_t, libc::c_long),
    flags: u32,
    generation: u32,
}

impl Snapshot {
    fn from_stat(stat: libc::stat) -> Self {
        Self {
            dev: stat.st_dev,
            ino: stat.st_ino,
            mode: stat.st_mode,
            links: stat.st_nlink,
            uid: stat.st_uid,
            gid: stat.st_gid,
            size: stat.st_size,
            modified: (stat.st_mtime, stat.st_mtime_nsec),
            changed: (stat.st_ctime, stat.st_ctime_nsec),
            flags: stat.st_flags,
            generation: stat.st_gen,
        }
    }

    fn is_dir(self) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFDIR
    }

    fn same_ancestor(self, other: Self) -> bool {
        // Unrelated sibling activity may change ancestor timestamps/link counts.
        self.dev == other.dev
            && self.ino == other.ino
            && self.mode == other.mode
            && self.uid == other.uid
            && self.gid == other.gid
            && self.flags == other.flags
            && self.generation == other.generation
    }
}

fn stat_fd(file: &File) -> Result<Snapshot, String> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: live owned descriptor and valid writable stat storage; initialize
    // only on successful fstat.
    if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(io_error("fstat"));
    }
    Ok(Snapshot::from_stat(unsafe { stat.assume_init() }))
}

fn stat_at(parent: &File, name: &CStr) -> Result<Snapshot, String> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: callers supply one component (never a member path) and a live
    // directory descriptor. AT_SYMLINK_NOFOLLOW inspects the link itself.
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io_error("fstatat (no-follow)"));
    }
    Ok(Snapshot::from_stat(unsafe { stat.assume_init() }))
}

fn open_at(parent: &File, name: &CStr, directory: bool) -> Result<File, String> {
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    // SAFETY: a single component relative to a live directory. NONBLOCK keeps a
    // regular-file-to-FIFO substitution from blocking before the following stat.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io_error("openat (no-follow)"));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

struct RootAnchor {
    path: PathBuf,
    // Anchor each ancestor once; never reopen an ancestor through its pathname.
    chain: Vec<(File, Snapshot)>,
    names: Vec<CString>,
}

impl RootAnchor {
    fn open(path: &Path, root: &str) -> Result<Self, String> {
        let bytes = path.as_os_str().as_bytes();
        require(
            path.is_absolute() && bytes.len() <= MAX_PATH_BYTES && !bytes.contains(&0),
            "app root must be a bounded absolute canonical path",
        )?;
        let parts: Vec<_> = bytes[1..].split(|b| *b == b'/').collect();
        require(parts.len() <= MAX_DEPTH, "app root ancestor depth limit")?;
        require(
            parts.last().copied() == Some(root.as_bytes()),
            "app root name mismatch",
        )?;
        for part in &parts {
            require(
                !part.is_empty() && part.len() <= 255 && *part != b"." && *part != b"..",
                "noncanonical app root component",
            )?;
        }
        let slash = File::open("/").map_err(|error| format!("Open filesystem root: {error}"))?;
        let before = stat_fd(&slash)?;
        let mut anchor = Self {
            path: path.to_path_buf(),
            chain: vec![(slash, before)],
            names: Vec::new(),
        };
        for part in parts {
            let name = CString::new(part).map_err(|_| "NUL in app root")?;
            let parent = &anchor.chain.last().unwrap().0;
            let before = stat_at(parent, &name)?;
            require(
                before.is_dir(),
                "symlink or non-directory app root ancestor",
            )?;
            let directory = open_at(parent, &name, true)?;
            require(
                before.same_ancestor(stat_fd(&directory)?),
                "app root ancestor changed while opening",
            )?;
            require(
                before.same_ancestor(stat_at(parent, &name)?),
                "app root ancestor path changed",
            )?;
            anchor.chain.push((directory, before));
            anchor.names.push(name);
        }
        anchor.revalidate()?;
        Ok(anchor)
    }

    fn directory(&self) -> &File {
        &self.chain.last().unwrap().0
    }

    fn revalidate(&self) -> Result<(), String> {
        for (index, (directory, before)) in self.chain.iter().enumerate() {
            require(
                before.same_ancestor(stat_fd(directory)?),
                "app root ancestor identity changed",
            )?;
            if index > 0 {
                require(
                    before
                        .same_ancestor(stat_at(&self.chain[index - 1].0, &self.names[index - 1])?),
                    "app root ancestor pathname changed",
                )?;
            }
        }
        // macOS F_GETPATH returns the descriptor's actual spelling/path without
        // resolving member symlinks. Byte equality also rejects case aliases,
        // renamed ancestors and lexical spellings Path's component equality can
        // otherwise normalize (e.g. repeated separators).
        let mut path = [0_u8; libc::PATH_MAX as usize];
        if unsafe {
            libc::fcntl(
                self.directory().as_raw_fd(),
                libc::F_GETPATH,
                path.as_mut_ptr(),
            )
        } < 0
        {
            return Err(io_error("F_GETPATH"));
        }
        let end = path
            .iter()
            .position(|byte| *byte == 0)
            .ok_or("Unterminated app root path")?;
        require(
            &path[..end] == self.path.as_os_str().as_bytes(),
            "app root is not canonical or changed path",
        )
    }
}

/// An independent directory stream, closed even when validation exits early.
struct DirectoryStream(*mut libc::DIR);

impl DirectoryStream {
    fn open(directory: &File) -> Result<Self, String> {
        // The only non-member component opened by the walker is this literal
        // dot, relative to an already-anchored real directory. A fresh open file
        // description avoids sharing readdir offsets across the two walks.
        let file = open_at(directory, c".", true)?;
        require(
            stat_fd(&file)? == stat_fd(directory)?,
            "directory changed before enumeration",
        )?;
        let fd = file.into_raw_fd();
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            let error = io_error("fdopendir");
            unsafe { libc::close(fd) };
            return Err(error);
        }
        Ok(Self(stream))
    }

    fn next(&mut self) -> Result<Option<String>, String> {
        loop {
            // SAFETY: this stream is uniquely owned. errno distinguishes EOF
            // from a failed enumeration; copy the dirent name before next read.
            unsafe { *libc::__error() = 0 };
            let entry = unsafe { libc::readdir(self.0) };
            if entry.is_null() {
                if unsafe { *libc::__error() } != 0 {
                    return Err(io_error("readdir"));
                }
                return Ok(None);
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name == b"." || name == b".." {
                continue;
            }
            let name = std::str::from_utf8(name).map_err(|_| "Non-UTF8 installed member")?;
            member_path(name, 1)?;
            return Ok(Some(name.to_owned()));
        }
    }
}

impl Drop for DirectoryStream {
    fn drop(&mut self) {
        // SAFETY: fdopendir transferred sole descriptor ownership to this stream.
        unsafe { libc::closedir(self.0) };
    }
}

struct Walk<'a> {
    expected: &'a BTreeMap<&'a str, &'a ArchiveEntry>,
    previous: Option<&'a BTreeMap<String, Snapshot>>,
    limits: Limits,
    root_device: libc::dev_t,
    seen: BTreeMap<String, Snapshot>,
    inodes: BTreeSet<(libc::dev_t, libc::ino_t)>,
    bytes: u64,
    metadata: usize,
}

impl<'a> Walk<'a> {
    fn new(
        expected: &'a BTreeMap<&'a str, &'a ArchiveEntry>,
        limits: Limits,
        root_device: libc::dev_t,
        previous: Option<&'a BTreeMap<String, Snapshot>>,
    ) -> Self {
        Self {
            expected,
            previous,
            limits,
            root_device,
            seen: BTreeMap::new(),
            inodes: BTreeSet::new(),
            bytes: 0,
            metadata: 0,
        }
    }

    fn record(&mut self, path: &str, metadata: Snapshot) -> Result<&'a ArchiveEntry, String> {
        require(
            self.seen.len() < self.limits.entries,
            "actual entry count limit",
        )?;
        member_path(path, self.limits.depth)?;
        charge_metadata(&mut self.metadata, path.len(), self.limits)?;
        let entry = *self
            .expected
            .get(path)
            .ok_or_else(|| format!("Unexpected installed member: {path}"))?;
        require(
            self.seen.insert(path.to_owned(), metadata).is_none(),
            "duplicate actual path",
        )?;
        require(
            self.inodes.insert((metadata.dev, metadata.ino)),
            "aliased installed inode",
        )?;
        require(
            metadata.dev == self.root_device,
            "mounted member crosses app device",
        )?;
        let kind = match entry.kind {
            ArchiveEntryKind::File { .. } => libc::S_IFREG,
            ArchiveEntryKind::Directory => libc::S_IFDIR,
            ArchiveEntryKind::Symlink { .. } => libc::S_IFLNK,
        };
        require(
            metadata.mode & libc::S_IFMT == kind,
            &format!("member type differs: {path}"),
        )?;
        require(
            u32::from(metadata.mode & 0o7777) == entry.mode,
            &format!("member mode differs: {path}"),
        )?;
        require(
            metadata.is_dir() || metadata.links == 1,
            "hard-linked member",
        )?;
        if let Some(previous) = self.previous {
            require(
                previous.get(path) == Some(&metadata),
                &format!("member changed after reads: {path}"),
            )?;
        }
        Ok(entry)
    }

    fn visit_directory(
        &mut self,
        directory: &File,
        path: &str,
        before: Snapshot,
        depth: usize,
    ) -> Result<(), String> {
        require(depth <= self.limits.depth, "actual directory depth limit")?;
        let entry = self.record(path, before)?;
        require(
            matches!(entry.kind, ArchiveEntryKind::Directory),
            "directory type differs",
        )?;
        let mut stream = DirectoryStream::open(directory)?;
        while let Some(name) = stream.next()? {
            let child = format!("{path}/{name}");
            let name = CString::new(name).map_err(|_| "NUL in member name")?;
            let before = stat_at(directory, &name)?;
            // Reject unknown paths/types before opening anything. A symlink is
            // handled with readlinkat only, never passed to openat or descended.
            let entry = self
                .expected
                .get(child.as_str())
                .ok_or_else(|| format!("Unexpected installed member: {child}"))?;
            if matches!(entry.kind, ArchiveEntryKind::Directory) {
                require(
                    before.is_dir(),
                    "expected directory is a symlink or other type",
                )?;
                let subdir = open_at(directory, &name, true)?;
                require(
                    stat_fd(&subdir)? == before,
                    "directory changed while opening",
                )?;
                self.visit_directory(&subdir, &child, before, depth + 1)?;
            } else {
                let entry = self.record(&child, before)?;
                match &entry.kind {
                    ArchiveEntryKind::File { size, sha256 } => {
                        require(
                            before.size >= 0 && before.size as u64 == *size,
                            "file size differs",
                        )?;
                        if self.previous.is_none() {
                            let mut file = open_at(directory, &name, false)?;
                            require(stat_fd(&file)? == before, "file changed while opening")?;
                            let digest =
                                hash_file(&mut file, *size, &mut self.bytes, self.limits.bytes)?;
                            require(digest == *sha256, &format!("file SHA-256 differs: {child}"))?;
                            require(
                                stat_fd(&file)? == before,
                                "file changed during content read",
                            )?;
                        }
                    }
                    ArchiveEntryKind::Symlink { target } => {
                        charge_metadata(&mut self.metadata, target.len(), self.limits)?;
                        require(
                            before.size >= 0 && before.size as usize == target.len(),
                            "symlink size differs",
                        )?;
                        let mut bytes = [0_u8; MAX_PATH_BYTES + 1];
                        let length = unsafe {
                            libc::readlinkat(
                                directory.as_raw_fd(),
                                name.as_ptr(),
                                bytes.as_mut_ptr().cast(),
                                bytes.len(),
                            )
                        };
                        if length < 0 {
                            return Err(io_error("readlinkat"));
                        }
                        require(
                            &bytes[..length as usize] == target.as_bytes(),
                            "symlink target differs",
                        )?;
                    }
                    ArchiveEntryKind::Directory => unreachable!(),
                }
            }
            require(
                stat_at(directory, &name)? == before,
                "member pathname changed during reads",
            )?;
        }
        require(
            stat_fd(directory)? == before,
            "directory changed during enumeration",
        )
    }
}

fn hash_file(
    file: &mut impl Read,
    size: u64,
    total: &mut u64,
    limit: u64,
) -> Result<String, String> {
    let mut hash = Sha256::new();
    let mut read_bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        // At most one extra probe byte; a growing file cannot create an
        // unbounded read or cause allocation proportional to its declared size.
        let length = buffer
            .len()
            .min((size - read_bytes).saturating_add(1) as usize);
        let read = file
            .read(&mut buffer[..length])
            .map_err(|error| format!("Read installed file: {error}"))?;
        if read == 0 {
            break;
        }
        read_bytes = read_bytes
            .checked_add(read as u64)
            .ok_or("File read overflow")?;
        *total = total
            .checked_add(read as u64)
            .ok_or("Total file read overflow")?;
        require(
            read_bytes <= size && *total <= limit,
            "file grew or read byte limit",
        )?;
        hash.update(&buffer[..read]);
    }
    require(read_bytes == size, "file truncated during read")?;
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater_archive::ArchiveIdentity;
    use std::{
        fs,
        io::{self, Cursor},
        os::unix::{
            fs::{symlink, MetadataExt, PermissionsExt},
            net::UnixListener,
        },
        time::{Duration, Instant},
    };

    const ROOT: &str = "Fixture.app";

    struct Fixture {
        temp: PathBuf,
        app: PathBuf,
        inventory: ArchiveInventory,
    }

    impl Fixture {
        fn new() -> Self {
            let mut entropy = [0; 8];
            getrandom::getrandom(&mut entropy).unwrap();
            // Keep Unix-domain socket fixture names within macOS SUN_LEN.
            let temp = fs::canonicalize("/private/tmp").unwrap().join(format!(
                "gjb-{}-{:x}",
                std::process::id(),
                u64::from_ne_bytes(entropy)
            ));
            fs::create_dir(&temp).unwrap();
            let mut fixture = Self {
                app: temp.join(ROOT),
                temp,
                inventory: ArchiveInventory {
                    identity: ArchiveIdentity {
                        product_name: "Fixture".into(),
                        executable: "app".into(),
                        bundle_identifier: "dev.fixture.app".into(),
                        package_name: "fixture".into(),
                        desktop_version: "1.0.0".into(),
                        product_version: "2.0.0-beta.1".into(),
                        minimum_system_version: "12.0".into(),
                    },
                    root: ROOT.into(),
                    compressed_bytes: 123,
                    expanded_bytes: 0,
                    total_file_bytes: 0,
                    archive_sha256: "a".repeat(64),
                    inventory_sha256: String::new(),
                    runtime_manifest_sha256: "b".repeat(64),
                    entries: Vec::new(),
                },
            };
            for dir in [
                "",
                "Contents",
                "Contents/MacOS",
                "Contents/Resources",
                "Contents/Resources/empty",
            ] {
                fixture.directory(dir);
            }
            fixture.file("Contents/MacOS/app", b"executable", 0o755);
            fixture.file("Contents/Resources/payload", b"payload", 0o644);
            fixture.file("Contents/Resources/zero", b"", 0o600);
            fixture.link("Contents/Resources/current", "payload");
            fixture.refresh();
            fixture
        }

        fn entry_path(&self, relative: &str) -> String {
            if relative.is_empty() {
                ROOT.into()
            } else {
                format!("{ROOT}/{relative}")
            }
        }

        fn directory(&mut self, relative: &str) {
            let path = self.app.join(relative);
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            self.inventory.entries.push(ArchiveEntry {
                path: self.entry_path(relative),
                mode: 0o755,
                kind: ArchiveEntryKind::Directory,
            });
        }

        fn file(&mut self, relative: &str, contents: &[u8], mode: u32) {
            let path = self.app.join(relative);
            fs::write(&path, contents).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            self.inventory.entries.push(ArchiveEntry {
                path: self.entry_path(relative),
                mode,
                kind: ArchiveEntryKind::File {
                    size: contents.len() as u64,
                    sha256: digest(contents),
                },
            });
        }

        fn link(&mut self, relative: &str, target: &str) {
            let path = self.app.join(relative);
            symlink(target, &path).unwrap();
            let mode = fs::symlink_metadata(&path).unwrap().mode() & 0o7777;
            self.inventory.entries.push(ArchiveEntry {
                path: self.entry_path(relative),
                mode,
                kind: ArchiveEntryKind::Symlink {
                    target: target.into(),
                },
            });
        }

        fn entry(&mut self, relative: &str) -> &mut ArchiveEntry {
            let path = self.entry_path(relative);
            self.inventory
                .entries
                .iter_mut()
                .find(|entry| entry.path == path)
                .unwrap()
        }

        fn refresh(&mut self) {
            self.inventory.entries.sort_by(|a, b| a.path.cmp(&b.path));
            let mut bytes = 0;
            let mut expanded = 1024 + self.inventory.entries.len() as u64 * 512;
            for entry in &self.inventory.entries {
                if let ArchiveEntryKind::File { size, .. } = entry.kind {
                    bytes += size;
                    expanded += (size + 511) & !511;
                }
            }
            self.inventory.total_file_bytes = bytes;
            self.inventory.expanded_bytes = expanded;
            self.inventory.inventory_sha256 = inventory_hash(&self.inventory.entries);
        }

        fn verify(&self) -> Result<VerifiedBundle, String> {
            verify_inventory(&self.app, &self.inventory)
        }

        fn rejects(&self, fragment: &str) {
            let error = self.verify().unwrap_err();
            assert!(
                error.contains(fragment),
                "expected {fragment:?}, got {error:?}"
            );
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.temp);
        }
    }

    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn complete_inventory_is_read_only_and_proof_exposes_only_root_and_digest() {
        let fixture = Fixture::new();
        let before = fixture
            .inventory
            .entries
            .iter()
            .map(|entry| {
                let path = fixture.temp.join(&entry.path);
                let metadata = fs::symlink_metadata(&path).unwrap();
                (
                    metadata.mode(),
                    metadata.len(),
                    metadata.mtime(),
                    metadata.ctime(),
                )
            })
            .collect::<Vec<_>>();
        let verified = fixture.verify().unwrap();
        assert_eq!(verified.root(), fixture.app);
        assert_eq!(
            verified.inventory_sha256(),
            fixture.inventory.inventory_sha256
        );
        for (entry, before) in fixture.inventory.entries.iter().zip(before) {
            let path = fixture.temp.join(&entry.path);
            let metadata = fs::symlink_metadata(&path).unwrap();
            assert_eq!(
                (
                    metadata.mode(),
                    metadata.len(),
                    metadata.mtime(),
                    metadata.ctime()
                ),
                before
            );
            match &entry.kind {
                ArchiveEntryKind::File { sha256, .. } => {
                    assert_eq!(digest(&fs::read(path).unwrap()), *sha256)
                }
                ArchiveEntryKind::Symlink { target } => {
                    assert_eq!(fs::read_link(path).unwrap(), Path::new(target))
                }
                ArchiveEntryKind::Directory => {}
            }
        }
        assert_eq!(fs::read_dir(&fixture.temp).unwrap().count(), 1);
    }

    #[test]
    fn accepts_real_archive_parser_inventory_including_identity_and_runtime_closure() {
        use crate::updater_archive::inspect_archive;
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;

        let mut fixture = Fixture::new();
        let identity = fixture.inventory.identity.clone();
        let fields = [
            ("CFBundleName", identity.product_name.as_str()),
            ("CFBundleDisplayName", identity.product_name.as_str()),
            ("CFBundleExecutable", identity.executable.as_str()),
            ("CFBundleIdentifier", identity.bundle_identifier.as_str()),
            ("CFBundlePackageType", "APPL"),
            (
                "CFBundleShortVersionString",
                identity.desktop_version.as_str(),
            ),
            ("CFBundleVersion", identity.desktop_version.as_str()),
            (
                "LSMinimumSystemVersion",
                identity.minimum_system_version.as_str(),
            ),
        ];
        let plist = plist::Value::Dictionary(
            fields
                .into_iter()
                .map(|(key, value)| (key.to_owned(), plist::Value::String(value.to_owned())))
                .collect(),
        );
        let mut plist_bytes = Vec::new();
        plist.to_writer_xml(&mut plist_bytes).unwrap();
        fixture.file("Contents/Info.plist", &plist_bytes, 0o644);

        // Structural Mach-O data only, never executed and not Apple-signed.
        let mut macho = vec![0_u8; 256];
        for (offset, value) in [
            (0, 0xfeed_facf_u32),
            (4, 0x0100_000c),
            (12, 2),
            (16, 3),
            (20, 120),
            (32, 0x19),
            (36, 72),
            (80, 256),
            (92, 5),
            (104, 0x32),
            (108, 24),
            (112, 1),
            (116, 12 << 16),
            (128, 0x8000_0028),
            (132, 24),
            (136, 160),
        ] {
            macho[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        fs::write(fixture.app.join("Contents/MacOS/app"), &macho).unwrap();
        fixture.entry("Contents/MacOS/app").kind = ArchiveEntryKind::File {
            size: macho.len() as u64,
            sha256: digest(&macho),
        };

        const PAYLOAD: &str = "Contents/Resources/resources/server-payload";
        for dir in [
            "Contents/Resources/resources".to_owned(),
            PAYLOAD.into(),
            format!("{PAYLOAD}/server"),
            format!("{PAYLOAD}/node_modules"),
            format!("{PAYLOAD}/node_modules/native"),
        ] {
            fixture.directory(&dir);
        }
        let package = serde_json::to_vec(&serde_json::json!({
            "name": identity.package_name, "version": identity.product_version,
            "desktopVersion": identity.desktop_version, "productName": identity.product_name,
            "build": { "appId": identity.bundle_identifier, "productName": identity.product_name },
        }))
        .unwrap();
        fixture.file(&format!("{PAYLOAD}/package.json"), &package, 0o644);
        fixture.file(
            &format!("{PAYLOAD}/node_modules/native/index.js"),
            b"native",
            0o644,
        );
        let runtime = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "gjcSdk": "0.16.4", "bun": "1.4.0", "natives": "0.16.4",
            "platforms": { "darwin-arm64": { "files": [{ "package": "native", "path": "index.js", "sha256": digest(b"native") }] } },
        })).unwrap();
        fixture.file(
            &format!("{PAYLOAD}/server/gjc-runtime-manifest.json"),
            &runtime,
            0o644,
        );
        fixture.refresh();
        let mut archive = tar::Builder::new(Vec::new());
        for entry in &fixture.inventory.entries {
            let mut header = tar::Header::new_ustar();
            header.set_path(&entry.path).unwrap();
            header.set_mode(entry.mode);
            let contents = match &entry.kind {
                ArchiveEntryKind::Directory => {
                    header.set_entry_type(tar::EntryType::Directory);
                    Vec::new()
                }
                ArchiveEntryKind::Symlink { target } => {
                    header.set_entry_type(tar::EntryType::Symlink);
                    header.set_link_name(target).unwrap();
                    Vec::new()
                }
                ArchiveEntryKind::File { .. } => {
                    header.set_entry_type(tar::EntryType::Regular);
                    fs::read(fixture.temp.join(&entry.path)).unwrap()
                }
            };
            header.set_size(contents.len() as u64);
            header.set_cksum();
            archive.append(&header, contents.as_slice()).unwrap();
        }
        let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
        gzip.write_all(&archive.into_inner().unwrap()).unwrap();
        let archive_inventory = inspect_archive(&gzip.finish().unwrap(), &identity).unwrap();
        assert_eq!(archive_inventory.entries, fixture.inventory.entries);
        assert_eq!(
            archive_inventory.inventory_sha256,
            fixture.inventory.inventory_sha256
        );
        let verified = verify_inventory(&fixture.app, &archive_inventory).unwrap();
        assert_eq!(
            verified.inventory_sha256(),
            archive_inventory.inventory_sha256
        );
        fs::write(
            fixture.app.join("Contents/Info.plist"),
            b"different identity",
        )
        .unwrap();
        assert!(verify_inventory(&fixture.app, &archive_inventory).is_err());
    }

    #[test]
    fn accepts_expected_framework_links_and_directory_back_links_without_walking_them() {
        let mut fixture = Fixture::new();
        for dir in [
            "Contents/Frameworks",
            "Contents/Frameworks/F.framework",
            "Contents/Frameworks/F.framework/Versions",
            "Contents/Frameworks/F.framework/Versions/A",
        ] {
            fixture.directory(dir);
        }
        fixture.file(
            "Contents/Frameworks/F.framework/Versions/A/F",
            b"framework",
            0o755,
        );
        fixture.link("Contents/Frameworks/F.framework/Versions/Current", "A");
        fixture.link("Contents/Frameworks/F.framework/F", "Versions/Current/F");
        fixture.link("Contents/Resources/back", "..");
        fixture.refresh();
        fixture.verify().unwrap();
    }

    #[test]
    fn rejects_changed_hash_same_size_and_changed_size() {
        for contents in [
            b"changed".as_slice(),
            b"short".as_slice(),
            b"much longer payload".as_slice(),
        ] {
            let fixture = Fixture::new();
            fs::write(fixture.app.join("Contents/Resources/payload"), contents).unwrap();
            fixture.rejects(if contents.len() == 7 {
                "SHA-256"
            } else {
                "file size"
            });
        }
    }

    #[test]
    fn rejects_changed_modes_on_files_directories_root_and_symlinks() {
        for relative in [
            "",
            "Contents",
            "Contents/MacOS/app",
            "Contents/Resources/current",
        ] {
            let fixture = Fixture::new();
            let path = fixture.app.join(relative);
            let mode = fs::symlink_metadata(&path).unwrap().mode() & 0o777;
            if relative.ends_with("current") {
                let path = CString::new(path.as_os_str().as_bytes()).unwrap();
                assert_eq!(
                    unsafe {
                        libc::fchmodat(
                            libc::AT_FDCWD,
                            path.as_ptr(),
                            (mode ^ 0o001) as libc::mode_t,
                            libc::AT_SYMLINK_NOFOLLOW,
                        )
                    },
                    0
                );
            } else {
                fs::set_permissions(&path, fs::Permissions::from_mode(mode ^ 0o001)).unwrap();
            }
            fixture.rejects("mode differs");
            if !relative.ends_with("current") {
                fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            }
        }
    }

    #[test]
    fn rejects_special_permission_bits_in_actual_tree() {
        let fixture = Fixture::new();
        fs::set_permissions(
            fixture.app.join("Contents/MacOS/app"),
            fs::Permissions::from_mode(0o4755),
        )
        .unwrap();
        fixture.rejects("mode differs");
    }

    #[test]
    fn rejects_missing_files_symlinks_and_empty_or_nonempty_directories() {
        for relative in [
            "Contents/MacOS/app",
            "Contents/Resources/current",
            "Contents/Resources/empty",
            "Contents/MacOS",
        ] {
            let fixture = Fixture::new();
            let path = fixture.app.join(relative);
            if fs::symlink_metadata(&path).unwrap().is_dir() {
                fs::remove_dir_all(path).unwrap();
            } else {
                fs::remove_file(path).unwrap();
            }
            fixture.rejects("missing members");
        }
    }

    #[test]
    fn rejects_extra_regular_hidden_directory_and_symlink_members() {
        for kind in 0..4 {
            let fixture = Fixture::new();
            let extra = fixture.app.join("Contents/Resources/.extra");
            match kind {
                0 => fs::write(extra, b"extra").unwrap(),
                1 => fs::create_dir(extra).unwrap(),
                2 => symlink("payload", extra).unwrap(),
                _ => fs::write(
                    fixture.app.join("Contents/Resources/empty/nested"),
                    b"extra",
                )
                .unwrap(),
            }
            fixture.rejects("Unexpected installed member");
        }
    }

    #[test]
    fn rejects_file_directory_type_changes() {
        let fixture = Fixture::new();
        let file = fixture.app.join("Contents/MacOS/app");
        fs::remove_file(&file).unwrap();
        fs::create_dir(file).unwrap();
        fixture.rejects("member type differs");
        let fixture = Fixture::new();
        let dir = fixture.app.join("Contents/Resources/empty");
        fs::remove_dir(&dir).unwrap();
        fs::write(dir, b"").unwrap();
        fixture.rejects("expected directory");
    }

    #[test]
    fn refuses_symlink_file_or_directory_substitution_without_following() {
        for relative in ["Contents/MacOS/app", "Contents/Resources/empty"] {
            let fixture = Fixture::new();
            let path = fixture.app.join(relative);
            if path.is_dir() {
                fs::remove_dir(&path).unwrap();
            } else {
                fs::remove_file(&path).unwrap();
            }
            symlink("/dev/zero", &path).unwrap();
            assert!(fixture.verify().is_err());
        }
    }

    #[test]
    fn rejects_modified_symlink_text_even_when_it_resolves_to_same_contents() {
        for target in [
            "./payload",
            "../Resources/payload",
            "zero",
            "/dev/zero",
            "../../../../outside",
        ] {
            let fixture = Fixture::new();
            let link = fixture.app.join("Contents/Resources/current");
            fs::remove_file(&link).unwrap();
            symlink(target, &link).unwrap();
            fixture.rejects("symlink");
        }
        let fixture = Fixture::new();
        let link = fixture.app.join("Contents/Resources/current");
        fs::remove_file(&link).unwrap();
        symlink("zero///", &link).unwrap(); // same seven-byte length as payload
        fixture.rejects("symlink target differs");
    }

    #[test]
    fn fifo_and_socket_members_are_rejected_promptly_without_opening() {
        for fifo in [true, false] {
            let fixture = Fixture::new();
            let path = fixture.app.join("Contents/MacOS/app");
            fs::remove_file(&path).unwrap();
            let _socket = if fifo {
                let name = CString::new(path.as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o755) }, 0);
                None
            } else {
                Some(UnixListener::bind(&path).unwrap())
            };
            let started = Instant::now();
            fixture.rejects("member type differs");
            assert!(started.elapsed() < Duration::from_secs(2));
        }
    }

    #[test]
    fn rejects_hardlinks_including_links_outside_inventory() {
        let fixture = Fixture::new();
        fs::hard_link(
            fixture.app.join("Contents/MacOS/app"),
            fixture.temp.join("outside-link"),
        )
        .unwrap();
        fixture.rejects("hard-linked");
    }

    #[test]
    fn rejects_root_symlink_symlink_ancestors_aliases_and_noncanonical_spellings() {
        let fixture = Fixture::new();
        let container = fixture.temp.join("container");
        fs::create_dir(&container).unwrap();
        symlink(&fixture.app, container.join(ROOT)).unwrap();
        assert!(verify_inventory(&container.join(ROOT), &fixture.inventory)
            .unwrap_err()
            .contains("ancestor"));
        let alias = fixture.temp.join("alias");
        symlink(&fixture.temp, &alias).unwrap();
        assert!(verify_inventory(&alias.join(ROOT), &fixture.inventory)
            .unwrap_err()
            .contains("ancestor"));
        let text = fixture.app.display().to_string();
        for path in [
            PathBuf::from(ROOT),
            fixture.app.join("."),
            PathBuf::from(format!("{text}/")),
            fixture.temp.join(".").join(ROOT),
            fixture.temp.join("container/../").join(ROOT),
            PathBuf::from(text.replace("/Fixture.app", "//Fixture.app")),
            fixture.temp.join("fixture.app"),
            fixture.app.join("Contents"),
        ] {
            assert!(
                verify_inventory(&path, &fixture.inventory).is_err(),
                "accepted {}",
                path.display()
            );
        }
        // Case alias in an ancestor, rather than just the already-bound app name.
        let upper = fixture
            .temp
            .with_file_name(
                fixture
                    .temp
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_ascii_uppercase(),
            )
            .join(ROOT);
        assert!(verify_inventory(&upper, &fixture.inventory).is_err());
    }

    #[test]
    fn rejects_actual_case_renames_and_unicode_names() {
        let fixture = Fixture::new();
        fs::rename(
            fixture.app.join("Contents/Resources/payload"),
            fixture.app.join("Contents/Resources/PAYLOAD"),
        )
        .unwrap();
        fixture.rejects("Unexpected installed member");
        let fixture = Fixture::new();
        fs::write(fixture.app.join("Contents/Resources/café"), b"").unwrap();
        fixture.rejects("ASCII paths only");
    }

    #[test]
    fn schema_rejects_duplicate_case_alias_unsorted_and_unsafe_paths() {
        for path in [
            "Fixture.app/../escape",
            "Fixture.app//extra",
            "/Fixture.app/extra",
            "Other.app/extra",
            "Fixture.app/./extra",
            "Fixture.app/._extra",
            "Fixture.app/café",
            "Fixture.app/a:b",
            "Fixture.app/a\\b",
            "Fixture.app/extra/",
        ] {
            let mut fixture = Fixture::new();
            fixture.inventory.entries.push(ArchiveEntry {
                path: path.into(),
                mode: 0o755,
                kind: ArchiveEntryKind::Directory,
            });
            fixture.refresh();
            assert!(
                validate_inventory(&fixture.inventory, Limits::default()).is_err(),
                "accepted {path}"
            );
        }
        for case in 0..3 {
            let mut fixture = Fixture::new();
            if case == 2 {
                fixture.inventory.entries.swap(0, 1);
            } else {
                let mut duplicate = fixture.inventory.entries[1].clone();
                if case == 1 {
                    duplicate.path = format!("{ROOT}/CONTENTS");
                }
                fixture.inventory.entries.push(duplicate);
                fixture.refresh();
            }
            assert!(validate_inventory(&fixture.inventory, Limits::default()).is_err());
        }
    }

    #[test]
    fn schema_rejects_missing_root_parents_and_children_beneath_links_or_files() {
        for relative in ["", "Contents", "Contents/Resources"] {
            let mut fixture = Fixture::new();
            let path = fixture.entry_path(relative);
            fixture.inventory.entries.retain(|entry| entry.path != path);
            fixture.refresh();
            assert!(validate_inventory(&fixture.inventory, Limits::default()).is_err());
        }
        for parent in ["current", "payload"] {
            let mut fixture = Fixture::new();
            fixture.inventory.entries.push(ArchiveEntry {
                path: format!("{ROOT}/Contents/Resources/{parent}/injected"),
                mode: 0o755,
                kind: ArchiveEntryKind::Directory,
            });
            fixture.refresh();
            fixture.rejects("parent");
        }
    }

    #[test]
    fn schema_rejects_escape_dangling_cycles_case_alias_and_file_dotdot_links() {
        for target in [
            "/dev/zero",
            "../../../outside",
            "missing",
            "current",
            "PAYLOAD",
            "payload/..",
            "payload/.",
            "../Resources//payload",
            "../../../../",
            "",
        ] {
            let mut fixture = Fixture::new();
            fixture.entry("Contents/Resources/current").kind = ArchiveEntryKind::Symlink {
                target: target.into(),
            };
            fixture.refresh();
            assert!(
                validate_inventory(&fixture.inventory, Limits::default()).is_err(),
                "accepted {target}"
            );
        }
        let mut fixture = Fixture::new();
        fixture.link("Contents/Resources/a", "b");
        fixture.link("Contents/Resources/b", "a");
        fixture.refresh();
        fixture.rejects("cycle");
    }

    #[test]
    fn schema_rejects_bad_digests_modes_totals_and_identity() {
        for case in 0..13 {
            let mut fixture = Fixture::new();
            match case {
                0 => fixture.inventory.inventory_sha256 = "0".repeat(64),
                1 => fixture.inventory.archive_sha256 = "A".repeat(64),
                2 => fixture.inventory.runtime_manifest_sha256 = "not-a-digest".into(),
                3 => fixture.entry("Contents/MacOS/app").mode = 0o4755,
                4 => fixture.inventory.total_file_bytes += 1,
                5 => fixture.inventory.expanded_bytes = 512,
                6 => fixture.inventory.compressed_bytes = 0,
                7 => fixture.inventory.identity.product_name = "Other".into(),
                8 => fixture.inventory.identity.executable = "../app".into(),
                9 => fixture.inventory.identity.product_version = "bad".into(),
                10 => fixture.inventory.identity.minimum_system_version = "12.999".into(),
                11 => {
                    fixture.entry("Contents/MacOS/app").kind = ArchiveEntryKind::File {
                        size: 10,
                        sha256: "g".repeat(64),
                    }
                }
                _ => fixture.inventory.entries.clear(),
            }
            assert!(
                validate_inventory(&fixture.inventory, Limits::default()).is_err(),
                "case {case}"
            );
        }
    }

    #[test]
    fn entry_byte_metadata_and_depth_limits_accept_boundary_and_reject_overflow() {
        let fixture = Fixture::new();
        let metadata = fixture
            .inventory
            .entries
            .iter()
            .map(|entry| {
                entry.path.len()
                    + match &entry.kind {
                        ArchiveEntryKind::Symlink { target } => target.len(),
                        _ => 0,
                    }
            })
            .sum();
        let exact = Limits {
            entries: fixture.inventory.entries.len(),
            bytes: fixture.inventory.total_file_bytes,
            depth: 4,
            metadata,
        };
        verify_with_limits(&fixture.app, &fixture.inventory, exact, || Ok(())).unwrap();
        for limits in [
            Limits {
                entries: exact.entries - 1,
                ..exact
            },
            Limits {
                bytes: exact.bytes - 1,
                ..exact
            },
            Limits {
                depth: exact.depth - 1,
                ..exact
            },
            Limits {
                metadata: exact.metadata - 1,
                ..exact
            },
        ] {
            assert!(
                verify_with_limits(&fixture.app, &fixture.inventory, limits, || Ok(())).is_err()
            );
        }
        let mut inventory = fixture.inventory.clone();
        inventory.compressed_bytes = MAX_COMPRESSED_BYTES as u64 + 1;
        assert!(validate_inventory(&inventory, Limits::default()).is_err());
        inventory = fixture.inventory.clone();
        inventory.expanded_bytes = MAX_EXPANDED_BYTES + 512;
        assert!(validate_inventory(&inventory, Limits::default()).is_err());
        inventory = fixture.inventory.clone();
        inventory.entries[0].kind = ArchiveEntryKind::File {
            size: u64::MAX,
            sha256: digest(b""),
        };
        assert!(validate_inventory(&inventory, Limits::default()).is_err());
        assert!(member_path(&format!("{ROOT}/{}", "x".repeat(256)), MAX_DEPTH).is_err());
        assert!(member_path(&"x/".repeat(MAX_DEPTH), MAX_DEPTH).is_err());
        assert!(ascii_path(&"x".repeat(MAX_PATH_BYTES + 1)).is_err());
    }

    #[test]
    fn validates_limits_in_actual_walk_too() {
        let fixture = Fixture::new();
        let limits = Limits::default();
        let entries = validate_inventory(&fixture.inventory, limits).unwrap();
        let anchor = RootAnchor::open(&fixture.app, ROOT).unwrap();
        let root = stat_fd(anchor.directory()).unwrap();
        for limits in [
            Limits {
                entries: 1,
                ..limits
            },
            Limits { bytes: 0, ..limits },
            Limits {
                metadata: 1,
                ..limits
            },
            Limits { depth: 1, ..limits },
        ] {
            let mut walk = Walk::new(&entries, limits, root.dev, None);
            assert!(walk
                .visit_directory(anchor.directory(), ROOT, root, 1)
                .is_err());
        }
    }

    #[test]
    fn bounded_hasher_detects_truncation_growth_io_error_and_stops_at_one_probe_byte() {
        for (bytes, size, cap) in [
            (b"ab".as_slice(), 3, 3),
            (b"abcd".as_slice(), 3, 4),
            (b"abc".as_slice(), 3, 2),
        ] {
            assert!(hash_file(&mut Cursor::new(bytes), size, &mut 0, cap).is_err());
        }
        struct Infinite(usize);
        impl Read for Infinite {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                self.0 += buf.len();
                buf.fill(b'a');
                Ok(buf.len())
            }
        }
        let mut infinite = Infinite(0);
        assert!(hash_file(&mut infinite, 5, &mut 0, 5).is_err());
        assert_eq!(infinite.0, 6);
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("fixture read failure"))
            }
        }
        assert!(hash_file(&mut Broken, 1, &mut 0, 1).is_err());
        assert_eq!(
            hash_file(&mut Cursor::new(b""), 0, &mut 0, 0).unwrap(),
            digest(b"")
        );
    }

    #[test]
    fn second_walk_rejects_mutation_of_already_hashed_file_link_and_directory() {
        for case in 0..6 {
            let fixture = Fixture::new();
            let result =
                verify_with_limits(&fixture.app, &fixture.inventory, Limits::default(), || {
                    let payload = fixture.app.join("Contents/Resources/payload");
                    match case {
                        0 => fs::write(payload, b"changed").unwrap(),
                        1 => {
                            fs::set_permissions(payload, fs::Permissions::from_mode(0o600)).unwrap()
                        }
                        2 => fs::write(fixture.app.join("extra"), b"extra").unwrap(),
                        3 => fs::remove_file(payload).unwrap(),
                        4 => {
                            let link = fixture.app.join("Contents/Resources/current");
                            fs::remove_file(&link).unwrap();
                            symlink("zero///", &link).unwrap();
                        }
                        _ => {
                            let dir = fixture.app.join("Contents/Resources/empty");
                            fs::remove_dir(&dir).unwrap();
                            fs::create_dir(&dir).unwrap();
                            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
                        }
                    }
                    Ok(())
                });
            assert!(result.is_err(), "case {case}");
        }
    }

    #[test]
    fn revalidates_original_root_identity_and_ancestor_path_after_reads() {
        for ancestor in [false, true] {
            let fixture = Fixture::new();
            let moved = fixture.temp.with_extension("moved");
            let result =
                verify_with_limits(&fixture.app, &fixture.inventory, Limits::default(), || {
                    if ancestor {
                        fs::rename(&fixture.temp, &moved).unwrap();
                        symlink(&moved, &fixture.temp).unwrap();
                    } else {
                        fs::rename(&fixture.app, fixture.temp.join("old.app")).unwrap();
                        fs::create_dir(&fixture.app).unwrap();
                        fs::set_permissions(&fixture.app, fs::Permissions::from_mode(0o755))
                            .unwrap();
                    }
                    Ok(())
                });
            if ancestor {
                fs::remove_file(&fixture.temp).unwrap();
                fs::rename(&moved, &fixture.temp).unwrap();
            }
            assert!(result.unwrap_err().contains("ancestor"));
        }
    }
}
