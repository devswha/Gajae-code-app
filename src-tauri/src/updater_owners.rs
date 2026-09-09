//! Read-only macOS packaged-owner evidence, never installation authority.
//!
//! Call under the native single-instance/startup gate and revalidate immediately
//! before the consuming action. Two bounded censuses detect observed changes;
//! libproc does NOT provide an atomic history or prevent unmanaged new starts.
//! A captured tree covers identities connected to the owned sidecar at capture,
//! not previously reparented processes or arbitrary escaped external daemons.
//! Only the compile-bound QA app can narrow packaged-owner vetoes to its whole
//! isolated QA root. Production and all other modes share the cross-installation
//! domain. This does not narrow PID enumeration or the captured tree. A foreign
//! executable may have path-bound exclusion evidence instead of BSD identity;
//! candidates/current/captured owners always require their full birth identity.
//! Unrelated PID/path churn and unclassified evidence still make either unknown.
//! Post-shutdown verification neither signals processes nor waits for idle.
//! The elapsed budget is checked around bounded operations; it cannot interrupt
//! an in-progress OS/filesystem call. Run off the UI thread. No successful proof
//! is returned after its budget, and no retry waits for the machine to go idle.
//!
//! ABI checked against the installed macOS SDK libproc.h/sys/proc_info.h and
//! Apple xnu libsyscall/wrappers/libproc/libproc.c + bsd/kern/proc_info.c:
//! proc_listpids returns BYTES (0 on wrapper failure); proc_pidinfo returns the
//! complete requested structure size; proc_pidpath returns strlen, excluding NUL.
//! Only ESRCH establishes a vanished PID. ENOENT/EPERM/zero/short reads do not.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    ffi::{CString, OsString},
    fs::File,
    io::{self, Cursor, Read, Seek, SeekFrom},
    mem::{size_of, MaybeUninit},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::{OsStrExt, OsStringExt},
            fs::MetadataExt,
        },
    },
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use sha2::{Digest, Sha256};

use crate::updater_binding::{Binding, Mode};

const MAX_PIDS: usize = 8192;
const MAX_TREE: usize = 512;
const MAX_BUNDLES: usize = 256;
const MAX_PATH: usize = 4096;
const MAX_PATH_TOTAL: usize = 8 * 1024 * 1024;
const MAX_PLIST: usize = 64 * 1024;
const BUDGET: Duration = Duration::from_secs(2);
// These selectors are not exported by libc 0.2.186. Values are from proc_info.h.
const PROC_UID_ONLY: u32 = 4;
const PROC_RUID_ONLY: u32 = 5;
const PROC_PPID_ONLY: u32 = 6;
// Apple xnu bsd/sys/codesign.h and osfmk/kern/cs_blobs.h. CS_OPS_STATUS is
// read-only; no mark/kill/entitlement operation is used. Not exported by libc.
const CS_OPS_STATUS: u32 = 0;
const CS_VALID: u32 = 0x0000_0001;
const CS_PLATFORM_BINARY: u32 = 0x0400_0000;
const CS_DEBUGGED: u32 = 0x1000_0000;
unsafe extern "C" {
    fn csops(pid: libc::pid_t, ops: u32, useraddr: *mut libc::c_void, usersize: usize) -> i32;
}
type Result<T> = std::result::Result<T, String>;

