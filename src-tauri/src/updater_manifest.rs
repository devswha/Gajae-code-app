//! Strict, bounded parsing for the desktop update manifest.
//!
//! This module validates manifest syntax and trusted product identity only. It
//! does not fetch, discover, cache, or cryptographically verify an archive.

use std::{collections::HashSet, fmt};

use reqwest::Url;
use semver::Version;
use serde::de::Error as _;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};

const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_NOTES_BYTES: usize = 64 * 1024;
const MAX_SIGNATURE_BYTES: usize = 16 * 1024;
const MAX_VERSION_LENGTH: usize = 128;
const MACOS_UPDATE_TARGET: &str = "darwin-aarch64";
const MACOS_RUST_TARGET: &str = "aarch64-apple-darwin";
const MAX_SEMVER_COMPONENT: u64 = 9_007_199_254_740_991;
const URL_CREDENTIALS_MESSAGE: &str =
    "Manifest updater URL must be credential-free HTTPS without query or fragment data.";

const ROOT_KEYS: &[&str] = &[
    "version",
    "notes",
    "pub_date",
    "platforms",
    "productVersion",
    "channel",
    "minimumSystemVersion",
    "repository",
    "build",
];
const PLATFORM_KEYS: &[&str] = &["url", "signature"];
const BUILD_KEYS: &[&str] = &["commit", "target"];

/// Native product identity. These values are compiled-in trust anchors, never
/// accepted from an updater request or another IPC caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProductIdentity<'a> {
    pub repository: &'a str,
    pub artifact_prefix: &'a str,
}

/// The only channels represented by the desktop updater contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Beta,
}

/// Owned values from a validated desktop update manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub version: Version,
    pub product_version: Version,
    pub channel: Channel,
    pub minimum_system_version: String,
    pub archive_url: Url,
    pub signature: String,
    pub commit: String,
    pub notes: String,
    pub pub_date: String,
}

/// Parse and validate one bounded `desktop-update.json` document.
///
/// A successful result proves only that the document satisfies the updater
/// schema and trusted identity policy. The signature remains syntax-only; the
/// archive bytes must be verified by the later archive-signing slice.
pub fn parse_manifest(bytes: &[u8], identity: &ProductIdentity<'_>) -> Result<Manifest, String> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(format!(
            "desktop-update.json exceeds its {MAX_MANIFEST_BYTES}-byte limit"
        ));
    }

    let value = parse_json(bytes)?;
    let root = object(&value, "desktop-update.json")?;
    exact_keys(root, ROOT_KEYS, "desktop-update.json")?;

    let version_text = string_field(root, "version", "Manifest version")?;
    let version = strict_version(version_text, "Manifest version")?;
    let product_version_text = string_field(root, "productVersion", "Manifest productVersion")?;
    let product_version = strict_version(product_version_text, "Manifest productVersion")?;
    let channel = channel_for(&product_version)?;
    let declared_channel = string_field(root, "channel", "Manifest channel")?;
    if declared_channel != channel.as_str() {
        return Err("Manifest channel does not match productVersion.".to_owned());
    }

    let notes = bounded_text(
        string_field(root, "notes", "Manifest notes")?,
        "Manifest notes",
        MAX_NOTES_BYTES,
        false,
    )?;
    let pub_date = string_field(root, "pub_date", "Manifest pub_date")?;
    validate_utc_date(pub_date, "Manifest pub_date")?;
    let minimum_system_version = string_field(
        root,
        "minimumSystemVersion",
        "Manifest minimumSystemVersion",
    )?;
    validate_macos_version(minimum_system_version)?;

    let repository = string_field(root, "repository", "Manifest repository")?;
    if repository != identity.repository {
        return Err("Manifest repository is not the trusted repository.".to_owned());
    }

    let platforms = object_field(root, "platforms", "Manifest platforms")?;
    exact_keys(platforms, &[MACOS_UPDATE_TARGET], "Manifest platforms")?;
    let platform = object_field(platforms, MACOS_UPDATE_TARGET, "Manifest platform")?;
    exact_keys(platform, PLATFORM_KEYS, "Manifest darwin-aarch64 platform")?;
    let archive_url_text = string_field(platform, "url", "Manifest updater URL")?;
    let archive_url = validate_archive_url(archive_url_text, product_version_text, identity)?;
    let signature = bounded_signature(string_field(
        platform,
        "signature",
        "Manifest updater signature",
    )?)?;

    let build = object_field(root, "build", "Manifest build")?;
    exact_keys(build, BUILD_KEYS, "Manifest build")?;
    let commit = string_field(build, "commit", "Build commit")?;
    validate_commit(commit)?;
    let target = string_field(build, "target", "Manifest build target")?;
    if target != MACOS_RUST_TARGET {
        return Err("Manifest build target is not the canonical macOS arm64 target.".to_owned());
    }

    Ok(Manifest {
        version,
        product_version,
        channel,
        minimum_system_version: minimum_system_version.to_owned(),
        archive_url,
        signature,
        commit: commit.to_owned(),
        notes,
        pub_date: pub_date.to_owned(),
    })
}

