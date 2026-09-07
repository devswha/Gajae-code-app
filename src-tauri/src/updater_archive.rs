//! Read-only inspection of the final `.app.tar.gz` release artifact.
//!
//! Call only after the parent verifies the updater signature on the same bytes.
//! Inventory/hash/metadata checks are NOT Apple code-signature, notarization,
//! installation or runtime-health proof. Nothing here extracts or opens a path.
//!
//! The producer is `scripts/release/updater-archive.mjs`: explicit directories,
//! preserved modes, one gzip member, and local PAX path/linkpath metadata. We
//! deliberately reject global/GNU/sparse extensions and unequal PAX/header sizes
//! to avoid interpreting different bytes from the selected official installer.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt,
    io::{self, Cursor, Read, Seek, SeekFrom},
};

use flate2::bufread::GzDecoder;
use serde::{
    de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor},
    Deserialize, Serialize,
};
use sha2::{Digest, Sha256};

pub const MAX_COMPRESSED_BYTES: usize = 250 * 1024 * 1024;
pub const MAX_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000; // Includes extension headers.
const MAX_PATH_BYTES: usize = 4096;
const MAX_DEPTH: usize = 128;
const MAX_METADATA_BYTES: usize = 64 * 1024;
const MAX_INVENTORY_METADATA_BYTES: usize = 32 * 1024 * 1024;
const MAX_LINK_DEREFERENCES: usize = 64;
const PAYLOAD: &str = "Contents/Resources/resources/server-payload";

/// Trusted build identity plus the validated candidate's versions/OS floor.
/// `package_name` is the desktop payload's package.json name (`gajae-app`),
/// not the separately distributed server archive's package name.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArchiveIdentity {
    pub product_name: String,
    pub executable: String,
    pub bundle_identifier: String,
    pub package_name: String,
    pub desktop_version: String,
    pub product_version: String,
    pub minimum_system_version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArchiveInventory {
    pub identity: ArchiveIdentity,
    pub root: String,
    pub compressed_bytes: u64,
    /// Entire decompressed stream, including headers, PAX, padding and EOF.
    pub expanded_bytes: u64,
    pub total_file_bytes: u64,
    pub archive_sha256: String,
    /// Domain-separated, length-framed hash of sorted paths/types/modes/bytes/links.
    pub inventory_sha256: String,
    /// Byte hash of the in-archive manifest, not a signature or current-build hash.
    pub runtime_manifest_sha256: String,
    pub entries: Vec<ArchiveEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArchiveEntry {
    pub path: String,
    pub mode: u32,
    pub kind: ArchiveEntryKind,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ArchiveEntryKind {
    File { size: u64, sha256: String },
    Directory,
    Symlink { target: String },
}

#[derive(Clone, Copy)]
struct Limits {
    compressed: usize,
    expanded: u64,
    entries: usize,
    metadata: usize,
    inventory_metadata: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            compressed: MAX_COMPRESSED_BYTES,
            expanded: MAX_EXPANDED_BYTES,
            entries: MAX_ENTRIES,
            metadata: MAX_METADATA_BYTES,
            inventory_metadata: MAX_INVENTORY_METADATA_BYTES,
        }
    }
}

pub fn inspect_archive(
    bytes: &[u8],
    expected: &ArchiveIdentity,
) -> Result<ArchiveInventory, String> {
    inspect_with_limits(bytes, expected, Limits::default())
}

fn require(condition: bool, error: &'static str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(error.to_owned())
    }
}

fn inspect_with_limits(
    bytes: &[u8],
    expected: &ArchiveIdentity,
    limits: Limits,
) -> Result<ArchiveInventory, String> {
    require(!bytes.is_empty(), "Archive is empty")?;
    require(
        bytes.len() <= limits.compressed,
        "Compressed archive exceeds limit",
    )?;
    validate_identity(expected)?;
    let root = format!("{}.app", expected.product_name);
    let plist_path = format!("{root}/Contents/Info.plist");
    let executable_path = format!("{root}/Contents/MacOS/{}", expected.executable);
    let package_path = format!("{root}/{PAYLOAD}/package.json");
    let runtime_path = format!("{root}/{PAYLOAD}/server/gjc-runtime-manifest.json");
    let mut captured = BTreeMap::new();

    // The bufread decoder leaves the compressed tail visible; the read decoder
    // may consume it. Drain through EOF below to check CRC/ISIZE, then reject
    // concatenated members or garbage. The producer writes exactly one member.
    let decoder = GzDecoder::new(bytes);
    require(decoder.header().is_some(), "Invalid gzip header")?;
    require(
        bytes.len() - decoder.get_ref().len() <= limits.metadata,
        "Gzip metadata exceeds limit",
    )?;
    let reader = LimitedReader {
        inner: decoder,
        count: 0,
        limit: limits.expanded,
    };
    let mut archive = tar::Archive::new(reader);
    let mut entries = BTreeMap::new();
    let mut aliases = BTreeSet::new();
    let mut pending_pax = None;
    let mut header_count = 0;
    let mut metadata_bytes = 0;
    let mut file_bytes = 0_u64;
    let mut expected_end = 0_u64;

    // raw(true) is essential: automatic PAX/GNU consumption allocates extension
    // bodies before the caller sees their size. tar still checks each checksum.
    for entry in archive
        .entries()
        .map_err(|_| "Invalid tar stream")?
        .raw(true)
    {
        let mut entry = entry.map_err(|_| "Invalid tar entry")?;
        header_count += 1;
        require(header_count <= limits.entries, "Too many archive entries")?;
        let header = entry.header().clone();
        require(
            header.as_ustar().is_some(),
            "Archive requires a POSIX ustar header",
        )?;
        let size = entry.size();
        require(
            size <= limits.expanded,
            "Declared entry size exceeds expanded limit",
        )?;
        require(
            entry.raw_header_position() == expected_end,
            "Unexpected tar entry boundary",
        )?;
        expected_end = entry
            .raw_file_position()
            .checked_add(size.checked_add(511).ok_or("Entry size overflow")? & !511)
            .ok_or("Archive size overflow")?;
        require(
            expected_end <= limits.expanded,
            "Tar stream exceeds expanded limit",
        )?;
        let entry_type = header.entry_type().as_byte();
        if entry_type == b'x' {
            require(pending_pax.is_none(), "Stacked PAX headers are ambiguous")?;
            require(
                size > 0 && size <= limits.metadata as u64,
                "PAX metadata exceeds limit",
            )?;
            charge_metadata(&mut metadata_bytes, size as usize, limits)?;
            let mut data = Vec::with_capacity(size as usize);
            entry
                .read_to_end(&mut data)
                .map_err(|_| "Truncated PAX metadata")?;
            require(data.len() as u64 == size, "Truncated PAX metadata")?;
            pending_pax = Some(parse_pax(&data)?);
            continue;
        }
        require(
            matches!(entry_type, 0 | b'0' | b'2' | b'5'),
            "Unsupported tar entry type",
        )?;
        let pax = pending_pax.take().unwrap_or_default();
        if let Some(pax_size) = pax.get("size") {
            require(
                parse_decimal(pax_size)? == size,
                "PAX/header size disagreement",
            )?;
        }
        let header_path = header.path_bytes();
        let header_path = std::str::from_utf8(&header_path).map_err(|_| "Non-UTF8 tar path")?;
        let path = member_path(
            pax.get("path").map(String::as_str).unwrap_or(header_path),
            entry_type == b'5',
            &root,
        )?;
        let mode = header.mode().map_err(|_| "Invalid archive mode")?;
        // Preserve ordinary modes verbatim, never bless setuid/setgid/sticky
        // entries as an installer permission request.
        require(mode <= 0o777, "Special permission bits are not permitted")?;
        charge_metadata(&mut metadata_bytes, path.len(), limits)?;
        require(!entries.contains_key(&path), "Duplicate archive path")?;
        require(
            aliases.insert(path.to_ascii_lowercase()),
            "Case-alias archive paths",
        )?;
        let raw_link = header.link_name_bytes();
        let raw_link = raw_link.as_deref().unwrap_or_default();
        let raw_link = std::str::from_utf8(raw_link).map_err(|_| "Non-UTF8 link target")?;
        let target = pax.get("linkpath").map(String::as_str).unwrap_or(raw_link);
        let kind = match entry_type {
            b'5' => {
                require(
                    size == 0 && target.is_empty(),
                    "Directory has data or link metadata",
                )?;
                ArchiveEntryKind::Directory
            }
            b'2' => {
                require(size == 0, "Symlink has file data")?;
                validate_link_text(target)?;
                charge_metadata(&mut metadata_bytes, target.len(), limits)?;
                ArchiveEntryKind::Symlink {
                    target: target.to_owned(),
                }
            }
            _ => {
                require(target.is_empty(), "Regular file has link metadata")?;
                file_bytes = file_bytes.checked_add(size).ok_or("File size overflow")?;
                require(
                    file_bytes <= limits.expanded,
                    "File bytes exceed expanded limit",
                )?;
                let metadata = path == plist_path || path == package_path || path == runtime_path;
                require(
                    !metadata || size <= limits.metadata as u64,
                    "Identity metadata exceeds limit",
                )?;
                let capture = metadata || path == executable_path;
                let (sha256, prefix) = hash_file(&mut entry, size, capture, limits.metadata)?;
                if capture {
                    captured.insert(path.clone(), prefix);
                }
                ArchiveEntryKind::File { size, sha256 }
            }
        };
        entries.insert(path.clone(), ArchiveEntry { path, mode, kind });
    }
    require(pending_pax.is_none(), "PAX header has no following member")?;
    let mut reader = archive.into_inner();
    // tar stops on the FIRST zero header (or plain EOF); insist on both EOF
    // blocks and zero-only, block-aligned trailing padding. Never ignore a
    // second hidden tar archive after its first end marker.
    require(reader.count == expected_end + 512, "Missing tar end marker")?;
    let mut tail = 0_u64;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "Invalid gzip trailer or expanded limit")?;
        if read == 0 {
            break;
        }
        require(
            buffer[..read].iter().all(|byte| *byte == 0),
            "Nonzero trailing tar data",
        )?;
        tail += read as u64;
    }
    require(
        tail >= 512 && tail % 512 == 0,
        "Truncated or misaligned tar end blocks",
    )?;
    let expanded_bytes = reader.count;
    require(
        reader.inner.into_inner().is_empty(),
        "Trailing compressed data or multiple gzip members",
    )?;
    validate_tree(&entries, &root)?;
    let metadata = |path: &str| {
        captured
            .get(path)
            .ok_or_else(|| "Required identity member is missing or not a file".to_owned())
    };
    validate_plist(metadata(&plist_path)?, expected)?;
    validate_package(metadata(&package_path)?, expected)?;
    let executable = entries
        .get(&executable_path)
        .ok_or("Main executable is missing")?;
    let ArchiveEntryKind::File { size, .. } = executable.kind else {
        return Err("Main executable is not a regular file".to_owned());
    };
    require(
        executable.mode & 0o111 != 0,
        "Main executable has no execute permission",
    )?;
    validate_macho(
        metadata(&executable_path)?,
        size,
        &expected.minimum_system_version,
    )?;
    validate_runtime_manifest(metadata(&runtime_path)?, &entries, &root)?;
    let runtime_manifest_sha256 = hash_bytes(metadata(&runtime_path)?);
    let entries: Vec<_> = entries.into_values().collect();
    Ok(ArchiveInventory {
        identity: expected.clone(),
        root,
        compressed_bytes: bytes.len() as u64,
        expanded_bytes,
        total_file_bytes: file_bytes,
        archive_sha256: hash_bytes(bytes),
        inventory_sha256: inventory_hash(&entries),
        runtime_manifest_sha256,
        entries,
    })
}

