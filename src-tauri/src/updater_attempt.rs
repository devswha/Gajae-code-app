//! Presence-only admission guard for an interrupted desktop update attempt.
//!
//! A future writer must durably publish the record before beginning install,
//! and must not clear it without proving the complete operation integrity and
//! completion. This reader intentionally never reads, creates, mutates, or
//! removes the record.
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) const ATTEMPT_RECORD: &str = "desktop-update-attempt.json";

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
