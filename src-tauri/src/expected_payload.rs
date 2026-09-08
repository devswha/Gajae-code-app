//! Read-only payload identity checks, independent of the supervised process.
//!
//! `build.rs` must bind package name/product version and the SHA-256 of the source
//! `server/gjc-runtime-manifest.json` into the executable. For a signed macOS
//! release, finalization rebuilds the desktop with the finalized payload digest
//! before sealing the app; the original source digest stays separate for release
//! diagnostics. Never derive these expectations at runtime from the installed
//! payload, a ready frame, health, or runtime
//! environment variables. Missing build inputs fail closed, even with updates
//! disabled. This module does not enable updates or access update state.
//!
//! Integration: verify the resolved packaged payload before spawning. Preserve
//! the supervisor's existing independently versioned ready/health checks and
//! the worker's own runtime file verification. Success here is not a signature,
//! installation, or writer-exit proof.

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    fs::{self, File},
    io::Read,
    path::Path,
};

use serde::{de, Deserialize, Deserializer};
use sha2::{Digest, Sha256};

const PACKAGE_LIMIT: usize = 256 * 1024;
const MANIFEST_LIMIT: usize = 64 * 1024;
const SOURCE_MANIFEST: &str = "server/gjc-runtime-manifest.json";
const WORKER_MANIFEST: &str = "dist-server/server/gjc-runtime-manifest.json";

#[derive(Debug)]
pub(crate) struct ExpectedPayload {
    package_name: String,
    product_version: String,
    runtime_manifest_sha256: String,
}

impl ExpectedPayload {
    pub(crate) fn compiled() -> Result<Self, String> {
        Self::from_build_values(
            option_env!("GJC_EXPECTED_PAYLOAD_PACKAGE_NAME"),
            option_env!("GJC_EXPECTED_PAYLOAD_VERSION"),
            option_env!("GJC_EXPECTED_RUNTIME_MANIFEST_SHA256"),
        )
    }

    fn from_build_values(
        package_name: Option<&str>,
        product_version: Option<&str>,
        runtime_manifest_sha256: Option<&str>,
    ) -> Result<Self, String> {
        let required = |value: Option<&str>, field: &str| {
            value
                .filter(|value| valid_identity_text(value))
                .map(str::to_owned)
                .ok_or_else(|| format!("missing or malformed compiled payload {field}"))
        };
        let digest = required(runtime_manifest_sha256, "runtime manifest digest")?;
        if !valid_sha256(&digest) {
            return Err("malformed compiled payload runtime manifest digest".to_owned());
        }
        Ok(Self {
            package_name: required(package_name, "package name")?,
            product_version: required(product_version, "product version")?,
            runtime_manifest_sha256: digest,
        })
    }

    /// Check both the packaging copy and the JSON imported by the Bun worker.
    /// TypeScript reformats the latter, so raw byte equality between the two is
    /// not required. Every field is represented in the strict manifest schema.
    pub(crate) fn verify_payload(&self, root: &Path) -> Result<(), String> {
        let package = read_payload_file(root, "package.json", PACKAGE_LIMIT)?;
        self.verify_package(&package)?;
        let source = read_payload_file(root, SOURCE_MANIFEST, MANIFEST_LIMIT)?;
        let worker = read_payload_file(root, WORKER_MANIFEST, MANIFEST_LIMIT)?;
        self.verify_manifests(&source, &worker)
    }

    fn verify_package(&self, bytes: &[u8]) -> Result<(), String> {
        check_limit(bytes, PACKAGE_LIMIT, "package metadata")?;
        let package: PackageIdentity = serde_json::from_slice(bytes)
            .map_err(|_| "malformed payload package metadata".to_owned())?;
        if package.name != self.package_name || package.version != self.product_version {
            return Err("payload package identity does not match the native build".to_owned());
        }
        Ok(())
    }

    fn verify_manifests(&self, source: &[u8], worker: &[u8]) -> Result<(), String> {
        check_limit(source, MANIFEST_LIMIT, "source runtime manifest")?;
        check_limit(worker, MANIFEST_LIMIT, "worker runtime manifest")?;
        if format!("{:x}", Sha256::digest(source)) != self.runtime_manifest_sha256 {
            return Err(
                "payload runtime manifest digest does not match the native build".to_owned(),
            );
        }
        let source = parse_manifest(source)?;
        let worker = parse_manifest(worker)?;
        if source != worker {
            return Err(
                "payload worker runtime manifest differs from the verified manifest".to_owned(),
            );
        }
        Ok(())
    }
}

