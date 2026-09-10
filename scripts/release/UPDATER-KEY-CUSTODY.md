# Local production updater-key custody

The matching public key is now compiled into the published beta.12 / desktop
0.2.6 application. The encrypted private key signed its updater archive and
official Minisign 0.12 verification passed. No private key/password was uploaded.
Independent backup remains deferred by the operator; see the release's explicit
acceptance/limitations in `docs/RELEASE-BETA12-ACCEPTANCE.md`.

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
official Minisign 0.12 as required by `LOCAL-RELEASE.md`. The original provisioning
proof preceded the beta.12 publication recorded above.

## Independent recovery backup — complete (2026-09-10)

The encrypted private key, public key and recovery instructions were copied to
iCloud Drive at `~/Library/Mobile Documents/com~apple~CloudDocs/gajae-release-backup/`
(mode 700; key files mode 600) with a `SHA256SUMS` manifest. Copied bytes hash-match
the source files (`updater.key` `22d01b6b…f4a45`, `updater.key.pub` `f4ac38b7…83e26`).
The key file itself stays password-encrypted; no password is stored beside it.

Completed gates:

- ~~A restore/sign/verify test FROM the backup copy~~ **Done 2026-09-10**
  (`verify-backup-restore.mjs` next to the key): restored from the iCloud copy
  into a temp dir, hash-matched the manifest and the original, signed a random
  challenge with the official Tauri signer using the restored key, and the
  native verifier accepted the signature while rejecting tampering and a wrong
  key (`backupRestoreVerified: true`). The original key was never modified.
- ~~Recording the password in a password store independent of this Mac~~
  **Done 2026-09-10** — the owner confirmed recording the password outside
  this Mac (contents not disclosed to or verified by the agent, by design).

Optional hardening, not required: a second destination (encrypted USB) if
iCloud is not considered sufficiently independent.

Local key provisioning is ready and the independent backup is complete. The
remaining authorization/recovery/minimum-OS/public-release gates are still
open. Do not
regenerate the production key merely because a new app version is being built.
