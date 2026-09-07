#![cfg(target_os = "macos")]

#[path = "../update_build_binding.rs"]
// Build-script-only entrypoints are intentionally unused by this policy harness.
#[allow(dead_code)]
mod binding;

use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use sha2::{Digest, Sha256};

use binding::{
    BuildInputs, PackageMetadata, UpdateMode, UPDATE_MODE_DISABLED, UPDATE_MODE_PRODUCTION,
    UPDATE_MODE_QA,
};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
        // Wall-clock resolution is not uniqueness under parallel test execution.
        let mut entropy = [0; 16];
        getrandom::getrandom(&mut entropy).unwrap();
        let id = u128::from_ne_bytes(entropy);
        let path = temp.join(format!("gajae-update-binding-{}-{id}", std::process::id()));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }

    fn child(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn package() -> PackageMetadata {
    PackageMetadata::from_parts(
        "gajae-app",
        "2.0.0-beta.9",
        "0.2.3",
        "https://github.com/devswha/gajae-code-app",
        "git+https://github.com/devswha/gajae-code-app.git",
    )
}

fn key_config() -> String {
    let mut record = [0u8; 42];
    record[..2].copy_from_slice(b"Ed");
    for (index, byte) in record[2..].iter_mut().enumerate() {
        *byte = (index as u8).wrapping_add(1);
    }
    let text = format!(
        "untrusted comment: minisign public key: fixture\n{}\n",
        STANDARD.encode(record)
    );
    STANDARD.encode(text)
}

fn expected_fingerprint() -> String {
    let mut record = [0u8; 42];
    record[..2].copy_from_slice(b"Ed");
    for (index, byte) in record[2..].iter_mut().enumerate() {
        *byte = (index as u8).wrapping_add(1);
    }
    let digest = Sha256::digest(record);
    format!("{digest:x}")
}

fn key_with_record(record: &[u8]) -> String {
    let text = format!(
        "untrusted comment: minisign public key: fixture\n{}\n",
        STANDARD.encode(record)
    );
    STANDARD.encode(text)
}

fn inputs(temp_root: &Path) -> BuildInputs {
    BuildInputs {
        target_os: "macos".into(),
        debug: false,
        feed_origin: None,
        mode: None,
        pubkey: None,
        qa_root: None,
        temp_root: Some(temp_root.to_owned()),
    }
}

fn production_inputs(temp_root: &Path) -> BuildInputs {
    BuildInputs {
        target_os: "macos".into(),
        debug: false,
        feed_origin: Some("https://api.github.com".into()),
        mode: Some(UPDATE_MODE_PRODUCTION.into()),
        pubkey: Some(key_config()),
        qa_root: None,
        temp_root: Some(temp_root.to_owned()),
    }
}

fn qa_inputs(temp_root: &Path, qa_root: PathBuf) -> BuildInputs {
    BuildInputs {
        target_os: "macos".into(),
        debug: false,
        feed_origin: Some("https://127.0.0.1:43123".into()),
        mode: Some(UPDATE_MODE_QA.into()),
        pubkey: Some(key_config()),
        qa_root: Some(qa_root),
        temp_root: Some(temp_root.to_owned()),
    }
}

#[test]
fn disabled_mode_is_explicitly_empty_and_unknown_or_partial_modes_fail() {
    let temp = TempRoot::new();
    let disabled = binding::validate(&package(), &inputs(&temp.0)).unwrap();
    assert_eq!(disabled.mode, UpdateMode::Disabled);
    assert_eq!(disabled.feed_origin_value(), "");
    assert_eq!(disabled.pubkey_value(), "");
    assert_eq!(disabled.qa_root_value(), "");

    for partial in [
        BuildInputs {
            feed_origin: Some(String::new()),
            ..inputs(&temp.0)
        },
        BuildInputs {
            pubkey: Some(String::new()),
            ..inputs(&temp.0)
        },
        BuildInputs {
            qa_root: Some(temp.child("root")),
            ..inputs(&temp.0)
        },
        BuildInputs {
            mode: Some(UPDATE_MODE_DISABLED.into()),
            feed_origin: Some("https://api.github.com".into()),
            ..inputs(&temp.0)
        },
    ] {
        assert!(binding::validate(&package(), &partial).is_err());
    }
    let unknown = BuildInputs {
        mode: Some("staging".into()),
        ..inputs(&temp.0)
    };
    assert!(binding::validate(&package(), &unknown).is_err());
}

#[test]
fn nonmac_targets_are_disabled_and_reject_explicit_enablement() {
    let temp = TempRoot::new();
    let mut disabled = inputs(&temp.0);
    disabled.target_os = "linux".into();
    assert_eq!(
        binding::validate(&package(), &disabled).unwrap().mode,
        UpdateMode::Disabled
    );
    for mode in [UPDATE_MODE_PRODUCTION, UPDATE_MODE_QA] {
        let enabled = BuildInputs {
            mode: Some(mode.into()),
            ..disabled.clone()
        };
        assert!(binding::validate(&package(), &enabled).is_err());
    }
}

#[test]
fn production_requires_exact_origin_key_and_release_build() {
    let temp = TempRoot::new();
    let valid = binding::validate(&package(), &production_inputs(&temp.0)).unwrap();
    assert_eq!(valid.mode, UpdateMode::Production);
    assert_eq!(valid.repository, "devswha/gajae-code-app");
    assert_eq!(valid.artifact_prefix, "gajae-app-");
    assert_eq!(valid.key_fingerprint_value(), expected_fingerprint());

    let mut debug = production_inputs(&temp.0);
    debug.debug = true;
    assert!(binding::validate(&package(), &debug).is_err());

    for origin in [
        "https://api.github.com/",
        "https://api.github.com/repos",
        "http://api.github.com",
        "https://user:pass@api.github.com",
        "https://api.github.com?x=1",
        "https://api.github.com#fragment",
    ] {
        let invalid = BuildInputs {
            feed_origin: Some(origin.into()),
            ..production_inputs(&temp.0)
        };
        assert!(binding::validate(&package(), &invalid).is_err());
    }
    let with_qa_root = BuildInputs {
        qa_root: Some(temp.child("qa")),
        ..production_inputs(&temp.0)
    };
    assert!(binding::validate(&package(), &with_qa_root).is_err());
}

#[test]
fn public_key_rejects_invalid_private_oversized_and_control_records() {
    let temp = TempRoot::new();
    let mut invalid = production_inputs(&temp.0);
    let mut wrong_length_record = vec![0u8; 43];
    wrong_length_record[..2].copy_from_slice(b"Ed");
    let mut wrong_algorithm_record = [0u8; 42];
    wrong_algorithm_record[..2].copy_from_slice(b"XX");
    for key in [
        "%%%".to_owned(),
        STANDARD.encode("untrusted comment: minisign encrypted secret key: fixture\n"),
        key_with_record(&wrong_length_record),
        key_with_record(&wrong_algorithm_record),
        STANDARD.encode(format!(
            "untrusted comment: minisign public key: fixture\0\n{}\n",
            STANDARD.encode([b'E', b'd'])
        )),
        "A".repeat(16 * 1024 + 1),
        format!("{}\n", key_config()),
    ] {
        invalid.pubkey = Some(key);
        let error = binding::validate(&package(), &invalid).unwrap_err();
        assert!(!error.contains("fixture"));
    }
}

#[test]
fn qa_requires_exact_local_origin_and_existing_canonical_private_root() {
    let temp = TempRoot::new();
    let root = temp.child("qa");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let valid = binding::validate(&package(), &qa_inputs(&temp.0, root.clone())).unwrap();
    assert_eq!(valid.mode, UpdateMode::Qa);
    assert_eq!(valid.qa_root.as_deref(), Some(root.as_path()));

    let missing_root = BuildInputs {
        qa_root: None,
        ..qa_inputs(&temp.0, root.clone())
    };
    assert!(binding::validate(&package(), &missing_root).is_err());
    assert!(binding::validate(&package(), &qa_inputs(&temp.0, temp.child("missing"))).is_err());
    assert!(binding::validate(&package(), &qa_inputs(&temp.0, temp.0.clone())).is_err());
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(binding::validate(&package(), &qa_inputs(&temp.0, root.clone())).is_err());
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();

    let alias = temp.child("alias");
    symlink(&root, &alias).unwrap();
    assert!(binding::validate(&package(), &qa_inputs(&temp.0, alias)).is_err());

    for origin in [
        "https://127.0.0.1:0",
        "https://127.0.0.1:01",
        "https://127.0.0.1:65536",
        "https://127.0.0.1:43123/",
        "https://127.0.0.1:43123/path",
        "https://user@127.0.0.1:43123",
        "https://127.0.0.2:43123",
        "http://127.0.0.1:43123",
        "https://127.0.0.1:43123?x=1",
        "https://127.0.0.1:43123#x",
    ] {
        let invalid = BuildInputs {
            feed_origin: Some(origin.into()),
            ..qa_inputs(&temp.0, root.clone())
        };
        assert!(binding::validate(&package(), &invalid).is_err());
    }
}

#[test]
fn package_metadata_repository_must_match_and_versions_must_be_semver() {
    let temp = TempRoot::new();
    let mut mismatch = package();
    mismatch.repository_url = "git+https://github.com/other/repo.git".into();
    assert!(binding::validate(&mismatch, &inputs(&temp.0)).is_err());
    let mut invalid_version = package();
    invalid_version.product_version = "not-semver".into();
    assert!(binding::validate(&invalid_version, &inputs(&temp.0)).is_err());
    let mut invalid_homepage = package();
    invalid_homepage.homepage = "https://github.com/devswha/gajae-code-app/".into();
    assert!(binding::validate(&invalid_homepage, &inputs(&temp.0)).is_err());
}

#[test]
fn qa_certificate_is_public_bounded_private_and_unaliased() {
    let temp = qa_certificate_root();
    let path = temp.child("updater-ca.pem");
    assert!(binding::read_qa_certificate(&temp.0).is_err());
    let pem = qa_certificate_fixture(&temp);
    assert_eq!(
        binding::read_qa_certificate(&temp.0).unwrap(),
        pem.as_bytes()
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    assert!(binding::read_qa_certificate(&temp.0).is_ok());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(binding::read_qa_certificate(&temp.0).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    for text in [
        "-----BEGIN CERTIFICATE-----\nMAA=\n-----END CERTIFICATE-----\n".into(),
        "-----BEGIN PRIVATE KEY-----\nMAA=\n-----END PRIVATE KEY-----".into(),
        format!("{pem}{pem}"),
        "x".repeat(65537),
    ] {
        fs::write(&path, text).unwrap();
        assert!(binding::read_qa_certificate(&temp.0).is_err());
    }
    fs::remove_file(&path).unwrap();
    let target = temp.child("certificate-original");
    fs::write(&target, &pem).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&target, &path).unwrap();
    assert!(binding::read_qa_certificate(&temp.0).is_err());
    fs::remove_file(&path).unwrap();
    fs::hard_link(&target, &path).unwrap();
    assert!(binding::read_qa_certificate(&temp.0).is_err());
    fs::remove_file(&path).unwrap();
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let fifo = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(binding::read_qa_certificate(&temp.0).is_err());
}

// Only disposable keys in an already-private fixture root. OpenSSL output is
// deliberately suppressed; no private key or certificate contents enter logs.
fn qa_certificate_root() -> TempRoot {
    use std::process::{Command, Stdio};
    let output = Command::new("mktemp")
        .arg("-d")
        .arg(std::env::temp_dir().join("gajae-qa-certificate.XXXXXX"))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .expect("mktemp is required for the isolated CA fixture");
    assert!(
        output.status.success(),
        "could not create private CA fixture"
    );
    let root = fs::canonicalize(std::str::from_utf8(&output.stdout).unwrap().trim()).unwrap();
    assert_eq!(
        fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o700
    );
    TempRoot(root)
}

fn qa_certificate_fixture(temp: &TempRoot) -> String {
    use std::process::{Command, Stdio};
    fs::write(
        temp.child("openssl.cnf"),
        "[req]\ndistinguished_name=dn\n[dn]\n",
    )
    .unwrap();
    let status = Command::new("openssl")
        .current_dir(&temp.0)
        .args([
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
            "-nodes",
            "-keyout",
            "ca-key.pem",
            "-out",
            "updater-ca.pem",
            "-days",
            "1",
            "-sha256",
            "-subj",
            "/CN=Disposable Gajae QA Certificate",
            "-config",
            "openssl.cnf",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("openssl is required for the isolated QA certificate test");
    assert!(
        status.success(),
        "disposable QA certificate generation failed"
    );
    for name in ["ca-key.pem", "updater-ca.pem"] {
        fs::set_permissions(temp.child(name), fs::Permissions::from_mode(0o600)).unwrap();
    }
    fs::read_to_string(temp.child("updater-ca.pem")).unwrap()
}

#[test]
fn qa_certificate_rejects_truncated_or_trailing_der_not_just_wrong_pem() {
    use rustls_pki_types::{pem::PemObject, CertificateDer};
    let temp = qa_certificate_root();
    let pem = qa_certificate_fixture(&temp);
    let certificate = CertificateDer::from_pem_slice(pem.as_bytes()).unwrap();
    let der = certificate.as_ref();
    let mut trailing = der.to_vec();
    trailing.push(0);
    for malformed in [
        &der[..1],
        &der[..der.len() / 2],
        &der[..der.len() - 1],
        trailing.as_slice(),
        b"\x30\x00",
    ] {
        let pem = format!(
            "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
            STANDARD.encode(malformed)
        );
        fs::write(temp.child("updater-ca.pem"), pem).unwrap();
        assert!(binding::read_qa_certificate(&temp.0).is_err());
    }
}

#[test]
fn qa_certificate_parsing_does_not_claim_self_signature_verification() {
    use rustls_pki_types::{pem::PemObject, CertificateDer};
    let temp = qa_certificate_root();
    let pem = qa_certificate_fixture(&temp);
    let mut der = CertificateDer::from_pem_slice(pem.as_bytes())
        .unwrap()
        .as_ref()
        .to_vec();
    // Change the signature value without changing X.509/DER structure. Trust
    // anchor extraction intentionally does not authenticate this self-signature.
    *der.last_mut().unwrap() ^= 1;
    let pem = format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        STANDARD.encode(der)
    );
    fs::write(temp.child("updater-ca.pem"), &pem).unwrap();
    assert_eq!(
        binding::read_qa_certificate(&temp.0).unwrap(),
        pem.as_bytes()
    );
}
