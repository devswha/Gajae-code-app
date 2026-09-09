//! Disposable macOS-only updater probe.
//!
//! This binary deliberately registers the official updater plugin only in this
//! example. It never uses the production application state, server, feed, or
//! keys. The parent process must create the fixture root and schema-2 marker
//! first.
//! The root marker is schema-versioned and must explicitly identify either a
//! `marker_only` observation fixture rooted at `A.app` or a `signed_bundle`
//! fixture rooted at the canonical `Gajae Code App.app`.
//!
//! The install scenario exercises the plugin's real `check` and
//! `Update::install` APIs. The native HTTPS client streams the official archive
//! URL through a hard cap, then the downloaded bytes are verified with the
//! maintained `minisign-verify` crate using the signature returned by the
//! official check; that exact buffer is passed to `install`. The plugin's
//! unbounded `download` API is intentionally not called. Native manifest and
//! archive requests and the plugin check use fixture-root `qa-ca.pem`; TLS
//! validation remains enabled and no invalid-certificate bypass is exposed.

#[cfg(target_os = "macos")]
#[path = "../src/updater_transport.rs"]
// The probe uses bounded body helpers, not preparation redirect metadata.
#[allow(dead_code)]
mod updater_transport;

#[cfg(target_os = "macos")]
mod macos_probe {
    use std::{
        env,
        fs::{self, File, FileType},
        io::{self, Read, Write},
        net::IpAddr,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
        panic::{self, AssertUnwindSafe},
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, AtomicI32, Ordering},
            mpsc, Arc,
        },
        thread,
        time::{Duration, Instant},
    };

    use base64::{engine::general_purpose::STANDARD, Engine};
    use reqwest::{redirect::Policy, Url};
    use serde::Deserialize;
    use serde_json::{json, Value};
    use tauri::{AppHandle, Context, RunEvent, Wry};
    use tauri_plugin_updater::{Update, UpdaterExt};

    use super::updater_transport::{self, TransportError};

    const PLUGIN_VERSION: &str = "2.6.0";
    const PROBE_IDENTIFIER: &str = "app.gajae.updater.probe";
    const PROBE_PRODUCT_NAME: &str = "Gajae Updater Probe";
    const ROOT_MARKER_NAME: &str = ".gajae-updater-probe-root";
    const ROOT_MARKER_PURPOSE: &str = "gajae-updater-probe";
    const ROOT_MARKER_FIXTURE: &str = "disposable-a-to-b";
    const ROOT_PREFIX: &str = "gajae-updater-probe-";
    // The marker-only fixture is intentionally a tiny disposable shell app.
    // Signed fixtures use the same updater target name as release archives.
    const MARKER_APP_DIR_NAME: &str = "A.app";
    const SIGNED_APP_DIR_NAME: &str = "Gajae Code App.app";
    const SIGNED_EXECUTABLE_BASENAME: &str = "gajae-app-desktop";
    const ARCHIVE_NAME: &str = "B.app.tar.gz";
    const MANIFEST_NAME: &str = "update.json";
    // This file stores the base64 public-key value expected by Tauri's
    // updater config, not private key material. The decoded text is the
    // standard two-line minisign public-key file.
    const PUBLIC_KEY_NAME: &str = "qa-public.key";
    const CA_CERTIFICATE_NAME: &str = "qa-ca.pem";
    const APP_MARKER_RELATIVE: &str = "Contents/Resources/gajae-updater-probe.txt";
    const APP_MARKER_A: &[u8] = b"gajae-updater-probe/A\n";
    const APP_MARKER_B: &[u8] = b"gajae-updater-probe/B\n";
    const MAX_ROOT_MARKER_BYTES: u64 = 16 * 1024;
    const MAX_APP_MARKER_BYTES: u64 = 1024;
    const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
    const MAX_PUBLIC_KEY_BYTES: u64 = 16 * 1024;
    const MAX_CA_CERTIFICATE_BYTES: u64 = 64 * 1024;
    const MAX_ARCHIVE_BYTES: u64 = 250 * 1024 * 1024;
    const MAX_NATIVE_MANIFEST_BYTES: u64 = 64 * 1024;
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
    const TOTAL_TIMEOUT: Duration = Duration::from_secs(5);
    const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(60);
    const INSTALL_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(100);
    const INSTALL_HEARTBEAT_DEADLINE: Duration = Duration::from_secs(60);

    #[derive(Clone, Copy, Debug)]
    enum Scenario {
        Check,
        Reconstruct,
        Install,
    }

    impl Scenario {
        fn parse(value: &str) -> Result<Self, ProbeError> {
            match value {
                "check" => Ok(Self::Check),
                "reconstruct" => Ok(Self::Reconstruct),
                "install" => Ok(Self::Install),
                _ => Err(ProbeError::new(
                    "invalid_arguments",
                    "--scenario must be check, reconstruct, or install",
                )),
            }
        }

        fn as_str(self) -> &'static str {
            match self {
                Self::Check => "check",
                Self::Reconstruct => "reconstruct",
                Self::Install => "install",
            }
        }

        fn requires_install(self) -> bool {
            matches!(self, Self::Install)
        }
    }

    #[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    enum ProofKind {
        MarkerOnly,
        SignedBundle,
    }

    impl ProofKind {
        fn as_str(self) -> &'static str {
            match self {
                Self::MarkerOnly => "marker_only",
                Self::SignedBundle => "signed_bundle",
            }
        }

        fn requires_marker(self) -> bool {
            matches!(self, Self::MarkerOnly)
        }
    }

    #[derive(Clone, Debug)]
    struct Options {
        root: PathBuf,
        scenario: Scenario,
        endpoint: Url,
        expected_version: Option<String>,
    }

    #[derive(Debug)]
    struct ProbeError {
        code: &'static str,
        message: String,
        details: Value,
    }

    impl ProbeError {
        fn new(code: &'static str, message: impl Into<String>) -> Self {
            Self {
                code,
                message: message.into(),
                details: Value::Null,
            }
        }

        fn with_details(mut self, details: Value) -> Self {
            self.details = details;
            self
        }

        fn with_code(mut self, code: &'static str) -> Self {
            self.code = code;
            self
        }
    }

    #[derive(Clone, Debug)]
    struct Fixture {
        root: PathBuf,
        proof_kind: ProofKind,
        executable_basename: String,
        current_desktop_version: String,
        app_dir: PathBuf,
        app_executable: PathBuf,
        app_marker: Option<PathBuf>,
        archive_size: u64,
        manifest: PathBuf,
        public_key: PathBuf,
        ca_certificate: PathBuf,
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RootMarker {
        schema: u32,
        purpose: String,
        root: String,
        fixture: String,
        proof_kind: ProofKind,
        app: String,
        archive: String,
        manifest: String,
        public_key: String,
        executable_basename: String,
        current_desktop_version: String,
    }

    #[derive(Debug)]
    struct InstallHeartbeat {
        attempts: u64,
        responsive: u64,
        timeouts: u64,
        max_latency_ms: u128,
        elapsed_ms: u128,
        stopped_reason: &'static str,
    }

    struct InstallHeartbeatHandle {
        stop: Arc<AtomicBool>,
        join: thread::JoinHandle<InstallHeartbeat>,
    }

    impl InstallHeartbeat {
        fn as_json(&self) -> Value {
            json!({
                "attempts": self.attempts,
                "responsive": self.responsive,
                "timeouts": self.timeouts,
                "max_latency_ms": self.max_latency_ms,
                "elapsed_ms": self.elapsed_ms,
                "observation_deadline_ms": INSTALL_HEARTBEAT_DEADLINE.as_millis(),
                "stopped_reason": self.stopped_reason,
                "first_timeout_stops_observation": true,
            })
        }
    }

    pub fn run() {
        if !cfg!(target_arch = "aarch64") {
            print_standalone_error(ProbeError::new(
                "unsupported_arch",
                "updater_probe is restricted to macOS arm64",
            ));
        }
        let options = match parse_args(env::args_os().skip(1)) {
            Ok(Some(options)) => options,
            Ok(None) => return,
            Err(error) => print_standalone_error(error),
        };

        let fixture = match load_fixture(&options.root) {
            Ok(fixture) => fixture,
            Err(error) => print_standalone_error(error),
        };

        if let Err(error) = validate_endpoint(&options.endpoint) {
            print_fixture_error(error, &fixture);
        }

        let key_config = match read_bounded_text(&fixture.public_key, MAX_PUBLIC_KEY_BYTES) {
            Ok(key) => key.trim().to_owned(),
            Err(error) => print_fixture_error(error.with_code("invalid_fixture"), &fixture),
        };
        if key_config.is_empty() {
            print_fixture_error(
                ProbeError::new("invalid_fixture", "the QA public key is empty"),
                &fixture,
            );
        }
        let key_text = match decode_public_key_config(&key_config) {
            Ok(key_text) => key_text,
            Err(error) => print_fixture_error(error, &fixture),
        };
        if key_text.to_ascii_lowercase().contains("private")
            || key_text.to_ascii_lowercase().contains("secret key")
        {
            print_fixture_error(
                ProbeError::new(
                    "production_key_refused",
                    "the fixture key looks like private or secret key material",
                ),
                &fixture,
            );
        }
        if let Err(error) = minisign_verify::PublicKey::decode(&key_text) {
            print_fixture_error(
                ProbeError::new(
                    "invalid_fixture_key",
                    format!("QA public key text is not valid Minisign data: {error}"),
                ),
                &fixture,
            );
        }
        if let Err(error) = validate_manifest_fixture(&fixture, &options) {
            print_fixture_error(error, &fixture);
        }

        let mut context = probe_context();
        if let Err(error) = configure_probe_context(
            &mut context,
            &fixture.current_desktop_version,
            &key_config,
            &options.endpoint,
        ) {
            print_fixture_error(error, &fixture);
        }

        let updater_plugin = tauri_plugin_updater::Builder::new()
            .pubkey(key_config)
            .build();
        let install_active = Arc::new(AtomicBool::new(false));
        let outcome_code = Arc::new(AtomicI32::new(2));
        let worker_outcome_code = Arc::clone(&outcome_code);
        let worker_active = Arc::clone(&install_active);
        let worker_options = options.clone();
        let worker_fixture = fixture.clone();

        let app = match tauri::Builder::default()
            // This registration is intentionally scoped to the standalone
            // probe; production main.rs remains updater-free in P0.
            .plugin(updater_plugin)
            .setup(move |app| {
                let app_handle = app.handle().clone();
                let run_options = worker_options.clone();
                let run_fixture = worker_fixture.clone();
                let active = Arc::clone(&worker_active);
                thread::spawn(move || {
                    let result = execute(&app_handle, &run_options, &run_fixture, active.as_ref());
                    let exit_code = match result {
                        Ok(value) => {
                            print_outcome(value);
                            0
                        }
                        Err(error) => {
                            print_outcome(error_outcome(
                                error,
                                Some(&run_options),
                                Some(&run_fixture),
                            ));
                            1
                        }
                    };
                    worker_outcome_code.store(exit_code, Ordering::Release);
                    app_handle.exit(exit_code);
                });
                Ok(())
            })
            .build(context)
        {
            Ok(app) => app,
            Err(error) => print_fixture_error(
                ProbeError::new(
                    "app_build_failed",
                    format!("failed to initialize the probe app: {error}"),
                ),
                &fixture,
            ),
        };

        let exit_code = app.run_return(move |_, event| {
            // A user quit request must not tear down the event thread while
            // Update::install may be synchronously waiting for its official
            // macOS authorization closure to run here. Apple events that
            // bypass this preventable event remain a manual fault-injection
            // branch and are reported by the resulting installer outcome.
            if let RunEvent::ExitRequested { api, .. } = event {
                if install_active.load(Ordering::Acquire) {
                    api.prevent_exit();
                }
            }
        });
        let outcome_code = outcome_code.load(Ordering::Acquire);
        if exit_code != 0 || outcome_code != 0 {
            std::process::exit(if exit_code != 0 {
                exit_code
            } else {
                outcome_code
            });
        }
    }

    fn parse_args<I>(args: I) -> Result<Option<Options>, ProbeError>
    where
        I: IntoIterator<Item = std::ffi::OsString>,
    {
        let mut root = None;
        let mut scenario = Scenario::Check;
        let mut endpoint = None;
        let mut expected_version = None;
        let mut args = args.into_iter();

        while let Some(argument) = args.next() {
            let argument = argument.to_str().ok_or_else(|| {
                ProbeError::new("invalid_arguments", "arguments must be valid UTF-8")
            })?;
            match argument {
                "--help" | "-h" => {
                    print_usage();
                    return Ok(None);
                }
                "--root" => {
                    root = Some(PathBuf::from(next_value(&mut args, "--root")?));
                }
                "--scenario" => {
                    scenario = Scenario::parse(&next_value(&mut args, "--scenario")?)?;
                }
                "--endpoint" => {
                    let value = next_value(&mut args, "--endpoint")?;
                    endpoint = Some(value.parse::<Url>().map_err(|error| {
                        ProbeError::new(
                            "invalid_endpoint",
                            format!("--endpoint is not a valid URL: {error}"),
                        )
                    })?);
                }
                "--expected-version" => {
                    let value = next_value(&mut args, "--expected-version")?;
                    if value.trim().is_empty() {
                        return Err(ProbeError::new(
                            "invalid_arguments",
                            "--expected-version cannot be empty",
                        ));
                    }
                    expected_version = Some(value);
                }
                _ if argument.starts_with('-') => {
                    return Err(ProbeError::new(
                        "invalid_arguments",
                        format!("unknown option `{argument}`"),
                    ));
                }
                _ => {
                    return Err(ProbeError::new(
                        "invalid_arguments",
                        format!("unexpected positional argument `{argument}`"),
                    ));
                }
            }
        }

        let root = root.ok_or_else(|| {
            ProbeError::new(
                "invalid_arguments",
                "--root is required; the probe never creates fixture roots",
            )
        })?;
        let endpoint = endpoint.ok_or_else(|| {
            ProbeError::new(
                "invalid_arguments",
                "--endpoint is required and must be the local HTTPS manifest URL",
            )
        })?;
        if scenario.requires_install() && expected_version.is_none() {
            return Err(ProbeError::new(
                "invalid_arguments",
                "--expected-version is required for --scenario install",
            ));
        }

        Ok(Some(Options {
            root,
            scenario,
            endpoint,
            expected_version,
        }))
    }

    fn next_value<I>(args: &mut I, option: &str) -> Result<String, ProbeError>
    where
        I: Iterator<Item = std::ffi::OsString>,
    {
        args.next()
            .ok_or_else(|| ProbeError::new("invalid_arguments", format!("{option} needs a value")))
            .and_then(|value| {
                value.to_str().map(str::to_owned).ok_or_else(|| {
                    ProbeError::new("invalid_arguments", format!("{option} must be UTF-8"))
                })
            })
    }

    fn load_fixture(root_arg: &Path) -> Result<Fixture, ProbeError> {
        let root_argument_metadata = fs::symlink_metadata(root_arg).map_err(|error| {
            ProbeError::new(
                "invalid_fixture",
                format!("cannot inspect --root before canonicalization: {error}"),
            )
        })?;
        if root_argument_metadata.file_type().is_symlink() {
            return Err(ProbeError::new(
                "fixture_symlink_refused",
                "--root must not be a symlink",
            ));
        }
        if !root_argument_metadata.is_dir() {
            return Err(ProbeError::new(
                "invalid_fixture",
                "--root must be a directory",
            ));
        }
        let root = fs::canonicalize(root_arg).map_err(|error| {
            ProbeError::new(
                "invalid_fixture",
                format!("cannot canonicalize --root: {error}"),
            )
        })?;
        let root_metadata = fs::symlink_metadata(&root).map_err(|error| {
            ProbeError::new("invalid_fixture", format!("cannot inspect --root: {error}"))
        })?;
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            return Err(ProbeError::new(
                "invalid_fixture",
                "--root must be a real directory, not a symlink",
            ));
        }
        validate_fixture_root(&root)?;

        let root_marker_path = root.join(ROOT_MARKER_NAME);
        ensure_regular(&root_marker_path, "root marker")?;
        let marker_text = read_bounded_text(&root_marker_path, MAX_ROOT_MARKER_BYTES)?;
        let marker: RootMarker = serde_json::from_str(&marker_text).map_err(|error| {
            ProbeError::new(
                "invalid_fixture",
                format!("root marker is not valid probe JSON: {error}"),
            )
        })?;
        if marker.schema != 2
            || marker.purpose != ROOT_MARKER_PURPOSE
            || marker.fixture != ROOT_MARKER_FIXTURE
            || marker.archive != ARCHIVE_NAME
            || marker.manifest != MANIFEST_NAME
            || marker.public_key != PUBLIC_KEY_NAME
        {
            return Err(ProbeError::new(
                "invalid_fixture",
                "root marker does not match the schema-2 disposable A-to-B probe contract",
            ));
        }
        let expected_app_dir = expected_app_dir_name(marker.proof_kind);
        validate_app_root_name(marker.proof_kind, &marker.app)?;
        if marker.proof_kind == ProofKind::SignedBundle
            && marker.executable_basename != SIGNED_EXECUTABLE_BASENAME
        {
            return Err(ProbeError::new(
                "invalid_fixture",
                format!("signed_bundle executable_basename must be {SIGNED_EXECUTABLE_BASENAME}"),
            ));
        }
        validate_executable_basename(&marker.executable_basename)?;
        validate_desktop_version(&marker.current_desktop_version)?;
        let marker_root = PathBuf::from(&marker.root);
        if !marker_root.is_absolute() || marker_root.as_path() != root {
            return Err(ProbeError::new(
                "fixture_root_binding_mismatch",
                "root marker is not bound to this canonical fixture directory",
            ));
        }

        let app_dir = root.join(expected_app_dir);
        let app_executable = app_dir
            .join("Contents")
            .join("MacOS")
            .join(&marker.executable_basename);
        let app_marker_path = app_dir.join(APP_MARKER_RELATIVE);
        let archive = root.join(ARCHIVE_NAME);
        let manifest = root.join(MANIFEST_NAME);
        let public_key = root.join(PUBLIC_KEY_NAME);
        let ca_certificate = root.join(CA_CERTIFICATE_NAME);
        let app_contents = app_dir.join("Contents");
        let app_macos = app_contents.join("MacOS");
        ensure_directory(&app_dir, expected_app_dir)?;
        ensure_directory(&app_contents, &format!("{expected_app_dir}/Contents"))?;
        ensure_directory(&app_macos, &format!("{expected_app_dir}/Contents/MacOS"))?;
        ensure_regular(&app_executable, "fixture app executable")?;
        let app_marker = if marker.proof_kind.requires_marker() {
            ensure_regular(&app_marker_path, "marker-only A.app fixture marker")?;
            Some(app_marker_path)
        } else {
            None
        };
        ensure_regular(&archive, "B.app archive")?;
        ensure_regular(&manifest, "update manifest")?;
        ensure_regular(&public_key, "QA public key")?;
        ensure_regular(&ca_certificate, "QA CA certificate")?;
        let mut fixture_paths = vec![
            &app_dir,
            &app_executable,
            &archive,
            &manifest,
            &public_key,
            &ca_certificate,
        ];
        if let Some(app_marker) = app_marker.as_ref() {
            fixture_paths.push(app_marker);
        }
        for path in fixture_paths {
            let canonical = fs::canonicalize(path).map_err(|error| {
                ProbeError::new(
                    "invalid_fixture",
                    format!(
                        "cannot canonicalize fixture path {}: {error}",
                        path.display()
                    ),
                )
            })?;
            if !canonical.starts_with(&root) {
                return Err(ProbeError::new(
                    "fixture_path_escape",
                    "fixture path escapes the bound root",
                ));
            }
        }
        if let Some(app_marker) = app_marker.as_ref() {
            let marker_bytes = read_bounded_bytes(app_marker, MAX_APP_MARKER_BYTES)?;
            if marker_bytes != APP_MARKER_A {
                return Err(ProbeError::new(
                    "invalid_fixture",
                    "marker-only fixture marker must identify version A",
                ));
            }
        }

        let archive_size = open_bounded_regular(&archive).and_then(|file| {
            file.metadata()
                .map(|metadata| metadata.len())
                .map_err(|error| {
                    ProbeError::new(
                        "invalid_fixture",
                        format!(
                            "cannot fstat fixture archive {}: {error}",
                            archive.display()
                        ),
                    )
                })
        })?;
        if archive_size == 0 || archive_size > MAX_ARCHIVE_BYTES {
            return Err(ProbeError::new(
                "invalid_fixture",
                format!("B.app archive size must be between 1 and {MAX_ARCHIVE_BYTES} bytes"),
            ));
        }

        Ok(Fixture {
            root,
            proof_kind: marker.proof_kind,
            executable_basename: marker.executable_basename,
            current_desktop_version: marker.current_desktop_version,
            app_dir,
            app_executable,
            app_marker,
            archive_size,
            manifest,
            public_key,
            ca_certificate,
        })
    }

    fn validate_executable_basename(name: &str) -> Result<(), ProbeError> {
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.contains('/')
            || name.contains('\\')
            || name.contains('\0')
            || name.chars().any(char::is_whitespace)
        {
            return Err(ProbeError::new(
                "invalid_fixture",
                "executable_basename must be one non-empty path component without whitespace",
            ));
        }
        Ok(())
    }

    fn expected_app_dir_name(proof_kind: ProofKind) -> &'static str {
        match proof_kind {
            ProofKind::MarkerOnly => MARKER_APP_DIR_NAME,
            ProofKind::SignedBundle => SIGNED_APP_DIR_NAME,
        }
    }

    fn validate_app_root_name(
        proof_kind: ProofKind,
        app_root_name: &str,
    ) -> Result<(), ProbeError> {
        let expected = expected_app_dir_name(proof_kind);
        if app_root_name != expected {
            return Err(ProbeError::new(
                "invalid_fixture",
                format!(
                    "root marker app must be {expected} for proof_kind {}",
                    proof_kind.as_str()
                ),
            ));
        }
        Ok(())
    }

    fn set_context_version(context: &mut Context<Wry>, version: &str) -> Result<(), ProbeError> {
        context.package_info_mut().version = version.parse().map_err(|error| {
            ProbeError::new(
                "invalid_fixture",
                format!("current_desktop_version is not accepted by Tauri: {error}"),
            )
        })?;
        Ok(())
    }

    // Expand the embedded Info.plist once, with a non-production identity.
    fn probe_context() -> Context<Wry> {
        tauri::generate_context!("examples/tauri.conf.json")
    }

    fn configure_probe_context(
        context: &mut Context<Wry>,
        version: &str,
        key_config: &str,
        endpoint: &Url,
    ) -> Result<(), ProbeError> {
        set_context_version(context, version)?;
        let config = context.config_mut();
        // The pinned runtime's automatic WindowConfig conversion can drop
        // data_store_identifier. Avoid WebView creation entirely: this probe
        // exercises only the event loop and official updater installer.
        config.app.windows.clear();
        config.identifier = PROBE_IDENTIFIER.to_string();
        config.product_name = Some(PROBE_PRODUCT_NAME.to_string());
        config.plugins.0.insert(
            "updater".to_string(),
            json!({
                "pubkey": key_config,
                "endpoints": [endpoint.as_str()],
                "dangerousInsecureTransportProtocol": false
            }),
        );
        Ok(())
    }

    fn validate_desktop_version(version: &str) -> Result<(), ProbeError> {
        semver::Version::parse(version)
            .map(|_| ())
            .map_err(|error| {
                ProbeError::new(
                    "invalid_fixture",
                    format!("current_desktop_version must be a semantic version: {error}"),
                )
            })
    }

    fn validate_fixture_root(root: &Path) -> Result<(), ProbeError> {
        let name = root
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                ProbeError::new("invalid_fixture_root", "fixture root has no UTF-8 name")
            })?;
        if !name.starts_with(ROOT_PREFIX) {
            return Err(ProbeError::new(
                "production_root_refused",
                "fixture root must use the gajae-updater-probe- prefix",
            ));
        }

        let temp_dir = fs::canonicalize(env::temp_dir()).map_err(|error| {
            ProbeError::new(
                "invalid_fixture_root",
                format!("cannot canonicalize the system temporary directory: {error}"),
            )
        })?;
        if root.parent() != Some(temp_dir.as_path()) {
            return Err(ProbeError::new(
                "production_root_refused",
                "fixture root must be a direct child of the system temporary directory",
            ));
        }

        if let Some(home) = env::var_os("HOME") {
            if let Ok(home) = fs::canonicalize(home) {
                if root.starts_with(home) {
                    return Err(ProbeError::new(
                        "production_root_refused",
                        "fixture root must not be under the production home directory",
                    ));
                }
            }
        }
        for production_root in [
            Path::new("/Applications"),
            Path::new("/System/Applications"),
        ] {
            if root.starts_with(production_root) {
                return Err(ProbeError::new(
                    "production_root_refused",
                    "fixture root must not be an application installation path",
                ));
            }
        }
        let metadata = fs::symlink_metadata(root).map_err(|error| {
            ProbeError::new(
                "invalid_fixture_root",
                format!("cannot inspect fixture root ownership and mode: {error}"),
            )
        })?;
        validate_fixture_owner_mode(metadata.uid(), metadata.mode() & 0o7777)?;
        Ok(())
    }

    fn validate_fixture_owner_mode(uid: u32, mode: u32) -> Result<(), ProbeError> {
        let effective_uid = unsafe { libc::geteuid() as u32 };
        if uid != effective_uid {
            return Err(ProbeError::new(
                "fixture_owner_refused",
                "fixture root must be owned by the current effective user",
            ));
        }
        if mode != 0o700 && mode != 0o500 {
            return Err(ProbeError::new(
                "fixture_mode_refused",
                "fixture root permissions must be exactly 0700 or 0500",
            ));
        }
        Ok(())
    }

    fn validate_install_volume(root: &Path, app_dir: &Path) -> Result<(), ProbeError> {
        validate_fixture_root(root)?;
        let root = ensure_path_type(root, "fixture root")?;
        let app = ensure_path_type(app_dir, "fixture app")?;
        let temporary = fs::metadata(env::temp_dir()).map_err(|error| {
            ProbeError::new(
                "invalid_fixture_root",
                format!("cannot inspect installer temporary volume: {error}"),
            )
        })?;
        if !root.is_dir()
            || !app.is_dir()
            || !temporary.is_dir()
            || root.dev() != temporary.dev()
            || app.dev() != temporary.dev()
        {
            return Err(ProbeError::new(
                "installation_volume_refused",
                "fixture root, app and installer temporary directory must share one volume",
            ));
        }
        Ok(())
    }

    fn ensure_directory(path: &Path, description: &str) -> Result<(), ProbeError> {
        let metadata = ensure_path_type(path, description)?;
        if !metadata.is_dir() {
            return Err(ProbeError::new(
                "invalid_fixture",
                format!("{description} must be a directory"),
            ));
        }
        Ok(())
    }

    fn ensure_regular(path: &Path, description: &str) -> Result<(), ProbeError> {
        let metadata = ensure_path_type(path, description)?;
        if !metadata.is_file() {
            return Err(ProbeError::new(
                "invalid_fixture",
                format!("{description} must be a regular file"),
            ));
        }
        Ok(())
    }

    fn ensure_path_type(path: &Path, description: &str) -> Result<fs::Metadata, ProbeError> {
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            ProbeError::new(
                "invalid_fixture",
                format!("cannot inspect {description} {}: {error}", path.display()),
            )
        })?;
        let file_type: FileType = metadata.file_type();
        if file_type.is_symlink() {
            return Err(ProbeError::new(
                "fixture_symlink_refused",
                format!("{description} must not be a symlink"),
            ));
        }
        Ok(metadata)
    }

    fn read_bounded_text(path: &Path, max_bytes: u64) -> Result<String, ProbeError> {
        String::from_utf8(read_bounded_bytes(path, max_bytes)?).map_err(|error| {
            ProbeError::new(
                "invalid_fixture",
                format!("{} is not valid UTF-8 text: {error}", path.display()),
            )
        })
    }

    fn validate_endpoint(endpoint: &Url) -> Result<(), ProbeError> {
        if endpoint.scheme() != "https" {
            return Err(ProbeError::new(
                "production_feed_refused",
                "the probe accepts HTTPS endpoints only",
            ));
        }
        if endpoint.port().is_none() {
            return Err(ProbeError::new(
                "production_feed_refused",
                "the probe requires an explicit local HTTPS port",
            ));
        }
        if endpoint.username() != "" || endpoint.password().is_some() {
            return Err(ProbeError::new(
                "production_feed_refused",
                "endpoint credentials are never accepted",
            ));
        }
        if endpoint.query().is_some() || endpoint.fragment().is_some() {
            return Err(ProbeError::new(
                "production_feed_refused",
                "endpoint query strings and fragments are not accepted",
            ));
        }
        if !is_loopback_host(endpoint.host_str()) {
            return Err(ProbeError::new(
                "production_feed_refused",
                "the probe endpoint host must be localhost or a loopback IP",
            ));
        }
        Ok(())
    }

    fn is_loopback_host(host: Option<&str>) -> bool {
        let Some(host) = host else {
            return false;
        };
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .map(|address| address.is_loopback())
                .unwrap_or(false)
    }

    fn same_origin(left: &Url, right: &Url) -> bool {
        left.scheme().eq_ignore_ascii_case(right.scheme())
            && left
                .host_str()
                .zip(right.host_str())
                .map(|(left, right)| left.eq_ignore_ascii_case(right))
                .unwrap_or(false)
            && left.port() == right.port()
    }

    fn is_fixed_archive_url(endpoint: &Url, archive_url: &Url) -> bool {
        same_origin(endpoint, archive_url)
            && archive_url.path() == format!("/{ARCHIVE_NAME}")
            && archive_url.query().is_none()
            && archive_url.fragment().is_none()
    }

    fn validate_manifest_fixture(fixture: &Fixture, options: &Options) -> Result<(), ProbeError> {
        let text = read_bounded_text(&fixture.manifest, MAX_MANIFEST_BYTES)?;
        let value: Value = serde_json::from_str(&text).map_err(|error| {
            ProbeError::new(
                "invalid_fixture",
                format!("update manifest is not valid JSON: {error}"),
            )
        })?;
        let version = value
            .get("version")
            .or_else(|| value.get("name"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProbeError::new(
                    "invalid_fixture",
                    "update manifest needs a version or name field",
                )
            })?;
        if let Some(expected) = options.expected_version.as_deref() {
            if version.trim_start_matches('v') != expected.trim_start_matches('v') {
                return Err(ProbeError::new(
                    "fixture_identity_mismatch",
                    "local update manifest version does not match --expected-version",
                ));
            }
        }
        let platform = value
            .get("platforms")
            .and_then(|platforms| platforms.get("darwin-aarch64"));
        let (url_value, signature_value) = if let Some(platform) = platform {
            (
                platform.get("url").and_then(Value::as_str),
                platform.get("signature").and_then(Value::as_str),
            )
        } else {
            (
                value.get("url").and_then(Value::as_str),
                value.get("signature").and_then(Value::as_str),
            )
        };
        let archive_url = url_value
            .ok_or_else(|| ProbeError::new("invalid_fixture", "manifest has no archive URL"))?
            .parse::<Url>()
            .map_err(|error| ProbeError::new("invalid_fixture", error.to_string()))?;
        validate_endpoint(&archive_url)?;
        if !is_fixed_archive_url(&options.endpoint, &archive_url) {
            return Err(ProbeError::new(
                "production_feed_refused",
                "manifest archive URL must be the local fixture archive on the endpoint origin",
            ));
        }
        if signature_value
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
        {
            return Err(ProbeError::new(
                "invalid_fixture",
                "manifest archive signature is empty",
            ));
        }
        Ok(())
    }

    fn execute(
        app: &AppHandle<Wry>,
        options: &Options,
        fixture: &Fixture,
        install_active: &AtomicBool,
    ) -> Result<Value, ProbeError> {
        let local_manifest = read_bounded_bytes(&fixture.manifest, MAX_MANIFEST_BYTES)?;
        let key_config = read_bounded_text(&fixture.public_key, MAX_PUBLIC_KEY_BYTES)?;
        let key_text = decode_public_key_config(key_config.trim())?;
        let ca_pem = read_bounded_bytes(&fixture.ca_certificate, MAX_CA_CERTIFICATE_BYTES)?;
        let ca_certificate = reqwest::Certificate::from_pem(&ca_pem).map_err(|error| {
            ProbeError::new(
                "invalid_fixture_ca",
                format!("QA CA certificate is not valid PEM: {error}"),
            )
        })?;

        let main_thread_before = main_thread_ping(app);
        if !main_thread_before {
            return Err(ProbeError::new(
                "main_thread_unavailable",
                "the Tauri event thread did not acknowledge the preflight ping",
            ));
        }

        let extract_path = tauri_plugin_updater::extract_path_from_executable(
            &fixture.app_executable,
        )
        .map_err(|error| {
            ProbeError::new(
                "fixture_target_rejected",
                format!("official updater could not derive the fixture app path: {error}"),
            )
        })?;
        let canonical_app = fs::canonicalize(&fixture.app_dir).map_err(|error| {
            ProbeError::new(
                "invalid_fixture",
                format!("cannot canonicalize the fixture app: {error}"),
            )
        })?;
        if extract_path != canonical_app {
            return Err(ProbeError::new(
                "fixture_target_rejected",
                "official updater extract path is not exactly the bound fixture app",
            ));
        }

        let preflight_started = Instant::now();
        let native_client = updater_transport::build_client(
            Some(ca_certificate.clone()),
            CONNECT_TIMEOUT,
            TOTAL_TIMEOUT,
        )
        .map_err(|error| {
            ProbeError::new(
                "native_check_configuration_rejected",
                format!("native manifest client failed to build: {error}"),
            )
        })?;
        let native_manifest = tauri::async_runtime::block_on(updater_transport::fetch_manifest(
            &native_client,
            &options.endpoint,
            MAX_NATIVE_MANIFEST_BYTES,
        ))
        .map_err(|error| {
            map_transport_error(
                error,
                "native HTTPS manifest prefetch",
                "native_check_failed",
                "native_manifest_size_limit",
            )
        })?;
        let native_manifest_matches_local = native_manifest
            .as_deref()
            .map(|manifest| manifest == local_manifest.as_slice());
        if native_manifest_matches_local == Some(false) {
            return Err(ProbeError::new(
                "native_manifest_mismatch",
                "the native HTTPS prefetch differs from the bound local update manifest",
            )
            .with_details(json!({
                "native_manifest_bytes": native_manifest.as_ref().map(|manifest| manifest.len()),
                "local_manifest_bytes": local_manifest.len(),
                "same_manifest": false,
            })));
        }
        let remaining = TOTAL_TIMEOUT
            .checked_sub(preflight_started.elapsed())
            .ok_or_else(|| {
                ProbeError::new(
                    "preflight_budget_exhausted",
                    "native manifest prefetch consumed the combined five-second preflight budget",
                )
            })?;
        if remaining.is_zero() {
            return Err(ProbeError::new(
                "preflight_budget_exhausted",
                "no time remained for official updater check reconstruction",
            ));
        }
        let plugin_ca_certificate = ca_certificate.clone();
        let updater = app
            .updater_builder()
            .endpoints(vec![options.endpoint.clone()])
            .map_err(|error| {
                ProbeError::new(
                    "check_configuration_rejected",
                    format!("official updater rejected the selected endpoint: {error}"),
                )
            })?
            .pubkey(key_config.trim().to_owned())
            .executable_path(&fixture.app_executable)
            .timeout(remaining)
            .configure_client(move |client| {
                client
                    .add_root_certificate(plugin_ca_certificate.clone())
                    .https_only(true)
                    .redirect(Policy::none())
                    .connect_timeout(CONNECT_TIMEOUT.min(remaining))
                    .timeout(remaining)
            })
            .build()
            .map_err(|error| {
                ProbeError::new(
                    "check_configuration_rejected",
                    format!("official updater builder failed: {error}"),
                )
            })?;

        let checked = tauri::async_runtime::block_on(updater.check()).map_err(|error| {
            ProbeError::new(
                "check_failed",
                format!("official updater check failed: {error}"),
            )
        })?;
        let Some(update): Option<Update> = checked else {
            if options.expected_version.is_some() {
                return Err(ProbeError::new(
                    "selected_update_missing",
                    "the official check returned no update for --expected-version",
                ));
            }
            return Ok(json!({
                "schema": 1,
                "ok": true,
                "app_integrity_proven": false,
                "scenario": options.scenario.as_str(),
                "plugin": {"name": "tauri-plugin-updater", "version": PLUGIN_VERSION},
                "current_version": fixture.current_desktop_version,
                "current_version_source": "root_marker.current_desktop_version",
                "target": "darwin-aarch64",
                "fixture": fixture_observation(fixture),
                "archive_cap_bytes": MAX_ARCHIVE_BYTES,
                "fixture_archive_bytes": fixture.archive_size,
                "native_prefetch": {
                    "performed": true,
                    "manifest_bytes": native_manifest.as_ref().map(|manifest| manifest.len()),
                    "manifest_cap_bytes": MAX_NATIVE_MANIFEST_BYTES,
                    "same_local_manifest": native_manifest_matches_local,
                    "trust_anchor": CA_CERTIFICATE_NAME,
                    "valid_certificates": true,
                    "redirect_policy": "none",
                },
                "check": {
                    "performed": true,
                    "update": null,
                    "endpoint_https": true,
                    "endpoint_loopback": true,
                    "https_only": true,
                    "redirect_policy": "none",
                    "valid_certificates": true,
                    "connect_timeout_ms": CONNECT_TIMEOUT.min(remaining).as_millis(),
                    "total_timeout_ms": remaining.as_millis(),
                    "native_total_timeout_ms": TOTAL_TIMEOUT.as_millis(),
                    "dangerous_insecure_transport_protocol": false,
                    "combined_preflight_budget_ms": TOTAL_TIMEOUT.as_millis(),
                    "preflight_elapsed_ms": preflight_started.elapsed().as_millis(),
                    "plugin_metadata_allocation": "timeout_bounded_not_byte_bounded",
                },
                "reconstruction": {
                    "performed": matches!(options.scenario, Scenario::Reconstruct),
                    "uses_supported_check": true,
                    "private_update_state_serialized": false,
                },
                "native_archive": {
                    "performed": false,
                    "reason": "check-only scenario does not fetch or install the archive",
                },
                "install": {"attempted": false},
                "main_thread": {"preflight_ping": main_thread_before},
            }));
        };

        if let Some(expected) = options.expected_version.as_deref() {
            if update.version.trim_start_matches('v') != expected.trim_start_matches('v') {
                return Err(ProbeError::new(
                    "selected_version_mismatch",
                    format!(
                        "official check selected {} but --expected-version is {expected}",
                        update.version
                    ),
                ));
            }
        }
        if update.signature.trim().is_empty() {
            return Err(ProbeError::new(
                "selected_signature_missing",
                "official check returned an update without a signature",
            ));
        }
        validate_endpoint(&update.download_url).map_err(|error| {
            ProbeError::new(
                "production_feed_refused",
                format!(
                    "official update archive URL was rejected: {}",
                    error.message
                ),
            )
        })?;
        if !is_fixed_archive_url(&options.endpoint, &update.download_url) {
            return Err(ProbeError::new(
                "selected_archive_mismatch",
                "official update archive URL is not the local fixture archive on the endpoint origin",
            ));
        }

        let common = json!({
            "schema": 1,
            "plugin": {"name": "tauri-plugin-updater", "version": PLUGIN_VERSION},
            "current_version": fixture.current_desktop_version,
            "current_version_source": "root_marker.current_desktop_version",
            "target": "darwin-aarch64",
            "fixture": fixture_observation(fixture),
            "archive_cap_bytes": MAX_ARCHIVE_BYTES,
            "fixture_archive_bytes": fixture.archive_size,
            "native_prefetch": {
                "performed": true,
                "manifest_bytes": native_manifest.as_ref().map(|manifest| manifest.len()),
                "manifest_cap_bytes": MAX_NATIVE_MANIFEST_BYTES,
                "same_local_manifest": native_manifest_matches_local,
                "trust_anchor": CA_CERTIFICATE_NAME,
                "valid_certificates": true,
                "redirect_policy": "none",
            },
            "check": {
                "performed": true,
                "selected_version": update.version,
                "selected_archive_origin": update.download_url.origin().ascii_serialization(),
                "signature_present": true,
                "endpoint_https": true,
                "endpoint_loopback": true,
                "https_only": true,
                "redirect_policy": "none",
                "valid_certificates": true,
                "connect_timeout_ms": CONNECT_TIMEOUT.min(remaining).as_millis(),
                "total_timeout_ms": remaining.as_millis(),
                "native_total_timeout_ms": TOTAL_TIMEOUT.as_millis(),
                "dangerous_insecure_transport_protocol": false,
                "combined_preflight_budget_ms": TOTAL_TIMEOUT.as_millis(),
                "preflight_elapsed_ms": preflight_started.elapsed().as_millis(),
                "plugin_metadata_allocation": "timeout_bounded_not_byte_bounded",
            },
            "reconstruction": {
                "performed": matches!(options.scenario, Scenario::Reconstruct),
                "uses_supported_check": true,
                "private_update_state_serialized": false,
            },
            "main_thread": {
                "preflight_ping": main_thread_before,
                "install_thread": "std::thread",
            },
            "selected_target_version": update.version,
        });

        if !options.scenario.requires_install() {
            return Ok(merge_json(
                common,
                json!({
                    "ok": true,
                    "scenario": options.scenario.as_str(),
                    "app_integrity_proven": false,
                    "signature_verification": {
                        "performed": false,
                        "reason": "check-only scenario does not download or install",
                    },
                    "install": {"attempted": false},
                }),
            ));
        }

        let native_archive_client =
            updater_transport::build_client(Some(ca_certificate), CONNECT_TIMEOUT, ARCHIVE_TIMEOUT)
                .map_err(|error| {
                    ProbeError::new(
                        "native_archive_configuration_rejected",
                        format!("native archive client failed to build: {error}"),
                    )
                })?;
        let native_archive = tauri::async_runtime::block_on(updater_transport::fetch_bounded(
            &native_archive_client,
            &update.download_url,
            MAX_ARCHIVE_BYTES,
        ))
        .map_err(|error| {
            map_transport_error(
                error,
                "native archive download",
                "native_archive_download_failed",
                "native_archive_size_limit",
            )
        })?;
        let native_downloaded_bytes = native_archive.len();

        let public_key = minisign_verify::PublicKey::decode(&key_text).map_err(|error| {
            ProbeError::new(
                "invalid_fixture_key",
                format!("QA public key is not a Minisign public key: {error}"),
            )
        })?;
        let signature_text = STANDARD
            .decode(update.signature.as_bytes())
            .map_err(|error| {
                ProbeError::new(
                    "signature_rejected",
                    format!("official check returned a non-base64 signature: {error}"),
                )
            })
            .and_then(|bytes| {
                String::from_utf8(bytes).map_err(|error| {
                    ProbeError::new(
                        "signature_rejected",
                        format!("official check returned a non-UTF-8 signature: {error}"),
                    )
                })
            })?;
        let signature = minisign_verify::Signature::decode(&signature_text).map_err(|error| {
            ProbeError::new(
                "signature_rejected",
                format!("official check returned an invalid signature: {error}"),
            )
        })?;
        public_key
            .verify(&native_archive, &signature, false)
            .map_err(|error| {
                ProbeError::new(
                    "signature_rejected",
                    format!("the native downloaded archive failed Minisign verification: {error}"),
                )
                .with_details(json!({
                    "native_downloaded_bytes": native_downloaded_bytes,
                    "archive_cap_bytes": MAX_ARCHIVE_BYTES,
                    "archive_timeout_ms": ARCHIVE_TIMEOUT.as_millis(),
                    "signature_verified": false,
                    "install_attempted": false,
                }))
            })?;
        if native_archive.is_empty() {
            return Err(ProbeError::new(
                "invalid_fixture",
                "the native downloaded archive is empty",
            )
            .with_details(json!({
                "signature_verified": true,
                "native_downloaded_bytes": native_downloaded_bytes,
                "archive_cap_bytes": MAX_ARCHIVE_BYTES,
                "install_attempted": false,
            })));
        }

        validate_install_volume(&fixture.root, &fixture.app_dir)?;
        install_active.store(true, Ordering::Release);
        let install_started = Instant::now();
        let heartbeat = spawn_install_heartbeat(app.clone());
        let install_result =
            panic::catch_unwind(AssertUnwindSafe(|| update.install(&native_archive)));
        install_active.store(false, Ordering::Release);
        let install_elapsed_ms = install_started.elapsed().as_millis();
        let install_heartbeat = finish_install_heartbeat(heartbeat);
        let main_thread_after = main_thread_ping(app);
        match install_result {
            Ok(Ok(())) => {
                if fixture.proof_kind.requires_marker() {
                    let observation = fixture_observation(fixture);
                    let marker_after = observation
                        .get("marker")
                        .and_then(|marker| marker.get("value"))
                        .and_then(Value::as_str);
                    if marker_after != Some("B") {
                        return Err(ProbeError::new(
                            "post_install_observation_failed",
                            "marker-only fixture did not expose its expected B observation",
                        )
                        .with_details(json!({
                            "signature_verified": true,
                            "native_downloaded_bytes": native_downloaded_bytes,
                            "archive_cap_bytes": MAX_ARCHIVE_BYTES,
                            "same_bytes": true,
                            "same_buffer_as_signature_verified": true,
                            "buffer_passed_unchanged_to_install": true,
                            "install_attempted": true,
                            "install_result": "success",
                            "selected_target_version": update.version,
                            "install_elapsed_ms": install_elapsed_ms,
                            "main_thread_post_install_ping": main_thread_after,
                            "main_thread_heartbeat": install_heartbeat.as_json(),
                            "app_integrity_proven": false,
                        })));
                    }
                }
                Ok(merge_json(
                    common,
                    json!({
                        "ok": true,
                        "scenario": "install",
                        "app_integrity_proven": false,
                        "native_archive": {
                        "performed": true,
                        "downloaded_bytes": native_downloaded_bytes,
                        "archive_cap_bytes": MAX_ARCHIVE_BYTES,
                        "timeout_ms": ARCHIVE_TIMEOUT.as_millis(),
                        "same_buffer_passed_to_install": true,
                        "redirect_policy": "none",
                        "https_only": true,
                        "valid_certificates": true,
                        },
                        "signature_verification": {
                            "performed": true,
                            "verified_by": "minisign-verify::PublicKey::verify",
                            "native_downloaded_bytes": native_downloaded_bytes,
                            "archive_cap_bytes": MAX_ARCHIVE_BYTES,
                            "same_bytes": true,
                            "same_buffer_as_signature_verified": true,
                            "buffer_passed_unchanged_to_install": true,
                            "app_integrity_proven": false,
                        },
                        "install": {
                            "attempted": true,
                            "result": "success",
                            "selected_target_version": update.version,
                            "target": fixture
                                .app_dir
                                .file_name()
                                .and_then(|name| name.to_str()),
                            "observed_after": fixture_observation(fixture),
                            "elapsed_ms": install_elapsed_ms,
                            "main_thread_post_install_ping": main_thread_after,
                            "main_thread_heartbeat": install_heartbeat.as_json(),
                        },
                    }),
                ))
            }
            Ok(Err(error)) => {
                let message = error.to_string();
                let code =
                    if message.contains("Authentication failed") || message.contains("cancelled") {
                        "authorization_cancelled_or_failed"
                    } else {
                        "install_failed"
                    };
                Err(
                    ProbeError::new(code, format!("official updater install failed: {message}"))
                        .with_details(json!({
                            "signature_verified": true,
                            "native_downloaded_bytes": native_downloaded_bytes,
                            "archive_cap_bytes": MAX_ARCHIVE_BYTES,
                            "same_bytes": true,
                            "same_buffer_as_signature_verified": true,
                            "buffer_passed_unchanged_to_install": true,
                            "selected_target_version": update.version,
                            "native_archive": {
                                "performed": true,
                                "downloaded_bytes": native_downloaded_bytes,
                                "archive_cap_bytes": MAX_ARCHIVE_BYTES,
                                "timeout_ms": ARCHIVE_TIMEOUT.as_millis(),
                                "same_buffer_passed_to_install": true,
                            },
                            "install_attempted": true,
                            "install_elapsed_ms": install_elapsed_ms,
                            "main_thread_post_install_ping": main_thread_after,
                            "main_thread_heartbeat": install_heartbeat.as_json(),
                            "app_integrity_proven": false,
                            "observed_after": fixture_observation(fixture),
                            "recovery": "integrity_unproven_manual_classification_required",
                            "retry_allowed": false,
                        })),
                )
            }
            Err(_) => {
                let details = json!({
                    "signature_verified": true,
                    "native_downloaded_bytes": native_downloaded_bytes,
                    "archive_cap_bytes": MAX_ARCHIVE_BYTES,
                    "same_bytes": true,
                    "same_buffer_as_signature_verified": true,
                    "buffer_passed_unchanged_to_install": true,
                    "selected_target_version": update.version,
                    "native_archive": {
                        "performed": true,
                        "downloaded_bytes": native_downloaded_bytes,
                        "archive_cap_bytes": MAX_ARCHIVE_BYTES,
                        "timeout_ms": ARCHIVE_TIMEOUT.as_millis(),
                        "same_buffer_passed_to_install": true,
                    },
                    "install_attempted": true,
                    "install_elapsed_ms": install_elapsed_ms,
                    "main_thread_post_install_ping": main_thread_after,
                    "main_thread_heartbeat": install_heartbeat.as_json(),
                    "app_integrity_proven": false,
                    "observed_after": fixture_observation(fixture),
                    "recovery": "integrity_unproven_manual_classification_required",
                    "retry_allowed": false,
                });
                Err(ProbeError::new(
                    "install_panicked",
                    "official updater install panicked; heartbeat observation was bounded",
                )
                .with_details(details))
            }
        }
    }

    fn map_transport_error(
        error: TransportError,
        operation: &'static str,
        error_code: &'static str,
        size_error_code: &'static str,
    ) -> ProbeError {
        match error {
            TransportError::Request(error) => {
                ProbeError::new(error_code, format!("{operation} failed: {error}"))
            }
            TransportError::Status(status) => {
                ProbeError::new(error_code, format!("{operation} returned status {status}"))
            }
            TransportError::Stream(error) => {
                ProbeError::new(error_code, format!("{operation} stream failed: {error}"))
            }
            TransportError::UrlCredentials => ProbeError::new(
                "production_feed_refused",
                updater_transport::URL_CREDENTIALS_MESSAGE,
            ),
            TransportError::ContentLengthExceeded { max_bytes } => ProbeError::new(
                size_error_code,
                format!("{operation} Content-Length exceeded the {max_bytes}-byte cap"),
            ),
            TransportError::BodyExceeded { max_bytes } => ProbeError::new(
                size_error_code,
                format!("{operation} exceeded the {max_bytes}-byte cap"),
            ),
            TransportError::SizeOverflow => ProbeError::new(
                size_error_code,
                format!("{operation} size overflowed the probe limit"),
            ),
            TransportError::InvalidHeader(name) => ProbeError::new(
                error_code,
                format!("{operation} returned an invalid {name} header"),
            ),
        }
    }

    fn read_bounded_bytes(path: &Path, max_bytes: u64) -> Result<Vec<u8>, ProbeError> {
        let file = open_bounded_regular(path)?;
        let mut bytes = Vec::new();
        file.take(max_bytes.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| {
                ProbeError::new(
                    "invalid_fixture",
                    format!("cannot read {}: {error}", path.display()),
                )
            })?;
        if bytes.len() as u64 > max_bytes {
            return Err(ProbeError::new(
                "fixture_size_limit",
                format!(
                    "{} is larger than the {max_bytes}-byte probe limit",
                    path.display()
                ),
            ));
        }
        Ok(bytes)
    }

    fn open_bounded_regular(path: &Path) -> Result<File, ProbeError> {
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|error| {
                ProbeError::new(
                    "invalid_fixture",
                    format!(
                        "cannot open {} without following links: {error}",
                        path.display()
                    ),
                )
            })?;
        let metadata = file.metadata().map_err(|error| {
            ProbeError::new(
                "invalid_fixture",
                format!(
                    "cannot inspect opened {} before reading: {error}",
                    path.display()
                ),
            )
        })?;
        if !metadata.is_file() {
            return Err(ProbeError::new(
                "invalid_fixture",
                format!("{} is not a regular file", path.display()),
            ));
        }
        Ok(file)
    }

    fn decode_public_key_config(key_config: &str) -> Result<String, ProbeError> {
        let bytes = STANDARD.decode(key_config.as_bytes()).map_err(|error| {
            ProbeError::new(
                "invalid_fixture_key",
                format!("QA public key is not base64 Tauri public-key text: {error}"),
            )
        })?;
        String::from_utf8(bytes).map_err(|error| {
            ProbeError::new(
                "invalid_fixture_key",
                format!("QA public-key text is not UTF-8: {error}"),
            )
        })
    }

    fn main_thread_ping(app: &AppHandle<Wry>) -> bool {
        let (sender, receiver) = mpsc::sync_channel(1);
        if app
            .run_on_main_thread(move || {
                let _ = sender.send(());
            })
            .is_err()
        {
            return false;
        }
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map(|_| true)
            .unwrap_or(false)
    }

    fn spawn_install_heartbeat(app: AppHandle<Wry>) -> InstallHeartbeatHandle {
        let stop = Arc::new(AtomicBool::new(false));
        let observer_stop = Arc::clone(&stop);
        let join = thread::spawn(move || {
            let started = Instant::now();
            let deadline = started
                .checked_add(INSTALL_HEARTBEAT_DEADLINE)
                .unwrap_or(started);
            let mut attempts = 0;
            let mut responsive = 0;
            let mut timeouts = 0;
            let mut max_latency_ms = 0;
            let mut stopped_reason = "observation_deadline";

            loop {
                if observer_stop.load(Ordering::Acquire) {
                    stopped_reason = "install_finished";
                    break;
                }
                if Instant::now() >= deadline {
                    break;
                }
                if deadline
                    .saturating_duration_since(Instant::now())
                    .lt(&Duration::from_secs(2))
                {
                    break;
                }

                let ping_started = Instant::now();
                let ping_responsive = main_thread_ping(&app);
                let latency_ms = ping_started.elapsed().as_millis();
                attempts += 1;
                max_latency_ms = max_latency_ms.max(latency_ms);
                if ping_responsive {
                    responsive += 1;
                } else {
                    timeouts += 1;
                    stopped_reason = "first_timeout";
                    break;
                }

                if observer_stop.load(Ordering::Acquire) {
                    stopped_reason = "install_finished";
                    break;
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                thread::sleep(INSTALL_HEARTBEAT_INTERVAL.min(remaining));
            }

            InstallHeartbeat {
                attempts,
                responsive,
                timeouts,
                max_latency_ms,
                elapsed_ms: started.elapsed().as_millis(),
                stopped_reason,
            }
        });
        InstallHeartbeatHandle { stop, join }
    }

    fn finish_install_heartbeat(handle: InstallHeartbeatHandle) -> InstallHeartbeat {
        handle.stop.store(true, Ordering::Release);
        match handle.join.join() {
            Ok(summary) => summary,
            Err(_) => InstallHeartbeat {
                attempts: 0,
                responsive: 0,
                timeouts: 0,
                max_latency_ms: 0,
                elapsed_ms: 0,
                stopped_reason: "observer_panicked",
            },
        }
    }

    fn merge_json(base: Value, extra: Value) -> Value {
        let mut base = match base {
            Value::Object(object) => object,
            _ => serde_json::Map::new(),
        };
        if let Value::Object(extra) = extra {
            base.extend(extra);
        }
        Value::Object(base)
    }

    fn print_outcome(value: Value) {
        let line = serde_json::to_string(&value).unwrap_or_else(|_| {
            "{\"schema\":1,\"ok\":false,\"error\":{\"code\":\"serialization_failed\"}}".to_string()
        });
        println!("{line}");
        let _ = io::stdout().flush();
    }

    fn fixture_observation(fixture: &Fixture) -> Value {
        let marker = match fixture.app_marker.as_ref() {
            Some(path) => match read_bounded_bytes(path, MAX_APP_MARKER_BYTES) {
                Ok(bytes) if bytes == APP_MARKER_A => {
                    json!({"present": true, "value": "A"})
                }
                Ok(bytes) if bytes == APP_MARKER_B => {
                    json!({"present": true, "value": "B"})
                }
                Ok(_) => json!({"present": true, "value": "other"}),
                Err(error) => json!({
                    "present": true,
                    "value": null,
                    "read_error": error.code,
                }),
            },
            None => json!({"present": false, "value": null, "scope": "not_applicable"}),
        };
        json!({
            "root_basename": fixture.root.file_name().and_then(|name| name.to_str()),
            "proof_kind": fixture.proof_kind.as_str(),
            "target": fixture
                .app_dir
                .file_name()
                .and_then(|name| name.to_str()),
            "executable_basename": fixture.executable_basename,
            "declared_current_desktop_version": fixture.current_desktop_version,
            "observed_current_desktop_version": fixture.current_desktop_version,
            "marker": marker,
            "app_integrity_proven": false,
        })
    }

    fn error_outcome(
        error: ProbeError,
        options: Option<&Options>,
        fixture: Option<&Fixture>,
    ) -> Value {
        let mut outcome = json!({
            "schema": 1,
            "ok": false,
            "scenario": options.map(|options| options.scenario.as_str()),
            "plugin": {
                "name": "tauri-plugin-updater",
                "version": PLUGIN_VERSION,
            },
            "app_integrity_proven": false,
            "error": {
                "code": error.code,
                "message": error.message,
                "details": error.details,
            },
        });
        if let Some(fixture) = fixture {
            if let Value::Object(outcome) = &mut outcome {
                outcome.insert("fixture".to_string(), fixture_observation(fixture));
            }
        }
        outcome
    }

    fn print_fixture_error(error: ProbeError, fixture: &Fixture) -> ! {
        print_outcome(error_outcome(error, None, Some(fixture)));
        std::process::exit(1);
    }

    fn print_standalone_error(error: ProbeError) -> ! {
        print_outcome(error_outcome(error, None, None));
        std::process::exit(1);
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            ffi::CString,
            os::unix::{ffi::OsStrExt, fs::PermissionsExt},
        };

        #[test]
        fn install_volume_precheck_rejects_a_different_device() {
            let temporary = fs::canonicalize(env::temp_dir()).unwrap();
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = temporary.join(format!(
                "{ROOT_PREFIX}volume-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let app = root.join("A.app");
            fs::create_dir(&app).unwrap();
            validate_install_volume(&root, &app).unwrap();
            assert_ne!(
                fs::metadata("/dev").unwrap().dev(),
                fs::metadata(&root).unwrap().dev()
            );
            assert_eq!(
                validate_install_volume(&root, Path::new("/dev"))
                    .unwrap_err()
                    .code,
                "installation_volume_refused"
            );
            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn bounded_fixture_reads_enforce_byte_limits_and_utf8() {
            let mut random = [0u8; 16];
            getrandom::getrandom(&mut random).unwrap();
            let path = env::temp_dir().join(format!(
                "gajae-updater-probe-read-{:032x}",
                u128::from_ne_bytes(random)
            ));
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .unwrap();
            struct Cleanup(PathBuf);
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    let _ = fs::remove_file(&self.0);
                }
            }
            let _cleanup = Cleanup(path.clone());
            assert!(read_bounded_bytes(&path, 0).unwrap().is_empty());
            file.write_all(b"abcd").unwrap();
            assert_eq!(read_bounded_text(&path, 4).unwrap(), "abcd");
            assert_eq!(
                read_bounded_bytes(&path, 3).unwrap_err().code,
                "fixture_size_limit"
            );
            file.write_all(&[0xff]).unwrap();
            assert_eq!(
                read_bounded_text(&path, 4).unwrap_err().code,
                "fixture_size_limit"
            );
            assert_eq!(
                read_bounded_text(&path, 5).unwrap_err().code,
                "invalid_fixture"
            );
        }

        #[test]
        fn probe_rejects_remote_insecure_and_credential_bearing_feeds() {
            for endpoint in [
                "http://127.0.0.1:3001/update.json",
                "https://example.com:443/update.json",
                "https://user:password@127.0.0.1:3001/update.json",
                "https://127.0.0.1:3001/update.json?token=secret",
            ] {
                assert_eq!(
                    validate_endpoint(&Url::parse(endpoint).unwrap())
                        .unwrap_err()
                        .code,
                    "production_feed_refused"
                );
            }
            validate_endpoint(&Url::parse("https://127.0.0.1:3001/update.json").unwrap()).unwrap();
        }

        #[test]
        fn schema_requires_explicit_proof_kind_and_bundle_metadata() {
            let mut marker = json!({
                "schema": 2,
                "purpose": ROOT_MARKER_PURPOSE,
                "root": "/tmp/gajae-updater-probe-test",
                "fixture": ROOT_MARKER_FIXTURE,
                "app": MARKER_APP_DIR_NAME,
                "archive": ARCHIVE_NAME,
                "manifest": MANIFEST_NAME,
                "public_key": PUBLIC_KEY_NAME,
                "proof_kind": "marker_only",
                "executable_basename": "A",
                "current_desktop_version": "0.2.3"
            });
            assert!(serde_json::from_value::<RootMarker>(marker.clone()).is_ok());
            marker.as_object_mut().unwrap().remove("proof_kind");
            assert!(serde_json::from_value::<RootMarker>(marker.clone()).is_err());
            marker["proof_kind"] = json!("legacy");
            assert!(serde_json::from_value::<RootMarker>(marker).is_err());
            let mut marker_with_extra = json!({
                "schema": 2,
                "purpose": ROOT_MARKER_PURPOSE,
                "root": "/tmp/gajae-updater-probe-test",
                "fixture": ROOT_MARKER_FIXTURE,
                "proof_kind": "marker_only",
                "app": MARKER_APP_DIR_NAME,
                "archive": ARCHIVE_NAME,
                "manifest": MANIFEST_NAME,
                "public_key": PUBLIC_KEY_NAME,
                "executable_basename": "A",
                "current_desktop_version": "0.2.3",
                "legacy": true
            });
            assert!(serde_json::from_value::<RootMarker>(marker_with_extra.clone()).is_err());
            marker_with_extra.as_object_mut().unwrap().remove("legacy");
            assert!(serde_json::from_value::<RootMarker>(marker_with_extra).is_ok());
            assert_eq!(
                expected_app_dir_name(ProofKind::MarkerOnly),
                MARKER_APP_DIR_NAME
            );
            assert_eq!(
                expected_app_dir_name(ProofKind::SignedBundle),
                SIGNED_APP_DIR_NAME
            );
            assert!(validate_app_root_name(ProofKind::SignedBundle, MARKER_APP_DIR_NAME).is_err());
            validate_app_root_name(ProofKind::SignedBundle, SIGNED_APP_DIR_NAME).unwrap();
            assert_eq!(SIGNED_EXECUTABLE_BASENAME, "gajae-app-desktop");
        }

        #[test]
        fn metadata_bounds_reject_paths_and_invalid_versions() {
            assert_eq!(MAX_MANIFEST_BYTES, 64 * 1024);
            assert_eq!(MAX_NATIVE_MANIFEST_BYTES, 64 * 1024);
            assert_eq!(MAX_ARCHIVE_BYTES, 250 * 1024 * 1024);
            for name in ["", ".", "..", "A/B", "A\\B", "A B"] {
                assert!(validate_executable_basename(name).is_err());
            }
            validate_executable_basename("GajaeCode").unwrap();
            for version in [
                "",
                "0.2",
                "0.02.3",
                "0.2.3 bad",
                "0.2.3-",
                "v0.2.3",
                " 0.2.3",
            ] {
                assert!(validate_desktop_version(version).is_err());
            }
            validate_desktop_version("0.2.2-beta.8").unwrap();
            validate_desktop_version("0.2.3").unwrap();
        }

        #[test]
        fn heartbeat_summary_exposes_bounded_aggregate_contract() {
            let summary = InstallHeartbeat {
                attempts: 3,
                responsive: 2,
                timeouts: 1,
                max_latency_ms: 2_000,
                elapsed_ms: 2_101,
                stopped_reason: "first_timeout",
            };
            let value = summary.as_json();
            assert_eq!(value["attempts"], 3);
            assert_eq!(value["responsive"], 2);
            assert_eq!(value["timeouts"], 1);
            assert_eq!(value["max_latency_ms"], 2_000);
            assert_eq!(value["first_timeout_stops_observation"], true);
            assert_eq!(value["stopped_reason"], "first_timeout");
            assert_eq!(value["observation_deadline_ms"], 60_000);
        }

        #[test]
        fn fixture_root_and_signed_observation_stay_isolated() {
            let temporary = fs::canonicalize(env::temp_dir()).unwrap();
            let valid_root =
                temporary.join(format!("{ROOT_PREFIX}metadata-{}", std::process::id()));
            fs::create_dir(&valid_root).unwrap();
            fs::set_permissions(&valid_root, fs::Permissions::from_mode(0o700)).unwrap();
            struct Cleanup(PathBuf);
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    let _ = fs::remove_dir_all(&self.0);
                }
            }
            let _cleanup = Cleanup(valid_root.clone());
            validate_fixture_root(&valid_root).unwrap();
            assert_eq!(
                validate_fixture_root(&temporary.join("not-a-probe-root"))
                    .unwrap_err()
                    .code,
                "production_root_refused"
            );
            let fixture = Fixture {
                root: valid_root,
                proof_kind: ProofKind::SignedBundle,
                executable_basename: SIGNED_EXECUTABLE_BASENAME.to_string(),
                current_desktop_version: "0.2.2".to_string(),
                app_dir: PathBuf::new(),
                app_executable: PathBuf::new(),
                app_marker: None,
                archive_size: 0,
                manifest: PathBuf::new(),
                public_key: PathBuf::new(),
                ca_certificate: PathBuf::new(),
            };
            let observed = fixture_observation(&fixture);
            assert_eq!(observed["proof_kind"], "signed_bundle");
            assert_eq!(observed["declared_current_desktop_version"], "0.2.2");
            assert_eq!(observed["marker"]["present"], false);
            assert_eq!(observed["app_integrity_proven"], false);
        }

        #[test]
        fn fixture_root_requires_current_owner_and_private_directory_mode() {
            let current_uid = unsafe { libc::geteuid() as u32 };
            validate_fixture_owner_mode(current_uid, 0o700).unwrap();
            validate_fixture_owner_mode(current_uid, 0o500).unwrap();
            assert_eq!(
                validate_fixture_owner_mode(current_uid, 0o755)
                    .unwrap_err()
                    .code,
                "fixture_mode_refused"
            );
            let other_uid = if current_uid == 0 { 1 } else { 0 };
            assert_eq!(
                validate_fixture_owner_mode(other_uid, 0o700)
                    .unwrap_err()
                    .code,
                "fixture_owner_refused"
            );
        }

        #[test]
        fn bounded_reader_rejects_symlink_without_following_it() {
            let target = env::temp_dir().join(format!(
                "gajae-updater-probe-symlink-target-{}",
                std::process::id()
            ));
            let link = env::temp_dir().join(format!(
                "gajae-updater-probe-symlink-{}",
                std::process::id()
            ));
            let _ = fs::remove_file(&target);
            let _ = fs::remove_file(&link);
            fs::write(&target, b"target").unwrap();
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert_eq!(
                read_bounded_bytes(&link, 1024).unwrap_err().code,
                "invalid_fixture"
            );
            let _ = fs::remove_file(&target);
            let _ = fs::remove_file(&link);
        }

        #[test]
        fn bounded_reader_rejects_fifo_without_blocking() {
            let fifo =
                env::temp_dir().join(format!("gajae-updater-probe-fifo-{}", std::process::id()));
            let _ = fs::remove_file(&fifo);
            let c_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
            assert_eq!(
                read_bounded_bytes(&fifo, 1024).unwrap_err().code,
                "invalid_fixture"
            );
            let _ = fs::remove_file(&fifo);
        }

        #[test]
        fn fixture_versions_follow_semver_including_build_metadata() {
            assert!(validate_desktop_version("0.2.2+build-with-hyphen").is_ok());
            assert!(validate_desktop_version("0.2.2-beta.1+build.01").is_ok());
            for version in ["0.2.2-01", "0.2.2+bad!", " 0.2.2", "00.2.2"] {
                assert!(validate_desktop_version(version).is_err(), "{version}");
            }
        }

        #[test]
        fn probe_context_has_no_configured_windows_before_construction() {
            let mut context = probe_context();
            assert_eq!(context.config().identifier, PROBE_IDENTIFIER);
            context.config_mut().app.windows.push(Default::default());
            let endpoint = Url::parse("https://127.0.0.1:3001/update.json").unwrap();
            configure_probe_context(&mut context, "0.2.2", "cHVibGljLWtleQ==", &endpoint).unwrap();
            assert!(
                context.config().app.windows.is_empty(),
                "updater probe must not construct any WebView"
            );
            assert_eq!(context.config().identifier, PROBE_IDENTIFIER);
        }
    }

    fn print_usage() {
        println!(
            "Usage: updater_probe --root ROOT --endpoint https://127.0.0.1:PORT/update.json [--scenario check|reconstruct|install] [--expected-version VERSION]\n\nROOT must be a parent-created $TMPDIR/gajae-updater-probe-* directory containing a schema-2 .gajae-updater-probe-root marker, qa-ca.pem, and fixture archive. proof_kind=marker_only requires the fixed root/A.app test fixture and observes its explicit test marker; proof_kind=signed_bundle requires the fixed root/Gajae Code App.app and declared gajae-app-desktop executable, without requiring or adding a marker. install performs native HTTPS manifest prefetch -> official check -> capped native archive download -> direct Minisign verification -> the unchanged buffer passed to official Update::install. This probe creates no WebViews and never proves complete app integrity."
        );
    }
}

#[cfg(target_os = "macos")]
fn main() {
    macos_probe::run();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!(
        "{{\"schema\":1,\"ok\":false,\"app_integrity_proven\":false,\"error\":{{\"code\":\"unsupported_os\",\"message\":\"updater_probe is macOS-only\"}}}}"
    );
    std::process::exit(2);
}
