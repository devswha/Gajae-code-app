//! Explicit, credential-free profiles for installed-app acceptance.
//! A HOME override alone does not isolate WKWebView's default data store.
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

use crate::macos_instance;
use serde::{Deserialize, Serialize};
use tauri::utils::config::{Config, WindowConfig};

const MANIFEST: &str = "desktop-qa-profile.json";
const AUTOMATION_SOCKET: &str = "a.sock";

fn validate_automation_socket(root: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        // Use the platform sockaddr layout, not a guessed cross-platform cap.
        let address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        if root.join(AUTOMATION_SOCKET).as_os_str().as_bytes().len() >= address.sun_path.len() {
            return Err(
                "QA root is too long for its private automation socket; choose a shorter path."
                    .into(),
            );
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u8,
    root: PathBuf,
    webkit_store: [u8; 16],
}

#[derive(Debug)]
pub(crate) struct QaProfile {
    root: PathBuf,
    webkit_store: [u8; 16],
    // Own the profile before changing directories or constructing any webview.
    // Tauri creates configured windows before invoking the app setup callback.
    _lock: macos_instance::InstanceLock,
}

pub(crate) fn requested_root(
    args: impl IntoIterator<Item = String>,
) -> Result<Option<PathBuf>, String> {
    let mut args = args.into_iter();
    let mut root = None;
    while let Some(arg) = args.next() {
        if arg == "--qa-profile" {
            if root.is_some() {
                return Err("Specify --qa-profile once.".into());
            }
            let path = args
                .next()
                .filter(|value| !value.starts_with('-'))
                .ok_or("--qa-profile requires an absolute directory.")?;
            if !Path::new(&path).is_absolute() {
                return Err("--qa-profile requires an absolute directory.".into());
            }
            root = Some(PathBuf::from(path));
        } else if arg.starts_with("--qa-profile=") {
            return Err("Use --qa-profile /absolute/directory.".into());
        }
    }
    Ok(root)
}

pub(crate) fn require_supported_os(version: &str) -> Result<(), String> {
    let major = version
        .trim()
        .split('.')
        .next()
        .and_then(|part| part.parse::<u32>().ok());
    if major.is_some_and(|major| major >= 14) {
        Ok(())
    } else {
        Err(
            "Isolated desktop QA requires macOS 14 or newer; refusing the default WebKit store."
                .into(),
        )
    }
}

fn private_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(format!(
                "QA path must be a real directory: {}",
                path.display()
            ))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path)
                .map_err(|error| format!("Could not create QA directory: {error}"))?;
        }
        Err(error) => return Err(format!("Could not inspect QA directory: {error}")),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not protect QA directory: {error}"))?;
    }
    Ok(())
}

