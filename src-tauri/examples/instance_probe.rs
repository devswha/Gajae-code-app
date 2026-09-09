//! Disposable cross-process probe for the macOS instance flock.
//!
//! Protocol:
//!   instance_probe hold <private-temp-root>
//!     stdout: `acquired\n`; stdin command: `release\n`; stdout: `released\n`.
//!   instance_probe try <private-temp-root> [timeout-ms]
//!     stdout: `acquired\n` or `contended\n`; exit 0 or 2 respectively.
//!
//! The root must already be a private, real directory below the system
//! temporary directory. This probe never launches the app/server and never
//! removes the lock path.
#[cfg(target_os = "macos")]
#[path = "../src/macos_instance.rs"]
mod macos_instance;

#[cfg(target_os = "macos")]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
#[cfg(not(target_os = "macos"))]
use std::process::ExitCode;
#[cfg(target_os = "macos")]
use std::{
    env, fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
const DEFAULT_TRY_TIMEOUT: Duration = Duration::from_millis(250);
#[cfg(target_os = "macos")]
const MAX_TRY_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(target_os = "macos")]
fn effective_uid() -> u32 {
    unsafe { libc::geteuid() }
}

#[cfg(target_os = "macos")]
fn private_temp_root(raw: &str) -> Result<PathBuf, String> {
    // Strip lexical trailing separators and `/.` before lstat; otherwise
    // macOS follows a final symlink when a directory path ends in `/`.
    let candidate: PathBuf = Path::new(raw).components().collect();
    if !candidate.is_absolute() {
        return Err("root must be an absolute private temporary directory".into());
    }
    let metadata = fs::symlink_metadata(&candidate)
        .map_err(|error| format!("could not inspect probe root: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("root must be a real directory, not a symlink".into());
    }
    #[cfg(unix)]
    {
        if metadata.uid() != effective_uid() {
            return Err("root must be owned by the current user".into());
        }
        if metadata.permissions().mode() & 0o7777 != 0o700 {
            return Err("root permissions must be exactly 0700".into());
        }
    }
    let temp = fs::canonicalize(env::temp_dir())
        .map_err(|error| format!("could not locate system temporary directory: {error}"))?;
    let root = candidate
        .canonicalize()
        .map_err(|error| format!("could not canonicalize probe root: {error}"))?;
    if root == temp || !root.starts_with(&temp) {
        return Err("root must be below the system temporary directory".into());
    }
    Ok(root)
}

#[cfg(target_os = "macos")]
fn acquire_error(error: macos_instance::LockError) -> ExitCode {
    if error.is_contended() {
        println!("contended");
        ExitCode::from(2)
    } else {
        eprintln!("error: {error}");
        ExitCode::from(1)
    }
}

#[cfg(target_os = "macos")]
fn hold(root: &Path) -> ExitCode {
    let lock = match macos_instance::acquire(&root.join("desktop.lock")) {
        Ok(lock) => lock,
        Err(error) => return acquire_error(error),
    };
    println!("acquired");
    io::stdout().flush().expect("flush acquisition marker");
    let mut command = String::new();
    let read = io::stdin().lock().read_line(&mut command);
    match read {
        Ok(_) if command.trim_end_matches(&['\r', '\n'][..]) == "release" => {
            println!("released");
            io::stdout().flush().expect("flush release marker");
            drop(lock);
            ExitCode::SUCCESS
        }
        Ok(_) => {
            eprintln!("error: expected the release command");
            drop(lock);
            ExitCode::from(1)
        }
        Err(error) => {
            eprintln!("error: could not read release command: {error}");
            drop(lock);
            ExitCode::from(1)
        }
    }
}

#[cfg(target_os = "macos")]
fn try_acquire(root: &Path, timeout: Duration) -> ExitCode {
    match macos_instance::acquire_until(&root.join("desktop.lock"), Instant::now() + timeout) {
        Ok(lock) => {
            println!("acquired");
            io::stdout().flush().expect("flush acquisition marker");
            drop(lock);
            ExitCode::SUCCESS
        }
        Err(error) => acquire_error(error),
    }
}

#[cfg(target_os = "macos")]
fn usage() -> ! {
    eprintln!(
        "usage: instance_probe hold <private-temp-root> | instance_probe try <private-temp-root> [timeout-ms]"
    );
    std::process::exit(1);
}

#[cfg(target_os = "macos")]
fn run() -> Result<ExitCode, String> {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_else(|| usage());
    let raw_root = args.next().unwrap_or_else(|| usage());
    let root = private_temp_root(&raw_root)?;
    let exit = match command.as_str() {
        "hold" if args.next().is_none() => hold(&root),
        "try" => {
            let timeout = match args.next() {
                None => DEFAULT_TRY_TIMEOUT,
                Some(raw) if args.next().is_none() => {
                    let millis = raw
                        .parse::<u64>()
                        .map_err(|_| "timeout-ms must be an integer".to_owned())?;
                    let timeout = Duration::from_millis(millis);
                    if timeout.is_zero() || timeout > MAX_TRY_TIMEOUT {
                        return Err("timeout-ms must be between 1 and 5000".into());
                    }
                    timeout
                }
                Some(_) => usage(),
            };
            try_acquire(&root, timeout)
        }
        _ => usage(),
    };
    Ok(exit)
}

#[cfg(target_os = "macos")]
fn main() -> ExitCode {
    match run() {
        Ok(exit) => exit,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::from(1)
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() -> ExitCode {
    eprintln!("instance_probe is supported only on macOS.");
    ExitCode::from(1)
}