struct LimitedReader<R> {
    inner: R,
    count: u64,
    limit: u64,
}

impl<R: Read> Read for LimitedReader<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        // Probe one byte at the boundary so exact-limit valid EOF succeeds.
        let length = output
            .len()
            .min((self.limit - self.count).saturating_add(1) as usize);
        let read = self.inner.read(&mut output[..length])?;
        if read as u64 > self.limit - self.count {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Expanded archive exceeds limit",
            ));
        }
        self.count += read as u64;
        Ok(read)
    }
}

fn charge_metadata(total: &mut usize, bytes: usize, limits: Limits) -> Result<(), String> {
    *total = total.checked_add(bytes).ok_or("Metadata size overflow")?;
    require(
        *total <= limits.inventory_metadata,
        "Aggregate archive metadata exceeds limit",
    )
}

fn parse_decimal(text: &str) -> Result<u64, String> {
    require(
        !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()),
        "Invalid PAX integer",
    )?;
    require(
        text.len() == 1 || !text.starts_with('0'),
        "Noncanonical PAX integer",
    )?;
    text.parse().map_err(|_| "PAX integer overflow".to_owned())
}

fn parse_pax(bytes: &[u8]) -> Result<BTreeMap<String, String>, String> {
    // PaxExtensions stops at an empty line and tolerates a missing final LF.
    // Reject those before invoking the maintained key/value/length parser.
    require(
        bytes.ends_with(b"\n")
            && !bytes.starts_with(b"\n")
            && !bytes.windows(2).any(|w| w == b"\n\n"),
        "Malformed PAX lines",
    )?;
    let mut result = BTreeMap::new();
    for record in tar::PaxExtensions::new(bytes) {
        let record = record.map_err(|_| "Malformed PAX record")?;
        let key = record.key().map_err(|_| "Invalid PAX key")?;
        let value = record.value().map_err(|_| "Invalid PAX value")?;
        // These are the only semantics needed by the final-app producer.
        // In particular never silently ignore sparse/xattr/ACL/type/mode keys.
        require(
            matches!(
                key,
                "path"
                    | "linkpath"
                    | "size"
                    | "uid"
                    | "gid"
                    | "uname"
                    | "gname"
                    | "mtime"
                    | "atime"
                    | "ctime"
            ),
            "Unsupported PAX key",
        )?;
        require(
            !value.bytes().any(|b| b < 0x20 || b == 0x7f),
            "Control character in PAX value",
        )?;
        if matches!(key, "size" | "uid" | "gid") {
            parse_decimal(value)?;
        }
        if matches!(key, "mtime" | "atime" | "ctime") {
            require(
                !value.is_empty()
                    && value.len() <= 32
                    && value.parse::<f64>().is_ok_and(|v| v.is_finite()),
                "Invalid PAX timestamp",
            )?;
        }
        require(
            result.insert(key.to_owned(), value.to_owned()).is_none(),
            "Duplicate PAX key",
        )?;
    }
    require(!result.is_empty(), "Empty PAX metadata")?;
    Ok(result)
}

fn path_text(text: &str) -> Result<(), String> {
    // Deliberately narrower than the JS producer: no Unicode path acceptance
    // without canonical decomposition + filesystem case-folding. This avoids
    // blessing NFC/NFD aliases with an incomplete Rust lowercase approximation.
    require(
        !text.is_empty() && text.len() <= MAX_PATH_BYTES,
        "Path length exceeds limit",
    )?;
    require(
        text.bytes()
            .all(|b| (0x20..0x7f).contains(&b) && b != b'\\' && b != b':'),
        "Unsupported path character (ASCII paths only)",
    )
}

fn relative_components(text: &str) -> Result<(), String> {
    path_text(text)?;
    let mut depth = 0;
    for component in text.split('/') {
        depth += 1;
        require(
            !component.is_empty()
                && component != "."
                && component != ".."
                && !component.starts_with("._"),
            "Noncanonical path component",
        )?;
        require(
            component.len() <= 255,
            "Path component exceeds macOS filename limit",
        )?;
    }
    require(depth <= MAX_DEPTH, "Archive path exceeds depth limit")
}

fn member_path(text: &str, directory: bool, root: &str) -> Result<String, String> {
    path_text(text)?;
    let text = if directory {
        text.strip_suffix('/').unwrap_or(text)
    } else {
        text
    };
    relative_components(text)?;
    require(
        text == root
            || text
                .strip_prefix(root)
                .is_some_and(|rest| rest.starts_with('/')),
        "Archive has a foreign or ambiguous root",
    )?;
    Ok(text.to_owned())
}

fn validate_link_text(target: &str) -> Result<(), String> {
    path_text(target)?;
    require(
        !target.starts_with('/') && !target.contains("//"),
        "Noncanonical or absolute link target",
    )?;
    require(
        target.split('/').count() <= MAX_DEPTH,
        "Link target exceeds depth limit",
    )
}

fn validate_identity(identity: &ArchiveIdentity) -> Result<(), String> {
    for component in [
        &identity.product_name,
        &identity.executable,
        &identity.package_name,
        &identity.bundle_identifier,
    ] {
        relative_components(component)?;
        require(
            !component.contains('/'),
            "Identity must contain single path components",
        )?;
    }
    for version in [&identity.desktop_version, &identity.product_version] {
        require(version.len() <= 128, "Identity version exceeds limit")?;
        let version = semver::Version::parse(version).map_err(|_| "Invalid identity version")?;
        require(
            version.build.is_empty(),
            "Identity version contains build metadata",
        )?;
    }
    macos_version(&identity.minimum_system_version)?;
    Ok(())
}

fn validate_tree(entries: &BTreeMap<String, ArchiveEntry>, root: &str) -> Result<(), String> {
    require(
        entries
            .get(root)
            .is_some_and(|e| matches!(e.kind, ArchiveEntryKind::Directory)),
        "Explicit app directory root is required",
    )?;
    for entry in entries.values() {
        if entry.path != root {
            let parent = entry
                .path
                .rsplit_once('/')
                .ok_or("Missing parent directory")?
                .0;
            require(
                entries
                    .get(parent)
                    .is_some_and(|e| matches!(e.kind, ArchiveEntryKind::Directory)),
                "Member beneath absent, file or symlink parent",
            )?;
        }
        if let ArchiveEntryKind::Symlink { target } = &entry.kind {
            resolve_link(&entry.path, target, entries, root)?;
        }
    }
    Ok(())
}