impl Channel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }
}

fn channel_for(version: &Version) -> Result<Channel, String> {
    match version.pre.as_str().split('.').next() {
        None | Some("") => Ok(Channel::Stable),
        Some("beta") => Ok(Channel::Beta),
        Some(_) => Err("Only beta and stable product channels are supported.".to_owned()),
    }
}

fn strict_version(value: &str, label: &str) -> Result<Version, String> {
    if value.is_empty() || value.len() > MAX_VERSION_LENGTH {
        return Err(format!(
            "{label} must be strict SemVer without a leading v."
        ));
    }
    let parsed = Version::parse(value)
        .map_err(|_| format!("{label} must be strict SemVer without a leading v."))?;
    // npm semver's `valid(value)` returns the normalized `version` string,
    // which intentionally omits build metadata. Equality in the producer's
    // strictVersion helper therefore rejects build metadata as well as `v`.
    if !parsed.build.is_empty()
        || parsed.major > MAX_SEMVER_COMPONENT
        || parsed.minor > MAX_SEMVER_COMPONENT
        || parsed.patch > MAX_SEMVER_COMPONENT
        || parsed.to_string() != value
    {
        return Err(format!(
            "{label} must be strict SemVer without a leading v."
        ));
    }
    Ok(parsed)
}

fn validate_macos_version(value: &str) -> Result<(), String> {
    let components: Vec<&str> = value.split('.').collect();
    if !(components.len() == 2 || components.len() == 3)
        || components.iter().any(|part| part.is_empty())
        || components.iter().any(|part| {
            (part.len() > 1 && part.starts_with('0'))
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || match part.parse::<u16>() {
                    Ok(number) => number > 999,
                    Err(_) => true,
                }
        })
    {
        return Err("minimumSystemVersion must be major.minor[.patch].".to_owned());
    }
    Ok(())
}

fn validate_commit(value: &str) -> Result<(), String> {
    if value.len() != 40
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("Build commit must be a lowercase full commit SHA.".to_owned());
    }
    Ok(())
}

fn bounded_signature(value: &str) -> Result<String, String> {
    bounded_text(
        value,
        "Manifest updater signature",
        MAX_SIGNATURE_BYTES,
        false,
    )?;
    if value.len() < 8
        || value.len() % 4 != 0
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err("Manifest updater signature must be base64.".to_owned());
    }
    // Keep the same strict padding grammar as the producer's BASE64 regex.
    let valid_padding = match value.as_bytes().iter().position(|byte| *byte == b'=') {
        None => true,
        Some(index) => {
            let padding = value.len() - index;
            (padding == 1 || padding == 2) && value[index..].bytes().all(|byte| byte == b'=')
        }
    };
    if !valid_padding {
        return Err("Manifest updater signature must be base64.".to_owned());
    }
    Ok(value.to_owned())
}

