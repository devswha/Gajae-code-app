# beta.13 release acceptance

Source: `58c700fc9288ed3e0ab14bf0a14050e61626cdb2`.
Product `2.0.0-beta.13`, desktop `0.2.7`, SDK `0.16.4`.
Release ID: `386022482`; publicly published September 10, 2026 at 05:24:33 UTC
(14:24:33 KST). Tag `v2.0.0-beta.13` resolves to the exact source commit above.

## Scope and operator decision

The operator asked for the open PR to be merged and the result redeployed so
that an installed beta.12 offers the sidebar **Update** to beta.13. PR #53
(browser preview DPR, clipboard bridging, archived sidebar rows) was merged at
`5226bd4`; the bump commit `58c700f` advanced `version`/`desktopVersion`,
`src-tauri/Cargo.toml`/`Cargo.lock` and added the release notes. PR #44
(Windows desktop) was left open: it conflicts with `main`.

This is the first public version published after the click-driven updater
shipped in beta.12, so it is the public A-to-B candidate. That A-to-B update
was not executed as part of this acceptance; it remains a user-observed result.
No Linux desktop packages were built (owner decision 2026-09-09: macOS first).
The website pins its Linux desktop links to beta.12, the last release that
shipped them.

## Build and cryptographic acceptance

- Hosted `release.yml` was not used: the `release` environment has no signing
  secrets, and the workflow refuses unsigned desktop publication. The local
  lane in `scripts/release/MACOS-ACCEPTANCE.md` and `LOCAL-RELEASE.md` was
  followed from a `git archive` snapshot of the exact commit with private
  `npm ci`, Bun 1.4.0 and a fresh `CARGO_TARGET_DIR`.
- Signing readiness (`--mode local`) passed for the Developer ID identity and
  the `gajae-notary` profile after the login Keychain was unlocked by the user.
- Developer ID: `sangwoo ha (5987KT43TJ)`; hardened signatures and nested
  runtime restamping verified; `codesign --verify --deep --strict` passed.
- App notarization Accepted: `4eae83e1-1f44-4026-9395-5772c94c4231`.
- DMG notarization Accepted: `953e7f13-d11c-4c0b-bb13-5fc7bb9a3e44`.
  Both were stapled before hashing and updater archive creation.
- Updater archive signed with the existing production key
  (`app.gajae.release.updater` / `production-v1`; password passed only to the
  signer child's environment) and verified with official Minisign 0.12.
  The manifest carries `version: 0.2.7`, `productVersion: 2.0.0-beta.13`,
  the exact commit and the public archive URL.
- `verifyMacosRelease` passed on the DMG, mounted app, quarantined copy and
  the updater-extracted app with archive/DMG inventory equivalence and the
  13.0 loader floor. The documented acceptance snippet omitted the now-required
  `updaterArchivePath`/`minimumSystemVersion` arguments and needs a 700 root;
  the run supplied them.
- Copied-app packaged-server smoke: 7 passed. Separate data-survival smoke
  passed (persisted job/event, idempotent schemas).

| Payload | SHA-256 |
| --- | --- |
| macOS DMG | `80e31bb5ae764c22e812198d85a6fe25979c9e43456b059d88818021c9aba146` |
| Signed updater archive | `17016a33a20bd04b25623cb5e7590f5ac5c8e4875d7499d933ccf9b351baa80c` |
| Linux server archive | `b192f67cc62a9deddf3e6302b87053537e0fd1bb9e5a8e9bf8cb7b177237556d` |

## CI and artifact transfer

Exact-source hosted runs passed: CI `34438565673`, Linux server `34438565690`
(archive built on glibc 2.35, accepted on Ubuntu 22.04 and 24.04). The server
archive and provenance were downloaded from that run; the provenance hash
matched the downloaded bytes and its checksum sidecar.

## Draft verification and publication

`gh release create --draft` uploaded the eight canonical assets against the
exact commit. `local-release.mjs` reported `verified-draft` with desktop
version floor `0.2.6` and candidate `0.2.7`, then `--publish` re-verified and
reported `published` for release ID `386022482`. A separate API read confirmed
`draft: false`, tag target `58c700f`, and all eight assets. Every website
download URL (macOS DMG, Linux server archive, beta.12 Linux desktop
packages, checksums) returned HTTP 200.

## First public A-to-B observation

The installed beta.12 (launched 14:37:29 KST, after publication) showed
"Waiting for the next check / Release discovery is incomplete" and its
**Check for updates** button did nothing. Cause: the anonymous GitHub API
primary limit for this network's public IP was exhausted
(`403`, `x-ratelimit-remaining: 0`, reset 15:16:49 KST) before the app's first
check. beta.12 maps that to `RetryAfter(60s)` with no reason and refuses manual
checks inside the window. The release itself was proven eligible by running the
native discovery code against the live listing and manifests
(`selected v2.0.0-beta.13 / 0.2.7`, complete scan). Follow-ups on `main`:
`7c57956` waits for `x-ratelimit-reset` and reports `discovery_rate_limited`;
`e2f761e` makes unchanged checks free with `If-None-Match` and a per-process
manifest cache. Neither is in the beta.13 binary.

## Incident: the published beta.13 binary has its updater disabled

The first public A-to-B run (16:49 KST) installed beta.13 and then blocked the
next launch with "Unfinished update requires the matching updater-enabled app
for verification." `--desktop-build-info` on the installed bundle reports
`updateMode: disabled`: the acceptance build ran without
`GJC_UPDATE_MODE=production` / `GJC_UPDATE_FEED_ORIGIN` / `GJC_UPDATE_PUBKEY`,
which `MACOS-ACCEPTANCE.md` never listed, and the updater-lane verifier only
read the build diagnostic on the manual lane. A disabled successor cannot
verify the journaled installation, and there is no automatic recovery: a
rebuilt binary fails the journal's inventory hash and beta.12 fails the
version match.

Operator recovery on this Mac: the journal and cache were moved to
`~/Library/Application Support/Gajae Code App Backups/beta13-incident-*/`,
and the installed (updater-disabled) beta.13 starts normally. User data was
not touched. The beta.13 release notes now carry a warning. Fixes on `main`:
`2095beb` runs `--desktop-build-info` on every verifier lane and refuses
anything but `production` for an updater release; the acceptance procedure
now exports the binding and checks the key fingerprint. **This release is
superseded**: a corrected desktop 0.2.8 must be published, beta.12 users will
be offered it directly, and users already on beta.13 need one manual DMG
install because their updater is compiled out.

## Limitations

- Public beta.12 to beta.13 in-app update is not yet observed; the sidebar
  update details are the evidence source for that first run.
- Real macOS 13 execution, administrator cancel/recovery, process ownership
  and external-account migration remain untested.
- Independent external backup of the updater key is still pending
  (`scripts/release/UPDATER-KEY-CUSTODY.md`).