fn resolve_link<'a>(
    path: &'a str,
    target: &'a str,
    entries: &'a BTreeMap<String, ArchiveEntry>,
    root: &str,
) -> Result<String, String> {
    let mut stack: Vec<&str> = path
        .rsplit_once('/')
        .ok_or("Symlink cannot be root")?
        .0
        .split('/')
        .collect();
    let mut pending: VecDeque<&str> = target.split('/').collect();
    let mut dereferences = 0;
    while let Some(component) = pending.pop_front() {
        // POSIX requires a directory even for `file/..` and `file/.`.
        let parent = stack.join("/");
        require(
            entries
                .get(&parent)
                .is_some_and(|e| matches!(e.kind, ArchiveEntryKind::Directory)),
            "Link traverses a non-directory",
        )?;
        match component {
            "" | "." => continue,
            ".." => {
                require(stack.len() > 1, "Link escapes app root")?;
                stack.pop();
            }
            component => {
                stack.push(component);
                require(
                    stack.len() <= MAX_DEPTH,
                    "Resolved link exceeds depth limit",
                )?;
                let resolved = stack.join("/");
                let entry = entries
                    .get(&resolved)
                    .ok_or("Link targets a missing or case-aliased member")?;
                if let ArchiveEntryKind::Symlink { target } = &entry.kind {
                    dereferences += 1;
                    require(
                        dereferences <= MAX_LINK_DEREFERENCES,
                        "Link cycle or dereference limit",
                    )?;
                    stack.pop();
                    for part in target.split('/').rev() {
                        pending.push_front(part);
                    }
                }
            }
        }
    }
    let resolved = stack.join("/");
    require(
        stack.first().copied() == Some(root) && entries.contains_key(&resolved),
        "Link escapes or has no target",
    )?;
    Ok(resolved)
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn hash_file(
    reader: &mut impl Read,
    size: u64,
    capture: bool,
    cap: usize,
) -> Result<(String, Vec<u8>), String> {
    let mut hash = Sha256::new();
    let mut prefix = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut count = 0_u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "Truncated file or expanded limit")?;
        if read == 0 {
            break;
        }
        count += read as u64;
        require(count <= size, "File exceeds declared size")?;
        hash.update(&buffer[..read]);
        if capture {
            prefix.extend_from_slice(&buffer[..read.min(cap - prefix.len())]);
        }
    }
    require(count == size, "Truncated archive file")?;
    Ok((format!("{:x}", hash.finalize()), prefix))
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

// Bounded serde visitor shared by plist and JSON. Avoid Value::from_reader:
// duplicate dictionary keys are otherwise overwritten, and nested/referenced
// binary plists can amplify a tiny encoded document into a huge object tree.
#[derive(Debug)]
enum MetadataValue {
    String(String),
    Integer(u64),
    Map(BTreeMap<String, MetadataValue>),
    Array(Vec<MetadataValue>),
    Other,
}
struct Document(MetadataValue);
struct MetadataBudget {
    nodes: usize,
    bytes: usize,
}
struct MetadataSeed<'a> {
    depth: usize,
    budget: &'a mut MetadataBudget,
}

impl<'de> Deserialize<'de> for Document {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut budget = MetadataBudget {
            nodes: 16_384,
            bytes: 4 * MAX_METADATA_BYTES,
        };
        MetadataSeed {
            depth: 0,
            budget: &mut budget,
        }
        .deserialize(deserializer)
        .map(Self)
    }
}

impl<'de> DeserializeSeed<'de> for MetadataSeed<'_> {
    type Value = MetadataValue;
    fn deserialize<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        if self.depth > 32 || self.budget.nodes == 0 {
            return Err(de::Error::custom("Metadata depth/node limit"));
        }
        self.budget.nodes -= 1;
        deserializer.deserialize_any(self)
    }
}

impl MetadataSeed<'_> {
    fn charge<E: de::Error>(&mut self, length: usize) -> Result<(), E> {
        self.budget.bytes = self
            .budget
            .bytes
            .checked_sub(length)
            .ok_or_else(|| E::custom("Decoded metadata size limit"))?;
        Ok(())
    }
}

impl<'de> Visitor<'de> for MetadataSeed<'_> {
    type Value = MetadataValue;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("bounded, duplicate-free metadata")
    }
    fn visit_str<E: de::Error>(mut self, value: &str) -> Result<Self::Value, E> {
        self.charge(value.len())?;
        Ok(MetadataValue::String(value.to_owned()))
    }
    fn visit_string<E: de::Error>(mut self, value: String) -> Result<Self::Value, E> {
        self.charge(value.len())?;
        Ok(MetadataValue::String(value))
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        Ok(MetadataValue::Integer(value))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
        Ok(u64::try_from(value)
            .map(MetadataValue::Integer)
            .unwrap_or(MetadataValue::Other))
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
        Ok(MetadataValue::Other)
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
        Ok(MetadataValue::Other)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(MetadataValue::Other)
    }
    fn visit_bytes<E: de::Error>(mut self, value: &[u8]) -> Result<Self::Value, E> {
        self.charge(value.len())?;
        Ok(MetadataValue::Other)
    }
    fn visit_byte_buf<E: de::Error>(self, value: Vec<u8>) -> Result<Self::Value, E> {
        self.visit_bytes(&value)
    }
    fn visit_map<A: MapAccess<'de>>(mut self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut result = BTreeMap::new();
        while let Some(key) = map.next_key::<String>()? {
            self.charge(key.len())?;
            if result.contains_key(&key) {
                return Err(de::Error::custom("Duplicate metadata key"));
            }
            let value = map.next_value_seed(MetadataSeed {
                depth: self.depth + 1,
                budget: self.budget,
            })?;
            result.insert(key, value);
        }
        Ok(MetadataValue::Map(result))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        let mut result = Vec::new();
        while let Some(value) = sequence.next_element_seed(MetadataSeed {
            depth: self.depth + 1,
            budget: self.budget,
        })? {
            result.push(value);
        }
        Ok(MetadataValue::Array(result))
    }
}

impl MetadataValue {
    fn map(&self) -> Result<&BTreeMap<String, Self>, String> {
        if let Self::Map(value) = self {
            Ok(value)
        } else {
            Err("Identity metadata must be an object".to_owned())
        }
    }
    fn field(&self, key: &str) -> Result<&Self, String> {
        self.map()?
            .get(key)
            .ok_or_else(|| format!("Missing identity metadata field: {key}"))
    }
    fn string(&self) -> Result<&str, String> {
        if let Self::String(value) = self {
            Ok(value)
        } else {
            Err("Identity metadata must be a string".to_owned())
        }
    }
    fn equals(&self, key: &str, expected: &str) -> Result<(), String> {
        if self.field(key)?.string()? == expected {
            Ok(())
        } else {
            Err(format!("Archive identity mismatch: {key}"))
        }
    }
}

fn validate_plist(bytes: &[u8], identity: &ArchiveIdentity) -> Result<(), String> {
    let Document(value) = if bytes.starts_with(b"bplist00") {
        plist::from_reader(Cursor::new(bytes))
    } else {
        // plist 1.7's serde entry point returns after the root value, without
        // consuming the XML footer. Limit read-ahead to one byte so we can
        // require the producer's closing plist tag, not accept a second root,
        // hidden duplicate dictionary or a truncated XML document. Binary
        // plist parsing instead validates its trailer at the end of the input.
        let mut cursor = Cursor::new(bytes);
        let result = plist::from_reader(ExactXmlReader(&mut cursor));
        if result.is_ok() {
            let tail = &bytes[cursor.position() as usize..];
            require(
                tail.trim_ascii() == b"</plist>",
                "Invalid or ambiguous Info.plist XML footer",
            )?;
        }
        result
    }
    .map_err(|_| "Invalid, duplicate or excessive Info.plist metadata")?;
    for (key, expected) in [
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
    ] {
        value.equals(key, expected)?;
    }
    if let Some(floors) = value.map()?.get("LSMinimumSystemVersionByArchitecture") {
        floors.equals("arm64", &identity.minimum_system_version)?;
    }
    Ok(())
}

struct ExactXmlReader<R>(R);

impl<R: Read> Read for ExactXmlReader<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let length = output.len().min(1);
        self.0.read(&mut output[..length])
    }
}

impl<R: Seek> Seek for ExactXmlReader<R> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.0.seek(position)
    }
}

fn json_metadata(bytes: &[u8]) -> Result<MetadataValue, String> {
    let Document(value) = serde_json::from_slice(bytes)
        .map_err(|_| "Invalid, duplicate or excessive JSON metadata")?;
    Ok(value)
}

