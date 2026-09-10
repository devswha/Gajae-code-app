//! Build-time binding for the optional desktop updater.
//!
//! This module is included by `build.rs` and by the focused integration tests.
//! It validates explicit inputs before Cargo emits any runtime constants. No
//! updater client, filesystem writer, installer, or release operation belongs
//! here.
use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const UPDATE_MODE_ENV: &str = "GJC_UPDATE_MODE";
pub const UPDATE_FEED_ORIGIN_ENV: &str = "GJC_UPDATE_FEED_ORIGIN";
pub const UPDATE_PUBKEY_ENV: &str = "GJC_UPDATE_PUBKEY";
pub const UPDATE_QA_ROOT_ENV: &str = "GJC_UPDATE_QA_ROOT";
pub const INPUT_ENV_NAMES: [&str; 4] = [
    UPDATE_MODE_ENV,
    UPDATE_FEED_ORIGIN_ENV,
    UPDATE_PUBKEY_ENV,
    UPDATE_QA_ROOT_ENV,
];

pub const UPDATE_MODE_DISABLED: &str = "disabled";
pub const UPDATE_MODE_PRODUCTION: &str = "production";
pub const UPDATE_MODE_QA: &str = "qa";
const PUBLIC_KEY_CONFIG_LIMIT: usize = 16 * 1024;
const PUBLIC_KEY_RECORD_LENGTH: usize = 42;
const PUBLIC_KEY_COMMENT_PREFIX: &str = "untrusted comment: minisign public key: ";
const PRODUCTION_FEED_ORIGIN: &str = "https://api.github.com";
const QA_HOST: &str = "127.0.0.1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageMetadata {
    pub name: String,
    pub product_version: String,
    pub desktop_version: String,
    pub homepage: String,
    pub repository_url: String,
}