// Package.json legitimately carries unrelated fields (dependencies, etc.).
// Required identity fields are typed and duplicates rejected by the derived
// deserializer, without denying those existing extra fields.
#[derive(Deserialize)]
struct PackageIdentity {
    name: String,
    version: String,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RuntimeManifest {
    schema_version: u32,
    gjc_sdk: String,
    bun: String,
    natives: String,
    #[serde(deserialize_with = "unique_platforms")]
    platforms: BTreeMap<String, RuntimePlatform>,
    sdk_lifecycle: SdkLifecycle,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SdkLifecycle {
    id: String,
    #[serde(deserialize_with = "unique_sdk_packages")]
    packages: BTreeMap<String, String>,
    files: Vec<RuntimeFile>,
}

fn unique_sdk_packages<'de, D>(deserializer: D) -> Result<BTreeMap<String, String>, D::Error>
where
    D: Deserializer<'de>,
{
    struct Packages;
    impl<'de> de::Visitor<'de> for Packages {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("unique SDK package versions")
        }
        fn visit_map<M: de::MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
            let mut result = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if result.insert(key, value).is_some() {
                    return Err(de::Error::custom("duplicate SDK package"));
                }
            }
            Ok(result)
        }
    }
    deserializer.deserialize_map(Packages)
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RuntimePlatform {
    files: Vec<RuntimeFile>,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RuntimeFile {
    package: String,
    path: String,
    sha256: String,
}

// A plain BTreeMap accepts duplicate platform keys by overwriting the earlier
// value. Reject them so semantic equality cannot hide ambiguous worker JSON.
fn unique_platforms<'de, D>(deserializer: D) -> Result<BTreeMap<String, RuntimePlatform>, D::Error>
where
    D: Deserializer<'de>,
{
    struct PlatformsVisitor;
    impl<'de> de::Visitor<'de> for PlatformsVisitor {
        type Value = BTreeMap<String, RuntimePlatform>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("runtime platforms with unique names")
        }

        fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
        where
            M: de::MapAccess<'de>,
        {
            let mut platforms = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, RuntimePlatform>()? {
                if platforms.insert(key, value).is_some() {
                    return Err(de::Error::custom("duplicate runtime platform"));
                }
            }
            Ok(platforms)
        }
    }
    deserializer.deserialize_map(PlatformsVisitor)
}

fn parse_manifest(bytes: &[u8]) -> Result<RuntimeManifest, String> {
    let target = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("linux", "x86_64") => "linux-x64",
        _ => return Err("unsupported desktop runtime manifest target".to_owned()),
    };
    parse_manifest_for_target(bytes, target)
}