fn validate_package(bytes: &[u8], identity: &ArchiveIdentity) -> Result<(), String> {
    let value = json_metadata(bytes)?;
    value.equals("name", &identity.package_name)?;
    value.equals("version", &identity.product_version)?;
    value.equals("desktopVersion", &identity.desktop_version)?;
    value.equals("productName", &identity.product_name)?;
    value
        .field("build")?
        .equals("appId", &identity.bundle_identifier)?;
    value
        .field("build")?
        .equals("productName", &identity.product_name)
}

fn validate_runtime_manifest(
    bytes: &[u8],
    entries: &BTreeMap<String, ArchiveEntry>,
    root: &str,
) -> Result<(), String> {
    let value = json_metadata(bytes)?;
    require(
        matches!(value.field("schemaVersion")?, MetadataValue::Integer(1)),
        "Unsupported runtime manifest schema",
    )?;
    for key in ["gjcSdk", "bun", "natives"] {
        let version = value.field(key)?.string()?;
        require(
            version.len() <= 128 && semver::Version::parse(version).is_ok(),
            "Invalid runtime manifest version",
        )?;
    }
    let MetadataValue::Array(files) = value
        .field("platforms")?
        .field("darwin-arm64")?
        .field("files")?
    else {
        return Err("Runtime manifest files must be an array".to_owned());
    };
    require(!files.is_empty(), "Runtime manifest closure is empty")?;
    let mut seen = BTreeSet::new();
    for file in files {
        let package = file.field("package")?.string()?;
        relative_components(package)?;
        let parts: Vec<_> = package.split('/').collect();
        require(
            (parts.len() == 1 && !package.starts_with('@'))
                || (parts.len() == 2 && parts[0].starts_with('@') && parts[0].len() > 1),
            "Invalid runtime package name",
        )?;
        let relative = file.field("path")?.string()?;
        relative_components(relative)?;
        let digest = file.field("sha256")?.string()?;
        require(
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "Invalid runtime manifest hash",
        )?;
        let path = format!("{root}/{PAYLOAD}/node_modules/{package}/{relative}");
        require(
            seen.insert(path.clone()),
            "Duplicate runtime manifest member",
        )?;
        let entry = entries
            .get(&path)
            .ok_or("Runtime manifest member is missing")?;
        require(
            matches!(&entry.kind, ArchiveEntryKind::File { sha256, .. } if sha256 == digest),
            "Runtime manifest member hash/type mismatch",
        )?;
    }
    Ok(())
}

fn macos_version(text: &str) -> Result<u32, String> {
    let parts: Vec<_> = text.split('.').collect();
    require(
        parts.len() == 2 || parts.len() == 3,
        "Invalid macOS version",
    )?;
    let mut values = [0_u32; 3];
    for (index, part) in parts.iter().enumerate() {
        let value = parse_decimal(part)?;
        require(
            value <= if index == 0 { 65535 } else { 255 },
            "macOS version component overflow",
        )?;
        values[index] = value as u32;
    }
    Ok((values[0] << 16) | (values[1] << 8) | values[2])
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or("Truncated Mach-O header")?;
    Ok(u32::from_le_bytes(
        slice.try_into().map_err(|_| "Invalid Mach-O word")?,
    ))
}

fn u64_at(bytes: &[u8], offset: usize) -> Result<u64, String> {
    let slice = bytes
        .get(offset..offset + 8)
        .ok_or("Truncated Mach-O command")?;
    Ok(u64::from_le_bytes(
        slice.try_into().map_err(|_| "Invalid Mach-O word")?,
    ))
}

