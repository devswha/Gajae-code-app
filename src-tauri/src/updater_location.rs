//! Validate the native-owned target before entering the official macOS installer.
//! No location, executable, key or temporary-directory override comes from IPC.
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

use crate::updater_binding::{Binding, Mode};

pub(crate) struct InstallLocation {
    app: PathBuf,
    executable: PathBuf,
    temporary: PathBuf,
    temporary_literal: PathBuf,
    device: u64,
    inode: u64,
}

impl InstallLocation {
    pub(crate) fn validate(binding: &Binding, executable: &Path) -> Result<Self, String> {
        if binding.mode == Mode::Disabled {
            return Err("Installation is disabled.".into());
        }
        let canonical =
            fs::canonicalize(executable).map_err(|_| "Installer executable is unavailable.")?;
        if canonical != executable {
            return Err("Installer executable must not be an alias.".into());
        }
        let app = canonical
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .ok_or("Installer executable is not in an application.")?
            .to_path_buf();
        let expected = app.join("Contents/MacOS").join(env!("CARGO_PKG_NAME"));
        if canonical != expected
            || app.file_name().and_then(|name| name.to_str())
                != Some(&format!("{}.app", env!("GJC_UPDATE_PRODUCT_NAME")))
        {
            return Err("Installer target does not match the running product.".into());
        }
        match binding.mode {
            Mode::Disabled => return Err("Installation is disabled.".into()),
            Mode::Qa => {
                if binding
                    .qa_root
                    .as_ref()
                    .map(|root| root.join(format!("{}.app", env!("GJC_UPDATE_PRODUCT_NAME"))))
                    != Some(app.clone())
                {
                    return Err("Installer target is outside the compiled QA application.".into());
                }
            }
            Mode::Production => {
                let in_system = app.parent() == Some(Path::new("/Applications"));
                let in_user = std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .and_then(|root| fs::canonicalize(root.join("Applications")).ok())
                    .is_some_and(|root| app.parent() == Some(root.as_path()));
                if !in_system && !in_user {
                    return Err("Move the application to Applications before updating.".into());
                }
            }
        }
        validate_ancestors(&app)?;
        let metadata =
            fs::symlink_metadata(&app).map_err(|_| "Installer target is unavailable.")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || (metadata.uid() != 0 && metadata.uid() != unsafe { libc::geteuid() })
        {
            return Err("Installer target ownership is unsupported.".into());
        }
        let temporary_literal = std::env::temp_dir();
        safe_script_path(&temporary_literal)?;
        let temporary = fs::canonicalize(&temporary_literal)
            .map_err(|_| "Installer temporary directory is unavailable.")?;
        // The pinned plugin interpolates paths in an AppleScript/shell string.
        // Reject characters it cannot quote safely before authorization is possible.
        safe_script_path(&app)?;
        safe_script_path(&temporary)?;
        same_volume(&metadata, &temporary)?;
        writable_volume(&app)?;
        writable_volume(&temporary)?;
        validate_bundle_identity(&app)?;
        let extracted = tauri_plugin_updater::extract_path_from_executable(&canonical)
            .map_err(|_| "Official installer target could not be derived.")?;
        if extracted != app {
            return Err("Official installer target differs from the running application.".into());
        }
        Ok(Self {
            app,
            executable: canonical,
            temporary,
            temporary_literal,
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    pub(crate) fn app(&self) -> &Path {
        &self.app
    }
    pub(crate) fn executable(&self) -> &Path {
        &self.executable
    }

    /// Immediately before mutation, require the same source directory and volume.
    /// This is a race detector, not an atomic filesystem namespace guarantee.
    pub(crate) fn revalidate(&self) -> Result<(), String> {
        validate_ancestors(&self.app)?;
        let metadata = fs::symlink_metadata(&self.app).map_err(|_| "Installer target changed.")?;
        if metadata.dev() != self.device || metadata.ino() != self.inode {
            return Err("Installer target changed.".into());
        }
        let literal = std::env::temp_dir();
        safe_script_path(&literal)?;
        if literal != self.temporary_literal {
            return Err("Installer temporary directory spelling changed.".into());
        }
        let temporary =
            fs::canonicalize(&literal).map_err(|_| "Installer temporary directory changed.")?;
        if temporary != self.temporary {
            return Err("Installer temporary directory changed.".into());
        }
        same_volume(&metadata, &temporary)?;
        writable_volume(&self.app)?;
        writable_volume(&temporary)?;
        validate_bundle_identity(&self.app)
    }
}

fn safe_script_path(path: &Path) -> Result<(), String> {
    let value = path.to_str().ok_or("Installer path must be UTF-8.")?;
    if !path.is_absolute()
        || value.len() > 4096
        || value
            .chars()
            .any(|c| c.is_control() || matches!(c, '\'' | '"' | '\\'))
    {
        return Err(
            "Installer path cannot be safely passed to the official authorization dialog.".into(),
        );
    }
    Ok(())
}

fn same_volume(app: &fs::Metadata, temporary: &Path) -> Result<(), String> {
    let metadata =
        fs::metadata(temporary).map_err(|_| "Installer temporary directory is unavailable.")?;
    if !metadata.is_dir() || metadata.dev() != app.dev() {
        return Err("Application and installer temporary directory must share one volume.".into());
    }
    Ok(())
}

fn writable_volume(path: &Path) -> Result<(), String> {
    use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};
    let path =
        CString::new(path.as_os_str().as_bytes()).map_err(|_| "Installer volume is invalid.")?;
    let mut info = MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::statfs(path.as_ptr(), info.as_mut_ptr()) } != 0 {
        return Err("Installer volume could not be inspected.".into());
    }
    let info = unsafe { info.assume_init() };
    if info.f_flags & libc::MNT_RDONLY as u32 != 0 {
        return Err("Installer volume is read-only.".into());
    }
    Ok(())
}

fn validate_ancestors(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Installer target must be absolute.".into());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err("Installer path is not canonical.".into());
        }
        current.push(component);
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| "Installer path is unavailable.")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Installer path contains an alias or non-directory.".into());
        }
    }
    Ok(())
}

fn validate_bundle_identity(app: &Path) -> Result<(), String> {
    validate_ancestors(&app.join("Contents"))?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(app.join("Contents/Info.plist"))
        .map_err(|_| "Application identity is unavailable.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Application identity is unavailable.")?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err("Application identity is invalid.".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Application identity could not be read.")?;
    if bytes.len() > 64 * 1024 {
        return Err("Application identity is oversized.".into());
    }
    crate::updater_archive::validate_installed_plist(
        &bytes,
        env!("GJC_UPDATE_BUNDLE_IDENTIFIER"),
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_paths_reject_script_metacharacters_not_innocent_spaces_or_unicode() {
        for path in [
            "/Applications/Gajae Code App.app",
            "/Users/사용자/Applications/Gajae Code App.app",
        ] {
            assert!(safe_script_path(Path::new(path)).is_ok());
        }
        for path in [
            "/tmp/o'brien/A.app",
            "/tmp/a\"b/A.app",
            "/tmp/a\\b/A.app",
            "/tmp/a\nb/A.app",
        ] {
            assert!(safe_script_path(Path::new(path)).is_err());
        }
    }

    #[test]
    fn disabled_and_out_of_bundle_targets_are_refused() {
        let binding = Binding {
            mode: Mode::Disabled,
            feed_origin: String::new(),
            public_key: String::new(),
            qa_root: None,
        };
        assert!(InstallLocation::validate(&binding, Path::new("/bin/sh")).is_err());
        assert!(InstallLocation::validate(&binding, Path::new("/does-not-exist")).is_err());
    }
}
