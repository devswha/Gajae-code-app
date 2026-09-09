//! Runtime admission for a compiled updater build. Disabled builds perform no
//! updater filesystem/network I/O, and ordinary QA can never activate production.
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Disabled,
    Production,
    Qa,
}

#[derive(Clone, Debug)]
pub struct Binding {
    pub mode: Mode,
    pub feed_origin: String,
    pub public_key: String,
    pub qa_root: Option<PathBuf>,
}

impl Binding {
    pub fn compiled() -> Self {
        Self {
            mode: match env!("GJC_UPDATE_MODE") {
                "production" => Mode::Production,
                "qa" => Mode::Qa,
                _ => Mode::Disabled,
            },
            feed_origin: env!("GJC_UPDATE_FEED_ORIGIN").into(),
            public_key: env!("GJC_UPDATE_PUBKEY").into(),
            qa_root: (!env!("GJC_UPDATE_QA_ROOT").is_empty())
                .then(|| PathBuf::from(env!("GJC_UPDATE_QA_ROOT"))),
        }
    }

    /// The outer mode/profile checks precede even resolving an executable or
    /// opening a state directory. Inputs are native-owned, never browser values.
    pub fn admits_profile(&self, qa_profile: Option<&Path>, release_arm64: bool) -> bool {
        match self.mode {
            Mode::Disabled => false,
            Mode::Production => release_arm64 && qa_profile.is_none() && self.qa_root.is_none(),
            Mode::Qa => qa_profile.is_some() && qa_profile == self.qa_root.as_deref(),
        }
    }

    /// A compiled updater QA executable must never fall back to the real HOME
    /// or WebKit store when launched by Finder or a UI automation tool without
    /// its arguments. This check precedes profile creation and every webview.
    pub(crate) fn validate_launch_profile(&self, requested: Option<&Path>) -> Result<(), String> {
        if self.mode == Mode::Qa && (requested.is_none() || requested != self.qa_root.as_deref()) {
            return Err("Updater QA builds require their exact compiled --qa-profile.".into());
        }
        Ok(())
    }