impl PackageMetadata {
    pub fn from_json(package: &Value) -> Result<Self, String> {
        let object = package
            .as_object()
            .ok_or_else(|| "package.json must contain a top-level object".to_owned())?;
        let string = |field: &str| {
            object
                .get(field)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("package.json must contain a non-empty {field} string"))
        };
        let repository = object
            .get("repository")
            .and_then(Value::as_object)
            .ok_or_else(|| "package.json repository must be an object".to_owned())?;
        let repository_url = repository
            .get("url")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "package.json repository.url must be a non-empty string".to_owned())?;
        Ok(Self {
            name: string("name")?,
            product_version: string("version")?,
            desktop_version: string("desktopVersion")?,
            homepage: string("homepage")?,
            repository_url,
        })
    }

    #[cfg(test)]
    pub fn from_parts(
        name: impl Into<String>,
        product_version: impl Into<String>,
        desktop_version: impl Into<String>,
        homepage: impl Into<String>,
        repository_url: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            product_version: product_version.into(),
            desktop_version: desktop_version.into(),
            homepage: homepage.into(),
            repository_url: repository_url.into(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BuildInputs {
    pub target_os: String,
    pub debug: bool,
    pub feed_origin: Option<String>,
    pub mode: Option<String>,
    pub pubkey: Option<String>,
    pub qa_root: Option<PathBuf>,
    pub temp_root: Option<PathBuf>,
}

impl BuildInputs {
    pub fn from_env(
        target_os: impl Into<String>,
        debug: bool,
        temp_root: Option<PathBuf>,
    ) -> Result<Self, String> {
        Ok(Self {
            target_os: target_os.into(),
            debug,
            feed_origin: env_value(UPDATE_FEED_ORIGIN_ENV)?,
            mode: env_value(UPDATE_MODE_ENV)?,
            pubkey: env_value(UPDATE_PUBKEY_ENV)?,
            qa_root: env_value(UPDATE_QA_ROOT_ENV)?.map(PathBuf::from),
            temp_root,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateMode {
    Disabled,
    Production,
    Qa,
}

impl UpdateMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => UPDATE_MODE_DISABLED,
            Self::Production => UPDATE_MODE_PRODUCTION,
            Self::Qa => UPDATE_MODE_QA,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildBinding {
    pub mode: UpdateMode,
    pub feed_origin: Option<String>,
    pub pubkey: Option<String>,
    pub qa_root: Option<PathBuf>,
    pub key_fingerprint: Option<String>,
    pub repository: String,
    pub artifact_prefix: String,
}

impl BuildBinding {
    pub fn feed_origin_value(&self) -> &str {
        self.feed_origin.as_deref().unwrap_or_default()
    }

    pub fn pubkey_value(&self) -> &str {
        self.pubkey.as_deref().unwrap_or_default()
    }

    pub fn qa_root_value(&self) -> &str {
        match self.qa_root.as_deref() {
            Some(path) => path
                .to_str()
                .expect("validated QA root must be UTF-8 for compile-time binding"),
            None => "",
        }
    }

    pub fn key_fingerprint_value(&self) -> &str {
        self.key_fingerprint.as_deref().unwrap_or_default()
    }
}

/// Validate package identity and explicit update inputs without reading or
/// mutating any update state. `temp_root` in `inputs` is supplied explicitly so
/// tests never need to mutate process-wide environment variables.
pub fn validate(package: &PackageMetadata, inputs: &BuildInputs) -> Result<BuildBinding, String> {
    let repository = derive_repository(&package.homepage, &package.repository_url)?;
    let artifact_prefix = artifact_prefix(&package.name)?;
    semver::Version::parse(&package.product_version)
        .map_err(|_| "package.json version must be valid SemVer".to_owned())?;
    semver::Version::parse(&package.desktop_version)
        .map_err(|_| "package.json desktopVersion must be valid SemVer".to_owned())?;
    reject_control_fields(inputs)?;

    let mode = match inputs.mode.as_deref() {
        // A release-profile macOS bundle is what the updater lane ships. Falling
        // back to `disabled` there produced beta.13: a valid signed update whose
        // successor could not verify its own installation. Silence is not consent;
        // a manual-install build must say `disabled` explicitly.
        None if inputs.target_os == "macos" && !inputs.debug => {
            return Err(
                "GJC_UPDATE_MODE is required for a release macOS build: set production for an updater release or disabled for a manual-install build"
                    .to_owned(),
            );
        }
        None => UpdateMode::Disabled,
        Some(UPDATE_MODE_DISABLED) => UpdateMode::Disabled,
        Some(UPDATE_MODE_PRODUCTION) => UpdateMode::Production,
        Some(UPDATE_MODE_QA) => UpdateMode::Qa,
        Some(_) => return Err("GJC_UPDATE_MODE is unknown".to_owned()),
    };
    let has_extra_input =
        inputs.feed_origin.is_some() || inputs.pubkey.is_some() || inputs.qa_root.is_some();
    if mode == UpdateMode::Disabled {
        if has_extra_input {
            return Err(
                "disabled update mode cannot include feed, public-key, or QA-root input".to_owned(),
            );
        }
        return Ok(BuildBinding {
            mode,
            feed_origin: None,
            pubkey: None,
            qa_root: None,
            key_fingerprint: None,
            repository,
            artifact_prefix,
        });
    }
    if inputs.target_os != "macos" {
        return Err("updater modes other than disabled are supported only on macOS".to_owned());
    }
    let feed_origin = inputs
        .feed_origin
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "updater feed origin is required".to_owned())?;
    let public_key = inputs
        .pubkey
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "updater public key is required".to_owned())?;
    let (public_key, key_fingerprint) = validate_public_key(public_key)?;

    match mode {
        UpdateMode::Production => {
            if inputs.debug {
                return Err("production updater mode is forbidden in debug builds".to_owned());
            }
            if feed_origin != PRODUCTION_FEED_ORIGIN {
                return Err(
                    "production updater feed origin must be exactly https://api.github.com"
                        .to_owned(),
                );
            }
            if inputs.qa_root.is_some() {
                return Err("production updater mode cannot include a QA root".to_owned());
            }
            Ok(BuildBinding {
                mode,
                feed_origin: Some(feed_origin.to_owned()),
                pubkey: Some(public_key),
                qa_root: None,
                key_fingerprint: Some(key_fingerprint),
                repository,
                artifact_prefix,
            })
        }
        UpdateMode::Qa => {
            let qa_root = inputs
                .qa_root
                .as_deref()
                .ok_or_else(|| "QA updater mode requires an explicit QA root".to_owned())?;
            validate_qa_root(qa_root, inputs.temp_root.as_deref())?;
            validate_qa_origin(feed_origin)?;
            Ok(BuildBinding {
                mode,
                feed_origin: Some(feed_origin.to_owned()),
                pubkey: Some(public_key),
                qa_root: Some(qa_root.to_owned()),
                key_fingerprint: Some(key_fingerprint),
                repository,
                artifact_prefix,
            })
        }
        UpdateMode::Disabled => unreachable!(),
    }
}

pub fn derive_repository(homepage: &str, repository_url: &str) -> Result<String, String> {
    let homepage_slug = parse_github_slug(homepage, false)?;
    let repository_slug = parse_github_slug(repository_url, true)?;
    if homepage_slug != repository_slug {
        return Err(
            "package homepage and repository.url do not identify the same GitHub repository"
                .to_owned(),
        );
    }
    Ok(homepage_slug)
}

/// Compile a private fixture CA into QA builds; never read runtime trust inputs.
pub fn read_qa_certificate(root: &Path) -> Result<Vec<u8>, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let file = options
        .open(root.join("updater-ca.pem"))
        .map_err(|_| "QA updater requires updater-ca.pem in its compiled root.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Could not inspect QA updater certificate.")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 64 * 1024 {
        return Err("QA updater certificate must be a bounded regular file.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.nlink() != 1
            || !matches!(metadata.mode() & 0o7777, 0o400 | 0o600)
        {
            return Err("QA updater certificate must be owner-only and unaliased.".into());
        }
    }
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read QA updater certificate.")?;
    if bytes.len() as u64 != metadata.len() || bytes.len() > 64 * 1024 {
        return Err("QA updater certificate changed or exceeded its limit.".into());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "Invalid QA updater certificate PEM.")?;
    let body = text
        .trim()
        .strip_prefix("-----BEGIN CERTIFICATE-----")
        .and_then(|text| text.strip_suffix("-----END CERTIFICATE-----"))
        .ok_or("QA updater trust input must be one public certificate PEM, never a key.")?;
    let encoded: String = body
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect();
    let der = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid QA updater certificate PEM.")?;
    // Parse the entire X.509 certificate using the same pinned parser as TLS,
    // not merely its ASN.1 sequence tag. The caller explicitly trusts this
    // private build-time input: parsing does not verify a root self-signature,
    // validity period, or CA basic constraints, nor claim to establish trust.
    let certificate = rustls_pki_types::CertificateDer::from(der.as_slice());
    webpki::anchor_from_trusted_cert(&certificate)
        .map_err(|_| "Invalid QA updater certificate DER.")?;
    Ok(bytes)
}

/// Finalization may change native signatures and therefore manifest hashes.
/// The signing owner rebuilds the desktop with that final digest BEFORE sealing
/// the app; runtime verification remains an exact compiled digest comparison.
pub fn signed_runtime_digest(
    source: &str,
    signed: Option<&str>,
    target_os: &str,
    release: bool,
) -> Result<String, String> {
    let valid = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    };
    if !valid(source) {
        return Err("Invalid source runtime manifest digest.".into());
    }
    match signed {
        None => Ok(source.to_owned()),
        Some(value) if target_os == "macos" && release && valid(value) => Ok(value.to_owned()),
        Some(_) => Err(
            "Signed runtime binding requires a macOS release build and a canonical SHA-256.".into(),
        ),
    }
}

pub fn artifact_prefix(package_name: &str) -> Result<String, String> {
    if package_name.is_empty()
        || package_name.len() > 128
        || !package_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("package.name must be a safe non-empty package identifier".to_owned());
    }
    Ok(format!("{package_name}-"))
}

fn parse_github_slug(value: &str, repository_url: bool) -> Result<String, String> {
    let mut value = value;
    if repository_url {
        value = value.strip_prefix("git+").unwrap_or(value);
    }
    let value = value
        .strip_prefix("https://github.com/")
        .ok_or_else(|| "package GitHub metadata must use canonical HTTPS".to_owned())?;
    if value.is_empty()
        || value
            .chars()
            .any(|character| matches!(character, '?' | '#' | '@'))
    {
        return Err("package GitHub metadata has an invalid repository path".to_owned());
    }
    let value = if repository_url {
        value
            .strip_suffix(".git")
            .ok_or_else(|| "package.repository.url must end in .git".to_owned())?
    } else {
        value
    };
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || owner.is_empty()
        || repo.is_empty()
        || !owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        || !repo
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("package GitHub metadata has an invalid owner/repository".to_owned());
    }
    Ok(format!("{owner}/{repo}"))
}

fn validate_public_key(config: &str) -> Result<(String, String), String> {
    if config.is_empty()
        || config.len() > PUBLIC_KEY_CONFIG_LIMIT
        || !config.is_ascii()
        || config
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(
            "GJC_UPDATE_PUBKEY must be bounded canonical base64 public-key text".to_owned(),
        );
    }
    let decoded = STANDARD
        .decode(config.as_bytes())
        .map_err(|_| "GJC_UPDATE_PUBKEY is not valid base64 public-key text".to_owned())?;
    if STANDARD.encode(&decoded) != config {
        return Err("GJC_UPDATE_PUBKEY must use canonical base64".to_owned());
    }
    let text = String::from_utf8(decoded)
        .map_err(|_| "GJC_UPDATE_PUBKEY must decode to UTF-8 Minisign text".to_owned())?;
    if text
        .chars()
        .any(|character| character.is_control() && character != '\n')
    {
        return Err("GJC_UPDATE_PUBKEY contains unsupported control input".to_owned());
    }
    let mut lines = text.lines();
    let comment = lines.next().unwrap_or_default();
    let record_text = lines.next().unwrap_or_default();
    if !comment.is_ascii()
        || !record_text.is_ascii()
        || !comment.starts_with(PUBLIC_KEY_COMMENT_PREFIX)
        || comment.len() == PUBLIC_KEY_COMMENT_PREFIX.len()
    {
        return Err("GJC_UPDATE_PUBKEY is not standard Minisign public-key text".to_owned());
    }
    if lines.next().is_some() || record_text.is_empty() {
        return Err("GJC_UPDATE_PUBKEY must contain exactly one public-key record".to_owned());
    }
    let record = STANDARD
        .decode(record_text.as_bytes())
        .map_err(|_| "GJC_UPDATE_PUBKEY public record is not canonical base64".to_owned())?;
    if record.len() != PUBLIC_KEY_RECORD_LENGTH
        || STANDARD.encode(&record) != record_text
        || record.get(..2) != Some(b"Ed")
    {
        return Err(
            "GJC_UPDATE_PUBKEY must contain an Ed public record of exactly 42 bytes".to_owned(),
        );
    }
    let mut hasher = Sha256::new();
    hasher.update(&record);
    let digest = hasher.finalize();
    let mut fingerprint = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut fingerprint, "{byte:02x}").expect("writing a digest to String cannot fail");
    }
    Ok((config.to_owned(), fingerprint))
}

