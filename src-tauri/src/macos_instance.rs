//! Bounded macOS single-instance ownership.
//!
//! The returned guard owns the open file descriptor and its advisory lock. It
//! deliberately does not remove the lock path or unlock before the guard is
//! dropped, so a successor started during shutdown can wait for ownership.
use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    thread,
    time::{Duration, Instant},
};

use fs2::FileExt;

pub(crate) const HANDOFF_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug)]
pub(crate) enum LockError {
    Contended,
    Open(io::Error),
    Lock(io::Error),
}

impl LockError {
    pub(crate) fn is_contended(&self) -> bool {
        matches!(self, Self::Contended)
    }
}

impl fmt::Display for LockError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Contended => {
                formatter.write_str("desktop instance lock is held by another process")
            }
            Self::Open(error) => write!(formatter, "could not open desktop instance lock: {error}"),
            Self::Lock(error) => write!(
                formatter,
                "could not acquire desktop instance lock: {error}"
            ),
        }
    }
}

impl std::error::Error for LockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Contended => None,
            Self::Open(error) | Self::Lock(error) => Some(error),
        }
    }
}

#[derive(Debug)]
pub(crate) struct InstanceLock {
    // Keeping this descriptor in the guard keeps the flock held for the whole
    // process lifetime. There is intentionally no explicit unlock or unlink.
    _file: File,
}

pub(crate) fn acquire(path: &Path) -> Result<InstanceLock, LockError> {
    acquire_until(path, Instant::now() + HANDOFF_TIMEOUT)
}

/// Acquire a lock with an injectable absolute deadline. Production callers use
/// [`acquire`]; tests and the disposable probe use short bounded deadlines.
pub(crate) fn acquire_until(path: &Path, deadline: Instant) -> Result<InstanceLock, LockError> {
    let file = open_lock_file(path)?;
    loop {
        // Check immediately before every non-blocking flock attempt. A
        // deadline expiring during the retry sleep must never turn into a
        // late ownership success.
        if Instant::now() >= deadline {
            return Err(LockError::Contended);
        }
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(InstanceLock { _file: file }),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(LockError::Contended);
                }
                thread::sleep(remaining.min(RETRY_INTERVAL));
            }
            Err(error) => return Err(LockError::Lock(error)),
        }
    }
}