impl QaProfile {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        Self::open_until(path, Instant::now() + macos_instance::HANDOFF_TIMEOUT)
    }

    pub(crate) fn open_until(path: &Path, deadline: Instant) -> Result<Self, String> {
        // A trailing slash or `/.` makes lstat follow the final symlink on
        // macOS. Remove those lexical suffixes before inspecting the root.
        let path: PathBuf = path.components().collect();
        if !path.is_absolute()
            || fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err("QA root must be an absolute non-symlink directory.".into());
        }
        // An existing directory belongs to QA only if empty or carrying our
        // root-bound manifest. Never adopt an existing home or project.
        if path.exists()
            && !path.join(MANIFEST).exists()
            && fs::read_dir(&path)
                .map_err(|e| e.to_string())?
                .next()
                .is_some()
        {
            return Err("QA root must be empty or an existing desktop QA profile.".into());
        }
        if !path.exists() {
            private_directory(&path)?;
        }
        let root = path.canonicalize().map_err(|error| error.to_string())?;
        validate_automation_socket(&root)?;
        let manifest_path = root.join(MANIFEST);
        if fs::symlink_metadata(&manifest_path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("QA manifest cannot be a symlink.".into());
        }
        let manifest: Option<Manifest> = if manifest_path.exists() {
            let metadata = fs::metadata(&manifest_path).map_err(|error| error.to_string())?;
            if !metadata.is_file() || metadata.len() > 4096 {
                return Err("QA manifest must be a regular file of at most 4096 bytes.".into());
            }
            let bytes = fs::read(&manifest_path).map_err(|error| error.to_string())?;
            let manifest: Manifest =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid desktop QA manifest.")?;
            if manifest.version != 1 || manifest.root != root || manifest.webkit_store == [0; 16] {
                return Err("Desktop QA manifest does not belong to this directory.".into());
            }
            Some(manifest)
        } else {
            None
        };
        // Validate ownership before creating a lock in an existing directory;
        // then acquire it before either profile initialization or WebKit use.
        let lock_path = root.join("desktop.lock");
        if fs::symlink_metadata(&lock_path).is_ok_and(|metadata| !metadata.file_type().is_file()) {
            return Err("QA instance lock must be a regular non-symlink file.".into());
        }
        let lock = macos_instance::acquire_until(&lock_path, deadline).map_err(|error| {
            if error.is_contended() {
                "This desktop QA profile is already in use.".to_owned()
            } else {
                error.to_string()
            }
        })?;
        private_directory(&root)?;
        let manifest = if let Some(manifest) = manifest {
            manifest
        } else {
            let mut webkit_store = [0; 16];
            getrandom::getrandom(&mut webkit_store).map_err(|error| error.to_string())?;
            webkit_store[6] = (webkit_store[6] & 0x0f) | 0x40;
            webkit_store[8] = (webkit_store[8] & 0x3f) | 0x80;
            let manifest = Manifest {
                version: 1,
                root: root.clone(),
                webkit_store,
            };
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&manifest_path)
                .map_err(|error| error.to_string())?;
            file.write_all(&serde_json::to_vec(&manifest).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            manifest
        };
        for name in [
            "home",
            "home/.gajae-app",
            "home/.gjc",
            "home/.gjc/agent",
            "home/.gjc/live-sessions",
            "home/.config",
            "home/.cache",
            "home/.local",
            "home/.local/share",
            "home/.local/state",
            "workspaces",
            "tmp",
            "browser",
            "browser/profile",
            "browser/chromium",
        ] {
            private_directory(&root.join(name))?;
        }
        Ok(Self {
            root,
            webkit_store: manifest.webkit_store,
            _lock: lock,
        })
    }

    pub(crate) fn home(&self) -> PathBuf {
        self.root.join("home")
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn configure(&self, config: &mut Config) -> Vec<WindowConfig> {
        let mut windows = Vec::new();
        for window in &mut config.app.windows {
            window.data_store_identifier = Some(self.webkit_store);
            window.title = format!("{} — QA", window.title);
            if window.create {
                windows.push(window.clone());
            }
            // tauri-runtime 2.7 drops the UUID in WindowConfig ->
            // WebviewAttributes. Build QA windows with the explicit setter.
            window.create = false;
        }
        windows
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn create_windows(
        &self,
        app: &tauri::App,
        windows: &[WindowConfig],
    ) -> tauri::Result<()> {
        for window in windows {
            tauri::WebviewWindowBuilder::from_config(app, window)?
                .data_store_identifier(self.webkit_store)
                .build()?;
        }
        Ok(())
    }

    pub(crate) fn environment(&self) -> BTreeMap<String, String> {
        let mut result = BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
            ("LANG".into(), "en_US.UTF-8".into()),
        ]);
        for (name, relative) in [
            ("HOME", "home"),
            ("USERPROFILE", "home"),
            ("DATABASE_PATH", "home/.gajae-app/auth.db"),
            ("GJC_CODING_AGENT_DIR", "home/.gjc/agent"),
            ("GJC_WORKER_AGENT_DIR", "home/.gjc/agent"),
            ("GJC_LIVE_SESSION_DIR", "home/.gjc/live-sessions"),
            ("WORKSPACES_ROOT", "workspaces"),
            ("XDG_CONFIG_HOME", "home/.config"),
            ("XDG_CACHE_HOME", "home/.cache"),
            ("XDG_DATA_HOME", "home/.local/share"),
            ("XDG_STATE_HOME", "home/.local/state"),
            ("TMPDIR", "tmp"),
            ("GAJAE_BROWSER_PROFILE_DIR", "browser/profile"),
            ("GAJAE_BROWSER_CACHE_DIR", "browser/chromium"),
            ("GAJAE_AUTOMATION_SOCKET", AUTOMATION_SOCKET),
        ] {
            result.insert(
                name.into(),
                self.root.join(relative).to_string_lossy().into_owned(),
            );
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let mut id = [0; 8];
            getrandom::getrandom(&mut id).unwrap();
            let path = std::env::temp_dir().join(format!(
                "gajae-profile-{}-{:x}",
                std::process::id(),
                u64::from_ne_bytes(id)
            ));
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn automation_socket_is_short_private_and_really_bindable() {
        let root = Temp::new();
        let profile = QaProfile::open(&root.0).unwrap();
        let environment = profile.environment();
        let socket = PathBuf::from(&environment["GAJAE_AUTOMATION_SOCKET"]);
        assert_eq!(socket, profile.root.join(AUTOMATION_SOCKET));
        #[cfg(unix)]
        {
            let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
            assert!(
                socket.exists(),
                "the OS must not silently truncate the bound path"
            );
            drop(listener);
        }
        assert!(
            validate_automation_socket(&PathBuf::from(format!("/{}", "x".repeat(200)))).is_err()
        );
    }

    #[test]
    fn profile_switch_is_explicit_and_unambiguous() {
        assert_eq!(
            requested_root(vec!["gajae-app://open/job/test".into()]).unwrap(),
            None
        );
        for args in [
            vec!["--qa-profile"],
            vec!["--qa-profile", "relative"],
            vec!["--qa-profile", "/a", "--qa-profile", "/b"],
            vec!["--qa-profile=/tmp/a"],
        ] {
            assert!(requested_root(args.into_iter().map(str::to_owned)).is_err());
        }
        assert_eq!(
            requested_root(vec!["--qa-profile".into(), "/tmp/qa".into()]).unwrap(),
            Some(PathBuf::from("/tmp/qa"))
        );
        for version in ["13.6.9", "11.0", "", "unknown"] {
            assert!(require_supported_os(version).is_err());
        }
        assert!(require_supported_os("14.0\n").is_ok());
        assert!(require_supported_os("26.6.2").is_ok());
    }

    #[test]
    fn profiles_persist_their_own_webkit_store_and_reject_copied_identity() {
        let a = Temp::new();
        let b = Temp::new();
        let first = QaProfile::open(&a.0).unwrap();
        let store = first.webkit_store;
        drop(first);
        let again = QaProfile::open(&a.0).unwrap();
        let other = QaProfile::open(&b.0).unwrap();
        assert_eq!(store, again.webkit_store);
        assert_ne!(store, other.webkit_store);
        drop(other);
        fs::copy(a.0.join(MANIFEST), b.0.join(MANIFEST)).unwrap();
        assert!(QaProfile::open(&b.0).is_err());
    }

    #[test]
    fn refuses_existing_user_data_and_symlinked_paths() {
        let root = Temp::new();
        fs::create_dir(&root.0).unwrap();
        fs::write(root.0.join("user-data"), "keep").unwrap();
        assert!(QaProfile::open(&root.0).is_err());
        assert_eq!(
            fs::read_to_string(root.0.join("user-data")).unwrap(),
            "keep"
        );
        #[cfg(unix)]
        {
            let profile = Temp::new();
            QaProfile::open(&profile.0).unwrap();
            let home = profile.0.join("home");
            fs::remove_dir_all(&home).unwrap();
            std::os::unix::fs::symlink(&root.0, &home).unwrap();
            assert!(QaProfile::open(&profile.0).is_err());
        }
    }

    #[test]
    fn isolates_every_window_and_server_path_without_inherited_credentials() {
        let root = Temp::new();
        let profile = QaProfile::open(&root.0).unwrap();
        let mut config = tauri::utils::config::Config::default();
        config
            .app
            .windows
            .push(tauri::utils::config::WindowConfig::default());
        let windows = profile.configure(&mut config);
        assert_eq!(windows.len(), 1);
        assert!(config
            .app
            .windows
            .iter()
            .all(
                |window| window.data_store_identifier == Some(profile.webkit_store)
                    && window.title.ends_with(" — QA")
            ));
        let environment = profile.environment();
        for (name, value) in &environment {
            if name != "PATH" && name != "LANG" {
                assert!(Path::new(value).starts_with(&profile.root), "{name}");
            }
        }
        assert_eq!(environment["HOME"], profile.home().to_string_lossy());
        assert!(!environment.contains_key("OPENAI_API_KEY"));
        assert!(!environment.contains_key("NODE_OPTIONS"));
        assert!(profile.root.join("desktop.lock").is_file());
    }

    #[test]
    fn qa_windows_cannot_be_created_by_tauris_config_conversion() {
        let root = Temp::new();
        let profile = QaProfile::open(&root.0).unwrap();
        let mut config = tauri::utils::config::Config::default();
        config.app.windows = vec![
            WindowConfig::default(),
            WindowConfig {
                label: "secondary".into(),
                ..WindowConfig::default()
            },
            WindowConfig {
                label: "deferred".into(),
                create: false,
                ..WindowConfig::default()
            },
        ];
        let windows = profile.configure(&mut config);
        // The pinned runtime drops the UUID in its config conversion. Such
        // windows must not reach Tauri's automatic window creation path.
        let attributes = tauri_runtime::webview::WebviewAttributes::from(&config.app.windows[0]);
        assert_eq!(attributes.data_store_identifier, None);
        assert!(config.app.windows.iter().all(|window| !window.create));
        assert_eq!(
            windows
                .iter()
                .map(|window| window.label.as_str())
                .collect::<Vec<_>>(),
            ["main", "secondary"]
        );
        assert!(windows
            .iter()
            .all(|window| window.data_store_identifier == Some(profile.webkit_store)));
    }

    #[test]
    fn profile_owns_its_lock_before_configuring_any_windows() {
        let root = Temp::new();
        let profile = QaProfile::open(&root.0).unwrap();
        let manifest = fs::read(root.0.join(MANIFEST)).unwrap();
        // A contender must not initialize missing paths before discovering the
        // owner. This directory is only a fixture, with no sidecar running.
        fs::remove_dir(profile.home().join(".cache")).unwrap();
        assert!(QaProfile::open_until(
            &root.0,
            Instant::now() + std::time::Duration::from_millis(60)
        )
        .is_err());
        assert!(!profile.home().join(".cache").exists());
        assert_eq!(fs::read(root.0.join(MANIFEST)).unwrap(), manifest);
        let store = profile.webkit_store;
        drop(profile);
        assert_eq!(QaProfile::open(&root.0).unwrap().webkit_store, store);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_roots_with_trailing_separators_without_mutating_target() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        for suffix in ["/", "/."] {
            let parent = Temp::new();
            fs::create_dir(&parent.0).unwrap();
            let target = parent.0.join("user-directory");
            fs::create_dir(&target).unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
            let link = parent.0.join("alias");
            symlink(&target, &link).unwrap();
            let alias = PathBuf::from(format!("{}{suffix}", link.display()));
            assert!(QaProfile::open(&alias).is_err(), "{alias:?}");
            assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
            assert_eq!(
                fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn invalid_manifest_does_not_change_permissions_or_create_a_lock() {
        use std::os::unix::fs::PermissionsExt;
        for contents in [
            "{}",
            "not json",
            "{\"version\":1,\"root\":\"/wrong\",\"webkit_store\":[0]}",
        ] {
            let root = Temp::new();
            fs::create_dir(&root.0).unwrap();
            fs::set_permissions(&root.0, fs::Permissions::from_mode(0o755)).unwrap();
            fs::write(root.0.join(MANIFEST), contents).unwrap();
            assert!(QaProfile::open(&root.0).is_err());
            assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
            assert_eq!(
                fs::metadata(&root.0).unwrap().permissions().mode() & 0o777,
                0o755
            );
            assert_eq!(fs::read_to_string(root.0.join(MANIFEST)).unwrap(), contents);
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_non_regular_manifest_and_symlinked_lock() {
        let root = Temp::new();
        fs::create_dir(&root.0).unwrap();
        let manifest = root.0.join(MANIFEST);
        assert!(std::process::Command::new("/usr/bin/mkfifo")
            .arg(&manifest)
            .status()
            .unwrap()
            .success());
        assert!(QaProfile::open(&root.0).is_err());
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
        fs::remove_file(manifest).unwrap();

        drop(QaProfile::open(&root.0).unwrap());
        let lock = root.0.join("desktop.lock");
        fs::remove_file(&lock).unwrap();
        let target = root.0.join("user-file");
        fs::write(&target, "keep").unwrap();
        std::os::unix::fs::symlink(&target, lock).unwrap();
        assert!(QaProfile::open(&root.0).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "keep");
    }
}
