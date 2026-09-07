# beta.10 — published manual-install acceptance

Published September 7, 2026 at **19:52:15 KST** (`2026-09-07T10:52:15Z`).
GitHub release `383970740`: public prerelease with eight assets.
Tag `v2.0.0-beta.10` resolves to `4979b2c49f54f79c51bf4f72cdca59c7b98ed44f`;
desktop version `0.2.4`. PR #46 merged as `7fa9d43b58972751f4ba36aac91c87eb109f2d77`.
Documentation-only follow-ups do not change this installer source.

## Included UI

The pending 20-file Chat UI change was preserved as `5056e5c`, integrated as
`32da9da`, and included in all published artifacts. Both have chat subtree
`426a930ad8f89816ce0b2eee563bc9f8ee8cd285`, also present in the release source.
The composer Project/worktree and new-goal creation controls are removed;
the model/reasoning picker is content-sized. Active goal controls and existing
worktree-session behavior remain. The final DMG's UI was visually checked.
Earlier UI-excluded `8cf7b86`/`a6b06a2` candidates were never published.

## Payloads

Every payload has a canonical `.sha256` sidecar. No updater archive, signature
or metadata is included. Prefix each filename below with `gajae-app-`.

| Filename suffix | Bytes | SHA-256 |
| --- | ---: | --- |
| `desktop-2.0.0-beta.10-macos-arm64.dmg` | 233392075 | `6db053dcda89947fbc80445939e1451d905fdd2ee032b3b018f07e90b99c0b42` |
| `desktop-2.0.0-beta.10-linux-x64.deb` | 173880136 | `ae0b60686d7892f621adce458afa6ffb05a6dca0cb9156bb3b4ae1c302967b48` |
| `desktop-2.0.0-beta.10-linux-x64.AppImage` | 223631864 | `f93a5783a3ec4c6d21fe288003b1c56f02722c8759cac24cebb49439cd4d7ea0` |
| `server-2.0.0-beta.10-linux-x64-node22.tar.gz` | 226203176 | `ad7de137b816d0ab02a0c67d81290bb276e65d585bde421f673aae50e5ae71b4` |

The Mac DMG/checksum are also staged under ignored `release/desktop/` in the
primary checkout. Independent hashes identify accepted artifacts; they are
not a claim of reproducible-build provenance.

## Verification

- Existing Developer ID team `5987KT43TJ`; no credentials exported. App
  notarization `adc13239-3eea-4a51-aa4a-96982ac98a8c` and DMG notarization
  `43399c88-9020-4e61-b7cd-15561ce78839` both Accepted. Both staples, signatures
  and Gatekeeper passed; final checksum taken after DMG stapling.
- Out-of-tree mounted/copy inventories agree across 20,613 entries. Twenty
  macOS loader stamps have maximum minimum OS `13.0`; nine IOS/IOSSIMULATOR
  vendor resources are separately inspected and reported.
- Copied binary positively reports `debug=false`, `updateMode=disabled`,
  beta.10 and desktop `0.2.4`. Source manifest hash:
  `c91d2d6ee464ca407f95d9e9db42cdd177cd3042beec77331d05308d4049498a`.
  Final signed payload manifest hash:
  `cba5773f3a57b9e291f8bc414e446f97f537d50dc132131a85197944dda23a7d`.
- Standard packaged integration: seven tests passed. Separate data-survival
  smoke passed with idempotent schemas.
- GUI host: **macOS 26.6.2 arm64**. Updated composer, model picker open/dismiss,
  Settings/About, scratch workspace/draft restoration, stable QA origin and
  two clean app/process-tree shutdowns passed. No real model request, OAuth
  grant or production-profile change was made.
- Focused UI tests (33), integrated `npm run verify`, GJC E2E (8), desktop native
  checks and merged website tests (14) passed. All eight CI jobs passed:
  source `34104590177`, Linux server `34104590133`, Linux desktop `34104590148`.
  PR source CI's merge tree equals the frozen release tree.
- Exact-source Linux packages use Node 22.22.2, Bun 1.4.0 and glibc 2.35.
  Separate startup/data-survival and desktop GUI checks passed on Ubuntu
  22.04/24.04, including extracted deb, AppImage and installed deb relaunches.
  Downloaded package hashes match their exact CI run.
- The strict manual publisher re-downloaded all eight assets and checked
  independent pins, sidecars, source/tag/version history, server identity and
  Mac copy before publishing the numeric draft. An earlier GitHub request
  failure blocked publication; a fresh full pass succeeded. No assets were
  replaced. Public release state, exact tag and unauthenticated checksum
  download were verified. Website deployment `34113708903` succeeded.

## Remaining boundaries

Automatic installation/restart remains disabled. Updater G0 authority and
cancellation qualification and actual macOS 13 execution remain separate
work; see `MACOS-UPDATER-HANDOFF.md`. Do not infer their completion or provision
updater keys from this manual release.
