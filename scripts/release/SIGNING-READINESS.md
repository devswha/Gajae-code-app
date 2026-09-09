# Release signing readiness

Production updater-key local provisioning was verified on September 9, 2026;
independent backup remains pending. See [UPDATER-KEY-CUSTODY.md](UPDATER-KEY-CUSTODY.md)
before generating or replacing any key. This does not configure hosted secrets
or complete public-release acceptance.

Run from the reviewed release checkout with Node 22. These checks do not sign,
submit, publish, dispatch workflows, export credentials or modify a keychain.
The checker uses only Node built-ins, so it can run before `npm ci`.

```sh
. "$HOME/.nvm/nvm.sh"
nvm use 22
node scripts/release/check-signing-readiness.mjs --mode github --repo devswha/gajae-code-app
node scripts/release/check-signing-readiness.mjs --mode ci
```

All modes emit JSON. Exit 0 means the reported prerequisite **scope** passed;
exit 1 means blocked; exit 2 means invalid CLI syntax. Each external command
has a 30-second timeout. Raw command errors, credentials and notarization
history entries are suppressed. `--mode ci` inspects environment-variable
presence only; `--mode github` requests only secret names and update times.
These checker modes cover the Apple-signing prerequisites below. The workflow
separately checks updater key/password/public-key configuration. Neither check
certifies credentials, updater key custody, or a built artifact.

The workflow now requires signing inputs before installing/building the
macOS payload and independently rejects an unsigned desktop at publication.
This supersedes the historical ad-hoc fallback described in
`docs/DESKTOP-TAURI-VERIFICATION.md`. The local packaging scripts can still
build ad-hoc development artifacts. Do not use the old sequence of publishing
an ad-hoc asset and replacing it later.

## GitHub-hosted signing requirements

The macOS job uses the `release` environment. Its Apple-signing secret names
are below; repository secrets are also visible to the job, with environment
secrets taking precedence. The checker does not inspect organization grants.
This repository is user-owned, so that limitation does not affect its result.

| Secret | Required metadata/value contract |
| --- | --- |
| `APPLE_CERTIFICATE_P12` | Base64-encoded Developer ID Application PKCS#12 identity, including its private key |
| `APPLE_CERTIFICATE_PASSWORD` | Nonempty password for that PKCS#12 identity |
| `APPLE_ID` | Apple developer account email |
| `APPLE_TEAM_ID` | Team owning the signing identity and notarization account |
| `APPLE_APP_PASSWORD` | App-specific notarization password, not the Apple account password |

The updater lane additionally requires `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets, plus the
`GAJAE_UPDATER_PUBLIC_KEY` repository/environment variable containing the
matching Tauri base64 public key. The workflow requires nonempty values and
official Minisign 0.12. The public key is not a credential; private keys and
passwords must never appear on argv, in artifacts or logs. Provisioning,
backup/recovery and production-versus-QA key/feed binding remain separately
approved readiness work, not consequences of an Apple certificate check.
Updater private credentials are scoped to the readiness and final archive
signing steps, not dependency installation, app builds, or runtime smokes.

`DISCORD_WEBHOOK_URL` is optional for announcements. `GITHUB_TOKEN` is supplied
by Actions for publication; it is not a signing secret to provision.
This task does not export or upload any private key or credential. Existing
local keychain items do not automatically become Actions secrets. Populating
this hosted lane requires owner-provisioned credentials under a separately
approved credential-handling process, or a different release architecture.

Read-only metadata inspection:

```sh
gh secret list --repo devswha/gajae-code-app --env release --json name,updatedAt
gh secret list --repo devswha/gajae-code-app --json name,updatedAt
gh api repos/devswha/gajae-code-app/environments/release \
  --jq '{protection_rules,deployment_branch_policy,can_admins_bypass}'
gh api repos/devswha/gajae-code-app/actions/runners \
  --jq '{total_count,runners:[.runners[]|{name,os,status}]}'
```

Observed September 6, 2026 (KST): both secret lists were `[]`, the environment
had no protection rules or deployment branch policy, and the repository had
zero self-hosted runners. The workflow itself rejects dispatches outside
`refs/heads/main`; do not describe this as a protected environment policy.
Before introducing CI credentials, the owner should configure the intended
environment access restrictions. A local Mac cannot be selected as an
Actions runner without separately provisioning and securing that runner.

## Existing local signing route, without exporting credentials

Use the documented Developer ID identity and known notary profile. The
identity selector is public certificate metadata, not a secret.

```sh
export APPLE_SIGNING_IDENTITY='Developer ID Application: sangwoo ha (5987KT43TJ)'
node scripts/release/check-signing-readiness.mjs --mode local \
  --keychain "$HOME/Library/Keychains/login.keychain-db" \
  --profile gajae-notary