fn validate_macho(bytes: &[u8], size: u64, floor: &str) -> Result<(), String> {
    // Layout/constants follow Apple's SDK mach-o/loader.h and mach/machine.h.
    // Thin little-endian MH_MAGIC_64 / CPU_TYPE_ARM64 / ARM64_ALL /
    // MH_EXECUTE. No fat/universal, Intel, ARM64E-only or dylib substitution.
    require(
        u32_at(bytes, 0)? == 0xfeed_facf
            && u32_at(bytes, 4)? == 0x0100_000c
            && u32_at(bytes, 8)? == 0
            && u32_at(bytes, 12)? == 2,
        "Main executable is not a thin arm64 Mach-O executable",
    )?;
    let count = u32_at(bytes, 16)? as usize;
    let length = u32_at(bytes, 20)? as usize;
    require(
        count > 0
            && count <= 4096
            && length <= MAX_METADATA_BYTES - 32
            && length + 32 <= bytes.len(),
        "Invalid or oversized Mach-O load commands",
    )?;
    let end = 32 + length;
    let mut offset = 32;
    let mut minimum = None;
    let mut main = None;
    let mut executable_ranges = Vec::new();
    for _ in 0..count {
        require(offset + 8 <= end, "Truncated Mach-O load command")?;
        let command = u32_at(bytes, offset)?;
        let length = u32_at(bytes, offset + 4)? as usize;
        require(
            length >= 8 && length % 8 == 0 && length <= end - offset,
            "Invalid Mach-O command length",
        )?;
        match command {
            0x32 => {
                // LC_BUILD_VERSION
                require(
                    length >= 24 && u32_at(bytes, offset + 8)? == 1,
                    "Mach-O is not a macOS build",
                )?;
                require(
                    u32_at(bytes, offset + 20)? as u64 * 8 + 24 == length as u64,
                    "Invalid Mach-O build tools",
                )?;
                require(
                    minimum.replace(u32_at(bytes, offset + 12)?).is_none(),
                    "Ambiguous Mach-O OS floor",
                )?;
            }
            0x24 => {
                // LC_VERSION_MIN_MACOSX
                require(length == 16, "Invalid Mach-O OS floor command")?;
                require(
                    minimum.replace(u32_at(bytes, offset + 8)?).is_none(),
                    "Ambiguous Mach-O OS floor",
                )?;
            }
            0x19 => {
                // LC_SEGMENT_64
                require(
                    length >= 72 && u32_at(bytes, offset + 64)? as u64 * 80 + 72 == length as u64,
                    "Invalid Mach-O segment",
                )?;
                let start = u64_at(bytes, offset + 40)?;
                let length = u64_at(bytes, offset + 48)?;
                require(
                    start <= size && length <= size - start,
                    "Mach-O segment outside executable",
                )?;
                if u32_at(bytes, offset + 60)? & 4 != 0 && length > 0 {
                    executable_ranges.push((start, start + length));
                }
            }
            0x8000_0028 => {
                // LC_MAIN
                require(
                    length == 24 && main.replace(u64_at(bytes, offset + 8)?).is_none(),
                    "Invalid or duplicate Mach-O entry point",
                )?;
            }
            0x1d => {
                // LC_CODE_SIGNATURE: bounds only, NEVER signature proof.
                require(length == 16, "Invalid Mach-O code signature command")?;
                let start = u32_at(bytes, offset + 8)? as u64;
                let length = u32_at(bytes, offset + 12)? as u64;
                require(
                    start <= size && length <= size - start,
                    "Mach-O signature data outside executable",
                )?;
            }
            _ => {}
        }
        offset += length;
    }
    require(offset == end, "Mach-O command count/size disagreement")?;
    require(
        minimum.is_some_and(|version| version > 0 && version <= macos_version(floor).unwrap_or(0)),
        "Mach-O deployment floor exceeds manifest or is missing",
    )?;
    require(
        main.is_some_and(|entry| {
            executable_ranges
                .iter()
                .any(|(start, end)| entry >= *start && entry < *end)
        }),
        "Mach-O entry point is outside executable segments",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    const ROOT: &str = "Gajae Code App.app";
    const PLIST: &str = "Gajae Code App.app/Contents/Info.plist";
    const EXECUTABLE: &str = "Gajae Code App.app/Contents/MacOS/gajae-app-desktop";
    const PACKAGE: &str =
        "Gajae Code App.app/Contents/Resources/resources/server-payload/package.json";
    const RUNTIME: &str = "Gajae Code App.app/Contents/Resources/resources/server-payload/server/gjc-runtime-manifest.json";
    const NATIVE: &str = "Gajae Code App.app/Contents/Resources/resources/server-payload/node_modules/@gajae-code/natives/native/index.js";

    #[derive(Clone)]
    struct Fixture {
        path: String,
        kind: u8,
        mode: u32,
        data: Vec<u8>,
        target: String,
        pax: Vec<(String, Vec<u8>)>,
    }

    impl Fixture {
        fn file(path: &str, data: &[u8]) -> Self {
            Self {
                path: path.into(),
                kind: b'0',
                mode: 0o644,
                data: data.into(),
                target: String::new(),
                pax: Vec::new(),
            }
        }
        fn directory(path: &str) -> Self {
            Self {
                kind: b'5',
                mode: 0o755,
                ..Self::file(path, b"")
            }
        }
        fn link(path: &str, target: &str) -> Self {
            Self {
                kind: b'2',
                mode: 0o777,
                target: target.into(),
                ..Self::file(path, b"")
            }
        }
        fn header(&self) -> tar::Header {
            let mut header = tar::Header::new_ustar();
            header.set_mode(self.mode);
            header.set_size(self.data.len() as u64);
            header.set_entry_type(tar::EntryType::new(self.kind));
            if self.path.len() <= 100 || header.set_path(&self.path).is_err() {
                // Deliberately bypass builder traversal protection for attacks.
                header.as_mut_bytes()[..100].fill(0);
                let bytes = self.path.as_bytes();
                header.as_mut_bytes()[..bytes.len().min(100)]
                    .copy_from_slice(&bytes[..bytes.len().min(100)]);
            }
            if !self.target.is_empty() {
                let bytes = self.target.as_bytes();
                header.as_mut_bytes()[157..257].fill(0);
                header.as_mut_bytes()[157..157 + bytes.len().min(100)]
                    .copy_from_slice(&bytes[..bytes.len().min(100)]);
            }
            header.set_cksum();
            header
        }
    }

    fn identity() -> ArchiveIdentity {
        ArchiveIdentity {
            product_name: "Gajae Code App".into(),
            executable: "gajae-app-desktop".into(),
            bundle_identifier: "app.gajae.desktop".into(),
            package_name: "gajae-app".into(),
            desktop_version: "0.2.4".into(),
            product_version: "2.0.0-beta.10".into(),
            minimum_system_version: "13.0".into(),
        }
    }

    fn plist_value() -> plist::Value {
        let identity = identity();
        let fields = [
            ("CFBundleName", identity.product_name.clone()),
            ("CFBundleDisplayName", identity.product_name),
            ("CFBundleExecutable", identity.executable),
            ("CFBundleIdentifier", identity.bundle_identifier),
            ("CFBundlePackageType", "APPL".into()),
            (
                "CFBundleShortVersionString",
                identity.desktop_version.clone(),
            ),
            ("CFBundleVersion", identity.desktop_version),
            ("LSMinimumSystemVersion", identity.minimum_system_version),
        ];
        plist::Value::Dictionary(
            fields
                .into_iter()
                .map(|(key, value)| (key.to_owned(), plist::Value::String(value)))
                .collect(),
        )
    }

    fn plist_bytes(value: &plist::Value, binary: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        if binary {
            value.to_writer_binary(&mut bytes).unwrap();
        } else {
            value.to_writer_xml(&mut bytes).unwrap();
        }
        bytes
    }

    fn word(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    fn wide(bytes: &mut [u8], offset: usize, value: u64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    /// Structural Mach-O fixture only: not signed, loadable or executable code.
    fn macho() -> Vec<u8> {
        let mut bytes = vec![0; 256];
        for (offset, value) in [
            (0, 0xfeed_facf),
            (4, 0x0100_000c),
            (12, 2),
            (16, 3),
            (20, 120),
            (32, 0x19),
            (36, 72),
            (92, 5),
            (104, 0x32),
            (108, 24),
            (112, 1),
            (116, 13 << 16),
            (128, 0x8000_0028),
            (132, 24),
        ] {
            word(&mut bytes, offset, value);
        }
        wide(&mut bytes, 80, 256); // segment filesize
        wide(&mut bytes, 136, 160); // LC_MAIN entryoff
        bytes
    }

    fn fixture() -> Vec<Fixture> {
        let id = identity();
        let package = serde_json::to_vec(&serde_json::json!({
            "name": id.package_name, "version": id.product_version,
            "desktopVersion": id.desktop_version, "productName": id.product_name,
            "build": { "appId": id.bundle_identifier, "productName": "Gajae Code App" },
            "scripts": {}, "dependencies": {}
        }))
        .unwrap();
        let native = b"export const fixture = true;\n";
        let runtime = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "gjcSdk": "0.16.4", "bun": "1.4.0", "natives": "0.16.4",
            "platforms": { "darwin-arm64": { "files": [{
                "package": "@gajae-code/natives", "path": "native/index.js", "sha256": hash_bytes(native)
            }] } }
        })).unwrap();
        let mut files = vec![
            Fixture::file(PLIST, &plist_bytes(&plist_value(), false)),
            Fixture {
                mode: 0o755,
                ..Fixture::file(EXECUTABLE, &macho())
            },
            Fixture::file(PACKAGE, &package),
            Fixture::file(RUNTIME, &runtime),
            Fixture::file(NATIVE, native),
        ];
        let mut parents = BTreeSet::new();
        for file in &files {
            let mut parent = file.path.as_str();
            while let Some((prefix, _)) = parent.rsplit_once('/') {
                parents.insert(prefix.to_owned());
                parent = prefix;
            }
        }
        files.extend(parents.iter().map(|p| Fixture::directory(p)));
        files.sort_by(|left, right| left.path.cmp(&right.path));
        files
    }

    fn tar_bytes(fixtures: &[Fixture]) -> Vec<u8> {
        let mut tar = tar::Builder::new(Vec::new());
        for file in fixtures {
            if !file.pax.is_empty() {
                tar.append_pax_extensions(file.pax.iter().map(|(k, v)| (k.as_str(), v.as_slice())))
                    .unwrap();
            }
            tar.append(&file.header(), file.data.as_slice()).unwrap();
        }
        tar.into_inner().unwrap()
    }
    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }
    fn inspect(fixtures: &[Fixture]) -> Result<ArchiveInventory, String> {
        inspect_archive(&gzip(&tar_bytes(fixtures)), &identity())
    }
    fn get<'a>(fixtures: &'a mut [Fixture], path: &str) -> &'a mut Fixture {
        fixtures.iter_mut().find(|f| f.path == path).unwrap()
    }
    fn rejected(fixtures: &[Fixture], reason: &str) {
        let error = inspect(fixtures).unwrap_err();
        assert!(error.contains(reason), "expected {reason:?}, got {error:?}");
    }

    #[test]
    fn accepts_complete_inventory_and_roundtrips_owned_types() {
        let fixtures = fixture();
        let raw = tar_bytes(&fixtures);
        let bytes = gzip(&raw);
        let inventory = inspect_archive(&bytes, &identity()).unwrap();
        assert_eq!(inventory.root, ROOT);
        assert_eq!(inventory.compressed_bytes, bytes.len() as u64);
        assert_eq!(inventory.expanded_bytes, raw.len() as u64);
        assert_eq!(
            inventory.total_file_bytes,
            fixtures.iter().map(|f| f.data.len() as u64).sum::<u64>()
        );
        assert_eq!(inventory.archive_sha256, hash_bytes(&bytes));
        assert_eq!(inventory.entries.len(), fixtures.len());
        assert_eq!(
            serde_json::from_value::<ArchiveInventory>(serde_json::to_value(&inventory).unwrap())
                .unwrap(),
            inventory
        );
    }

    #[test]
    fn accepts_binary_plist_and_nested_standard_plist_values() {
        let mut value = plist_value();
        value.as_dictionary_mut().unwrap().insert(
            "CFBundleURLTypes".into(),
            plist::Value::Array(vec![plist::Value::Dictionary(
                [
                    (
                        "CFBundleURLSchemes".to_owned(),
                        plist::Value::Array(vec![plist::Value::String("gajae-app".into())]),
                    ),
                    ("Enabled".to_owned(), plist::Value::Boolean(true)),
                ]
                .into_iter()
                .collect(),
            )]),
        );
        for binary in [true, false] {
            let mut fixtures = fixture();
            get(&mut fixtures, PLIST).data = plist_bytes(&value, binary);
            inspect(&fixtures).unwrap();
        }
    }

    #[test]
    fn inventory_hash_commits_to_every_file_mode_link_and_path_not_order() {
        let mut fixtures = fixture();
        fixtures.push(Fixture::file(&format!("{ROOT}/extra"), b"A"));
        fixtures.push(Fixture::file(&format!("{ROOT}/other"), b"B"));
        fixtures.push(Fixture::link(&format!("{ROOT}/link"), "extra"));
        let original = inspect(&fixtures).unwrap();
        fixtures.reverse();
        let reordered = inspect(&fixtures).unwrap();
        assert_eq!(original.entries, reordered.entries);
        assert_eq!(original.inventory_sha256, reordered.inventory_sha256);
        assert_ne!(original.archive_sha256, reordered.archive_sha256);
        for change in 0..5 {
            let mut changed = fixtures.clone();
            let entry = get(&mut changed, &format!("{ROOT}/extra"));
            match change {
                0 => entry.data[0] ^= 1,
                1 => entry.mode = 0o600,
                2 => get(&mut changed, ROOT).mode = 0o700,
                3 => get(&mut changed, &format!("{ROOT}/link")).target = "other".into(),
                _ => get(&mut changed, &format!("{ROOT}/other")).path = format!("{ROOT}/renamed"),
            }
            assert_ne!(
                original.inventory_sha256,
                inspect(&changed).unwrap().inventory_sha256
            );
        }
    }

    #[test]
    fn compressed_expanded_count_and_aggregate_metadata_limits_are_hard() {
        let fixtures = fixture();
        let raw = tar_bytes(&fixtures);
        let bytes = gzip(&raw);
        for limits in [
            Limits {
                compressed: bytes.len() - 1,
                ..Limits::default()
            },
            Limits {
                expanded: raw.len() as u64 - 1,
                ..Limits::default()
            },
            Limits {
                entries: fixtures.len() - 1,
                ..Limits::default()
            },
            Limits {
                inventory_metadata: 20,
                ..Limits::default()
            },
            Limits {
                metadata: 64,
                ..Limits::default()
            },
        ] {
            assert!(inspect_with_limits(&bytes, &identity(), limits).is_err());
        }
        let exact = Limits {
            compressed: bytes.len(),
            expanded: raw.len() as u64,
            entries: fixtures.len(),
            ..Limits::default()
        };
        inspect_with_limits(&bytes, &identity(), exact).unwrap();
    }

    #[test]
    fn counts_zero_padding_and_pax_headers_against_limits() {
        let fixtures = fixture();
        let mut raw = tar_bytes(&fixtures);
        let cap = raw.len() as u64 + 512;
        raw.extend_from_slice(&[0; 1024]);
        assert!(inspect_with_limits(
            &gzip(&raw),
            &identity(),
            Limits {
                expanded: cap,
                ..Limits::default()
            }
        )
        .is_err());
        let mut fixtures = fixtures;
        fixtures[0]
            .pax
            .push(("path".into(), ROOT.as_bytes().into()));
        assert!(inspect_with_limits(
            &gzip(&tar_bytes(&fixtures)),
            &identity(),
            Limits {
                entries: fixtures.len(),
                ..Limits::default()
            }
        )
        .is_err());
    }

    #[test]
    fn refuses_huge_declared_sizes_before_body_allocation() {
        for kind in [b'0', b'x'] {
            let fixture = Fixture {
                kind,
                ..Fixture::file(ROOT, b"")
            };
            let mut header = fixture.header();
            header.set_size(MAX_EXPANDED_BYTES + 1);
            header.set_cksum();
            assert!(inspect_archive(&gzip(header.as_bytes()), &identity())
                .unwrap_err()
                .contains("size exceeds"));
        }
        let mut header = Fixture {
            kind: b'x',
            ..Fixture::file("PaxHeader/root", b"")
        }
        .header();
        header.set_size(MAX_METADATA_BYTES as u64 + 1);
        header.set_cksum();
        assert!(inspect_archive(&gzip(header.as_bytes()), &identity())
            .unwrap_err()
            .contains("PAX metadata exceeds"));
    }

    #[test]
    fn rejects_every_truncation_of_a_small_valid_gzip() {
        let bytes = gzip(&tar_bytes(&fixture()));
        for cut in 0..bytes.len() {
            assert!(
                inspect_archive(&bytes[..cut], &identity()).is_err(),
                "accepted truncation {cut}"
            );
        }
    }

    #[test]
    fn rejects_crc_isize_and_hidden_compressed_members() {
        let bytes = gzip(&tar_bytes(&fixture()));
        for position in [bytes.len() - 8, bytes.len() - 4] {
            let mut bad = bytes.clone();
            bad[position] ^= 1;
            assert!(inspect_archive(&bad, &identity()).is_err());
        }
        for suffix in [vec![0], b"garbage".to_vec(), gzip(b""), bytes.clone()] {
            let mut bad = bytes.clone();
            bad.extend_from_slice(&suffix);
            assert!(inspect_archive(&bad, &identity()).is_err());
        }
        assert!(inspect_archive(b"not gzip", &identity()).is_err());
    }

    #[test]
    fn rejects_excessive_gzip_metadata_and_invalid_gzip_flags() {
        let raw = tar_bytes(&fixture());
        let mut writer = flate2::GzBuilder::new()
            .comment(vec![b'x'; 1024])
            .write(Vec::new(), Compression::fast());
        writer.write_all(&raw).unwrap();
        let bytes = writer.finish().unwrap();
        assert!(inspect_with_limits(
            &bytes,
            &identity(),
            Limits {
                metadata: 1024,
                ..Limits::default()
            }
        )
        .unwrap_err()
        .contains("Gzip metadata"));
        let mut bytes = gzip(&raw);
        bytes[3] |= 0x80;
        assert!(inspect_archive(&bytes, &identity()).is_err());
    }

    #[test]
    fn rejects_tar_trailing_data_missing_markers_and_bad_checksum() {
        let raw = tar_bytes(&fixture());
        for removed in [1, 512, 1024] {
            assert!(inspect_archive(&gzip(&raw[..raw.len() - removed]), &identity()).is_err());
        }
        let mut hidden = raw.clone();
        hidden.extend_from_slice(&raw);
        assert!(inspect_archive(&gzip(&hidden), &identity())
            .unwrap_err()
            .contains("trailing tar"));
        let mut aligned = raw.clone();
        aligned.push(0);
        assert!(inspect_archive(&gzip(&aligned), &identity()).is_err());
        let mut bad = raw;
        bad[0] ^= 1;
        assert!(inspect_archive(&gzip(&bad), &identity()).is_err());
    }

    #[test]
    fn rejects_foreign_root_traversal_separator_control_and_unicode_paths() {
        let paths = [
            "/Gajae Code App.app/bad",
            "../Gajae Code App.app/bad",
            "./Gajae Code App.app/bad",
            "Other.app/bad",
            "gajae code app.app/bad",
            "Gajae Code App.app2/bad",
            "Gajae Code App.app/../bad",
            "Gajae Code App.app/./bad",
            "Gajae Code App.app//bad",
            "Gajae Code App.app/evil\\path",
            "Gajae Code App.app/evil:path",
            "Gajae Code App.app/._metadata",
            "Gajae Code App.app/a\nb",
            "Gajae Code App.app/a\tb",
            "Gajae Code App.app/café",
            "Gajae Code App.app/cafe\u{301}",
            "Gajae Code App.app/한글",
            "Gajae Code App.app/bad/",
        ];
        for path in paths {
            let mut fixtures = fixture();
            fixtures.push(Fixture::file(path, b"x"));
            assert!(inspect(&fixtures).is_err(), "accepted {path:?}");
        }
    }

    #[test]
    fn rejects_missing_parents_duplicate_paths_and_case_aliases() {
        for path in [
            ROOT.to_owned(),
            format!("{ROOT}/Contents/info.plist"),
            format!("{ROOT}/Contents/Info.plist"),
            format!("{ROOT}/Missing/file"),
        ] {
            let mut fixtures = fixture();
            fixtures.push(Fixture::file(&path, b"x"));
            assert!(inspect(&fixtures).is_err());
        }
        let mut fixtures = fixture();
        fixtures.push(Fixture::directory(&format!("{ROOT}/")));
        rejected(&fixtures, "Duplicate");
        let mut fixtures = fixture();
        fixtures.retain(|f| f.path != ROOT);
        rejected(&fixtures, "root");
        let mut fixtures = fixture();
        fixtures.retain(|f| f.path != format!("{ROOT}/Contents"));
        rejected(&fixtures, "parent");
    }

    #[test]
    fn rejects_special_files_modes_and_nonfile_data() {
        for kind in [
            b'1', b'3', b'4', b'6', b'7', b'S', b'g', b'L', b'K', b'D', b'V',
        ] {
            let mut fixtures = fixture();
            fixtures.push(Fixture {
                kind,
                ..Fixture::file(&format!("{ROOT}/special"), b"")
            });
            rejected(&fixtures, "Unsupported");
        }
        for mode in [0o1000, 0o2000, 0o4000, 0o100755] {
            let mut fixtures = fixture();
            get(&mut fixtures, EXECUTABLE).mode = mode;
            rejected(&fixtures, "permission");
        }
        for kind in [b'2', b'5'] {
            let mut fixtures = fixture();
            fixtures.push(Fixture {
                kind,
                ..Fixture::file(&format!("{ROOT}/data"), b"not empty")
            });
            assert!(inspect(&fixtures).is_err());
        }
        let mut fixtures = fixture();
        get(&mut fixtures, PLIST).target = "Contents".into();
        rejected(&fixtures, "link metadata");
    }

    #[test]
    fn accepts_local_pax_long_paths_and_links_like_release_packer() {
        let mut fixtures = fixture();
        let mut parent = ROOT.to_owned();
        for _ in 0..4 {
            parent.push('/');
            parent.push_str(&"long".repeat(15));
            fixtures.push(Fixture::directory(&parent));
        }
        let long_path = format!("{parent}/data");
        fixtures.push(Fixture {
            pax: vec![
                ("path".into(), long_path.as_bytes().into()),
                ("size".into(), b"1".to_vec()),
            ],
            ..Fixture::file(&format!("{ROOT}/placeholder"), b"x")
        });
        let target = long_path.strip_prefix(&format!("{ROOT}/")).unwrap();
        fixtures.push(Fixture {
            pax: vec![("linkpath".into(), target.as_bytes().into())],
            ..Fixture::link(&format!("{ROOT}/link"), "placeholder")
        });
        // Long directory paths also need PAX (tar::Builder would use GNU L).
        for file in &mut fixtures {
            if file.kind == b'5' && file.path.len() > 250 {
                file.pax
                    .push(("path".into(), file.path.as_bytes().to_vec()));
                file.path = format!("{ROOT}/directory-placeholder");
            }
        }
        let inventory = inspect(&fixtures).unwrap();
        assert!(inventory.entries.iter().any(|e| e.path == long_path));
    }

    #[test]
    fn rejects_pax_ambiguity_sparse_xattr_traversal_and_size_disagreement() {
        let variants: Vec<Vec<(String, Vec<u8>)>> = vec![
            vec![("path".into(), b"../outside".to_vec())],
            vec![("path".into(), b"/absolute".to_vec())],
            vec![("path".into(), format!("{ROOT}/a\0hidden").into_bytes())],
            vec![
                ("path".into(), format!("{ROOT}/a").into_bytes()),
                ("path".into(), format!("{ROOT}/b").into_bytes()),
            ],
            vec![("size".into(), b"2".to_vec())],
            vec![("size".into(), b"01".to_vec())],
            vec![("size".into(), b"18446744073709551616".to_vec())],
            vec![("GNU.sparse.map".into(), b"0,1".to_vec())],
            vec![("SCHILY.xattr.user.foo".into(), b"x".to_vec())],
            vec![("SCHILY.acl.access".into(), b"x".to_vec())],
            vec![("mode".into(), b"493".to_vec())],
            vec![("type".into(), b"2".to_vec())],
            vec![("mtime".into(), b"NaN".to_vec())],
        ];
        for pax in variants {
            let mut fixtures = fixture();
            fixtures.push(Fixture {
                pax,
                ..Fixture::file(&format!("{ROOT}/extra"), b"x")
            });
            assert!(inspect(&fixtures).is_err());
        }
    }

    #[test]
    fn rejects_malformed_and_dangling_pax_records() {
        for data in [
            b"12 path=bad\n".as_slice(),
            b"11 path=xx",
            b"\n11 path=xx\n",
            b"11 path=xx\n\nignored",
            b"11 path=xx\n9 size=1\n",
        ] {
            let mut fixtures = fixture();
            fixtures.insert(
                0,
                Fixture {
                    kind: b'x',
                    ..Fixture::file("PaxHeader/x", data)
                },
            );
            assert!(inspect(&fixtures).is_err());
        }
        let mut tar = tar::Builder::new(Vec::new());
        tar.append_pax_extensions([("path", ROOT.as_bytes())])
            .unwrap();
        assert!(inspect_archive(&gzip(&tar.into_inner().unwrap()), &identity()).is_err());
        let mut fixtures = fixture();
        fixtures.insert(
            0,
            Fixture {
                kind: b'x',
                data: b"9 size=0\n".to_vec(),
                ..Fixture::file("PaxHeader/x", b"")
            },
        );
        fixtures[1].pax = vec![("path".into(), ROOT.as_bytes().into())];
        rejected(&fixtures, "Stacked PAX");
    }

    #[test]
    fn accepts_framework_link_chains_with_complete_parent_inventory() {
        let mut fixtures = fixture();
        for path in ["Framework", "Framework/Versions", "Framework/Versions/A"] {
            fixtures.push(Fixture::directory(&format!("{ROOT}/{path}")));
        }
        fixtures.push(Fixture::file(
            &format!("{ROOT}/Framework/Versions/A/Foo"),
            b"framework",
        ));
        fixtures.push(Fixture::link(
            &format!("{ROOT}/Framework/Versions/Current"),
            "A",
        ));
        fixtures.push(Fixture::link(
            &format!("{ROOT}/Framework/Foo"),
            "Versions/Current/Foo",
        ));
        fixtures.push(Fixture::link(
            &format!("{ROOT}/again"),
            "Framework/../Framework/Foo",
        ));
        inspect(&fixtures).unwrap();
    }

    #[test]
    fn rejects_escaping_dangling_cycles_case_links_and_file_dotdot() {
        for target in [
            "/tmp/escape",
            "../escape",
            "../../escape",
            "C:/escape",
            "Contents\\Info.plist",
            "Contents//Info.plist",
            "missing",
            "link",
            "contents/Info.plist",
            "Contents/Info.plist/..",
            "Contents/Info.plist/",
            "Contents/Info.plist/.",
        ] {
            let mut fixtures = fixture();
            fixtures.push(Fixture::link(&format!("{ROOT}/link"), target));
            assert!(inspect(&fixtures).is_err(), "accepted {target:?}");
        }
        let mut fixtures = fixture();
        fixtures.push(Fixture::link(&format!("{ROOT}/a"), "b"));
        fixtures.push(Fixture::link(&format!("{ROOT}/b"), "a"));
        rejected(&fixtures, "cycle");
        let mut fixtures = fixture();
        fixtures.push(Fixture::link(&format!("{ROOT}/Contents/back"), ".."));
        fixtures.push(Fixture::link(
            &format!("{ROOT}/danger"),
            "Contents/back/../outside",
        ));
        rejected(&fixtures, "escapes");
    }

    #[test]
    fn rejects_children_beneath_links_regardless_of_order() {
        for reverse in [true, false] {
            let mut fixtures = fixture();
            fixtures.push(Fixture::link(&format!("{ROOT}/linked"), "Contents"));
            fixtures.push(Fixture::file(&format!("{ROOT}/linked/injected"), b"x"));
            if reverse {
                fixtures.reverse();
            }
            rejected(&fixtures, "parent");
        }
    }

    #[test]
    fn rejects_overlong_paths_components_and_depth() {
        for path in [
            format!("{ROOT}/{}", "x".repeat(256)),
            format!("{ROOT}/{}", "x/".repeat(128)),
            format!("{ROOT}/{}", "x".repeat(MAX_PATH_BYTES)),
        ] {
            let mut fixtures = fixture();
            fixtures.push(Fixture {
                pax: vec![("path".into(), path.into_bytes())],
                ..Fixture::file(&format!("{ROOT}/short"), b"")
            });
            assert!(inspect(&fixtures).is_err());
        }
    }

    #[test]
    fn identity_fields_must_match_archive_and_be_trusted_components() {
        let fixtures = fixture();
        let bytes = gzip(&tar_bytes(&fixtures));
        for field in 0..7 {
            let mut id = identity();
            match field {
                0 => id.product_name = "Other".into(),
                1 => id.executable = "other".into(),
                2 => id.bundle_identifier = "other.app".into(),
                3 => id.package_name = "gajae-app-server".into(),
                4 => id.desktop_version = "0.2.5".into(),
                5 => id.product_version = "2.0.0-beta.11".into(),
                _ => id.minimum_system_version = "14.0".into(),
            }
            assert!(inspect_archive(&bytes, &id).is_err());
        }
        let mut id = identity();
        id.executable = "../../other".into();
        assert!(inspect_archive(&bytes, &id).is_err());
        let mut id = identity();
        id.product_version = "2.0.0+unbound".into();
        assert!(inspect_archive(&bytes, &id).is_err());
    }

    #[test]
    fn rejects_missing_and_symlinked_identity_members() {
        for path in [PLIST, PACKAGE, RUNTIME, EXECUTABLE] {
            let mut fixtures = fixture();
            fixtures.retain(|f| f.path != path);
            assert!(inspect(&fixtures).is_err());
            let mut fixtures = fixture();
            let original = get(&mut fixtures, path).clone();
            let alternative = format!("{ROOT}/alternative");
            fixtures.push(Fixture {
                path: alternative,
                ..original
            });
            let parent_depth = path.split('/').count() - 2;
            *get(&mut fixtures, path) =
                Fixture::link(path, &format!("{}alternative", "../".repeat(parent_depth)));
            assert!(inspect(&fixtures).is_err());
        }
    }

    #[test]
    fn rejects_plist_mismatch_wrong_type_duplicates_and_deep_nesting() {
        for key in [
            "CFBundleName",
            "CFBundleDisplayName",
            "CFBundleExecutable",
            "CFBundleIdentifier",
            "CFBundlePackageType",
            "CFBundleShortVersionString",
            "CFBundleVersion",
            "LSMinimumSystemVersion",
        ] {
            let mut value = plist_value();
            value
                .as_dictionary_mut()
                .unwrap()
                .insert(key.into(), plist::Value::String("wrong".into()));
            let mut fixtures = fixture();
            get(&mut fixtures, PLIST).data = plist_bytes(&value, false);
            assert!(inspect(&fixtures).is_err());
        }
        let mut fixtures = fixture();
        let xml = String::from_utf8(get(&mut fixtures, PLIST).data.clone()).unwrap();
        get(&mut fixtures, PLIST).data = xml
            .replace(
                "</dict>",
                "<key>CFBundleName</key><string>Gajae Code App</string></dict>",
            )
            .into_bytes();
        rejected(&fixtures, "Info.plist");
        let mut value = plist_value();
        value
            .as_dictionary_mut()
            .unwrap()
            .insert("CFBundleVersion".into(), plist::Value::Integer(24.into()));
        let mut fixtures = fixture();
        get(&mut fixtures, PLIST).data = plist_bytes(&value, true);
        rejected(&fixtures, "string");
        let mut nested = plist::Value::String("x".into());
        for _ in 0..40 {
            nested = plist::Value::Array(vec![nested]);
        }
        let mut value = plist_value();
        value
            .as_dictionary_mut()
            .unwrap()
            .insert("Extra".into(), nested);
        let mut fixtures = fixture();
        get(&mut fixtures, PLIST).data = plist_bytes(&value, true);
        rejected(&fixtures, "Info.plist");
    }

    #[test]
    fn rejects_plist_reference_amplification_under_small_encoded_size() {
        // The binary writer deduplicates strings, so the encoded input is small
        // while materializing every repeated reference would exceed the budget.
        let mut value = plist_value();
        value.as_dictionary_mut().unwrap().insert(
            "Amplification".into(),
            plist::Value::Array(vec![plist::Value::String("x".repeat(4096)); 100]),
        );
        let bytes = plist_bytes(&value, true);
        assert!(bytes.len() < MAX_METADATA_BYTES);
        let mut fixtures = fixture();
        get(&mut fixtures, PLIST).data = bytes;
        rejected(&fixtures, "Info.plist");
    }

    #[test]
    fn rejects_package_identity_disagreement_duplicate_keys_and_trailing_json() {
        for key in ["name", "version", "desktopVersion", "productName"] {
            let mut fixtures = fixture();
            let file = get(&mut fixtures, PACKAGE);
            let mut value: serde_json::Value = serde_json::from_slice(&file.data).unwrap();
            value[key] = "wrong".into();
            file.data = serde_json::to_vec(&value).unwrap();
            rejected(&fixtures, "identity mismatch");
        }
        let mut fixtures = fixture();
        let file = get(&mut fixtures, PACKAGE);
        let mut text = String::from_utf8(file.data.clone()).unwrap();
        text.insert_str(1, "\"name\":\"gajae-app\",");
        file.data = text.into_bytes();
        rejected(&fixtures, "JSON metadata");
        let mut fixtures = fixture();
        get(&mut fixtures, PACKAGE).data.extend_from_slice(b"{}");
        rejected(&fixtures, "JSON metadata");
    }

    #[test]
    fn runtime_manifest_closure_requires_exact_existing_regular_file_hashes() {
        for mutation in 0..9 {
            let mut fixtures = fixture();
            let file = get(&mut fixtures, RUNTIME);
            let mut value: serde_json::Value = serde_json::from_slice(&file.data).unwrap();
            let record = &mut value["platforms"]["darwin-arm64"]["files"][0];
            match mutation {
                0 => record["sha256"] = "0".repeat(64).into(),
                1 => record["path"] = "../../escape".into(),
                2 => record["package"] = "../../escape".into(),
                3 => record["path"] = "native/missing.js".into(),
                4 => record["sha256"] = "A".repeat(64).into(),
                5 => {
                    let duplicate = record.clone();
                    value["platforms"]["darwin-arm64"]["files"]
                        .as_array_mut()
                        .unwrap()
                        .push(duplicate);
                }
                6 => value["schemaVersion"] = 2.into(),
                7 => value["platforms"]["darwin-arm64"]["files"] = serde_json::json!([]),
                _ => value["platforms"] = serde_json::json!({ "linux-x64": {} }),
            }
            file.data = serde_json::to_vec(&value).unwrap();
            assert!(inspect(&fixtures).is_err());
        }
        let mut fixtures = fixture();
        get(&mut fixtures, NATIVE).data.push(0);
        rejected(&fixtures, "hash/type mismatch");
    }

    #[test]
    fn rejects_macho_wrong_arch_type_load_command_floor_and_segment_bounds() {
        for (offset, value) in [
            (0, 0xcafe_babe),
            (4, 0x0100_0007),
            (8, 2),
            (12, 6),
            (16, 0),
            (16, 4097),
            (16, 2),
            (20, 119),
            (20, 65536),
            (36, 7),
            (36, 0),
            (36, 65528),
            (96, 100),
            (112, 2),
            (116, 14 << 16),
            (124, 1),
            (136, 256),
            (92, 1),
        ] {
            let mut fixtures = fixture();
            word(&mut get(&mut fixtures, EXECUTABLE).data, offset, value);
            assert!(inspect(&fixtures).is_err(), "accepted {offset}={value}");
        }
        let mut fixtures = fixture();
        wide(&mut get(&mut fixtures, EXECUTABLE).data, 80, u64::MAX);
        rejected(&fixtures, "segment outside");
        let mut fixtures = fixture();
        get(&mut fixtures, EXECUTABLE).data.truncate(31);
        rejected(&fixtures, "load commands");
        let mut fixtures = fixture();
        get(&mut fixtures, EXECUTABLE).mode = 0o644;
        rejected(&fixtures, "execute permission");
    }

    #[test]
    fn accepts_older_macho_floor_but_not_an_ambiguous_floor() {
        let mut fixtures = fixture();
        word(&mut get(&mut fixtures, EXECUTABLE).data, 116, 11 << 16);
        inspect(&fixtures).unwrap();
        let mut bytes = macho();
        word(&mut bytes, 16, 4);
        word(&mut bytes, 20, 136);
        word(&mut bytes, 152, 0x24);
        word(&mut bytes, 156, 16);
        word(&mut bytes, 160, 13 << 16);
        assert!(validate_macho(&bytes, 256, "13.0")
            .unwrap_err()
            .contains("Ambiguous"));
    }

    #[test]
    fn macho_code_signature_command_is_only_bounds_checked() {
        let mut bytes = macho();
        word(&mut bytes, 16, 4);
        word(&mut bytes, 20, 136);
        word(&mut bytes, 152, 0x1d);
        word(&mut bytes, 156, 16);
        word(&mut bytes, 160, 240);
        word(&mut bytes, 164, 16);
        validate_macho(&bytes, 256, "13.0").unwrap();
        word(&mut bytes, 164, 17);
        assert!(validate_macho(&bytes, 256, "13.0")
            .unwrap_err()
            .contains("signature data outside"));
    }

    #[test]
    fn rejects_truncated_or_multiple_xml_plist_roots() {
        let original = plist_bytes(&plist_value(), false);
        let text = std::str::from_utf8(&original).unwrap();
        for text in [
            text.replace("</plist>", ""),
            text.replace(
                "</plist>",
                "<dict><key>CFBundleName</key><string>Other</string></dict></plist>",
            ),
            format!("{text}<!-- hidden trailing data -->"),
            format!("{text}{text}"),
        ] {
            assert!(validate_plist(text.as_bytes(), &identity()).is_err());
        }
    }

    /// Optional, explicitly invoked compatibility check. Reads an EXISTING
    /// artifact only; no signing, download, filesystem extraction or execution.
    #[test]
    #[ignore = "requires GJC_ARCHIVE_FIXTURE and GJC_ARCHIVE_FIXTURE_IDENTITY"]
    fn existing_release_archive_read_only() {
        let path = std::env::var_os("GJC_ARCHIVE_FIXTURE").expect("existing archive path");
        let identity: ArchiveIdentity = serde_json::from_str(
            &std::env::var("GJC_ARCHIVE_FIXTURE_IDENTITY").expect("expected identity JSON"),
        )
        .unwrap();
        let file = std::fs::File::open(path).unwrap();
        assert!(file.metadata().unwrap().is_file());
        let mut bytes = Vec::new();
        file.take(MAX_COMPRESSED_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .unwrap();
        let inventory = inspect_archive(&bytes, &identity).unwrap();
        if let Some(path) = std::env::var_os("GJC_ARCHIVE_FIXTURE_INVENTORY") {
            let file = std::fs::File::open(path).unwrap();
            let mut bytes = Vec::new();
            file.take(MAX_INVENTORY_METADATA_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .unwrap();
            assert!(bytes.len() <= MAX_INVENTORY_METADATA_BYTES);
            let producer: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(producer["root"], inventory.root);
            assert_eq!(producer["totalFileBytes"], inventory.total_file_bytes);
            let expected_entries = producer["entries"].as_array().unwrap();
            assert_eq!(expected_entries.len(), inventory.entries.len());
            for (expected, actual) in expected_entries.iter().zip(&inventory.entries) {
                let mut value = serde_json::to_value(&actual.kind).unwrap();
                value["path"] = actual.path.clone().into();
                value["mode"] = actual.mode.into();
                assert_eq!(*expected, value, "producer/native inventory disagreement");
            }
            println!(
                "all {} producer inventory entries match bytes, modes and links",
                expected_entries.len()
            );
        }
        println!(
            "existing archive: compressed={} expanded={} entries={} sha256={} inventory_sha256={}",
            inventory.compressed_bytes,
            inventory.expanded_bytes,
            inventory.entries.len(),
            inventory.archive_sha256,
            inventory.inventory_sha256
        );
    }
}