fn unknown(reason: &'static str) -> String {
    format!("Updater owner evidence is unknown: {reason}.")
}
fn require(value: bool, reason: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(unknown(reason))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Birth {
    seconds: u64,
    microseconds: u64,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity {
    pid: u32,
    parent: u32,
    uid: u32,
    real_uid: u32,
    birth: Birth,
    zombie: bool,
}
impl Identity {
    fn same_lifetime(&self, other: &Self) -> bool {
        self.pid == other.pid
            && self.uid == other.uid
            && self.real_uid == other.real_uid
            && self.birth == other.birth
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Process {
    identity: Identity,
    executable: PathBuf,
}
#[derive(Clone, PartialEq, Eq)]
struct Bundle {
    identifier: String,
    // Present only after validating OUR complete APPL/executable identity.
    // A foreign helper's identifier is enough; its other fields are not ours.
    executable: Option<String>,
    digest: [u8; 32],
}
#[derive(Clone, Copy)]
enum Selection {
    Effective(u32),
    Real(u32),
    Children(u32),
}
struct Listing {
    pids: Vec<u32>,
    complete: bool,
}

/// No public probe injection: only this module's tests can mint synthetic evidence.
trait Probe {
    fn current_pid(&self) -> u32;
    fn current_uid(&self) -> u32;
    fn list(&mut self, selection: Selection) -> Result<Listing>;
    fn identity(&mut self, pid: u32) -> Result<Option<Identity>>;
    fn executable(&mut self, pid: u32) -> Result<Option<PathBuf>>;
    fn bundle(&mut self, root: &Path) -> Result<Bundle>;
    fn code_status(&mut self, pid: u32) -> Result<u32>;
}

struct Product {
    identifier: &'static str,
    executable: &'static str,
    binding: Binding,
}
impl Product {
    fn compiled() -> Self {
        Self {
            identifier: env!("GJC_UPDATE_BUNDLE_IDENTIFIER"),
            executable: env!("CARGO_PKG_NAME"),
            binding: Binding::compiled(),
        }
    }
}

// No domain/Binding argument is exposed by a proof API. Production entrypoints
// construct Product::compiled; only private injectable tests can supply a binding.
enum OwnerDomain {
    Shared,
    QaRoot(PathBuf),
}
impl OwnerDomain {
    fn for_current_app(product: &Product, current_app: &Path) -> Result<Self> {
        if product.binding.mode != Mode::Qa {
            return Ok(Self::Shared);
        }
        let root = product
            .binding
            .qa_root
            .as_deref()
            .ok_or_else(|| unknown("compiled QA root missing"))?;
        valid_path(root)?;
        let name = format!("{}.app", env!("GJC_UPDATE_PRODUCT_NAME"));
        require(
            root.parent().is_some()
                && Path::new(&name).components().count() == 1
                && matches!(Path::new(&name).components().next(), Some(Component::Normal(_)))
                // Byte equality, not canonicalization or string-prefix matching:
                // a copy, alias spelling or JS path cannot select the QA domain.
                && current_app.as_os_str() == root.join(name).as_os_str(),
            "current application does not match compiled QA root",
        )?;
        Ok(Self::QaRoot(root.to_path_buf()))
    }

    fn includes(&self, process: &Process) -> bool {
        self.includes_path(&process.executable)
    }

    fn includes_path(&self, executable: &Path) -> bool {
        match self {
            Self::Shared => true,
            // Path component boundary includes every nested/renamed installation
            // and orphan within the root, never an adjacent prefix-lookalike root.
            Self::QaRoot(root) => executable.starts_with(root),
        }
    }
}

struct ScanScope<'a> {
    product: &'a Product,
    domain: OwnerDomain,
    // Never substitute foreign-path evidence for a required birth identity.
    required: BTreeSet<u32>,
}

#[derive(PartialEq, Eq)]
enum ForeignBasis {
    OutsideQaRoot,
    BundleIdentifiers,
    ApplePlatform(u32),
}
#[derive(PartialEq, Eq)]
struct ForeignProcess {
    executable: PathBuf,
    basis: ForeignBasis,
}

#[derive(PartialEq, Eq)]
struct Census {
    // Retain raw membership too: disappearing short-lived PIDs must not be
    // dropped into two falsely equal live-record snapshots under churn.
    listed: BTreeSet<u32>,
    processes: BTreeMap<u32, Process>,
    foreign: BTreeMap<u32, ForeignProcess>,
    bundles: BTreeMap<PathBuf, Bundle>,
}

/// Process-bound observation, not Clone/Serialize/Deserialize or browser input.
#[must_use]
pub(crate) struct OwnerAbsence {
    creator: Identity,
    current_app: PathBuf,
}

/// Captured, birth-bound owned sidecar tree. Never accepts a saved JSON PID list.
#[must_use]
pub(crate) struct ServerTree {
    creator: Identity,
    current_app: PathBuf,
    root: Identity,
    members: BTreeMap<u32, Process>,
}

pub(crate) fn prove_no_packaged_owners(current_app: &Path) -> Result<OwnerAbsence> {
    prove_absence(&mut Native, &Product::compiled(), current_app, None)
}

impl OwnerAbsence {
    pub(crate) fn revalidate(&self) -> Result<()> {
        prove_absence(
            &mut Native,
            &Product::compiled(),
            &self.current_app,
            Some(self.creator),
        )
        .map(|_| ())
    }
}

/// Both arguments are native supervisor values. The parent must be THIS process,
/// and the server must independently prove its live packaged-child identity.
pub(crate) fn capture_owned_server(server_pid: u32, parent_pid: u32) -> Result<ServerTree> {
    capture(&mut Native, &Product::compiled(), server_pid, parent_pid)
}

impl ServerTree {
    /// One fresh check. False means a captured birth identity is still present;
    /// incomplete/ambiguous enumeration is Err. No sleep, signal, kill or health I/O.
    pub(crate) fn all_gone(&self) -> Result<bool> {
        all_gone(&mut Native, &Product::compiled(), self)
    }

    /// Optional precommit freshness check; new/reparented descendants invalidate it.
    pub(crate) fn revalidate(&self) -> Result<()> {
        let fresh = capture(
            &mut Native,
            &Product::compiled(),
            self.root.pid,
            self.creator.pid,
        )?;
        require(
            fresh.creator.same_lifetime(&self.creator) && fresh.members == self.members,
            "captured server tree changed",
        )
    }
}

struct Deadline(Instant);
impl Deadline {
    fn new() -> Self {
        Self(Instant::now())
    }
    fn check(&self) -> Result<()> {
        require(self.0.elapsed() < BUDGET, "observation budget exceeded")
    }
}

fn validated_list(
    probe: &mut impl Probe,
    selection: Selection,
    deadline: &Deadline,
) -> Result<BTreeSet<u32>> {
    deadline.check()?;
    let listing = probe.list(selection)?;
    deadline.check()?;
    require(
        listing.complete && listing.pids.len() <= MAX_PIDS,
        "incomplete process enumeration",
    )?;
    let mut result = BTreeSet::new();
    for pid in listing.pids {
        require(
            pid > 0 && pid <= i32::MAX as u32 && result.insert(pid),
            "invalid or duplicate PID enumeration",
        )?;
    }
    Ok(result)
}

fn read_process(probe: &mut impl Probe, pid: u32, deadline: &Deadline) -> Result<Option<Process>> {
    deadline.check()?;
    let Some(before) = probe.identity(pid)? else {
        return Ok(None);
    };
    read_process_from_identity(probe, pid, before, deadline)
}

fn read_process_from_identity(
    probe: &mut impl Probe,
    pid: u32,
    before: Identity,
    deadline: &Deadline,
) -> Result<Option<Process>> {
    require(
        before.pid == pid && before.birth.seconds != 0 && before.birth.microseconds < 1_000_000,
        "invalid BSD process identity",
    )?;
    let Some(executable) = probe.executable(pid)? else {
        return match probe.identity(pid)? {
            None => Ok(None),
            Some(_) => Err(unknown("executable vanished without process disappearance")),
        };
    };
    valid_path(&executable)?;
    let Some(after) = probe.identity(pid)? else {
        return Ok(None);
    };
    require(
        before == after,
        "PID identity changed during executable read",
    )?;
    deadline.check()?;
    Ok(Some(Process {
        identity: before,
        executable,
    }))
}

fn app_roots(path: &Path) -> Vec<PathBuf> {
    let mut root = PathBuf::new();
    let mut roots = Vec::new();
    for component in path.components() {
        root.push(component.as_os_str());
        if component
            .as_os_str()
            .as_bytes()
            .to_ascii_lowercase()
            .ends_with(b".app")
        {
            roots.push(root.clone());
        }
    }
    roots
}

fn app_root(path: &Path) -> Option<PathBuf> {
    app_roots(path).pop()
}

fn valid_path(path: &Path) -> Result<()> {
    require(
        path.is_absolute()
            && path.as_os_str() == path.components().collect::<PathBuf>().as_os_str()
            && path.as_os_str().as_bytes().len() < MAX_PATH
            && path.components().count() <= 128
            && !path
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir)),
        "invalid executable or bundle path",
    )
}

fn read_bundles(
    probe: &mut impl Probe,
    executable: &Path,
    bundles: &mut BTreeMap<PathBuf, Bundle>,
    deadline: &Deadline,
) -> Result<()> {
    for root in app_roots(executable) {
        if !bundles.contains_key(&root) {
            require(bundles.len() < MAX_BUNDLES, "bundle identity count limit")?;
            deadline.check()?;
            bundles.insert(root.clone(), probe.bundle(&root)?);
        }
    }
    deadline.check()
}

fn system_executable_path(path: &Path) -> bool {
    [
        "/System/Library",
        "/usr/bin",
        "/usr/sbin",
        "/usr/libexec",
        "/bin",
        "/sbin",
    ]
    .iter()
    .any(|root| path.starts_with(root) && path != Path::new(root))
}

fn foreign_path_evidence(
    probe: &mut impl Probe,
    pid: u32,
    executable: &Path,
    scope: &ScanScope<'_>,
    bundles: &mut BTreeMap<PathBuf, Bundle>,
    deadline: &Deadline,
) -> Result<ForeignBasis> {
    require(
        !reserved_role(executable, scope.product),
        "candidate executable requires BSD birth identity",
    )?;
    if !scope.domain.includes_path(executable) {
        // Native compile-bound domain only. No out-of-scope Info.plist access
        // is necessary; the complete PID list and repeated native path remain.
        return Ok(ForeignBasis::OutsideQaRoot);
    }
    if system_executable_path(executable) {
        let flags = probe.code_status(pid)?;
        require(
            flags & (CS_VALID | CS_PLATFORM_BINARY) == (CS_VALID | CS_PLATFORM_BINARY)
                && flags & CS_DEBUGGED == 0,
            "system executable lacks valid platform code identity",
        )?;
        // A pathname/name alone is not enough. The running image must also have
        // kernel platform identity. This excludes its executable role, not any
        // arbitrary script/daemon it might own; captured descendants stay strict.
        return Ok(ForeignBasis::ApplePlatform(flags));
    }
    require(
        !app_roots(executable).is_empty(),
        "executable has no proven foreign identity",
    )?;
    read_bundles(probe, executable, bundles, deadline)?;
    require(
        !is_packaged_path(executable, bundles, scope.product)?,
        "product executable requires BSD birth identity",
    )?;
    Ok(ForeignBasis::BundleIdentifiers)
}

fn scan(probe: &mut impl Probe, scope: &ScanScope<'_>, deadline: &Deadline) -> Result<Census> {
    let uid = probe.current_uid();
    require(uid != 0, "elevated owner is unsupported")?;
    let mut pids = validated_list(probe, Selection::Effective(uid), deadline)?;
    pids.extend(validated_list(probe, Selection::Real(uid), deadline)?);
    require(
        pids.len() <= MAX_PIDS && pids.contains(&probe.current_pid()),
        "incomplete same-user census",
    )?;
    let mut census = Census {
        listed: pids.clone(),
        processes: BTreeMap::new(),
        foreign: BTreeMap::new(),
        bundles: BTreeMap::new(),
    };
    let mut path_bytes = 0usize;
    for pid in pids {
        deadline.check()?;
        // Path first permits positive foreign-role evidence for protected RUID
        // helpers. Neither an unreadable BSD record nor RUID membership itself
        // is an exclusion, and both unavailable always remain unknown.
        let Some(executable) = probe.executable(pid)? else {
            require(
                probe.identity(pid)?.is_none(),
                "path vanished without BSD disappearance",
            )?;
            continue;
        };
        valid_path(&executable)?;
        path_bytes = path_bytes
            .checked_add(executable.as_os_str().as_bytes().len())
            .ok_or_else(|| unknown("path byte limit"))?;
        require(path_bytes <= MAX_PATH_TOTAL, "path byte limit")?;
        let before = match probe.identity(pid) {
            Ok(Some(before)) => before,
            Ok(None) => continue, // ESRCH only, never an unreadable identity.
            Err(error) => {
                if pid == probe.current_pid() || scope.required.contains(&pid) {
                    return Err(error);
                }
                let basis = foreign_path_evidence(
                    probe,
                    pid,
                    &executable,
                    scope,
                    &mut census.bundles,
                    deadline,
                )?;
                let after = probe
                    .executable(pid)?
                    .ok_or_else(|| unknown("foreign executable vanished during exclusion proof"))?;
                valid_path(&after)?;
                require(
                    after.as_os_str() == executable.as_os_str(),
                    "foreign executable changed during exclusion proof",
                )?;
                census
                    .foreign
                    .insert(pid, ForeignProcess { executable, basis });
                continue;
            }
        };
        if let Some(process) = read_process_from_identity(probe, pid, before, deadline)? {
            require(
                process.executable == executable,
                "executable changed before BSD identity",
            )?;
            require(
                process.identity.uid == uid || process.identity.real_uid == uid,
                "UID changed during enumeration",
            )?;
            if scope.domain.includes(&process) {
                read_bundles(probe, &process.executable, &mut census.bundles, deadline)?;
            }
            census.processes.insert(pid, process);
        }
    }
    deadline.check()?;
    Ok(census)
}

fn stable_census(
    probe: &mut impl Probe,
    scope: &ScanScope<'_>,
    deadline: &Deadline,
) -> Result<Census> {
    let first = scan(probe, scope, deadline)?;
    let second = scan(probe, scope, deadline)?;
    require(first == second, "process or bundle census changed")?;
    Ok(second)
}

/// Tail guard after plist/tree work. This is a fixed additional sample, not a
/// retry-until-idle loop; newly observed processes/execs make the proof unknown.
fn revalidate_census(
    probe: &mut impl Probe,
    scope: &ScanScope<'_>,
    census: &Census,
    deadline: &Deadline,
) -> Result<()> {
    // Recheck positive foreign evidence too, not only birth-accounted processes.
    let fresh = scan(probe, scope, deadline)?;
    require(
        fresh == *census,
        "process, foreign evidence or bundle changed after census",
    )
}

fn creator(
    census: &Census,
    probe: &impl Probe,
    product: &Product,
    current_app: &Path,
) -> Result<Identity> {
    valid_path(current_app)?;
    let current = census
        .processes
        .get(&probe.current_pid())
        .ok_or_else(|| unknown("current process missing"))?;
    require(
        current.identity.uid == probe.current_uid()
            && current.identity.real_uid == probe.current_uid()
            && !current.identity.zombie,
        "current process ownership is ambiguous",
    )?;
    require(
        current.executable == current_app.join("Contents/MacOS").join(product.executable),
        "current process is not the native packaged app",
    )?;
    let bundle = census
        .bundles
        .get(current_app)
        .ok_or_else(|| unknown("current bundle identity missing"))?;
    require(
        bundle.identifier == product.identifier
            && bundle.executable.as_deref() == Some(product.executable),
        "current product bundle identity mismatch",
    )?;
    Ok(current.identity)
}

fn reserved_role(executable: &Path, product: &Product) -> bool {
    let basename = executable
        .file_name()
        .map(|value| value.as_bytes())
        .unwrap_or_default();
    let reserved_name = [
        product.executable.as_bytes(),
        b"gajae-app-server",
        b"gajae-core",
    ]
    .contains(&basename);
    let roots = app_roots(executable);
    reserved_name
        || roots.iter().any(|root| {
            [
                "Contents/Resources/server-payload",
                "Contents/Resources/resources/server-payload",
            ]
            .iter()
            .any(|base| {
                ["node/bin/node", "dist-native/bun", "dist-native/gajae-core"]
                    .iter()
                    .any(|role| executable == root.join(base).join(role))
            })
        })
}

fn is_packaged_path(
    executable: &Path,
    bundles: &BTreeMap<PathBuf, Bundle>,
    product: &Product,
) -> Result<bool> {
    let reserved = reserved_role(executable, product);
    let roots = app_roots(executable);
    if roots.is_empty() {
        // An unpackaged generic node/bun is outside this proof's scope. A
        // reserved product executable without bundle identity is ambiguous.
        require(!reserved, "reserved executable has no packaged identity")?;
        return Ok(false);
    }
    for root in &roots {
        let bundle = bundles
            .get(root)
            .ok_or_else(|| unknown("bundle identity missing"))?;
        if bundle.identifier == product.identifier {
            require(
                bundle.executable.as_deref() == Some(product.executable),
                "product bundle executable identity is ambiguous",
            )?;
            // Inspect every app ancestor: a copied installation can itself be
            // nested in a foreign bundle, and helpers can have their own plist.
            return Ok(true);
        }
    }
    require(
        !reserved,
        "reserved executable conflicts with foreign bundle identity",
    )?;
    Ok(false)
}

fn deny_other_packaged(
    census: &Census,
    product: &Product,
    domain: &OwnerDomain,
    current_pid: u32,
    allowed_tree: &BTreeMap<u32, Process>,
) -> Result<()> {
    for (&pid, process) in &census.processes {
        if pid == current_pid
            || allowed_tree.get(&pid) == Some(process)
            || !domain.includes(process)
        {
            continue;
        }
        if is_packaged_path(&process.executable, &census.bundles, product)? {
            return Err("A packaged Gajae owner is still present.".into());
        }
    }
    Ok(())
}

fn prove_absence(
    probe: &mut impl Probe,
    product: &Product,
    current_app: &Path,
    expected: Option<Identity>,
) -> Result<OwnerAbsence> {
    let deadline = Deadline::new();
    let scope = ScanScope {
        product,
        domain: OwnerDomain::for_current_app(product, current_app)?,
        required: BTreeSet::from([probe.current_pid()]),
    };
    let census = stable_census(probe, &scope, &deadline)?;
    let owner = creator(&census, probe, product, current_app)?;
    if let Some(expected) = expected {
        require(
            owner.same_lifetime(&expected),
            "proof used by a different process incarnation",
        )?;
    }
    deny_other_packaged(&census, product, &scope.domain, owner.pid, &BTreeMap::new())?;
    revalidate_census(probe, &scope, &census, &deadline)?;
    deadline.check()?;
    Ok(OwnerAbsence {
        creator: owner,
        current_app: current_app.to_path_buf(),
    })
}

fn is_server_path(path: &Path, app: &Path) -> bool {
    [
        "Contents/MacOS/gajae-app-server",
        "Contents/Resources/server-payload/node/bin/node",
        "Contents/Resources/resources/server-payload/node/bin/node",
    ]
    .iter()
    .any(|role| path == app.join(role))
}

fn tree(
    probe: &mut impl Probe,
    census: &Census,
    root: Identity,
    deadline: &Deadline,
) -> Result<BTreeMap<u32, Process>> {
    let mut members = BTreeMap::new();
    let mut queue = VecDeque::from([root.pid]);
    while let Some(pid) = queue.pop_front() {
        require(members.len() < MAX_TREE, "owned tree size limit")?;
        let node = census
            .processes
            .get(&pid)
            .ok_or_else(|| unknown("owned child missing from same-user census"))?;
        require(
            node.identity.uid == root.uid && node.identity.real_uid == root.uid,
            "owned child UID mismatch",
        )?;
        require(
            members.insert(pid, node.clone()).is_none(),
            "cyclic owned tree",
        )?;
        // PPID enumeration is not UID-filtered: a cross-UID child must fail,
        // not vanish silently from a same-UID-only traversal.
        let children = validated_list(probe, Selection::Children(pid), deadline)?;
        let expected: BTreeSet<_> = census
            .processes
            .values()
            .filter(|other| other.identity.parent == pid)
            .map(|other| other.identity.pid)
            .collect();
        require(
            children == expected,
            "child enumeration is incomplete or changed",
        )?;
        for child in children {
            let child_node = census
                .processes
                .get(&child)
                .ok_or_else(|| unknown("child identity missing"))?;
            require(
                child_node.identity.birth >= node.identity.birth,
                "parent PID incarnation does not own child",
            )?;
            queue.push_back(child);
        }
        let current = probe
            .identity(pid)?
            .ok_or_else(|| unknown("owned parent vanished during capture"))?;
        require(
            current == node.identity,
            "owned parent identity changed during capture",
        )?;
    }
    Ok(members)
}

fn capture(
    probe: &mut impl Probe,
    product: &Product,
    server_pid: u32,
    parent_pid: u32,
) -> Result<ServerTree> {
    require(
        parent_pid == probe.current_pid() && server_pid > 0 && server_pid != parent_pid,
        "untrusted server parent or PID",
    )?;
    let deadline = Deadline::new();
    let anchor = read_process(probe, parent_pid, &deadline)?
        .ok_or_else(|| unknown("native app identity unavailable"))?;
    let current_app =
        app_root(&anchor.executable).ok_or_else(|| unknown("native app location unavailable"))?;
    let scope = ScanScope {
        product,
        domain: OwnerDomain::for_current_app(product, &current_app)?,
        required: BTreeSet::from([parent_pid, server_pid]),
    };
    let first = scan(probe, &scope, &deadline)?;
    let owner = creator(&first, probe, product, &current_app)?;
    require(
        owner == anchor.identity,
        "native app identity changed before census",
    )?;
    let server = first
        .processes
        .get(&server_pid)
        .ok_or_else(|| unknown("owned server unavailable"))?;
    // Same predicates as updater_attempt::owned_server_identity, plus executable
    // role and parent-birth checks; no PID supplied by IPC can bypass ownership.
    require(
        server.identity.parent == owner.pid
            && server.identity.uid == owner.uid
            && server.identity.real_uid == owner.uid
            && !server.identity.zombie
            && server.identity.birth >= owner.birth
            && is_server_path(&server.executable, &current_app),
        "server is not our live packaged child",
    )?;
    let members = tree(probe, &first, server.identity, &deadline)?;
    let second = scan(probe, &scope, &deadline)?;
    require(
        first == second,
        "process or bundle census changed during capture",
    )?;
    require(
        tree(probe, &second, server.identity, &deadline)? == members,
        "owned tree changed during capture",
    )?;
    deny_other_packaged(&second, product, &scope.domain, owner.pid, &members)?;
    revalidate_census(probe, &scope, &second, &deadline)?;
    deadline.check()?;
    Ok(ServerTree {
        creator: owner,
        current_app,
        root: server.identity,
        members,
    })
}

fn all_gone(probe: &mut impl Probe, product: &Product, captured: &ServerTree) -> Result<bool> {
    let deadline = Deadline::new();
    let scope = ScanScope {
        product,
        domain: OwnerDomain::for_current_app(product, &captured.current_app)?,
        required: captured
            .members
            .keys()
            .copied()
            .chain([probe.current_pid()])
            .collect(),
    };
    let census = stable_census(probe, &scope, &deadline)?;
    let current = creator(&census, probe, product, &captured.current_app)?;
    require(
        current.same_lifetime(&captured.creator),
        "tree proof used by a different process incarnation",
    )?;
    let mut alive = false;
    for process in captured.members.values() {
        deadline.check()?;
        if let Some(now) = probe.identity(process.identity.pid)? {
            require(
                census
                    .processes
                    .get(&now.pid)
                    .is_some_and(|entry| entry.identity == now),
                "captured PID changed after census",
            )?;
            if now.birth == process.identity.birth {
                require(
                    now.uid == process.identity.uid && now.real_uid == process.identity.real_uid,
                    "captured identity changed UID",
                )?;
                alive = true; // Reparenting and zombies are NOT disappearance.
            }
            // Different birth proves the old identity is gone, not that the new
            // PID is harmless. The complete census below checks new packaged owners.
        }
    }
    revalidate_census(probe, &scope, &census, &deadline)?;
    if alive {
        return Ok(false);
    }
    deny_other_packaged(
        &census,
        product,
        &scope.domain,
        current.pid,
        &BTreeMap::new(),
    )?;
    deadline.check()?;
    Ok(true)
}

struct Native;
fn complete_bsd_read(count: i32, errno: Option<i32>) -> Result<bool> {
    if count == size_of::<libc::proc_bsdinfo>() as i32 {
        return Ok(true);
    }
    if count == 0 && errno == Some(libc::ESRCH) {
        return Ok(false);
    }
    // Report only the failure class, never the PID or other process details.
    // In particular, a protected same-UID process cannot become an absence.
    Err(unknown(if count != 0 {
        "BSD identity size was not exact"
    } else if matches!(errno, Some(libc::EPERM | libc::EACCES)) {
        "BSD identity permission denied"
    } else if errno.is_none() || errno == Some(0) {
        "BSD identity empty without ESRCH"
    } else {
        "BSD identity query failed without ESRCH"
    }))
}
impl Probe for Native {
    fn current_pid(&self) -> u32 {
        std::process::id()
    }
    fn current_uid(&self) -> u32 {
        unsafe { libc::geteuid() }
    }
    fn list(&mut self, selection: Selection) -> Result<Listing> {
        require(
            unsafe { libc::getuid() } == self.current_uid(),
            "set-UID observer is unsupported",
        )?;
        let (kind, value) = match selection {
            Selection::Effective(uid) => (PROC_UID_ONLY, uid),
            Selection::Real(uid) => (PROC_RUID_ONLY, uid),
            Selection::Children(pid) => (PROC_PPID_ONLY, pid),
        };
        let mut buffer = vec![0i32; MAX_PIDS + 1];
        let capacity = buffer.len() * size_of::<libc::pid_t>();
        unsafe {
            *libc::__error() = 0;
        }
        let bytes = unsafe {
            libc::proc_listpids(kind, value, buffer.as_mut_ptr().cast(), capacity as i32)
        };
        let errno = io::Error::last_os_error().raw_os_error().unwrap_or(0);
        require(
            bytes >= 0 && !(bytes == 0 && errno != 0),
            "process listing failed",
        )?;
        require(
            (bytes as usize) < capacity && bytes as usize % size_of::<libc::pid_t>() == 0,
            "truncated or malformed process listing",
        )?;
        buffer.truncate(bytes as usize / size_of::<libc::pid_t>());
        require(
            buffer.iter().all(|pid| *pid > 0),
            "invalid PID in process listing",
        )?;
        Ok(Listing {
            pids: buffer.into_iter().map(|pid| pid as u32).collect(),
            complete: true,
        })
    }
    fn identity(&mut self, pid: u32) -> Result<Option<Identity>> {
        require(pid > 0 && pid <= i32::MAX as u32, "invalid PID")?;
        let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
        unsafe {
            *libc::__error() = 0;
        }
        let count = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size_of::<libc::proc_bsdinfo>() as i32,
            )
        };
        if !complete_bsd_read(count, io::Error::last_os_error().raw_os_error())? {
            return Ok(None);
        }
        let info = unsafe { info.assume_init() };
        require(
            info.pbi_pid == pid && info.pbi_start_tvsec != 0 && info.pbi_start_tvusec < 1_000_000,
            "invalid BSD birth identity",
        )?;
        Ok(Some(Identity {
            pid,
            parent: info.pbi_ppid,
            uid: info.pbi_uid,
            real_uid: info.pbi_ruid,
            birth: Birth {
                seconds: info.pbi_start_tvsec,
                microseconds: info.pbi_start_tvusec,
            },
            zombie: info.pbi_status == libc::SZOMB,
        }))
    }
    fn executable(&mut self, pid: u32) -> Result<Option<PathBuf>> {
        let mut bytes = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        unsafe {
            *libc::__error() = 0;
        }
        let count = unsafe {
            libc::proc_pidpath(pid as i32, bytes.as_mut_ptr().cast(), bytes.len() as u32)
        };
        if count == 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        require(
            count > 0
                && (count as usize) < bytes.len() - 1
                && bytes[count as usize] == 0
                && !bytes[..count as usize].contains(&0),
            "executable path missing, denied or truncated",
        )?;
        bytes.truncate(count as usize);
        Ok(Some(PathBuf::from(OsString::from_vec(bytes))))
    }
    fn bundle(&mut self, root: &Path) -> Result<Bundle> {
        read_bundle(root)
    }

    fn code_status(&mut self, pid: u32) -> Result<u32> {
        require(
            pid > 0 && pid <= i32::MAX as u32,
            "invalid code identity PID",
        )?;
        let mut flags = 0u32;
        let status = unsafe {
            csops(
                pid as i32,
                CS_OPS_STATUS,
                (&mut flags as *mut u32).cast(),
                size_of::<u32>(),
            )
        };
        require(status == 0, "platform code identity unavailable")?;
        Ok(flags)
    }
}

