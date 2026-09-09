# beta.12 click-update release acceptance

Source: `48fffce62492d04eb207d8c1cb66024ef3636877`.
Product `2.0.0-beta.12`, desktop `0.2.6`, SDK `0.16.4`.
Release ID: `385189777`; publicly published September 9, 2026 at 02:58:52 UTC
(11:58:52 KST). Tag `v2.0.0-beta.12` resolves to the exact source commit above.

## Scope and operator decision

The operator explicitly requested replacing the installed application and
publishing this beta, with additional end-to-end testing deferred to a later
version. Source, signing, notarization, archive, version and data-safety gates
were retained. Extended minimum-OS, administrator cancel/recovery, process-owner
and external-account scenarios are disclosed in the release notes; they are
not represented as passed.

The first updater-enabled release needs one manual installation for users of
older disabled builds. Future eligible updates use the sidebar Update button;
automatic checks alone never download or install. A later public version is
still needed to prove public A-to-B behavior.

## Build and cryptographic acceptance

- Fresh source snapshot, dependency installation and Cargo output. All 1,056
  tracked source blobs match the frozen commit after building.
- Whole `npm run verify` and desktop native tests passed at this version.
- Native diagnostics confirm release mode, `updateMode: production`, correct
  product/desktop versions, and the finalized payload runtime hash.
- The expected public key is compiled into the desktop. Packet SHA-256:
  `6f0054b3ce55917aeb1bc07e18b6c7d266298fe356a361ab94972fc821f1a4c5`.
  Private signing material was neither embedded nor uploaded. The password was
  retrieved from the named login-Keychain item only for the signer child.
- Developer ID: `sangwoo ha (5987KT43TJ)`; hardened signatures and nested runtime
  restamping were verified.
- App notarization Accepted: `36f480ed-1134-4e0c-bc34-9c8181c339a5`.
- DMG notarization Accepted: `9ef18dee-9001-4cc9-b25d-379381b22a64`.
  Both were stapled before final hashes/signature generation.
- Official Minisign 0.12 verified the updater signature. Its macOS tool archive
  was itself verified with the upstream public key before execution.
- DMG, app and updater archive inventories match. Quarantined copied-app
  signatures, Gatekeeper, loader stamps and versions passed.
- Copied-app server integration: 7 passed. Separate data-survival smoke passed
  with persisted job/event and idempotent schemas.

| Payload | SHA-256 |
| --- | --- |
| macOS DMG | `c6351841b7570c0cadc2e035ac7f4618cdee07935ea0da1c155fd0b8b3e2832d` |
| Signed updater archive | `bba0268c0b5d953f624604045379b018d7af8a0ed362fb905693260b31040e90` |
| Linux server archive | `9a2b5860898fd3b728987f116d5d88565b40d56f4cbfd013bada32fca442f580` |
| Linux deb | `036a9d9be144c328f44532cbc19c1a4b762fcf632b468a8c864989db501cfc04` |
| Linux AppImage | `c7aa4fe42450b80a4f5b7daf73ec8b61c66509f094c724845db5c86e15cbffa2` |

## CI and artifact transfer

Exact-source runs passed: CI `34302548199`, Linux server `34302548214`, Linux
desktop `34302548183`. Ubuntu 22.04/24.04 package/server/GUI checks passed.
Server provenance independently binds the downloaded archive to the source SHA.

The first desktop artifact transfer was mistakenly judged stalled; inspection
showed it had slowly transferred most of the file. A duplicate retry was stopped.
The retained prefix and exact remaining HTTP byte range were joined, and the
complete ZIP matched GitHub artifact `10085736889`'s SHA-256
`06200c0230651c88bc2a5aa4e11084deb9b75d2c0786d8c2f0cecaab49359159`.
Only the four expected entries were extracted, then individual checksums were
verified. No incomplete file was accepted and no check was relaxed.

## Installed application

The user-authorized replacement is at `/Applications/Gajae Code App.app`.
The seven captured old application processes exited after normal Cmd-Q; no
force-kill was used. Previous beta.11 is preserved at:

`/Users/devswha/Library/Application Support/Gajae Code App Backups/before-beta12-wwmklE/Gajae Code App.app`

An initial command-line placement retained App Translocation. The accepted DMG
was then copied through Finder's standard Applications/Replace operation.
Quarantine was not manually removed. Post-copy inventory and signature checks
passed, and the actual native/server executables now run from `/Applications`.

The UI confirms beta.12 / 0.2.6 and the native checks-only update controls.
The origin remains `http://127.0.0.1:60278`, preserving the existing WebKit origin.
The application was left running; no real provider request was sent. App data
directories were not part of the file replacement or deleted. Binary backup is
not a promise of automatic rollback of future user-data changes.

Local evidence: `/private/tmp/gajae-beta12-release.5ah7NF`, including context,
source-integrity, signing/notary receipts, local/Linux acceptance, artifact
transfer digest, installation and runtime records. The tested Mac is macOS
26.6.2; declared loader minimum 13.0 is not actual macOS 13 execution evidence.

## Publication and website

PRs #49, #50 and #51 were merged without squashing the frozen build commit.
The release contains twelve verified files: six macOS updater/DMG assets, two
server assets and four optional Linux desktop assets. The guarded verifier
completed a full `verified-draft` pass, then repeated download/signature/version/
inventory/history checks in its `--publish` invocation before changing the exact
release ID to public. A separate API read confirmed `draft: false`, the tag target
and all twelve uploaded assets. The public manifest URL was checked against its
independently pinned digest.

The same accepted DMG and checksum are also in Downloads. Website PR #52 updates
the advertised files to beta.12 only after verified publication. Its application
code is unchanged from the frozen release; website-only checks and the following
acceptance documentation do not change the published binary provenance.