fn parse_manifest_for_target(bytes: &[u8], platform: &str) -> Result<RuntimeManifest, String> {
    check_limit(bytes, MANIFEST_LIMIT, "runtime manifest")?;
    let failure = || "malformed payload runtime manifest".to_owned();
    let manifest: RuntimeManifest = serde_json::from_slice(bytes).map_err(|_| failure())?;
    if manifest.schema_version != 2
        || !valid_identity_text(&manifest.gjc_sdk)
        || !valid_identity_text(&manifest.bun)
        || !valid_identity_text(&manifest.natives)
        || manifest.platforms.is_empty()
    {
        return Err(failure());
    }
    let sdk = &manifest.sdk_lifecycle;
    let allowed = [
        "@gajae-code/coding-agent",
        "@gajae-code/agent-core",
        "@gajae-code/ai",
    ];
    if sdk.id.is_empty()
        || sdk.id.len() > 128
        || !sdk.id.as_bytes()[0].is_ascii_lowercase()
        || !sdk
            .id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || sdk.packages.len() < 2
        || sdk.packages.len() > allowed.len()
        || !sdk.packages.contains_key(allowed[0])
        || !sdk.packages.contains_key(allowed[1])
        || sdk.packages.iter().any(|(name, version)| {
            !allowed.contains(&name.as_str())
                || version.split('.').count() != 3
                || version
                    .split('.')
                    .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
        })
        || sdk.packages.get(allowed[0]) != Some(&manifest.gjc_sdk)
        || sdk.files.is_empty()
        || sdk.files.len() > sdk_file_limit()?
    {
        return Err(failure());
    }
    let mut seen = BTreeSet::new();
    for file in &sdk.files {
        if !sdk.packages.contains_key(&file.package)
            || !valid_sdk_path(&file.path)
            || !valid_sha256(&file.sha256)
            || !seen.insert((&file.package, &file.path))
        {
            return Err(failure());
        }
    }
    if sdk
        .packages
        .keys()
        .any(|name| !sdk.files.iter().any(|file| &file.package == name))
    {
        return Err(failure());
    }
    for (platform, closure) in &manifest.platforms {
        if !valid_identity_text(platform)
            || !platform
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(failure());
        }
        let platform_package = format!("@gajae-code/natives-{platform}");
        let mut seen = BTreeSet::new();
        for file in &closure.files {
            if (file.package != "@gajae-code/natives" && file.package != platform_package)
                || !valid_native_path(&file.path)
                || !valid_sha256(&file.sha256)
                || !seen.insert((&file.package, &file.path))
            {
                return Err(failure());
            }
        }
    }
    // fill:runtime-manifest permits empty closures for foreign platforms. The
    // actual desktop target must still have a populated closure.
    if manifest
        .platforms
        .get(platform)
        .is_none_or(|closure| closure.files.is_empty())
    {
        return Err("payload runtime manifest lacks the desktop target closure".to_owned());
    }
    Ok(manifest)
}

fn sdk_file_limit() -> Result<usize, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct Policy {
        schema_version: u8,
        max_files: usize,
    }
    let policy: Policy = serde_json::from_str(include_str!("../../shared/sdkLifecyclePolicy.json"))
        .map_err(|_| "Invalid compiled SDK lifecycle policy.")?;
    if policy.schema_version != 1 || policy.max_files == 0 || policy.max_files > 128 {
        return Err("Invalid compiled SDK lifecycle policy.".into());
    }
    Ok(policy.max_files)
}

/// One strict schema owns both the installed-payload and in-archive checks.
/// The archive validator still verifies every returned member's actual bytes.
#[cfg(target_os = "macos")]
pub(crate) fn runtime_manifest_files(
    bytes: &[u8],
    platform: &str,
) -> Result<Vec<(String, String, String)>, String> {
    let mut manifest = parse_manifest_for_target(bytes, platform)?;
    let mut files = manifest
        .platforms
        .remove(platform)
        .ok_or("Missing runtime target")?
        .files;
    files.extend(manifest.sdk_lifecycle.files);
    Ok(files
        .into_iter()
        .map(|file| (file.package, file.path, file.sha256))
        .collect())
}

fn valid_identity_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_native_path(value: &str) -> bool {
    value.starts_with("native/")
        && !value.contains(['\\', '\0'])
        && !value.contains("..")
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && !part.chars().any(char::is_control))
}

