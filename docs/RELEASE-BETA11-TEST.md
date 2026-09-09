# beta.11 macOS local test installer — accepted

This is a private, manual-install test candidate, not a public release or an
updater-enabled distribution. The installed production app is not overwritten
by the build or acceptance process.

## Frozen source and scope

- Source: `e28fa6d68e5985e0a7fda5320e23c0bff66fd364`.
- Product: `2.0.0-beta.11`; desktop: `0.2.5`; SDK: `0.16.4`.
- Apple Silicon macOS; declared loader minimum remains `13.0`.
- Native build information confirms `debug: false`, `updateMode: disabled`.
- Includes tasks above chat, routine auto-approved notice filtering, browser
  top-level await and bypass handoff fixes, browser reveal/viewport fixes,
  SDK lifecycle/data preservation work and the latest YAML/Multer/ZIP security
  changes. It is not the earlier pre-security beta.11 updater-QA fixture.
- No production updater private key is provided to the build or embedded in
  the app. Public updater activation remains a separate acceptance step.

## Verification

- Whole `npm run verify`: passed at this version.
- Native shell: 320 tests passed, 6 dedicated/optional helpers ignored;
  build-binding suite: 10 passed.
- Browser sidecar E2E: 3 passed. GJC driver/wire E2E: 8 passed; these use
  controlled fixtures, not an external paid model/account.
- Fresh source snapshot and dependencies; all 1,049 tracked source blobs
  match the pinned commit after building.
- Developer ID application signing, strict/deep verification, hardened runtime
  and runtime-manifest rebinding completed.
- App notarization: Accepted, submission
  `b0850e34-c358-47e8-92ae-3458c1c30007`; app stapled and Gatekeeper accepted.
- DMG notarization: Accepted, submission
  `d377189e-2355-415c-87a3-26d47d19b26f`; final DMG stapled and rehashed.
- Mounted/copy inventories, both Apple signature/ticket checks, expected versions,
  native build mode and loader stamps passed the manual-lane verifier.
- Copied-app packaged server integration: 7 passed; separate data-survival smoke
  passed (persisted job/event and idempotent schemas).
- Actual macOS 26.6.2 GUI: Scratch creation, draft plus SVG attachment, theme
  change, normal Cmd-Q/reopen, same origin and final native/server exit passed.
  The 510-byte IndexedDB draft record remained byte-identical, including the
  exact 173-byte SVG. SVG SHA-256:
  `40b67b4752793406a80fa6b2bc12a1103421d9cbbad1fbaa5986967192da76f1`.
  The draft was not sent and no external account/model was used.
- The quarantined copy ran under macOS App Translocation. Computer Use followed
  the actual translocated QA path; quarantine was not removed. The production
  native/server processes remained running and were not changed.

The original CI app verification reached the independent website gate, where
Node 22/24 failed because its test equated the public release with every local
candidate version. Website-only follow-up `a649273` pins the reviewed public
beta.10 fixture instead; website tests/build pass and download links stay on the
existing public release. No shipped app input changed; this DMG remains built
from `e28fa6d`. Subsequent CI runs must be reported separately.

Evidence root: `/private/tmp/gajae-beta11-build.WfsStD`.
Source/native/E2E logs are `/private/tmp/gajae-beta11-{source-verify,native-tests,browser-e2e,gjc-e2e}.log`.
The private GUI profile is `/private/tmp/gajae-beta11-gui.trY6Xu`; it does not
reuse the user's production WebKit store, credentials or conversations.
Its WebKit UUID is `9E84C9D0-22B4-40B7-A2C9-8F33409486DB`. Evidence includes
`context.json`, `source-integrity.json`, `build-info.json`, both notary receipts,
`dmg-verification.json`, `accepted.json`, `gui-accepted.json`, draft snapshots
and the before/reopen screenshots. The QA app is normally stopped; evidence is
retained. The separate WebKit store is not removed by deleting the profile.

## Delivered file

`/Users/devswha/Downloads/gajae-app-desktop-2.0.0-beta.11-macos-arm64.dmg`

- Size: 220,781,809 bytes.
- SHA-256: `6e6910bd72f35eb09b96149b5162321df14bb8718bd6a04383209483b17cc035`.
- Adjacent `.dmg.sha256` sidecar copied with exclusive creation; delivered bytes
  match the independently accepted final DMG hash. No existing download was
  replaced. No GitHub release, tag or public artifact was created.

## User test procedure

Fully quit the existing app with Cmd-Q, open
the delivered DMG, and copy its app into Applications. Launch the Applications
copy, not the mounted DMG app or an older temporary QA copy. About must show
beta.11. The independently checked native desktop version is 0.2.5; the disabled
updater panel does not display that field. Use a disposable project for initial
agent actions.

Check the task list above chat, browser panel sizing and top-level await, and
the project permission-mode behavior. OS permissions, first browser-download
consent and genuine questions are not suppressed by bypass mode.

This test installer cannot demonstrate public automatic updates: its updater
is intentionally disabled. Minimum-OS execution, broader authority/cancellation
qualification, production updater activation and initial/subsequent public
release acceptance remain separate. Local package/GUI QA must not be described
as real external-account login validation.
