# Native updater installation progress

2026-09-08. The active objective is still **complete automatic updating and app
distribution**, not preparation-only acceptance. This is an implementation
checkpoint; the objective is not achieved and installation is not activated.

## CI correction

`7ef7cda` records the new OAuth test in the engine SSOT and includes untracked,
nonignored `server/gjc-*` files in the inventory check. The earlier local gate
missed that file before staging; the committed head failed remotely. The new
head's Node 22/24 CI and Linux server build/smokes passed. Desktop Linux remained
in progress when checked. Do not transfer those results to later native changes.

## Implemented native installation components

- `updater_install.rs`: `VerifiedArchive::load` verifies cache digest, Minisign,
  full archive identity/inventory and retains **one immutable boxed buffer**.
  Preparation cache validation now uses this same implementation.
- `VerifiedArchive::reconstruct` accepts native `Reconstruction` inputs and uses
  supported `UpdaterExt` APIs. The plugin must first be registered by an admitted
  native caller. Native release/asset-ID and manifest rereads share one absolute
  five-second deadline with plugin check. No plugin download API is called.
- Discovery returns the exact final validated HTTPS manifest endpoint, starting
  from the public download URL so the plugin's forced JSON Accept header cannot
  select GitHub asset-API metadata instead. Redirect/token policy is retained.
  Raw/encoded template braces are rejected before the plugin can rewrite the URL.
  Plugin metadata allocation is still timeout-bounded, not byte-bounded; native
  reserialization has its own 64-KiB cap rather than making another unbounded copy.
- `InstallLocation` checks the native executable/product/version, canonical
  allowed app location, supported ownership, read-only volume and same temporary
  volume. Both literal and canonical temporary paths are retained/rechecked;
  quote/backslash/control characters are rejected before the pinned plugin's
  AppleScript authorization branch. The source Info.plist uses the archive's
  bounded semantic parser, including duplicate/depth/reference-expansion limits.
- `updater_attempt.rs`: `Journal::begin(Target)` publishes and fsyncs the canonical
  blocker before returning a non-Clone PID-bound `LiveAttempt`. Descriptor/root/
  inode/source-app rechecks guard the permit. Failure/Drop/crash preserves the
  blocker. `record_installed` requires the opaque bundle verifier via a sealed
  adapter and durably changes the record to `AwaitingHealth`.
- `PreparedInstall::apply` consumes the verified buffer, revalidates location,
  begins the journal, calls the official synchronous `Update::install` off the
  future event-thread caller, verifies the complete installed B tree, then records
  awaiting health. It never reloads different bytes or times out an active
  installer. Error/panic/uncertain replacement requires recovery, not retry or a
  claim that cancellation left A safe.
- `updater_bundle.rs`: bounded descriptor-relative, no-follow complete-tree
  comparison against `ArchiveInventory`, including extras, omissions, modes,
  hashes and link targets, followed by a second walk/metadata checks. Its private
  `VerifiedBundle` is inventory evidence, not Apple signing/notarization or a
  permanent filesystem snapshot against a hostile same-UID process.

These APIs are **not yet called by the app launch/restart flow**. The existing
presence guard still rejects every present attempt. `LoadedAttempt` is read-only
inspection, not a startup/cleanup permit. Native installation availability stays
false, and the About restart command still rejects. No production app, public
release or signing key was changed.

## Verified here

- Whole `npm run verify`: passed (`/private/tmp/gajae-updater-install-verify.log`).
- Locked desktop Rust tests: 236 passed, two opt-in/helper tests ignored; ten
  build-binding tests passed (`/private/tmp/gajae-updater-native-install-tests.log`).
  Parent tests exercise the journal's ignored subprocess helper explicitly.
- Native formatting passed. Clippy excluding **only unintegrated dead-code
  warnings** passed (`/private/tmp/gajae-updater-native-install-clippy.log`). This
  is not the final standard `-D warnings` gate: real launch integration must remove
  the unused API warnings; no source-level dead-code suppression was added.
- The explicit existing-archive read-only test also compared the historical
  isolated installed B using the new native verifier: all **20,673** entries
  matched, inventory SHA256
  `384eaccc5d8214a617d8ef45530be997bda73f3480ce06572a3980e1d0763b23`.
  Artifact SHA256 was independently rechecked as
  `dda009d8e3d51a89fce3c61968fe386f1fcaad9954628aab4ea56ae6b8ffbe63`.
  Evidence: `/private/tmp/gajae-updater-installed-bundle-proof.log`.
  The fixture is beta.9/desktop 0.2.3 with the known declared-11/loader-13 mismatch.
  It is **not** new product A→B, macOS 13, or live installer execution evidence.
- Review corrections: literal temporary path, plugin URL substitution and bounded
  installed plist parsing. Focused review found those deltas resolved.
- Read-only operational check: repository Actions secret/variable name lists are
  empty. This Mac has a valid Developer ID Application identity; no credential was
  exported, no signing/notary submission or secret provisioning occurred. The
  existing runbook names the local `gajae-notary` profile; its current authentication
  was not revalidated in this checkpoint.

## Next critical-path work — do not replace this with more preparation-only UI

1. Register the official plugin only after compiled macOS mode/profile admission.
   Gate setup and every supervisor/Retry entry while checking/applying/recovering.
2. Implement verified successor resolution: an `AwaitingHealth` record alone or
   matching version strings must not start a server. Require signature-verified
   cached bytes, complete installed-B inventory, compiled payload identity and
   proved previous-owner exit. Then acknowledge the actual owned server's checked
   health and durably archive the attempt; never erase an interrupted `Installing`
   record on a guess. Preserve the cache until this durable success transition.
3. Connect next-launch apply before server/worker startup, embedded applying and
   recovery screens, preventable Quit deferral, explicit restart intent, held-lock
   successor handoff and deep-link replay. Do not abandon a live OS installer.
4. Complete required runtime ownership/internal admission and global draft/File/
   queued-send freeze acknowledgment; connect prepare/commit/cancel and safe
   manual restart without force-draining active work.
5. Exercise this exact integrated code using isolated signed/notarized QA A→B,
   startup-before-server ordering, same origin/data, prompt/error/crash recovery,
   actual macOS 13 and Linux regressions. The approved G0/G3/G5 gates still apply;
   production activation is not authorized by the primitive tests above.
6. Establish production updater-key custody/backup and the valid local signing/
   notary route, bump product and desktop versions, produce/verify/publish the
   updater-enabled initial DMG and a distinct later update. First-install success
   alone does not prove automatic updating. Keep the full goal active until the
   requested distribution and update path are actually verified.