fn validate_qa_origin(origin: &str) -> Result<(), String> {
    if origin.is_empty()
        || origin
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err("QA updater feed origin contains invalid input".to_owned());
    }
    let authority = origin
        .strip_prefix("https://")
        .ok_or_else(|| "QA updater feed origin must use HTTPS".to_owned())?;
    if authority.is_empty()
        || authority
            .chars()
            .any(|character| matches!(character, '/' | '?' | '#' | '@'))
    {
        return Err("QA updater feed origin must contain only a host and port".to_owned());
    }
    let port = authority
        .strip_prefix(&format!("{QA_HOST}:"))
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or_else(|| "QA updater feed origin must use numeric 127.0.0.1 port".to_owned())?;
    let number = port
        .parse::<u16>()
        .ok()
        .filter(|number| *number != 0)
        .ok_or_else(|| "QA updater feed origin port must be nonzero and valid".to_owned())?;
    if number.to_string() != port {
        return Err("QA updater feed origin port must be canonical decimal".to_owned());
    }
    Ok(())
}

fn validate_qa_root(path: &Path, temp_root: Option<&Path>) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("QA root must be an absolute directory".to_owned());
    }
    if path.to_str().is_none() {
        return Err("QA root must be valid UTF-8".to_owned());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "QA root must be an existing private directory".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("QA root must be an existing non-symlink directory".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let uid = unsafe { libc::geteuid() };
        if metadata.uid() != uid {
            return Err("QA root must be owned by the current user".to_owned());
        }
        if metadata.mode() & 0o7777 != 0o700 {
            return Err("QA root permissions must be exactly 0700".to_owned());
        }
    }
    #[cfg(not(unix))]
    return Err("QA root ownership cannot be validated on this platform".to_owned());

    let temp_root =
        temp_root.ok_or_else(|| "canonical OS temporary root is unavailable".to_owned())?;
    if !temp_root.is_absolute() {
        return Err("canonical OS temporary root must be absolute".to_owned());
    }
    let temp_metadata = fs::symlink_metadata(temp_root)
        .map_err(|_| "canonical OS temporary root is unavailable".to_owned())?;
    if temp_metadata.file_type().is_symlink() || !temp_metadata.is_dir() {
        return Err("canonical OS temporary root is unavailable".to_owned());
    }
    let canonical_temp_root = fs::canonicalize(temp_root)
        .map_err(|_| "canonical OS temporary root is unavailable".to_owned())?;
    if canonical_temp_root != temp_root {
        return Err("canonical OS temporary root must not contain symlink components".to_owned());
    }
    let temp_root = canonical_temp_root;
    let canonical = fs::canonicalize(path)
        .map_err(|_| "QA root must be canonical and accessible".to_owned())?;
    if canonical != path || canonical.parent() != Some(temp_root.as_path()) {
        return Err("QA root must be a canonical direct child of the OS temporary root".to_owned());
    }
    Ok(())
}

fn reject_control_fields(inputs: &BuildInputs) -> Result<(), String> {
    for value in [
        inputs.mode.as_deref(),
        inputs.feed_origin.as_deref(),
        inputs.pubkey.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if value.chars().any(char::is_control) {
            return Err("updater configuration contains unsupported control input".to_owned());
        }
    }
    if let Some(path) = inputs.qa_root.as_deref() {
        if path.to_string_lossy().chars().any(char::is_control) {
            return Err("updater QA root contains unsupported control input".to_owned());
        }
    }
    Ok(())
}

fn env_value(name: &str) -> Result<Option<String>, String> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => {
            Err(format!("{name} contains invalid environment text"))
        }
    }
}
