//! Verify the same immutable archive buffer used for inspection and staging,
//! using the selected official updater's Minisign algorithm/library.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use sha2::{Digest, Sha256};

pub fn verify_archive(bytes: &[u8], public_key: &str, signature: &str) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() > crate::updater_store::MAX_ARCHIVE_BYTES {
        return Err("Updater archive is empty or exceeds its limit.".into());
    }
    let key = decode(public_key)?;
    let signature = decode(signature)?;
    let key = PublicKey::decode(&key).map_err(|_| "Invalid updater public key.")?;
    let signature = Signature::decode(&signature).map_err(|_| "Invalid updater signature.")?;
    key.verify(bytes, &signature, false)
        .map_err(|_| "Updater archive signature verification failed.")?;
    Ok(digest(bytes))
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn decode(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 16 * 1024 {
        return Err("Updater signature material exceeds its limit.".into());
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "Invalid updater signature encoding.")?;
    String::from_utf8(bytes).map_err(|_| "Invalid updater signature text.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Published minisign-verify 0.2.5 test vector; real cryptographic verification,
    // not the manifest schema fixture's intentionally fake signature.
    fn vector() -> (String, String) {
        let key = "untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
        let signature = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";
        (STANDARD.encode(key), STANDARD.encode(signature))
    }
    #[test]
    fn actual_signature_accepts_exact_bytes_and_rejects_tampering() {
        let (key, signature) = vector();
        assert_eq!(
            verify_archive(b"test", &key, &signature).unwrap(),
            digest(b"test")
        );
        assert!(verify_archive(b"changed", &key, &signature).is_err());
        assert!(verify_archive(b"test", &STANDARD.encode("bad key"), &signature).is_err());
    }
    #[test]
    fn malformed_material_is_bounded_and_errors_do_not_echo_it() {
        for value in [
            "secret://credential".into(),
            "A".repeat(16385),
            "/w==".into(),
        ] {
            let error = verify_archive(b"test", &value, &value).unwrap_err();
            assert!(!error.contains(&value));
        }
    }
}