#[derive(PartialEq, Eq)]
struct Stamp {
    device: u64,
    inode: u64,
    size: u64,
    mode: u32,
    uid: u32,
    modified: (i64, i64),
    changed: (i64, i64),
}
fn stamp(file: &File) -> Result<Stamp> {
    let value = file
        .metadata()
        .map_err(|_| unknown("bundle metadata unavailable"))?;
    Ok(Stamp {
        device: value.dev(),
        inode: value.ino(),
        size: value.len(),
        mode: value.mode(),
        uid: value.uid(),
        modified: (value.mtime(), value.mtime_nsec()),
        changed: (value.ctime(), value.ctime_nsec()),
    })
}
fn open_at(parent: &File, name: &std::ffi::OsStr, directory: bool) -> Result<File> {
    let name = CString::new(name.as_bytes()).map_err(|_| unknown("invalid bundle component"))?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(unknown("bundle component unavailable or aliased"));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn open_directory(path: &Path) -> Result<File> {
    valid_path(path)?;
    let mut directory = File::open("/").map_err(|_| unknown("filesystem root unavailable"))?;
    for part in path.components() {
        if let Component::Normal(name) = part {
            directory = open_at(&directory, name, true)?;
        }
    }
    Ok(directory)
}
fn read_bundle(root: &Path) -> Result<Bundle> {
    let app = open_directory(root)?;
    let mut filesystem = MaybeUninit::<libc::statfs>::uninit();
    require(
        unsafe { libc::fstatfs(app.as_raw_fd(), filesystem.as_mut_ptr()) } == 0,
        "bundle filesystem unavailable",
    )?;
    let filesystem = unsafe { filesystem.assume_init() };
    require(
        filesystem.f_flags & libc::MNT_LOCAL as u32 != 0,
        "nonlocal bundle filesystem is unsupported",
    )?;
    let app_before = stamp(&app)?;
    let contents = open_at(&app, std::ffi::OsStr::new("Contents"), true)?;
    let contents_before = stamp(&contents)?;
    let mut file = open_at(&contents, std::ffi::OsStr::new("Info.plist"), false)?;
    let before = stamp(&file)?;
    require(
        before.mode & u32::from(libc::S_IFMT) == u32::from(libc::S_IFREG)
            && before.size > 0
            && before.size <= MAX_PLIST as u64,
        "Info.plist is not a bounded regular file",
    )?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_PLIST as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unknown("Info.plist read failed"))?;
    require(
        bytes.len() == before.size as usize && bytes.len() <= MAX_PLIST && stamp(&file)? == before,
        "Info.plist changed while reading",
    )?;
    let bundle = parse_bundle(&bytes)?;
    require(
        stamp(&open_at(
            &contents,
            std::ffi::OsStr::new("Info.plist"),
            false,
        )?)? == before
            && stamp(&contents)? == contents_before
            && stamp(&open_at(&app, std::ffi::OsStr::new("Contents"), true)?)? == contents_before
            && stamp(&app)? == app_before
            && stamp(&open_directory(root)?)? == app_before,
        "bundle bindings changed while reading",
    )?;
    Ok(bundle)
}