    /// The official plugin deserializes its Config BEFORE Builder::pubkey can
    /// override it. Supply the public-only config in the native context, while
    /// preserving disabled/unbound modes and all remote IPC restrictions.
    pub(crate) fn configure_plugin(
        &self,
        config: &mut tauri::Config,
        qa_profile: Option<&Path>,
        release_arm64: bool,
    ) {
        if !self.admits_profile(qa_profile, release_arm64) {
            return;
        }
        config.plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": self.public_key,
                "endpoints": [],
                "dangerousInsecureTransportProtocol": false,
            }),
        );
    }

    pub fn validate_runtime(
        &self,
        qa_profile: Option<&Path>,
        executable: &Path,
        data_root: &Path,
        release_arm64: bool,
    ) -> Result<(), String> {
        if !self.admits_profile(qa_profile, release_arm64) {
            return Err("Updater build/profile binding is inactive.".into());
        }
        if self.mode == Mode::Production {
            if self.feed_origin != "https://api.github.com" || self.public_key.is_empty() {
                return Err("Invalid production updater binding.".into());
            }
            return Ok(());
        }
        let root = self
            .qa_root
            .as_deref()
            .ok_or("Missing compiled updater QA root.")?;
        let metadata = fs::symlink_metadata(root).map_err(|_| "Updater QA root is unavailable.")?;
        let canonical = root
            .canonicalize()
            .map_err(|_| "Updater QA root is unavailable.")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o7777 != 0o700
            || canonical != root
            || root.parent()
                != Some(
                    fs::canonicalize(std::env::temp_dir())
                        .map_err(|_| "Updater QA temporary root is unavailable.")?
                        .as_path(),
                )
        {
            return Err("Updater QA root no longer matches its private build binding.".into());
        }
        // Even a matching --qa-profile cannot enable a production/foreign app.
        let executable = executable
            .canonicalize()
            .map_err(|_| "Updater QA app is unavailable.")?;
        let data_root = data_root
            .canonicalize()
            .map_err(|_| "Updater QA data is unavailable.")?;
        if !executable.starts_with(root)
            || data_root != root.join("home/.gajae-app")
            || executable.parent().and_then(Path::file_name) != Some(std::ffi::OsStr::new("MacOS"))
            || executable
                .parent()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                != Some(std::ffi::OsStr::new("Contents"))
            || executable
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .and_then(Path::file_name)
                != Some(std::ffi::OsStr::new(&format!(
                    "{}.app",
                    env!("GJC_UPDATE_PRODUCT_NAME")
                )))
        {
            return Err(
                "Updater QA executable/data are outside the compiled isolated profile.".into(),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn official_plugin_configuration_is_supplied_only_for_admitted_profiles() {
        let root = Path::new("/qa-profile");
        let mut config = tauri::Config::default();
        let mut binding = Binding {
            mode: Mode::Disabled,
            feed_origin: String::new(),
            public_key: "public-test-key".into(),
            qa_root: None,
        };
        binding.configure_plugin(&mut config, None, true);
        assert!(!config.plugins.0.contains_key("updater"));
        binding.mode = Mode::Qa;
        binding.qa_root = Some(root.into());
        binding.configure_plugin(&mut config, None, true);
        assert!(!config.plugins.0.contains_key("updater"));
        binding.configure_plugin(&mut config, Some(root), false);
        let decoded: tauri_plugin_updater::Config =
            serde_json::from_value(config.plugins.0["updater"].clone()).unwrap();
        assert_eq!(decoded.pubkey, "public-test-key");
        assert!(decoded.endpoints.is_empty());
        assert!(!decoded.dangerous_insecure_transport_protocol);
        assert!(
            serde_json::from_value::<tauri_plugin_updater::Config>(serde_json::json!({})).is_err(),
            "Builder's key override cannot repair missing Config.pubkey during deserialization"
        );
    }

    #[test]
    fn qa_executable_cannot_launch_with_missing_or_foreign_profile_before_any_io() {
        let root = Path::new("/uncreated-qa-profile");
        let mut binding = Binding {
            mode: Mode::Qa,
            feed_origin: String::new(),
            public_key: String::new(),
            qa_root: Some(root.into()),
        };
        assert!(binding.validate_launch_profile(None).is_err());
        assert!(binding
            .validate_launch_profile(Some(Path::new("/foreign")))
            .is_err());
        assert!(binding.validate_launch_profile(Some(root)).is_ok());
        binding.mode = Mode::Disabled;
        assert!(binding.validate_launch_profile(None).is_ok());
        assert!(binding.validate_launch_profile(Some(root)).is_ok());
    }

    #[test]
    fn disabled_development_and_unbound_qa_are_inert_before_io() {
        let absent = Path::new("/does-not-exist/updater-tests");
        let mut binding = Binding {
            mode: Mode::Disabled,
            feed_origin: String::new(),
            public_key: String::new(),
            qa_root: None,
        };
        assert!(!binding.admits_profile(None, true));
        assert!(binding
            .validate_runtime(None, absent, absent, true)
            .is_err());
        binding.mode = Mode::Production;
        assert!(!binding.admits_profile(None, false));
        assert!(!binding.admits_profile(Some(absent), true));
        binding.mode = Mode::Qa;
        assert!(!binding.admits_profile(Some(absent), true));
        assert!(!absent.exists());
    }

    #[test]
    fn matching_qa_profile_still_rejects_a_foreign_executable_or_data_root() {
        let mut random = [0; 8];
        getrandom::getrandom(&mut random).unwrap();
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "gajae-binding-runtime-{:x}",
                u64::from_ne_bytes(random)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let data = root.join("home/.gajae-app");
        fs::create_dir_all(&data).unwrap();
        let binary = root.join(format!(
            "{}.app/Contents/MacOS/app",
            env!("GJC_UPDATE_PRODUCT_NAME")
        ));
        fs::create_dir_all(binary.parent().unwrap()).unwrap();
        fs::write(&binary, b"fixture").unwrap();
        let binding = Binding {
            mode: Mode::Qa,
            feed_origin: "https://127.0.0.1:44321".into(),
            public_key: "test".into(),
            qa_root: Some(root.clone()),
        };
        assert!(binding
            .validate_runtime(Some(&root), &binary, &data, true)
            .is_ok());
        assert!(binding
            .validate_runtime(Some(&root), Path::new("/bin/sh"), &data, true)
            .is_err());
        assert!(binding
            .validate_runtime(Some(&root), &binary, &root, true)
            .is_err());
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(binding
            .validate_runtime(Some(&root), &binary, &data, true)
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