```

Observed September 6, 2026 (KST): the exact valid Developer ID identity was
present in the specified login keychain, and the named profile successfully
authenticated a read-only `notarytool history` request. No private-key signing
operation was performed. The profile uses notarytool's default credential
store: forcing `--notary-keychain` to the login keychain reports a missing
profile on this Mac. Specify `--notary-keychain /absolute/path` only for a
profile deliberately stored there. The checker enumerates only code-signing
identities in the explicit certificate keychain and queries only the named
notary profile; it never enumerates credential items or profiles.

This is a viable prerequisite route for a local release, not proof of new
artifact acceptance. Keep `APPLE_SIGNING_IDENTITY` exported throughout the
existing signed release procedure in `docs/DESKTOP-TAURI-VERIFICATION.md`.
Build from the final integrated commit and release version owned by the
parent; do not reuse a pre-SDK-upgrade bundle. `codesign` consumes the existing
keychain identity; notarytool consumes the named profile. No PKCS#12 export,
Apple password extraction or GitHub secret transfer is necessary.

The hosted workflow cannot ingest an already signed local DMG. Use the
explicit draft-first path in `scripts/release/LOCAL-RELEASE.md`: the local
verifier binds the draft ID/tag/commit and independent asset hashes, checks
signatures/staples/Gatekeeper and versions, then publishes only when invoked
with `--publish`. This path requires no hosted signing secrets and preserves
the workflow's unsigned-publication guard. Neither route was dispatched or
published while implementing these checks.

Hosted dispatch is also draft-only by default. Its explicit `publish` input
authorizes publication only after the shared verifier has rechecked all eight
assets, signatures, exact commit, complete desktop-version history and mutable
draft/tag inputs. Announcements run only after successful explicit publication.

## Bounded validation after integration

1. Run the parent integration's `npm run verify` on supported Node, Rust and
   exactly Bun 1.4.0. Re-run the readiness commands above against the selected
   signing route. This check does not send any live model prompt.
2. Build one macOS arm64 candidate at that commit using the existing payload,
   Tauri (`env -u CI`), signing and DMG commands. Notarize the app first, staple
   it, then package/sign/notarize/staple the DMG. Use
   `xcrun notarytool submit <artifact> --keychain-profile gajae-notary --wait --timeout 60m`
   for a bounded submission wait. If it remains in progress, record the
   submission ID and use `notarytool info` on that ID; do not submit duplicates.
   Never re-sign a stapled app; regenerate the DMG checksum after stapling.
   Then follow `LOCAL-RELEASE.md` to build/sign the unchanged final app archive
   and verify DMG/updater equivalence. Never use a pre-staple updater archive.
3. Require DMG and app staples, Gatekeeper acceptance, and deep/strict
   signatures both on the mounted image and on a quarantined copy on a
   writable volume. Run both packaged-server smokes below against that copy,
   outside any checkout/node_modules ancestor, with their isolated data roots.
   Complete one GUI sign-in-link, quit/relaunch and persistence drill.

   ```sh
   node scripts/release/smoke-packaged-server.mjs --tauri-app "$COPIED_APP"
   node scripts/release/smoke-packaged-server.mjs --tauri-app "$COPIED_APP" --data-survival
   ```

4. Linux self-hosting: the existing supported artifact is
   `gajae-app-server-<version>-linux-x64-node22.tar.gz` (glibc 2.35+). Let the
   Linux packaging owner validate fresh archives on Ubuntu 22.04 and 24.04,
   including checksum, outside-checkout native/Bun loading, authenticated
   startup, job create/abort/replay, and a two-boot data-survival drill. On a
   disposable systemd user account, exercise install, cutover and rollback
   from `docs/SELF-HOST.md`; never use production data for acceptance. The
   existing 22.04 extraction/CLI-help check alone is insufficient for that
   claim. No Linux archive or systemd acceptance was run in this task.
5. Windows: there is no Windows release job or installer target in the
   current workflow/Tauri configuration (`targets: ["dmg"]`). Windows source
   and Job Object tests do not establish installable Windows support. A
   Windows runner, packaged native runtime closure, installer configuration,
   signing/distribution decision, and installed-app lifecycle/PTY/job tests
   are a separate bounded packaging effort. Do not advertise Windows release
   readiness from the macOS/Linux results.

Capture commit/version, architecture, checksums, submission IDs and acceptance
results with the final artifacts before the parent publishes anything. If a
live provider drill is added, the authorized model is exclusively
`openai-codex/gpt-6-astra` (`openai/gpt-6-astra`) with reasoning `xhigh`.
