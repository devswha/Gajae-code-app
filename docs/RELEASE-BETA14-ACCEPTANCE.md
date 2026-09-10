# beta.14 release acceptance

Source: `60c98e33db3905a483c536e4c1b76215b4398aa2`.
Product `2.0.0-beta.14`, desktop `0.2.8`, SDK `0.16.4`.
Release ID: `386182917`; publicly published September 10, 2026 at 10:28:43 UTC
(19:28:43 KST). Tag `v2.0.0-beta.14` resolves to the exact source commit above.

## Why this release exists

beta.13 shipped a macOS binary with `updateMode: disabled` (see
`RELEASE-BETA13-ACCEPTANCE.md`). beta.14 is the corrected successor and
carries the fixes that make that class of failure impossible or survivable:

| Commit | Change |
| --- | --- |
| `2095beb`, `3305e43` | Release verifier runs `--desktop-build-info` on every lane (from the mounted image) and refuses anything but `production` for an updater release |
| `98f7a86` | Release-profile macOS builds fail without an explicit `GJC_UPDATE_MODE`; CI names the mode |
| `0bd7a57` | A build without an updater sets aside the attempt that installed it and starts instead of blocking forever |
| `ee17c83` | Only an unconsumed Update click or an unfinished install shows a launch screen |
| `384a8cd` | The ready state says **Restart to install** and names the version |
| `6068f06` | Update screens explain themselves in user terms |
| `7c57956`, `e2f761e`, `799a5b8` | Rate-limit reset honored and reported; quiet checks cost one request |

## Build and cryptographic acceptance

- Local lane (`MACOS-ACCEPTANCE.md` + `LOCAL-RELEASE.md`) from a `git archive`
  snapshot of the exact commit with the production binding exported
  (`GJC_UPDATE_MODE=production`, `GJC_UPDATE_FEED_ORIGIN=https://api.github.com`,
  `GJC_UPDATE_PUBKEY` with packet fingerprint `6f0054b3…1f1a4c5`).
- `--desktop-build-info` on the freshly built bundle reported
  `updateMode: production` **before** signing; the verifier reported the same
  from the mounted DMG and the updater-extracted app.
- Developer ID `sangwoo ha (5987KT43TJ)`; hardened signatures verified.
- App notarization Accepted: `1c6e6d1d-c5a8-43f0-8a96-2d51619232ab`.
- DMG notarization Accepted: `81f4d4af-216c-4871-a407-73cbb23acade`.
- Updater archive signed with the production key and verified with Minisign
  0.12; manifest `version: 0.2.8`, `productVersion: 2.0.0-beta.14`.
- Copied-app packaged-server smoke: 7 passed; data-survival smoke passed.

| Payload | SHA-256 |
| --- | --- |
| macOS DMG | `4e890f0d01c7416ef3fc1b566590d8dd66df7972e9bc5b7d7fdef9996f9441f1` |
| Signed updater archive | `d7b9fb05486ec66985bd79a9f67ac91554adad850c392d6afe04af8ee7d2f671` |
| Linux server archive | `0b4dbcb4a54e3d287b4a41316d01a611b456f2f3163ed509ab8f9f39a2886ade` |

## CI and artifact transfer

Exact-source hosted runs passed: CI `34462838582`, macOS desktop
`34462838593` (cargo test incl. the journal set-aside test), Linux server
`34464517385` (dispatched for the exact SHA; Ubuntu 22.04/24.04 acceptance).
Provenance hash matched the downloaded archive and its sidecar.

Two earlier candidates (`d46e6bd`, `3305e43`) were built and notarized but not
published: the first predates the mounted-image verifier fix, the second's
macOS desktop lane failed on a briefly retained journal lock in the new test.

## Draft verification and publication

`local-release.mjs` reported `verified-draft` (floor `0.2.7`, candidate
`0.2.8`), then `--publish` re-verified and reported `published`. The native
discovery code, fed the live listing and manifests, selects
`v2.0.0-beta.14 / 0.2.8` for both a beta.12 (0.2.6) and a beta.13 (0.2.7)
client with a complete scan.

## Operator installation

This Mac ran the updater-disabled beta.13, so the published DMG was installed
manually after a bundle backup (`Gajae Code App Backups/before-beta14-*`).
The installed bundle reports `updateMode: production` and launched normally.

## Public A-to-B observation (beta.12 to beta.14)

After the operator install above, the public beta.12 DMG (SHA `c6351841…`)
was reinstalled over `/Applications` and launched at 20:38:32 KST. Its startup
check reached GitHub (anonymous quota 10 to 16), the sidebar offered 0.2.8,
and the operator pressed Update twice (download, then restart). Observed from
the data root: 20:46:13 cached archive/record, `manual-intent.json` consumed,
beta.12 exited; 20:46:18 bundle at 0.2.8 with the journal in
`awaiting_health`; 20:46:33 journal retired and
`desktop-update-completed.json` written as schema 2 `committed`
(`completed_by_pid` 31552, `server_pid` 31575, target 0.2.6 to 0.2.8, archive
`d7b9fb05…`). The running bundle reports `2.0.0-beta.14 / 0.2.8 / production`
with the release payload manifest digest, valid signature and staple. No
manual intervention was needed.

## Limitations

- Real macOS 13 execution remains untested.
- Administrator cancel/recovery and process ownership scenarios remain
  untested and are **deferred by owner decision (2026-09-10)**: they stay
  disclosed known limitations, not active work, and will be addressed when a
  user issue or PR reports them. The designed behavior (cancel → update held,
  old bundle intact, no automatic retry, explicit recovery) is unchanged.
- Independent external backup of the updater key: **completed 2026-09-10**
  (see `../scripts/release/UPDATER-KEY-CUSTODY.md`).