fn open_lock_file(path: &Path) -> Result<File, LockError> {
    // std also sets close-on-exec, so child servers cannot retain this lock.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(LockError::Open)?;

    let descriptor = file.metadata().map_err(LockError::Open)?;
    if !descriptor.file_type().is_file() {
        return Err(LockError::Open(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "desktop instance lock descriptor must be a regular file",
        )));
    }
    #[cfg(unix)]
    {
        let path_metadata = fs::symlink_metadata(path).map_err(LockError::Open)?;
        if !path_metadata.file_type().is_file()
            || descriptor.dev() != path_metadata.dev()
            || descriptor.ino() != path_metadata.ino()
        {
            return Err(LockError::Open(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "desktop instance lock path changed while opening",
            )));
        }
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{mpsc, Arc, Barrier},
        thread,
    };

    struct TempDirectory(std::path::PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let mut entropy = [0; 16];
            getrandom::getrandom(&mut entropy).unwrap();
            let id = u128::from_ne_bytes(entropy);
            let path = std::env::temp_dir()
                .join(format!("gajae-macos-instance-{}-{id}", std::process::id()));
            fs::create_dir(&path).expect("create temporary lock directory");
            Self(path)
        }

        fn lock_path(&self) -> std::path::PathBuf {
            self.0.join("desktop.lock")
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn held_lock_blocks_until_deadline_then_release_admits_a_new_owner() {
        let directory = TempDirectory::new();
        let path = directory.lock_path();
        let first = acquire(&path).expect("first owner acquires");
        let error = acquire_until(&path, Instant::now() + Duration::from_millis(60))
            .expect_err("held lock must not be reported as acquired");
        assert!(error.is_contended());
        assert!(path.is_file());
        drop(first);
        let second = acquire_until(&path, Instant::now() + Duration::from_millis(60))
            .expect("released lock admits a successor");
        drop(second);
        assert!(path.is_file());
    }

    #[test]
    fn two_contenders_never_own_the_lock_simultaneously() {
        let directory = TempDirectory::new();
        let path = directory.lock_path();
        let first = acquire(&path).expect("first owner acquires");
        let start = Arc::new(Barrier::new(3));
        let (result_tx, result_rx) = mpsc::channel();
        let mut releases = Vec::new();
        let mut workers = Vec::new();
        for id in 0..2 {
            let start = Arc::clone(&start);
            let path = path.clone();
            let result_tx = result_tx.clone();
            let (release_tx, release_rx) = mpsc::channel();
            releases.push(release_tx);
            workers.push(thread::spawn(move || {
                start.wait();
                match acquire_until(&path, Instant::now() + Duration::from_millis(180)) {
                    Ok(lock) => {
                        result_tx.send((id, true)).unwrap();
                        release_rx
                            .recv_timeout(Duration::from_secs(1))
                            .expect("owner release signal");
                        drop(lock);
                    }
                    Err(error) if error.is_contended() => {
                        result_tx.send((id, false)).unwrap();
                    }
                    Err(error) => panic!("unexpected lock error: {error}"),
                }
            }));
        }
        drop(result_tx);
        start.wait();
        drop(first);
        let results = [result_rx.recv().unwrap(), result_rx.recv().unwrap()];
        assert_eq!(results.iter().filter(|(_, acquired)| *acquired).count(), 1);
        assert_eq!(results.iter().filter(|(_, acquired)| !*acquired).count(), 1);
        let owner = results
            .iter()
            .find_map(|(id, acquired)| acquired.then_some(*id))
            .unwrap();
        releases[owner].send(()).unwrap();
        for worker in workers {
            worker.join().unwrap();
        }
    }

    #[test]
    fn child_exec_cannot_inherit_the_instance_lock() {
        use std::os::fd::AsRawFd;

        let directory = TempDirectory::new();
        let owner = acquire(&directory.lock_path()).unwrap();
        let flags = unsafe { libc::fcntl(owner._file.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0);
        assert_ne!(flags & libc::FD_CLOEXEC, 0);
    }

    #[test]
    fn open_errors_are_not_misreported_as_contention() {
        let directory = TempDirectory::new();
        let path = directory.0.join("not-a-lock");
        fs::create_dir(&path).unwrap();
        let error = acquire_until(&path, Instant::now() + Duration::from_millis(60))
            .expect_err("directory cannot become an instance lock");
        assert!(matches!(error, LockError::Open(_)));
        assert!(!error.is_contended());
    }

    #[test]
    fn expired_deadline_does_not_attempt_lock_ownership() {
        let directory = TempDirectory::new();
        let path = directory.lock_path();
        let owner = acquire(&path).expect("first owner acquires");
        let started = Instant::now();
        let error =
            acquire_until(&path, started).expect_err("expired deadline must refuse ownership");
        assert!(error.is_contended());
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "expired acquisition must not wait for the owner"
        );
        drop(owner);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_and_fifo_lock_paths_are_rejected_without_blocking() {
        use std::os::unix::fs::symlink;

        let directory = TempDirectory::new();
        let target = directory.0.join("target");
        fs::write(&target, b"not the lock").unwrap();
        let path = directory.lock_path();
        symlink(&target, &path).unwrap();
        let error = acquire_until(&path, Instant::now() + Duration::from_millis(60))
            .expect_err("symlink lock path must be refused");
        assert!(matches!(error, LockError::Open(_)));
        assert!(!error.is_contended());

        fs::remove_file(&path).unwrap();
        assert!(std::process::Command::new("/usr/bin/mkfifo")
            .arg(&path)
            .status()
            .expect("run mkfifo")
            .success());
        let started = Instant::now();
        let error = acquire_until(&path, Instant::now() + Duration::from_millis(60))
            .expect_err("FIFO lock path must be refused");
        assert!(matches!(error, LockError::Open(_)));
        assert!(!error.is_contended());
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "FIFO refusal must not block"
        );
    }
}