fn bounded_text(value: &str, label: &str, max_bytes: usize, empty: bool) -> Result<String, String> {
    if (!empty && value.is_empty()) || value.len() > max_bytes {
        return Err(format!("{label} is missing or oversized."));
    }
    if value.bytes().any(|byte| {
        matches!(
            byte,
            0x00..=0x08 | 0x0b..=0x0c | 0x0e..=0x1f | 0x7f
        )
    }) {
        return Err(format!("{label} contains control characters."));
    }
    Ok(value.to_owned())
}

fn validate_utc_date(value: &str, label: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let fractional_len = match bytes.len() {
        20 => 0,
        22 => 1,
        23 => 2,
        24 => 3,
        _ => return Err(format!("{label} must be an ISO-8601 UTC timestamp.")),
    };
    let z_index = if fractional_len == 0 {
        19
    } else {
        20 + fractional_len
    };
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[z_index] != b'Z'
        || (fractional_len > 0 && bytes[19] != b'.')
        || bytes[..4].iter().any(|byte| !byte.is_ascii_digit())
        || bytes[5..7].iter().any(|byte| !byte.is_ascii_digit())
        || bytes[8..10].iter().any(|byte| !byte.is_ascii_digit())
        || bytes[11..13].iter().any(|byte| !byte.is_ascii_digit())
        || bytes[14..16].iter().any(|byte| !byte.is_ascii_digit())
        || bytes[17..19].iter().any(|byte| !byte.is_ascii_digit())
        || bytes[20..20 + fractional_len]
            .iter()
            .any(|byte| !byte.is_ascii_digit())
    {
        return Err(format!("{label} must be an ISO-8601 UTC timestamp."));
    }
    let year = number(&bytes[0..4]);
    let month = number(&bytes[5..7]);
    let day = number(&bytes[8..10]);
    let hour = number(&bytes[11..13]);
    let minute = number(&bytes[14..16]);
    let second = number(&bytes[17..19]);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if month == 0 || day == 0 || day > days_in_month || hour > 23 || minute > 59 || second > 59 {
        return Err(format!("{label} is not a real UTC timestamp."));
    }
    Ok(())
}

fn number(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .fold(0, |value, byte| value * 10 + u32::from(byte - b'0'))
}

fn validate_archive_url(
    value: &str,
    product_version: &str,
    identity: &ProductIdentity<'_>,
) -> Result<Url, String> {
    let archive = format!(
        "https://github.com/{}/releases/download/v{}/{}desktop-{}-macos-arm64.app.tar.gz",
        identity.repository, product_version, identity.artifact_prefix, product_version
    );
    if value != archive {
        return Err("Manifest updater URL is not the canonical GitHub download URL.".to_owned());
    }
    let parsed = Url::parse(value).map_err(|_| "Manifest updater URL is malformed.".to_owned())?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.as_str() != archive
    {
        return Err(URL_CREDENTIALS_MESSAGE.to_owned());
    }
    Ok(parsed)
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object."))
}

fn object_field<'a>(
    values: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<&'a Map<String, Value>, String> {
    object(
        values
            .get(key)
            .ok_or_else(|| format!("{label} is missing."))?,
        label,
    )
}

fn string_field<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .ok_or_else(|| format!("{label} is missing."))?
        .as_str()
        .ok_or_else(|| format!("{label} must be a string."))
}

fn exact_keys(object: &Map<String, Value>, expected: &[&str], label: &str) -> Result<(), String> {
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(format!("{label} contains unexpected or missing fields."));
    }
    Ok(())
}

fn parse_json(bytes: &[u8]) -> Result<Value, String> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = StrictValue::deserialize(&mut deserializer)
        .map_err(|error| format!("desktop-update.json is invalid JSON: {error}"))?
        .0;
    deserializer
        .end()
        .map_err(|error| format!("desktop-update.json has trailing data: {error}"))?;
    Ok(value)
}

struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct StrictVisitor;

        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = StrictValue;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON value")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(StrictValue(Value::Bool(value)))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(StrictValue(Value::Number(value.into())))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(StrictValue(Value::Number(value.into())))
            }

            fn visit_i128<E>(self, value: i128) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                serde_json::Number::from_i128(value)
                    .map(|number| StrictValue(Value::Number(number)))
                    .ok_or_else(|| E::custom("JSON number out of range"))
            }

            fn visit_u128<E>(self, value: u128) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                serde_json::Number::from_u128(value)
                    .map(|number| StrictValue(Value::Number(number)))
                    .ok_or_else(|| E::custom("JSON number out of range"))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                serde_json::Number::from_f64(value)
                    .map(|number| StrictValue(Value::Number(number)))
                    .ok_or_else(|| E::custom("non-finite JSON number"))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(StrictValue(Value::String(value.to_owned())))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(StrictValue(Value::String(value)))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(StrictValue(Value::Null))
            }

            fn visit_seq<A>(self, mut access: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(value) = access.next_element::<StrictValue>()? {
                    values.push(value.0);
                }
                Ok(StrictValue(Value::Array(values)))
            }

            fn visit_map<A>(self, mut access: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = Map::new();
                let mut keys = HashSet::new();
                while let Some(key) = access.next_key::<String>()? {
                    if !keys.insert(key.clone()) {
                        return Err(A::Error::custom("duplicate JSON object key"));
                    }
                    let value = access.next_value::<StrictValue>()?;
                    values.insert(key, value.0);
                }
                Ok(StrictValue(Value::Object(values)))
            }
        }

        deserializer.deserialize_any(StrictVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: ProductIdentity<'static> = ProductIdentity {
        repository: "devswha/gajae-code-app",
        artifact_prefix: "gajae-app-",
    };

    fn fixture() -> Value {
        serde_json::from_slice(include_bytes!(
            "../../shared/fixtures/desktop-update-manifest.json"
        ))
        .expect("fixture JSON")
    }

    fn bytes(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).expect("manifest JSON")
    }

    fn assert_rejected(change: impl FnOnce(&mut Value)) {
        let mut value = fixture();
        change(&mut value);
        assert!(parse_manifest(&bytes(&value), &IDENTITY).is_err());
    }

    #[test]
    fn fixture_is_accepted_with_owned_fields() {
        let manifest = parse_manifest(
            include_bytes!("../../shared/fixtures/desktop-update-manifest.json"),
            &IDENTITY,
        )
        .unwrap();
        assert_eq!(manifest.version.to_string(), "0.2.4");
        assert_eq!(manifest.product_version.to_string(), "2.0.0-beta.10");
        assert_eq!(manifest.channel, Channel::Beta);
        assert_eq!(manifest.minimum_system_version, "13.0");
        assert_eq!(manifest.commit, "a".repeat(40));
        assert_eq!(manifest.signature, "A".repeat(88));
        assert_eq!(manifest.pub_date, "2026-09-06T00:00:00Z");
    }

    #[test]
    fn malformed_unknown_and_duplicate_keys_fail_closed() {
        assert!(parse_manifest(br"{}", &IDENTITY).is_err());
        assert_rejected(|value| {
            value
                .as_object_mut()
                .unwrap()
                .insert("unknown".into(), Value::Null);
        });
        let duplicate = br#"{"version":"0.2.4","version":"0.2.4"}"#;
        assert!(parse_manifest(duplicate, &IDENTITY).is_err());
        let nested_duplicate = br#"{"version":"0.2.4","notes":"ok","pub_date":"2026-09-06T00:00:00Z","platforms":{"darwin-aarch64":{"url":"x","url":"y","signature":"AAAAAAAA"}},"productVersion":"2.0.0-beta.10","channel":"beta","minimumSystemVersion":"13.0","repository":"devswha/gajae-code-app","build":{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","target":"aarch64-apple-darwin"}}"#;
        assert!(parse_manifest(nested_duplicate, &IDENTITY).is_err());
    }

    #[test]
    fn url_date_version_channel_and_target_policy_fail_closed() {
        let wrong_identity = ProductIdentity {
            repository: "another-owner/another-repository",
            artifact_prefix: IDENTITY.artifact_prefix,
        };
        assert!(parse_manifest(
            include_bytes!("../../shared/fixtures/desktop-update-manifest.json"),
            &wrong_identity,
        )
        .is_err());
        let wrong_prefix = ProductIdentity {
            repository: IDENTITY.repository,
            artifact_prefix: "another-prefix-",
        };
        assert!(parse_manifest(
            include_bytes!("../../shared/fixtures/desktop-update-manifest.json"),
            &wrong_prefix,
        )
        .is_err());
        assert_rejected(|value| {
            value["platforms"][MACOS_UPDATE_TARGET]["url"] =
                Value::String("https://github.com/devswha/gajae-code-app/releases/download/v2.0.0-beta.10/gajae-app-desktop-2.0.0-beta.10-macos-arm64.app.tar.gz?token=secret".into());
        });
        for date in [
            "2026-02-29T00:00:00Z",
            "2024-02-30T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-01-01T24:00:00Z",
        ] {
            assert_rejected(|value| value["pub_date"] = Value::String(date.into()));
        }
        for version in ["v2.0.0-beta.10", "2.0.0-beta.01", "2.0.0+build.1", "2.0"] {
            assert_rejected(|value| value["productVersion"] = Value::String(version.into()));
        }
        for version in ["v0.2.4", "0.2.4+build.1", "0.2.4-beta.01", "0.2"] {
            assert_rejected(|value| value["version"] = Value::String(version.into()));
        }
        assert_rejected(|value| value["channel"] = Value::String("stable".into()));
        assert_rejected(|value| {
            value["build"]["target"] = Value::String("aarch64-unknown-linux-gnu".into())
        });
    }

    #[test]
    fn field_bounds_and_shapes_are_enforced() {
        assert!(parse_manifest(&vec![b' '; MAX_MANIFEST_BYTES + 1], &IDENTITY).is_err());
        assert_rejected(|value| value["notes"] = Value::String("x".repeat(MAX_NOTES_BYTES)));
        assert_rejected(|value| value["notes"] = Value::String("ok\u{000b}".into()));
        assert_rejected(|value| {
            value["platforms"][MACOS_UPDATE_TARGET]["signature"] =
                Value::String("A".repeat(MAX_SIGNATURE_BYTES + 1))
        });
        for signature in ["not-base64", "AAAAAAA!", "AAAA===="] {
            assert_rejected(|value| {
                value["platforms"][MACOS_UPDATE_TARGET]["signature"] =
                    Value::String(signature.into())
            });
        }
        assert_rejected(|value| value["build"]["commit"] = Value::String("A".repeat(40)));
        for minimum in [
            "13", "013.0", "13.00", "13.0.0.1", "1000.0", "13.1000", "+13.0", "13.0 ",
        ] {
            assert_rejected(|value| value["minimumSystemVersion"] = Value::String(minimum.into()));
        }
        assert_rejected(|value| value["platforms"] = Value::Array(Vec::new()));
    }

    #[test]
    fn real_leap_day_and_bounded_fractional_utc_timestamp_are_accepted() {
        let mut value = fixture();
        value["pub_date"] = Value::String("2024-02-29T23:59:59.123Z".into());
        assert!(parse_manifest(&bytes(&value), &IDENTITY).is_ok());
    }

    #[test]
    fn producer_semver_build_metadata_is_rejected_like_js_normalized_valid() {
        assert!(strict_version("2.0.0-beta.10+build.1", "version").is_err());
        assert!(strict_version("2.0.0-beta.10", "version").is_ok());
    }
}
