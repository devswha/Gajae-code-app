# Local production updater-key custody

## Verified local setup — September 9, 2026

The operator generated a password-protected Tauri key through the official
interactive prompt and stored the same password through macOS Security's
interactive Keychain prompt. Neither password was supplied in chat or on argv.
No existing key or Keychain item was overwritten.

- Private key: `/Users/devswha/.config/gajae-release/updater.key`.
- Public key: the adjacent `updater.key.pub`.
- The private directory is mode 700; both key files are mode 600.
- Exact login Keychain item: service `app.gajae.release.updater`, account
  `production-v1`. Other credential items were not read.
- Public-key packet SHA-256:
  `6f0054b3ce55917aeb1bc07e18b6c7d266298fe356a361ab94972fc821f1a4c5`.

The stored, nonempty password successfully decrypted the key for an official
Tauri CLI 2.11.4 signature over a random non-release challenge. Password input
was scoped to that signer child's documented environment, not command arguments,
build/install processes or logs. The native updater dependency minisign-verify
0.2.5 accepted the prehashed signature, rejected changed challenge bytes and
rejected an unrelated public key. Both key files were unchanged.

Local receipt:
`/Users/devswha/.config/gajae-release/verification-FoLuRJ/result.json`.
The private directory also contains the operator guide and bounded smoke helper.
The repository contains no private key, password or signing credential.

This is **local key-provisioning proof**, not a published update, a production
app change, or final release acceptance. The release verifier must still use
official Minisign 0.12 as required by `LOCAL-RELEASE.md`. This key has not yet
been bound into a publicly distributed updater-enabled application.

## Independent recovery backup remains pending

The key and Keychain password currently reside on one Mac. A second folder on
that Mac is not an independent backup. No external destination was selected,
no external key copy was created, and no restore test was claimed.

The operator must select encrypted external storage and retain the encrypted
private key, matching public key and recovery instructions there. The password
must also remain recoverable independently of this Mac, without storing it in
plaintext beside the key. Verify copied bytes and a restore/sign/verify test
before marking backup complete; never overwrite the original to test recovery.

Local key provisioning is now ready. Independent backup and remaining
authorization/recovery/minimum-OS/public-release gates are still open. Do not
regenerate the production key merely because a new app version is being built.