fn valid_sdk_path(value: &str) -> bool {
    value.starts_with("src/")
        && value.ends_with(".ts")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-/".contains(&byte))
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn check_limit(bytes: &[u8], limit: usize, label: &str) -> Result<(), String> {
    if bytes.len() > limit {
        return Err(format!("payload {label} exceeds its size limit"));
    }
    Ok(())
}

fn read_payload_file(root: &Path, relative: &str, limit: usize) -> Result<Vec<u8>, String> {
    let failure = || format!("payload {relative} is missing or is not a regular file");
    if !fs::symlink_metadata(root)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        return Err("payload root is not a directory".to_owned());
    }
    // All callers use fixed relative paths, never inputs from a manifest.
    let mut path = root.to_path_buf();
    let mut components = relative.split('/').peekable();
    while let Some(component) = components.next() {
        path.push(component);
        let metadata = fs::symlink_metadata(&path).map_err(|_| failure())?;
        if components.peek().is_some() {
            if !metadata.is_dir() {
                return Err(failure());
            }
        } else if !metadata.is_file() {
            return Err(failure());
        }
    }
    let file = File::open(path).map_err(|_| failure())?;
    let metadata = file.metadata().map_err(|_| failure())?;
    if !metadata.is_file() {
        return Err(failure());
    }
    if metadata.len() > limit as u64 {
        return Err(format!("payload {relative} exceeds its size limit"));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("could not read payload {relative}"))?;
    check_limit(&bytes, limit, relative)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    const PACKAGE_NAME: &str = "gajae-app";
    const VERSION: &str = "2.0.0-beta.9";
    const OTHER_VERSION: &str = "2.0.0-beta.10";

    fn manifest() -> Value {
        let file = |package| {
            json!({
                "package": package,
                "path": "native/index.js",
                "sha256": "0".repeat(64),
            })
        };
        json!({
            "schemaVersion": 2,
            "gjcSdk": "0.16.4",
            "bun": "1.4.0",
            "natives": "0.16.4",
            "platforms": {
                "darwin-arm64": {"files": [file("@gajae-code/natives")]},
                "linux-x64": {"files": [file("@gajae-code/natives")]},
            },
            "sdkLifecycle": {
                "id": "gjc-sdk-lifecycle-v1",
                "packages": {"@gajae-code/coding-agent":"0.16.4", "@gajae-code/agent-core":"0.16.4"},
                "files": [
                    {"package":"@gajae-code/coding-agent","path":"src/sdk/session.ts","sha256":"a".repeat(64)},
                    {"package":"@gajae-code/agent-core","path":"src/agent-loop.ts","sha256":"b".repeat(64)}
                ]
            }
        })
    }

    fn expected(source: &[u8]) -> ExpectedPayload {
        ExpectedPayload::from_build_values(
            Some(PACKAGE_NAME),
            Some(VERSION),
            Some(&format!("{:x}", Sha256::digest(source))),
        )
        .unwrap()
    }

    fn bytes(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).unwrap()
    }

    #[test]
    fn compiled_expectations_are_complete() {
        // This also detects missing build.rs integration; no payload fallback.
        ExpectedPayload::compiled().unwrap();
    }

    #[test]
    fn missing_or_malformed_build_values_fail_closed() {
        let digest = "a".repeat(64);
        let valid = [Some(PACKAGE_NAME), Some(VERSION), Some(digest.as_str())];
        for index in 0..valid.len() {
            for bad in [
                None,
                Some(""),
                Some(" "),
                Some("untrusted\nvalue"),
                Some(" padded"),
            ] {
                let mut inputs = valid;
                inputs[index] = bad;
                assert!(
                    ExpectedPayload::from_build_values(inputs[0], inputs[1], inputs[2]).is_err()
                );
            }
        }
        for bad in [
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            "g".repeat(64),
        ] {
            assert!(ExpectedPayload::from_build_values(valid[0], valid[1], Some(&bad)).is_err());
        }
    }

    #[test]
    fn package_requires_expected_name_and_product_version_but_allows_existing_fields() {
        let expected = expected(&bytes(&manifest()));
        let package = json!({"name": PACKAGE_NAME, "version": VERSION,
            "desktopVersion": "0.2.3", "dependencies": {}, "type": "module"});
        assert!(expected.verify_package(&bytes(&package)).is_ok());
        for field in ["name", "version"] {
            for bad in [
                Value::Null,
                json!(false),
                json!(1),
                json!([]),
                json!({}),
                json!(""),
                json!("wrong"),
            ] {
                let mut value = package.clone();
                value[field] = bad;
                assert!(expected.verify_package(&bytes(&value)).is_err());
            }
            let mut value = package.clone();
            value.as_object_mut().unwrap().remove(field);
            assert!(expected.verify_package(&bytes(&value)).is_err());
            let duplicate = format!(
                "{{\"{field}\":{},{}",
                package[field],
                &package.to_string()[1..]
            );
            assert!(expected.verify_package(duplicate.as_bytes()).is_err());
        }
        for bad in [b"null".as_slice(), b"[]", b"{", b"\xff"] {
            assert!(expected.verify_package(bad).is_err());
        }
    }

    #[test]
    fn manifest_copies_may_differ_in_formatting_but_not_content() {
        let manifest = manifest();
        let source = serde_json::to_vec_pretty(&manifest).unwrap();
        let worker = bytes(&manifest);
        assert_ne!(source, worker);
        let expected = expected(&source);
        assert!(expected.verify_manifests(&source, &worker).is_ok());
        // The source copy's digest remains exact, not canonicalized at runtime.
        assert!(expected.verify_manifests(&worker, &worker).is_err());
        let mut changed = manifest.clone();
        changed["bun"] = json!("1.4.1");
        assert!(expected
            .verify_manifests(&source, &bytes(&changed))
            .is_err());
        assert!(expected
            .verify_manifests(&bytes(&changed), &bytes(&changed))
            .is_err());
        changed = manifest;
        changed["platforms"]["darwin-arm64"]["files"][0]["sha256"] = json!("f".repeat(64));
        assert!(expected
            .verify_manifests(&source, &bytes(&changed))
            .is_err());
    }

    #[test]
    fn signed_manifest_requires_its_final_compiled_digest_without_a_runtime_fallback() {
        let original = bytes(&manifest());
        let mut signed = manifest();
        signed["platforms"]["darwin-arm64"]["files"][0]["sha256"] = json!("f".repeat(64));
        let signed = bytes(&signed);
        // Code signing legitimately changes native bytes. The pre-sign binding
        // must reject those bytes; the finalization rebuild supplies the exact
        // post-sign digest rather than trusting a mutable receipt at startup.
        assert!(expected(&original)
            .verify_manifests(&signed, &signed)
            .is_err());
        assert!(expected(&signed).verify_manifests(&signed, &signed).is_ok());
        assert!(expected(&signed)
            .verify_manifests(&original, &original)
            .is_err());
    }

    fn reject_even_with_matching_digest(value: &Value) {
        let source = bytes(value);
        assert!(expected(&source)
            .verify_manifests(&source, &source)
            .is_err());
    }

    #[test]
    fn current_source_manifest_is_accepted_by_the_native_pre_server_guard() {
        let source = include_bytes!("../../server/gjc-runtime-manifest.json");
        let value: Value = serde_json::from_slice(source).unwrap();
        let formatted = serde_json::to_vec_pretty(&value).unwrap();
        expected(source)
            .verify_manifests(source, &formatted)
            .unwrap();
    }

    #[test]
    fn shared_sdk_inventory_limit_accepts_the_boundary_and_rejects_overflow() {
        let mut value = manifest();
        let files = value["sdkLifecycle"]["files"].as_array_mut().unwrap();
        let template = files[0].clone();
        while files.len() < sdk_file_limit().unwrap() {
            let mut file = template.clone();
            file["path"] = json!(format!("src/provider-{}.ts", files.len()));
            files.push(file);
        }
        let source = bytes(&value);
        assert!(expected(&source).verify_manifests(&source, &source).is_ok());
        let mut overflow = template;
        overflow["path"] = json!("src/overflow.ts");
        value["sdkLifecycle"]["files"]
            .as_array_mut()
            .unwrap()
            .push(overflow);
        reject_even_with_matching_digest(&value);
    }

    #[test]
    fn sdk_closure_is_required_unique_and_semantically_identical_in_worker_copy() {
        let source = bytes(&manifest());
        let mut worker = manifest();
        worker["sdkLifecycle"]["files"][0]["sha256"] = json!("f".repeat(64));
        assert!(expected(&source)
            .verify_manifests(&source, &bytes(&worker))
            .is_err());
        for bad in [
            json!({}),
            json!({"id":"x","packages":{},"files":[]}),
            Value::Null,
        ] {
            let mut value = manifest();
            value["sdkLifecycle"] = bad;
            reject_even_with_matching_digest(&value);
        }
        let mut value = manifest();
        let file = value["sdkLifecycle"]["files"][0].clone();
        value["sdkLifecycle"]["files"]
            .as_array_mut()
            .unwrap()
            .push(file);
        reject_even_with_matching_digest(&value);
        let mut value = manifest();
        value["sdkLifecycle"]["files"][0]["path"] = json!("src/../secret.ts");
        reject_even_with_matching_digest(&value);
        let duplicate = String::from_utf8(source).unwrap().replace(
            "\"@gajae-code/coding-agent\":\"0.16.4\"",
            "\"@gajae-code/coding-agent\":\"0.16.4\",\"@gajae-code/coding-agent\":\"0.16.4\"",
        );
        assert!(parse_manifest(duplicate.as_bytes()).is_err());
    }

    #[test]
    fn manifest_requires_supported_schema_and_typed_nonempty_fields() {
        for field in [
            "schemaVersion",
            "gjcSdk",
            "bun",
            "natives",
            "platforms",
            "sdkLifecycle",
        ] {
            let mut value = manifest();
            value.as_object_mut().unwrap().remove(field);
            reject_even_with_matching_digest(&value);
            for bad in [Value::Null, json!([]), json!(false)] {
                let mut value = manifest();
                value[field] = bad;
                reject_even_with_matching_digest(&value);
            }
        }
        for (field, bad) in [
            ("schemaVersion", json!(1)),
            ("schemaVersion", json!("1")),
            ("schemaVersion", json!(1.0)),
            ("gjcSdk", json!("")),
            ("bun", json!(" ")),
            ("natives", json!(3)),
            ("platforms", json!({})),
            ("unknown", json!(true)),
        ] {
            let mut value = manifest();
            value[field] = bad;
            reject_even_with_matching_digest(&value);
        }
    }

    #[test]
    fn manifest_rejects_bad_closures_files_hashes_and_paths() {
        for platform in ["darwin-arm64", "linux-x64"] {
            for bad in [
                Value::Null,
                json!({}),
                json!({"files": null}),
                json!({"files": {}}),
                json!({"files": [null]}),
            ] {
                let mut value = manifest();
                value["platforms"][platform] = bad;
                reject_even_with_matching_digest(&value);
            }
            for field in ["package", "path", "sha256"] {
                let mut value = manifest();
                value["platforms"][platform]["files"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove(field);
                reject_even_with_matching_digest(&value);
            }
            for (field, bad) in [
                ("package", json!("other")),
                ("path", json!("native/../elsewhere")),
                ("path", json!("/native/index.js")),
                ("path", json!("native/./index.js")),
                ("path", json!("native//index.js")),
                ("path", json!("native\\index.js")),
                ("path", json!("native/")),
                ("path", json!("native/a\u{0}b")),
                ("sha256", json!("0".repeat(63))),
                ("sha256", json!("F".repeat(64))),
                ("sha256", json!(false)),
                ("extra", json!(true)),
            ] {
                let mut value = manifest();
                value["platforms"][platform]["files"][0][field] = bad;
                reject_even_with_matching_digest(&value);
            }
            let mut value = manifest();
            let file = value["platforms"][platform]["files"][0].clone();
            value["platforms"][platform]["files"]
                .as_array_mut()
                .unwrap()
                .push(file);
            reject_even_with_matching_digest(&value);
        }
        let mut value = manifest();
        value["platforms"]["darwin-arm64"]["files"] = json!([]);
        value["platforms"]["linux-x64"]["files"] = json!([]);
        reject_even_with_matching_digest(&value);
    }

    #[test]
    fn duplicate_manifest_fields_or_platforms_are_rejected() {
        let original = manifest().to_string();
        for source in [
            original.replacen("\"bun\":", "\"bun\":\"wrong\",\"bun\":", 1),
            original.replacen(
                "\"darwin-arm64\":",
                "\"darwin-arm64\":{\"files\":[]},\"darwin-arm64\":",
                1,
            ),
            original.replacen("\"files\":", "\"files\":[],\"files\":", 1),
            original.replacen("\"path\":", "\"path\":\"native/other\",\"path\":", 1),
            "null".into(),
            "[]".into(),
            "{".into(),
        ] {
            assert!(expected(source.as_bytes())
                .verify_manifests(source.as_bytes(), source.as_bytes())
                .is_err());
        }
    }

    #[test]
    fn all_input_sizes_are_bounded_including_valid_json_with_trailing_whitespace() {
        let source = bytes(&manifest());
        let expected = expected(&source);
        let mut oversized = bytes(&json!({"name": PACKAGE_NAME, "version": VERSION}));
        oversized.resize(PACKAGE_LIMIT + 1, b' ');
        assert!(expected
            .verify_package(&oversized)
            .unwrap_err()
            .contains("size limit"));
        oversized = source.clone();
        oversized.resize(MANIFEST_LIMIT + 1, b' ');
        assert!(expected
            .verify_manifests(&oversized, &source)
            .unwrap_err()
            .contains("size limit"));
        assert!(expected
            .verify_manifests(&source, &oversized)
            .unwrap_err()
            .contains("size limit"));
    }

    struct Fixture {
        root: PathBuf,
        source: Vec<u8>,
    }

    impl Fixture {
        fn new() -> Self {
            static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "gajae-expected-payload-test-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            // Exclusive creation: never reuse or clean another test's directory.
            fs::create_dir(&root).unwrap();
            let fixture = Self {
                root,
                source: serde_json::to_vec_pretty(&manifest()).unwrap(),
            };
            fs::create_dir(fixture.root.join("server")).unwrap();
            fs::create_dir_all(fixture.root.join("dist-server/server")).unwrap();
            fixture.write(
                "package.json",
                &bytes(&json!({"name": PACKAGE_NAME, "version": VERSION})),
            );
            fixture.write(SOURCE_MANIFEST, &fixture.source);
            fixture.write(WORKER_MANIFEST, &bytes(&manifest()));
            fixture
        }

        fn write(&self, relative: &str, content: &[u8]) {
            fs::write(self.root.join(relative), content).unwrap();
        }

        fn verify(&self) -> Result<(), String> {
            expected(&self.source).verify_payload(&self.root)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn packaged_layout_is_accepted_without_update_configuration_or_writes() {
        let fixture = Fixture::new();
        assert!(fixture.verify().is_ok());
        assert_eq!(
            fs::read(fixture.root.join(SOURCE_MANIFEST)).unwrap(),
            fixture.source
        );
        assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 3);
    }

    #[test]
    fn missing_files_and_nonregular_files_fail_closed() {
        for relative in ["package.json", SOURCE_MANIFEST, WORKER_MANIFEST] {
            let fixture = Fixture::new();
            fs::remove_file(fixture.root.join(relative)).unwrap();
            assert!(fixture.verify().is_err());
            fs::create_dir(fixture.root.join(relative)).unwrap();
            assert!(fixture.verify().is_err());
        }
        let fixture = Fixture::new();
        assert!(expected(&fixture.source)
            .verify_payload(&fixture.root.join("missing"))
            .is_err());
        assert!(expected(&fixture.source)
            .verify_payload(&fixture.root.join("package.json"))
            .is_err());
    }

    #[test]
    fn wrong_payload_metadata_is_refused_before_startup() {
        for relative in ["package.json", SOURCE_MANIFEST, WORKER_MANIFEST] {
            let fixture = Fixture::new();
            fixture.write(relative, b"{}");
            assert!(fixture.verify().is_err());
        }
        let fixture = Fixture::new();
        fixture.write(
            "package.json",
            &bytes(&json!({"name": PACKAGE_NAME, "version": OTHER_VERSION})),
        );
        assert!(fixture.verify().is_err());
    }

    #[test]
    fn oversized_files_are_refused() {
        for (relative, limit) in [
            ("package.json", PACKAGE_LIMIT),
            (SOURCE_MANIFEST, MANIFEST_LIMIT),
            (WORKER_MANIFEST, MANIFEST_LIMIT),
        ] {
            let fixture = Fixture::new();
            fixture.write(relative, &vec![b' '; limit + 1]);
            assert!(fixture.verify().unwrap_err().contains("size limit"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_files_or_manifest_directories_are_refused() {
        use std::os::unix::fs::symlink;
        for relative in ["package.json", SOURCE_MANIFEST, WORKER_MANIFEST] {
            let fixture = Fixture::new();
            let file = fixture.root.join(relative);
            let moved = file.with_extension("saved");
            fs::rename(&file, &moved).unwrap();
            symlink(moved.file_name().unwrap(), &file).unwrap();
            assert!(fixture.verify().is_err());
        }
        let fixture = Fixture::new();
        fs::rename(
            fixture.root.join("server"),
            fixture.root.join("saved-server"),
        )
        .unwrap();
        symlink("saved-server", fixture.root.join("server")).unwrap();
        assert!(fixture.verify().is_err());
    }

    #[test]
    fn errors_do_not_echo_payload_controlled_values() {
        let expected = expected(&bytes(&manifest()));
        let sentinel = "sentinel-secret-file-path-and-token";
        let value = json!({"name": PACKAGE_NAME, "version": sentinel});
        assert!(!expected
            .verify_package(&bytes(&value))
            .unwrap_err()
            .contains(sentinel));
        assert!(!expected
            .verify_package(sentinel.as_bytes())
            .unwrap_err()
            .contains(sentinel));
    }
}
