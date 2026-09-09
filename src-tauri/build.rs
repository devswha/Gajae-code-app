#[path = "update_build_binding.rs"]
mod update_build_binding;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-changed=../server/gjc-runtime-manifest.json");
    println!("cargo:rerun-if-changed=update_build_binding.rs");
    println!("cargo:rerun-if-env-changed=GJC_SIGNED_RUNTIME_MANIFEST_SHA256");
    for name in update_build_binding::INPUT_ENV_NAMES {
        println!("cargo:rerun-if-env-changed={name}");
    }

    let package_json =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing manifest directory"))
            .join("../package.json");
    let package_text = fs::read_to_string(&package_json)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", package_json.display()));
    let package_value: serde_json::Value =
        serde_json::from_str(&package_text).unwrap_or_else(|error| {
            panic!("failed to parse {}: {error}", package_json.display());
        });
    let package = update_build_binding::PackageMetadata::from_json(&package_value)
        .unwrap_or_else(|error| panic!("invalid {}: {error}", package_json.display()));

    assert_eq!(
        package.desktop_version,
        env::var("CARGO_PKG_VERSION").expect("missing Cargo package version"),
        "src-tauri/Cargo.toml package.version must match package.json desktopVersion"
    );

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let temp_root = (target_os == "macos")
        .then(|| fs::canonicalize(env::temp_dir()).ok())
        .flatten();
    let inputs = update_build_binding::BuildInputs::from_env(
        target_os,
        env::var("PROFILE").is_ok_and(|profile| profile == "debug"),
        temp_root,
    )
    .unwrap_or_else(|error| panic!("invalid updater build inputs: {error}"));
    let binding = update_build_binding::validate(&package, &inputs)
        .unwrap_or_else(|error| panic!("invalid updater build binding: {error}"));
    let qa_ca = match binding.qa_root.as_deref() {
        Some(root) => {
            println!(
                "cargo:rerun-if-changed={}",
                root.join("updater-ca.pem").display()
            );
            STANDARD.encode(
                update_build_binding::read_qa_certificate(root)
                    .expect("QA updater HTTPS certificate is required"),
            )
        }
        None => String::new(),
    };
    println!("cargo:rustc-env=GJC_UPDATE_QA_CA_CERT={qa_ca}");

    println!(
        "cargo:rustc-env=GJC_EXPECTED_PAYLOAD_VERSION={}",
        package.product_version
    );
    println!("cargo:rustc-env=GJC_UPDATE_MODE={}", binding.mode.as_str());
    println!(
        "cargo:rustc-env=GJC_UPDATE_FEED_ORIGIN={}",
        binding.feed_origin_value()
    );
    println!(
        "cargo:rustc-env=GJC_UPDATE_PUBKEY={}",
        binding.pubkey_value()
    );
    println!(
        "cargo:rustc-env=GJC_UPDATE_QA_ROOT={}",
        binding.qa_root_value()
    );
    println!(
        "cargo:rustc-env=GJC_UPDATE_KEY_FINGERPRINT={}",
        binding.key_fingerprint_value()
    );
    println!(
        "cargo:rustc-env=GJC_UPDATE_REPOSITORY={}",
        binding.repository
    );
    println!(
        "cargo:rustc-env=GJC_UPDATE_ARTIFACT_PREFIX={}",
        binding.artifact_prefix
    );
    println!("cargo:rustc-env=GJC_UPDATE_PACKAGE_NAME={}", package.name);
    let product_name = package_value["build"]["productName"]
        .as_str()
        .expect("package.json build.productName is required");
    assert!(!product_name.chars().any(char::is_control));
    println!("cargo:rustc-env=GJC_UPDATE_PRODUCT_NAME={product_name}");
    let identifier = package_value["build"]["appId"]
        .as_str()
        .expect("package build.appId is required");
    assert!(!identifier.chars().any(char::is_control));
    println!("cargo:rustc-env=GJC_UPDATE_BUNDLE_IDENTIFIER={identifier}");
    println!(
        "cargo:rustc-env=GJC_EXPECTED_PAYLOAD_PACKAGE_NAME={}",
        package.name
    );
    let runtime_manifest = fs::read(
        package_json
            .parent()
            .unwrap()
            .join("server/gjc-runtime-manifest.json"),
    )
    .expect("source runtime manifest is required for independent payload binding");
    assert!(
        !runtime_manifest.is_empty() && runtime_manifest.len() <= 64 * 1024,
        "source runtime manifest is empty or oversized"
    );
    let source_digest = format!("{:x}", Sha256::digest(&runtime_manifest));
    let signed_digest = env::var("GJC_SIGNED_RUNTIME_MANIFEST_SHA256").ok();
    let expected_digest = update_build_binding::signed_runtime_digest(
        &source_digest,
        signed_digest.as_deref(),
        &inputs.target_os,
        env::var("PROFILE").is_ok_and(|profile| profile == "release"),
    )
    .expect("invalid final signed runtime binding");
    println!("cargo:rustc-env=GJC_SOURCE_RUNTIME_MANIFEST_SHA256={source_digest}");
    println!("cargo:rustc-env=GJC_EXPECTED_RUNTIME_MANIFEST_SHA256={expected_digest}");

    tauri_build::build()
}