// Mirrors updater_archive's bounded, duplicate-free visitor and strict XML
// footer check. Its public validate_installed_plist requires a known version;
// owner discovery must also recognize OTHER installed versions/copy names.
enum Metadata {
    Text(String),
    Map(BTreeMap<String, Metadata>),
    Other,
}
struct Budget {
    nodes: usize,
    bytes: usize,
}
struct Seed<'a> {
    depth: usize,
    budget: &'a mut Budget,
}
impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Metadata;
    fn deserialize<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Metadata, D::Error> {
        if self.depth > 32 || self.budget.nodes == 0 {
            return Err(de::Error::custom("metadata limit"));
        }
        self.budget.nodes -= 1;
        deserializer.deserialize_any(self)
    }
}
impl Seed<'_> {
    fn charge<E: de::Error>(&mut self, length: usize) -> std::result::Result<(), E> {
        self.budget.bytes = self
            .budget
            .bytes
            .checked_sub(length)
            .ok_or_else(|| E::custom("metadata limit"))?;
        Ok(())
    }
}
impl<'de> Visitor<'de> for Seed<'_> {
    type Value = Metadata;
    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("bounded bundle metadata")
    }
    fn visit_str<E: de::Error>(mut self, value: &str) -> std::result::Result<Metadata, E> {
        self.charge(value.len())?;
        Ok(Metadata::Text(value.to_owned()))
    }
    fn visit_string<E: de::Error>(mut self, value: String) -> std::result::Result<Metadata, E> {
        self.charge(value.len())?;
        Ok(Metadata::Text(value))
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> std::result::Result<Metadata, E> {
        Ok(Metadata::Other)
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> std::result::Result<Metadata, E> {
        Ok(Metadata::Other)
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> std::result::Result<Metadata, E> {
        Ok(Metadata::Other)
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> std::result::Result<Metadata, E> {
        Ok(Metadata::Other)
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Metadata, E> {
        Ok(Metadata::Other)
    }
    fn visit_bytes<E: de::Error>(mut self, value: &[u8]) -> std::result::Result<Metadata, E> {
        self.charge(value.len())?;
        Ok(Metadata::Other)
    }
    fn visit_byte_buf<E: de::Error>(self, value: Vec<u8>) -> std::result::Result<Metadata, E> {
        self.visit_bytes(&value)
    }
    fn visit_map<A: MapAccess<'de>>(
        mut self,
        mut map: A,
    ) -> std::result::Result<Metadata, A::Error> {
        let mut values = BTreeMap::new();
        while let Some(key) = map.next_key::<String>()? {
            self.charge(key.len())?;
            if values.contains_key(&key) {
                return Err(de::Error::custom("duplicate metadata"));
            }
            let value = map.next_value_seed(Seed {
                depth: self.depth + 1,
                budget: self.budget,
            })?;
            values.insert(key, value);
        }
        Ok(Metadata::Map(values))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Metadata, A::Error> {
        while seq
            .next_element_seed(Seed {
                depth: self.depth + 1,
                budget: self.budget,
            })?
            .is_some()
        {}
        Ok(Metadata::Other)
    }
}
struct Document(Metadata);
impl<'de> serde::Deserialize<'de> for Document {
    fn deserialize<D: de::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        Seed {
            depth: 0,
            budget: &mut Budget {
                nodes: 4096,
                bytes: 4 * MAX_PLIST,
            },
        }
        .deserialize(deserializer)
        .map(Self)
    }
}
struct ExactXml<'a, 'b>(&'a mut Cursor<&'b [u8]>);
impl Read for ExactXml<'_, '_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let length = buffer.len().min(1);
        self.0.read(&mut buffer[..length])
    }
}
impl Seek for ExactXml<'_, '_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.0.seek(position)
    }
}
fn parse_bundle(bytes: &[u8]) -> Result<Bundle> {
    require(
        !bytes.is_empty() && bytes.len() <= MAX_PLIST,
        "Info.plist size limit",
    )?;
    let document: Document = if bytes.starts_with(b"bplist00") {
        plist::from_reader(Cursor::new(bytes))
            .map_err(|_| unknown("invalid bounded binary plist"))?
    } else {
        let mut cursor = Cursor::new(bytes);
        let parsed = plist::from_reader(ExactXml(&mut cursor))
            .map_err(|_| unknown("invalid bounded XML plist"))?;
        require(
            bytes[cursor.position() as usize..].trim_ascii() == b"</plist>",
            "ambiguous plist footer",
        )?;
        parsed
    };
    let Metadata::Map(values) = document.0 else {
        return Err(unknown("plist root is not a dictionary"));
    };
    let text = |name: &str| -> Result<String> {
        let Some(Metadata::Text(value)) = values.get(name) else {
            return Err(unknown(match name {
                "CFBundleIdentifier" => "bundle identifier missing or mistyped",
                "CFBundleExecutable" => "bundle executable missing or mistyped",
                "CFBundlePackageType" => "bundle package type missing or mistyped",
                _ => "bundle identity field missing or mistyped",
            }));
        };
        require(
            !value.is_empty() && value.len() <= 255 && !value.chars().any(char::is_control),
            "invalid bundle identity string",
        )?;
        Ok(value.clone())
    };
    let identifier = text("CFBundleIdentifier")?;
    let product = Product::compiled();
    let executable = if identifier == product.identifier {
        let executable = text("CFBundleExecutable")?;
        require(
            text("CFBundlePackageType")? == "APPL"
                && executable == product.executable
                && Path::new(&executable).components().count() == 1
                && matches!(
                    Path::new(&executable).components().next(),
                    Some(Component::Normal(_))
                ),
            "invalid application role identity",
        )?;
        Some(executable)
    } else {
        // The entire document above must still be bounded, unique and valid;
        // the full digest below still participates in census stability. Do not
        // impose our application schema on unrelated helpers. is_packaged also
        // checks the actual executable path for conflicting reserved Gajae roles.
        None
    };
    Ok(Bundle {
        identifier,
        executable,
        digest: Sha256::digest(bytes).into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = "/Applications/Gajae Code App.app";
    fn product() -> Product {
        Product {
            identifier: "app.gajae.desktop",
            executable: "gajae-app-desktop",
            binding: Binding {
                mode: Mode::Production,
                feed_origin: String::new(),
                public_key: String::new(),
                qa_root: None,
            },
        }
    }
    fn process(pid: u32, parent: u32, seconds: u64, executable: &str) -> Process {
        Process {
            identity: Identity {
                pid,
                parent,
                uid: 501,
                real_uid: 501,
                birth: Birth {
                    seconds,
                    microseconds: 1,
                },
                zombie: false,
            },
            executable: executable.into(),
        }
    }
    fn bundle(identifier: &str, executable: &str) -> Bundle {
        Bundle {
            identifier: identifier.into(),
            executable: Some(executable.into()),
            digest: [0; 32],
        }
    }
    struct Fake {
        pid: u32,
        records: BTreeMap<u32, Process>,
        bundles: BTreeMap<PathBuf, Bundle>,
        partial: bool,
        denied: BTreeSet<u32>,
        paths_denied: BTreeSet<u32>,
        code_flags: BTreeMap<u32, u32>,
        path_reads: BTreeMap<u32, VecDeque<Option<PathBuf>>>,
        flag_reads: BTreeMap<u32, VecDeque<u32>>,
        phantom: Vec<u32>,
        extra_child: Option<(u32, u32)>,
        reads: BTreeMap<u32, VecDeque<Option<Identity>>>,
        listing_calls: usize,
        mutate_on_second: bool,
        mutate_on_tail: bool,
        gone_on_second: bool,
    }
    impl Fake {
        fn new() -> Self {
            Self {
                pid: 10,
                records: BTreeMap::from([(
                    10,
                    process(
                        10,
                        1,
                        100,
                        "/Applications/Gajae Code App.app/Contents/MacOS/gajae-app-desktop",
                    ),
                )]),
                bundles: BTreeMap::from([(
                    APP.into(),
                    bundle("app.gajae.desktop", "gajae-app-desktop"),
                )]),
                partial: false,
                denied: BTreeSet::new(),
                paths_denied: BTreeSet::new(),
                code_flags: BTreeMap::new(),
                path_reads: BTreeMap::new(),
                flag_reads: BTreeMap::new(),
                phantom: vec![],
                extra_child: None,
                reads: BTreeMap::new(),
                listing_calls: 0,
                mutate_on_second: false,
                mutate_on_tail: false,
                gone_on_second: false,
            }
        }
        fn with_tree() -> Self {
            let mut fake = Self::new();
            fake.records.insert(
                20,
                process(
                    20,
                    10,
                    110,
                    "/Applications/Gajae Code App.app/Contents/MacOS/gajae-app-server",
                ),
            );
            fake.records.insert(21, process(21, 20, 120, "/Applications/Gajae Code App.app/Contents/Resources/resources/server-payload/dist-native/bun"));
            fake.records.insert(22, process(22, 21, 130, "/bin/sh"));
            fake
        }
    }
    impl Probe for Fake {
        fn current_pid(&self) -> u32 {
            self.pid
        }
        fn current_uid(&self) -> u32 {
            501
        }
        fn list(&mut self, selection: Selection) -> Result<Listing> {
            self.listing_calls += 1;
            if self.gone_on_second && self.listing_calls == 3 {
                self.phantom.push(99);
            }
            if (self.mutate_on_second && self.listing_calls == 3)
                || (self.mutate_on_tail && self.listing_calls == 5)
            {
                self.records
                    .insert(30, process(30, 1, 140, "/usr/bin/true"));
            }
            let mut pids: Vec<_> = self
                .records
                .values()
                .filter(|process| match selection {
                    Selection::Effective(uid) => process.identity.uid == uid,
                    Selection::Real(uid) => process.identity.real_uid == uid,
                    Selection::Children(pid) => process.identity.parent == pid,
                })
                .map(|process| process.identity.pid)
                .collect();
            if let Selection::Children(pid) = selection {
                if let Some((owner, child)) = self.extra_child {
                    if owner == pid {
                        pids.push(child);
                    }
                }
            } else {
                pids.extend(&self.phantom);
            }
            Ok(Listing {
                pids,
                complete: !self.partial,
            })
        }
        fn identity(&mut self, pid: u32) -> Result<Option<Identity>> {
            if self.denied.contains(&pid) {
                return Err(unknown("permission denied"));
            }
            if let Some(queue) = self.reads.get_mut(&pid) {
                if let Some(next) = queue.pop_front() {
                    return Ok(next);
                }
            }
            Ok(self.records.get(&pid).map(|process| process.identity))
        }
        fn executable(&mut self, pid: u32) -> Result<Option<PathBuf>> {
            if self.paths_denied.contains(&pid) {
                return Err(unknown("executable permission denied"));
            }
            if let Some(queue) = self.path_reads.get_mut(&pid) {
                if let Some(path) = queue.pop_front() {
                    return Ok(path);
                }
            }
            Ok(self
                .records
                .get(&pid)
                .map(|process| process.executable.clone()))
        }
        fn bundle(&mut self, root: &Path) -> Result<Bundle> {
            self.bundles
                .get(root)
                .cloned()
                .ok_or_else(|| unknown("Info.plist unavailable"))
        }
        fn code_status(&mut self, pid: u32) -> Result<u32> {
            if let Some(queue) = self.flag_reads.get_mut(&pid) {
                if let Some(flags) = queue.pop_front() {
                    return Ok(flags);
                }
            }
            self.code_flags
                .get(&pid)
                .copied()
                .ok_or_else(|| unknown("code identity denied"))
        }
    }

    #[test]
    fn only_current_native_app_pid_is_excluded_and_another_copy_blocks() {
        let mut fake = Fake::new();
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_ok());
        fake.records.insert(
            11,
            process(
                11,
                1,
                200,
                "/Volumes/Other/Copy.app/Contents/MacOS/gajae-app-desktop",
            ),
        );
        fake.bundles.insert(
            "/Volumes/Other/Copy.app".into(),
            bundle("app.gajae.desktop", "gajae-app-desktop"),
        );
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
    }

    const QA_ROOT: &str = "/private/tmp/gjc-updater-owner-qa-fixture";
    fn qa_app() -> PathBuf {
        Path::new(QA_ROOT).join(format!("{}.app", env!("GJC_UPDATE_PRODUCT_NAME")))
    }
    fn qa_product() -> Product {
        let mut product = product();
        product.binding.mode = Mode::Qa;
        product.binding.qa_root = Some(QA_ROOT.into());
        product
    }
    fn qa_fixture(mut fake: Fake) -> Fake {
        for process in fake.records.values_mut() {
            if let Ok(role) = process.executable.strip_prefix(APP) {
                process.executable = qa_app().join(role);
            }
        }
        let identity = fake.bundles.remove(Path::new(APP)).unwrap();
        fake.bundles.insert(qa_app(), identity.clone());
        // The user's independent production app stays live throughout every
        // synthetic QA scenario. No test has to stop it to manufacture absence.
        fake.records.insert(
            90,
            process(
                90,
                1,
                80,
                &format!("{APP}/Contents/MacOS/gajae-app-desktop"),
            ),
        );
        fake.bundles.insert(APP.into(), identity);
        fake
    }

    #[test]
    fn qa_domain_excludes_production_but_includes_other_copies_and_orphans_in_its_root() {
        let mut fake = qa_fixture(Fake::new());
        assert!(prove_absence(&mut fake, &qa_product(), &qa_app(), None).is_ok());
        for role in [
            "Contents/MacOS/gajae-app-desktop",
            "Contents/MacOS/gajae-app-server",
            "Contents/Resources/server-payload/node/bin/node",
            "Contents/Resources/resources/server-payload/dist-native/bun",
            "Contents/Resources/resources/server-payload/dist-native/gajae-core",
        ] {
            let mut fake = qa_fixture(Fake::new());
            let copy = format!("{QA_ROOT}/old/nested/Renamed Copy.app");
            fake.records
                .insert(30, process(30, 1, 200, &format!("{copy}/{role}")));
            fake.bundles.insert(
                copy.into(),
                bundle(product().identifier, product().executable),
            );
            assert_eq!(
                prove_absence(&mut fake, &qa_product(), &qa_app(), None).err(),
                Some("A packaged Gajae owner is still present.".into()),
            );
        }
    }

    #[test]
    fn qa_domain_requires_exact_compiled_app_and_other_modes_keep_shared_scope() {
        let product = qa_product();
        for wrong in [
            PathBuf::from(APP),
            Path::new(QA_ROOT).join("Other.app"),
            Path::new(QA_ROOT)
                .join("nested")
                .join(qa_app().file_name().unwrap()),
            PathBuf::from(format!(
                "{QA_ROOT}/./{}",
                qa_app().file_name().unwrap().to_str().unwrap()
            )),
            PathBuf::from(format!(
                "{QA_ROOT}-other/{}",
                qa_app().file_name().unwrap().to_str().unwrap()
            )),
        ] {
            assert!(OwnerDomain::for_current_app(&product, &wrong).is_err());
        }
        let domain = OwnerDomain::for_current_app(&product, &qa_app()).unwrap();
        assert!(!domain.includes(&process(
            90,
            1,
            80,
            &format!("{QA_ROOT}-other/Copy.app/Contents/MacOS/gajae-app-desktop")
        )));
        let mut unbound = qa_product();
        unbound.binding.qa_root = None;
        assert!(OwnerDomain::for_current_app(&unbound, &qa_app()).is_err());
        for mode in [Mode::Production, Mode::Disabled] {
            // Even a matching root field does not grant QA isolation in another mode.
            let mut product = qa_product();
            product.binding.mode = mode;
            let mut fake = qa_fixture(Fake::new());
            assert_eq!(
                prove_absence(&mut fake, &product, &qa_app(), None).err(),
                Some("A packaged Gajae owner is still present.".into()),
            );
        }
    }

    #[test]
    fn qa_tree_joins_outside_root_descendants_without_requiring_production_shutdown() {
        let mut fake = qa_fixture(Fake::with_tree());
        let captured = capture(&mut fake, &qa_product(), 20, 10).unwrap();
        assert_eq!(captured.members.len(), 3);
        assert!(!captured.members.contains_key(&90));
        assert!(!all_gone(&mut fake, &qa_product(), &captured).unwrap());
        fake.records.remove(&20);
        fake.records.remove(&21);
        fake.records.get_mut(&22).unwrap().identity.parent = 1;
        // /bin/sh is outside the QA root but its captured birth is still owned.
        assert!(!all_gone(&mut fake, &qa_product(), &captured).unwrap());
        fake.records.remove(&22);
        assert!(all_gone(&mut fake, &qa_product(), &captured).unwrap());
        assert!(fake.records.contains_key(&90));
        let copy = format!("{QA_ROOT}/old/Copy.app");
        fake.records.insert(
            30,
            process(
                30,
                1,
                200,
                &format!("{copy}/Contents/Resources/server-payload/dist-native/bun"),
            ),
        );
        fake.bundles.insert(
            copy.into(),
            bundle(product().identifier, product().executable),
        );
        assert!(all_gone(&mut fake, &qa_product(), &captured).is_err());
    }

    #[test]
    fn qa_scope_preserves_ambiguous_candidates_and_complete_foreign_census() {
        let copy = format!("{QA_ROOT}/Old.app");
        for foreign_identity in [false, true] {
            let mut fake = qa_fixture(Fake::new());
            fake.records.insert(
                30,
                process(
                    30,
                    1,
                    200,
                    &format!("{copy}/Contents/MacOS/gajae-app-server"),
                ),
            );
            if foreign_identity {
                fake.bundles
                    .insert(copy.clone().into(), bundle("org.other", "other"));
            } // Otherwise missing Info.plist for the in-scope orphan is unknown.
            assert!(prove_absence(&mut fake, &qa_product(), &qa_app(), None).is_err());
        }
        for case in 0..4 {
            let mut fake = qa_fixture(Fake::new());
            match case {
                0 => fake.partial = true,
                1 => {
                    fake.denied.insert(90);
                }
                2 => fake.mutate_on_second = true,
                _ => {
                    let before = fake.records[&90].identity;
                    let mut after = before;
                    after.birth.microseconds += 1;
                    fake.reads
                        .insert(90, VecDeque::from([Some(before), Some(after)]));
                }
            }
            assert!(prove_absence(&mut fake, &qa_product(), &qa_app(), None).is_err());
        }
    }

    fn denied_platform_helper() -> Fake {
        let mut fake = Fake::new();
        let mut helper = process(30, 1, 200, "/usr/bin/helper-fixture");
        helper.identity.uid = 0; // RUID-only, like the actual protected helper.
        fake.records.insert(30, helper);
        fake.denied.insert(30);
        fake.code_flags.insert(30, CS_VALID | CS_PLATFORM_BINARY);
        fake
    }

    #[test]
    fn ruid_only_bsd_denied_requires_stable_positive_platform_evidence() {
        let mut fake = denied_platform_helper();
        let product = product();
        let scope = ScanScope {
            product: &product,
            domain: OwnerDomain::Shared,
            required: BTreeSet::from([10]),
        };
        let census = stable_census(&mut fake, &scope, &Deadline::new()).unwrap();
        assert!(census.listed.contains(&30)); // Never drop RUID-only membership.
        assert!(!census.processes.contains_key(&30)); // No invented birth identity.
        assert!(matches!(
            census.foreign[&30].basis,
            ForeignBasis::ApplePlatform(_)
        ));
        revalidate_census(&mut fake, &scope, &census, &Deadline::new()).unwrap();
        assert!(prove_absence(&mut fake, &product, Path::new(APP), None).is_ok());

        for case in 0..6 {
            let mut fake = denied_platform_helper();
            match case {
                0 => {
                    fake.code_flags.clear();
                } // Code-signing query denied.
                1 => {
                    fake.code_flags.insert(30, CS_VALID);
                } // Name/path is not proof.
                2 => {
                    fake.code_flags.insert(30, CS_PLATFORM_BINARY);
                }
                3 => {
                    fake.code_flags
                        .insert(30, CS_VALID | CS_PLATFORM_BINARY | CS_DEBUGGED);
                }
                4 => {
                    fake.paths_denied.insert(30);
                } // Both unavailable is unknown.
                _ => {
                    fake.partial = true;
                }
            }
            assert!(prove_absence(&mut fake, &product, Path::new(APP), None).is_err());
        }
    }

    #[test]
    fn foreign_path_or_platform_evidence_changes_in_any_sample_fail_closed() {
        let path = PathBuf::from("/usr/bin/helper-fixture");
        let other = PathBuf::from("/usr/bin/different-helper-fixture");
        for change_at in [1, 2, 4] {
            // Within first read, second census, and tail census.
            let mut fake = denied_platform_helper();
            let mut reads = VecDeque::from(vec![Some(path.clone()); 6]);
            reads[change_at] = Some(other.clone());
            fake.path_reads.insert(30, reads);
            assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
        }
        for flags in [0, CS_VALID | CS_PLATFORM_BINARY | 0x10] {
            let mut fake = denied_platform_helper();
            fake.flag_reads
                .insert(30, VecDeque::from([CS_VALID | CS_PLATFORM_BINARY, flags]));
            assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
        }
        let mut fake = denied_platform_helper();
        fake.path_reads
            .insert(30, VecDeque::from([Some(path), None]));
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
        let mut fake = denied_platform_helper();
        fake.path_reads.insert(
            30,
            VecDeque::from([
                Some("/usr/bin/helper-fixture".into()),
                Some("/usr/bin/./helper-fixture".into()),
            ]),
        );
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
    }

    #[test]
    fn denied_foreign_bundle_needs_all_ancestor_ids_and_no_reserved_role() {
        let mut fake = Fake::new();
        fake.records.insert(
            30,
            process(30, 1, 200, "/Applications/Other.app/Contents/MacOS/helper"),
        );
        fake.denied.insert(30);
        let xml = String::from_utf8(plist_xml("org.other.helper"))
            .unwrap()
            .replace("<key>CFBundlePackageType</key><string>APPL</string>", "");
        fake.bundles.insert(
            "/Applications/Other.app".into(),
            parse_bundle(xml.as_bytes()).unwrap(),
        );
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_ok());
        fake.bundles.clear();
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
        fake.bundles.insert(
            "/Applications/Other.app".into(),
            bundle(product().identifier, product().executable),
        );
        // Even a non-reserved helper name is a candidate under our identifier.
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
    }

    #[test]
    fn denied_candidate_or_suspicious_path_never_uses_foreign_fallback() {
        for path in [
            "/Applications/Other.app/Contents/MacOS/gajae-app-desktop",
            "/Applications/Other.app/Contents/MacOS/gajae-app-server",
            "/Applications/Other.app/Contents/Resources/server-payload/node/bin/node",
            "/Applications/Other.app/Contents/Resources/resources/server-payload/dist-native/bun",
            "/usr/bin/gajae-core",
            "/usr/bin-lookalike/helper-fixture",
            "/private/tmp/helper-fixture",
            "/usr/bin/./helper-fixture",
            "/usr/bin/../bin/helper-fixture",
            "/usr//bin/helper-fixture",
        ] {
            let mut fake = denied_platform_helper();
            fake.records.get_mut(&30).unwrap().executable = path.into();
            fake.bundles.insert(
                "/Applications/Other.app".into(),
                bundle("org.other", "helper"),
            );
            assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
        }
    }

    #[test]
    fn current_and_captured_descendants_require_birth_even_with_platform_paths() {
        let mut fake = Fake::with_tree();
        fake.code_flags.insert(22, CS_VALID | CS_PLATFORM_BINARY);
        let captured = capture(&mut fake, &product(), 20, 10).unwrap();
        fake.denied.insert(22);
        // The /bin/sh child cannot disappear from a PPID census via exclusion.
        assert!(capture(&mut fake, &product(), 20, 10).is_err());
        assert!(all_gone(&mut fake, &product(), &captured).is_err());
        fake.denied.remove(&22);
        fake.records.get_mut(&10).unwrap().executable = "/usr/bin/helper-fixture".into();
        fake.denied.insert(10);
        fake.code_flags.insert(10, CS_VALID | CS_PLATFORM_BINARY);
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
    }

    #[test]
    fn qa_outside_paths_do_not_require_foreign_metadata_but_in_scope_paths_do() {
        let mut fake = qa_fixture(Fake::new());
        fake.bundles.remove(Path::new(APP)); // Production Info.plist is not touched in QA.
        fake.records.insert(
            30,
            process(
                30,
                1,
                200,
                "/Applications/Unknown.app/Contents/MacOS/helper",
            ),
        );
        fake.denied.insert(30);
        assert!(prove_absence(&mut fake, &qa_product(), &qa_app(), None).is_ok());
        fake.records.get_mut(&30).unwrap().executable =
            format!("{QA_ROOT}/Unknown.app/Contents/MacOS/helper").into();
        assert!(prove_absence(&mut fake, &qa_product(), &qa_app(), None).is_err());
        fake.paths_denied.insert(30);
        assert!(prove_absence(&mut fake, &qa_product(), &qa_app(), None).is_err());
    }

    #[test]
    fn packaged_server_bun_and_core_block_even_without_a_desktop_parent() {
        for path in [
            "/Volumes/Copy.app/Contents/MacOS/gajae-app-server",
            "/Volumes/Copy.app/Contents/Resources/server-payload/node/bin/node",
            "/Volumes/Copy.app/Contents/Resources/resources/server-payload/dist-native/bun",
            "/Volumes/Copy.app/Contents/Resources/resources/server-payload/dist-native/gajae-core",
        ] {
            let mut fake = Fake::new();
            fake.records.insert(20, process(20, 1, 200, path));
            fake.bundles.insert(
                "/Volumes/Copy.app".into(),
                bundle("app.gajae.desktop", "gajae-app-desktop"),
            );
            assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
        }
    }

    #[test]
    fn unrelated_bun_and_foreign_bundles_are_not_product_owners_but_conflicts_are_unknown() {
        let mut fake = Fake::new();
        fake.records
            .insert(20, process(20, 1, 200, "/opt/homebrew/bin/bun"));
        fake.records.insert(
            21,
            process(21, 1, 200, "/Applications/Other.app/Contents/MacOS/bun"),
        );
        fake.bundles.insert(
            "/Applications/Other.app".into(),
            bundle("org.other.app", "bun"),
        );
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_ok());
        fake.records.get_mut(&21).unwrap().executable =
            "/Applications/Other.app/Contents/MacOS/gajae-app-server".into();
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
    }

    #[test]
    fn partial_listing_missing_plist_and_permissions_never_prove_absence() {
        let mut partial = Fake::new();
        partial.partial = true;
        assert!(prove_absence(&mut partial, &product(), Path::new(APP), None).is_err());
        for path_error in [false, true] {
            let mut fake = Fake::new();
            fake.records
                .insert(20, process(20, 1, 200, "/usr/bin/true"));
            if path_error {
                fake.paths_denied.insert(20);
            } else {
                fake.denied.insert(20);
            }
            assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
        }
        let mut fake = Fake::new();
        fake.bundles.clear();
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
        let mut foreign = Fake::new();
        foreign.records.insert(
            20,
            process(20, 1, 200, "/Applications/Unknown.app/Contents/MacOS/other"),
        );
        assert!(prove_absence(&mut foreign, &product(), Path::new(APP), None).is_err());
    }

    #[test]
    fn over_limit_or_duplicate_pid_lists_are_not_deduplicated_into_complete_evidence() {
        let mut fake = Fake::new();
        fake.phantom = (100..100 + MAX_PIDS as u32).collect();
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
        let mut duplicate = Fake::new();
        duplicate.phantom.push(10);
        assert!(prove_absence(&mut duplicate, &product(), Path::new(APP), None).is_err());
    }

    #[test]
    fn missing_pid_requires_esrch_and_short_bsd_reads_are_unknown() {
        assert!(!complete_bsd_read(0, Some(libc::ESRCH)).unwrap());
        for errno in [
            None,
            Some(0),
            Some(libc::EPERM),
            Some(libc::EACCES),
            Some(libc::ENOENT),
            Some(libc::EINVAL),
        ] {
            assert!(complete_bsd_read(0, errno).is_err());
        }
        assert!(complete_bsd_read(1, Some(libc::ESRCH)).is_err());
        assert!(complete_bsd_read(size_of::<libc::proc_bsdinfo>() as i32, None).unwrap());
        let mut fake = Fake::new();
        fake.phantom.push(99); // Probe None represents ESRCH only.
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_ok());
    }

    #[test]
    fn pid_reuse_between_bsd_and_executable_reads_is_unknown() {
        let mut fake = Fake::new();
        let before = fake.records[&10].identity;
        let mut after = before;
        after.birth.microseconds += 1;
        fake.reads
            .insert(10, VecDeque::from([Some(before), Some(after)]));
        assert!(read_process(&mut fake, 10, &Deadline::new()).is_err());
    }

    #[test]
    fn changing_membership_or_invalid_path_invalidates_census() {
        let mut fake = Fake::new();
        fake.mutate_on_second = true;
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
        let mut tail = Fake::new();
        tail.mutate_on_tail = true;
        assert!(prove_absence(&mut tail, &product(), Path::new(APP), None).is_err());
        let mut gone = Fake::new();
        gone.gone_on_second = true;
        assert!(prove_absence(&mut gone, &product(), Path::new(APP), None).is_err());
        for path in ["relative/bun", "/Applications/../Other.app/x"] {
            let mut fake = Fake::new();
            fake.records.insert(20, process(20, 1, 200, path));
            assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
        }
    }

    #[test]
    fn nested_installation_copy_is_detected_even_when_only_bun_remains() {
        let mut fake = Fake::new();
        fake.records.insert(20, process(20, 1, 200,
            "/Applications/Foreign.app/Contents/Resources/Copy.app/Contents/Resources/resources/server-payload/dist-native/bun"));
        fake.bundles.insert(
            "/Applications/Foreign.app".into(),
            bundle("org.foreign", "Foreign"),
        );
        fake.bundles.insert(
            "/Applications/Foreign.app/Contents/Resources/Copy.app".into(),
            bundle("app.gajae.desktop", "gajae-app-desktop"),
        );
        assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_err());
    }

    #[test]
    fn captured_tree_includes_nonpackaged_children_and_reparenting_is_not_gone() {
        let mut fake = Fake::with_tree();
        let captured = capture(&mut fake, &product(), 20, 10).unwrap();
        assert_eq!(captured.members.len(), 3);
        fake.records.remove(&20);
        fake.records.remove(&21);
        fake.records.get_mut(&22).unwrap().identity.parent = 1;
        assert!(!all_gone(&mut fake, &product(), &captured).unwrap());
        fake.records.remove(&22);
        assert!(all_gone(&mut fake, &product(), &captured).unwrap());
    }

    #[test]
    fn server_capture_rejects_arbitrary_parent_pid_role_uid_and_birth() {
        for case in 0..6 {
            let mut fake = Fake::with_tree();
            match case {
                0 => assert!(capture(&mut fake, &product(), 20, 999).is_err()),
                1 => {
                    fake.records.get_mut(&20).unwrap().identity.parent = 1;
                    assert!(capture(&mut fake, &product(), 20, 10).is_err());
                }
                2 => {
                    fake.records.get_mut(&20).unwrap().identity.uid = 0;
                    assert!(capture(&mut fake, &product(), 20, 10).is_err());
                }
                3 => {
                    fake.records.get_mut(&20).unwrap().identity.birth.seconds = 99;
                    assert!(capture(&mut fake, &product(), 20, 10).is_err());
                }
                4 => {
                    fake.records.get_mut(&20).unwrap().identity.zombie = true;
                    assert!(capture(&mut fake, &product(), 20, 10).is_err());
                }
                _ => {
                    fake.records.get_mut(&20).unwrap().executable = "/usr/bin/node".into();
                    assert!(capture(&mut fake, &product(), 20, 10).is_err());
                }
            }
        }
    }

    #[test]
    fn incomplete_or_cross_uid_child_enumeration_fails_capture() {
        let mut fake = Fake::with_tree();
        fake.extra_child = Some((21, 99));
        assert!(capture(&mut fake, &product(), 20, 10).is_err());
        let mut fake = Fake::with_tree();
        fake.records.get_mut(&22).unwrap().identity.uid = 0;
        assert!(capture(&mut fake, &product(), 20, 10).is_err());
    }

    #[test]
    fn reused_pid_is_not_old_process_but_new_packaged_owner_still_blocks() {
        let mut fake = Fake::with_tree();
        let captured = capture(&mut fake, &product(), 20, 10).unwrap();
        fake.records.remove(&21);
        fake.records.remove(&22);
        fake.records
            .insert(20, process(20, 1, 300, "/usr/bin/true"));
        assert!(all_gone(&mut fake, &product(), &captured).unwrap());
        fake.records.get_mut(&20).unwrap().executable =
            "/Applications/Gajae Code App.app/Contents/MacOS/gajae-app-server".into();
        assert!(all_gone(&mut fake, &product(), &captured).is_err());
    }

    #[test]
    fn permission_partial_listing_and_observer_reuse_block_post_shutdown_proof() {
        let mut fake = Fake::with_tree();
        let captured = capture(&mut fake, &product(), 20, 10).unwrap();
        fake.records.remove(&20);
        fake.records.remove(&21);
        fake.records.remove(&22);
        fake.denied.insert(22);
        assert!(all_gone(&mut fake, &product(), &captured).is_err());
        fake.denied.clear();
        fake.partial = true;
        assert!(all_gone(&mut fake, &product(), &captured).is_err());
        fake.partial = false;
        fake.records
            .get_mut(&10)
            .unwrap()
            .identity
            .birth
            .microseconds += 1;
        assert!(all_gone(&mut fake, &product(), &captured).is_err());
    }

    fn plist_xml(identifier: &str) -> Vec<u8> {
        format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{identifier}</string><key>CFBundleExecutable</key><string>gajae-app-desktop</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.1.0</string></dict></plist>").into_bytes()
    }

    #[test]
    fn foreign_identifier_without_application_fields_is_excluded() {
        // Helper bundles need not be applications. Only their unique bounded
        // identifier discriminates them; their executable/type schema is not ours.
        for fields in [
            "<key>CFBundleExecutable</key><string>helper</string>",
            "",
            "<key>CFBundlePackageType</key><string>BNDL</string>",
            "<key>CFBundleExecutable</key><false/><key>CFBundlePackageType</key><integer>0</integer>",
        ] {
            let xml = format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>org.other.helper</string>{fields}</dict></plist>");
            let parsed = parse_bundle(xml.as_bytes()).unwrap();
            let mut fake = Fake::new();
            fake.records.insert(
                20,
                process(20, 1, 200, "/Applications/Other.app/Contents/MacOS/helper"),
            );
            fake.bundles
                .insert("/Applications/Other.app".into(), parsed);
            assert!(prove_absence(&mut fake, &product(), Path::new(APP), None).is_ok());
        }
    }

    #[test]
    fn our_identifier_requires_full_exact_application_identity() {
        let xml = String::from_utf8(plist_xml(product().identifier)).unwrap();
        for invalid in [
            xml.replace("<key>CFBundlePackageType</key><string>APPL</string>", ""),
            xml.replace("<string>APPL</string>", "<string>BNDL</string>"),
            xml.replace("<string>APPL</string>", "<false/>"),
            xml.replace(
                "<key>CFBundleExecutable</key><string>gajae-app-desktop</string>",
                "",
            ),
            xml.replace(
                "<string>gajae-app-desktop</string>",
                "<string>other</string>",
            ),
            xml.replace(
                "<string>gajae-app-desktop</string>",
                "<string>./gajae-app-desktop</string>",
            ),
        ] {
            assert!(parse_bundle(invalid.as_bytes()).is_err());
        }
    }

    #[test]
    fn foreign_identifier_cannot_hide_reserved_product_roles_or_current_app() {
        let xml = String::from_utf8(plist_xml("org.other.helper"))
            .unwrap()
            .replace("<key>CFBundlePackageType</key><string>APPL</string>", "");
        let foreign = parse_bundle(xml.as_bytes()).unwrap();
        for role in [
            "Contents/MacOS/gajae-app-desktop",
            "Contents/MacOS/gajae-app-server",
            "Contents/MacOS/gajae-core",
            "Contents/Resources/server-payload/node/bin/node",
            "Contents/Resources/server-payload/dist-native/bun",
            "Contents/Resources/resources/server-payload/node/bin/node",
            "Contents/Resources/resources/server-payload/dist-native/bun",
        ] {
            let mut fake = Fake::new();
            fake.records.insert(
                20,
                process(20, 1, 200, &format!("/Applications/Other.app/{role}")),
            );
            fake.bundles
                .insert("/Applications/Other.app".into(), foreign.clone());
            assert_eq!(
                prove_absence(&mut fake, &product(), Path::new(APP), None).err(),
                Some(unknown(
                    "reserved executable conflicts with foreign bundle identity"
                )),
            );
        }
        let mut fake = Fake::new();
        fake.bundles.insert(APP.into(), foreign);
        assert_eq!(
            prove_absence(&mut fake, &product(), Path::new(APP), None).err(),
            Some(unknown("current product bundle identity mismatch")),
        );
    }

    #[test]
    fn foreign_classification_still_requires_unique_bounded_identifier_and_full_bytes() {
        let xml = String::from_utf8(plist_xml("org.other.helper"))
            .unwrap()
            .replace("<key>CFBundlePackageType</key><string>APPL</string>", "");
        for invalid in [
            xml.replace(
                "<key>CFBundleIdentifier</key><string>org.other.helper</string>",
                "",
            ),
            xml.replace("<string>org.other.helper</string>", "<integer>1</integer>"),
            xml.replace("<string>org.other.helper</string>", "<string></string>"),
            xml.replace("org.other.helper", &"x".repeat(256)),
            xml.replace("org.other.helper", "org.other.&#10;helper"),
            xml.replace(
                "</dict>",
                "<key>CFBundleIdentifier</key><string>org.other.helper</string></dict>",
            ),
            xml.replace(
                "</dict>",
                "<key>CFBundleIdentifier</key><string>app.gajae.desktop</string></dict>",
            ),
            xml.replace(
                "</dict>",
                "<key>CFBundleExecutable</key><string>other</string></dict>",
            ),
        ] {
            assert!(parse_bundle(invalid.as_bytes()).is_err());
        }
        let foreign = parse_bundle(xml.as_bytes()).unwrap();
        let changed = parse_bundle(xml.replace("0.1.0", "0.1.1").as_bytes()).unwrap();
        assert!(foreign != changed); // Even foreign metadata's full digest binds the census.
        assert!(parse_bundle(&xml.as_bytes()[..xml.len() - 8]).is_err());
        assert!(parse_bundle(&[xml.as_bytes(), xml.as_bytes()].concat()).is_err());
    }

    #[test]
    fn plist_identity_accepts_other_versions_but_rejects_duplicates_truncation_and_amplification() {
        let xml = plist_xml("app.gajae.desktop");
        assert_eq!(parse_bundle(&xml).unwrap().identifier, "app.gajae.desktop");
        let duplicate = String::from_utf8(xml.clone()).unwrap().replace(
            "</dict>",
            "<key>CFBundleIdentifier</key><string>foreign</string></dict>",
        );
        assert!(parse_bundle(duplicate.as_bytes()).is_err());
        assert!(parse_bundle(&xml[..xml.len() - 8]).is_err());
        assert!(parse_bundle(&[xml.clone(), xml].concat()).is_err());
        let mut value =
            plist::Value::from_reader_xml(plist_xml("app.gajae.desktop").as_slice()).unwrap();
        value.as_dictionary_mut().unwrap().insert(
            "large".into(),
            plist::Value::Array(vec![plist::Value::String("x".repeat(4096)); 100]),
        );
        let mut bytes = Vec::new();
        value.to_writer_binary(&mut bytes).unwrap();
        assert!(bytes.len() < MAX_PLIST);
        assert!(parse_bundle(&bytes).is_err());
    }

    #[test]
    fn bounded_filesystem_reader_rejects_symlink_directory_and_oversized_plist() {
        let name = format!(
            "gjc-owner-plist-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let scratch = std::env::temp_dir().join(name);
        std::fs::create_dir(&scratch).unwrap();
        let scratch = scratch.canonicalize().unwrap();
        let app = scratch.join("Copy.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        let info = app.join("Contents/Info.plist");
        std::fs::write(&info, plist_xml("app.gajae.desktop")).unwrap();
        assert!(read_bundle(&app).is_ok());
        std::fs::rename(&info, scratch.join("identity.plist")).unwrap();
        std::os::unix::fs::symlink(scratch.join("identity.plist"), &info).unwrap();
        assert!(read_bundle(&app).is_err());
        std::fs::remove_file(&info).unwrap();
        std::fs::create_dir(&info).unwrap();
        assert!(read_bundle(&app).is_err());
        std::fs::remove_dir(&info).unwrap();
        std::fs::write(&info, vec![b'x'; MAX_PLIST + 1]).unwrap();
        assert!(read_bundle(&app).is_err());
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn read_only_real_mac_libproc_abi_smoke() {
        let mut probe = Native;
        let pid = std::process::id();
        let identity = probe.identity(pid).unwrap().unwrap();
        assert_eq!(identity.pid, pid);
        assert_eq!(identity.uid, unsafe { libc::geteuid() });
        assert!(identity.birth.seconds > 0 && identity.birth.microseconds < 1_000_000);
        assert!(probe.executable(pid).unwrap().unwrap().is_absolute());
        let listing = validated_list(
            &mut probe,
            Selection::Effective(identity.uid),
            &Deadline::new(),
        )
        .unwrap();
        assert!(listing.contains(&pid));
        // No process names, paths, arguments, or credentials are printed, and
        // this unbundled test runner cannot manufacture an app absence proof.
        assert!(capture_owned_server(pid, pid).is_err());
    }

    #[test]
    #[ignore = "Optional live census; process churn or inaccessible metadata must fail closed"]
    fn read_only_real_mac_census_smoke() -> Result<()> {
        let mut probe = Native;
        let deadline = Deadline::new();
        let product = Product::compiled();
        // The unbundled runner cannot request a QA domain or mint a capability.
        let scope = ScanScope {
            product: &product,
            domain: OwnerDomain::Shared,
            required: BTreeSet::from([std::process::id()]),
        };
        let census = stable_census(&mut probe, &scope, &deadline)?;
        revalidate_census(&mut probe, &scope, &census, &deadline)?;
        assert!(census.processes.contains_key(&std::process::id()));
        eprintln!("Read-only same-UID census complete: {} BSD identities, {} positive foreign exclusions, {} bundle identities; no absence capability minted.",
            census.processes.len(), census.foreign.len(), census.bundles.len());
        Ok(())
    }
}
