//! Read-only, compile-bound release diagnostics. This CLI exits before any
//! webview, profile, keychain, updater cache, instance lock or sidecar is created.
use std::ffi::OsString;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildInfo {
    schema_version: u8,
    package_name: &'static str,
    product_version: &'static str,
    desktop_version: &'static str,
    debug: bool,
    update_mode: &'static str,
    runtime_manifest_sha256: &'static str,
    payload_runtime_manifest_sha256: &'static str,
}

pub(crate) fn handle_cli(
    args: impl IntoIterator<Item = OsString>,
) -> Result<Option<String>, String> {
    let args: Vec<_> = args.into_iter().collect();
    if !args.iter().any(|arg| arg == "--desktop-build-info") {
        return Ok(None);
    }
    if args.len() != 1 {
        return Err("--desktop-build-info must be used alone.".into());
    }
    let info = BuildInfo {
        schema_version: 1,
        package_name: env!("GJC_EXPECTED_PAYLOAD_PACKAGE_NAME"),
        product_version: env!("GJC_EXPECTED_PAYLOAD_VERSION"),
        desktop_version: env!("CARGO_PKG_VERSION"),
        debug: cfg!(debug_assertions),
        update_mode: env!("GJC_UPDATE_MODE"),
        runtime_manifest_sha256: env!("GJC_SOURCE_RUNTIME_MANIFEST_SHA256"),
        payload_runtime_manifest_sha256: env!("GJC_EXPECTED_RUNTIME_MANIFEST_SHA256"),
    };
    serde_json::to_string(&info)
        .map(Some)
        .map_err(|_| "Could not encode desktop build info.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostics_are_exact_public_build_constants() {
        let result = handle_cli([OsString::from("--desktop-build-info")])
            .unwrap()
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 8);
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(
            value["packageName"],
            env!("GJC_EXPECTED_PAYLOAD_PACKAGE_NAME")
        );
        assert_eq!(
            value["productVersion"],
            env!("GJC_EXPECTED_PAYLOAD_VERSION")
        );
        assert_eq!(value["desktopVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(value["debug"], cfg!(debug_assertions));
        assert_eq!(value["updateMode"], env!("GJC_UPDATE_MODE"));
        assert_eq!(
            value["runtimeManifestSha256"],
            env!("GJC_SOURCE_RUNTIME_MANIFEST_SHA256")
        );
        assert_eq!(
            value["payloadRuntimeManifestSha256"],
            env!("GJC_EXPECTED_RUNTIME_MANIFEST_SHA256")
        );
        assert!(!result.contains("publicKey") && !result.contains("qaRoot"));
    }

    #[test]
    fn only_explicit_standalone_diagnostic_request_is_handled() {
        assert!(handle_cli(Vec::<OsString>::new()).unwrap().is_none());
        assert!(
            handle_cli([OsString::from("--qa-profile"), OsString::from("/qa")])
                .unwrap()
                .is_none()
        );
        for args in [
            vec!["--desktop-build-info", "--qa-profile", "/qa"],
            vec!["--desktop-build-info", "--desktop-build-info"],
        ] {
            assert!(handle_cli(args.into_iter().map(OsString::from)).is_err());
        }
    }
}
