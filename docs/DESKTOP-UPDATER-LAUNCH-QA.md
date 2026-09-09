# Native next-launch updater: integrated private QA

Date: 2026-09-08. This advances the active automatic-update **and distribution**
goal. It is not public-release, macOS 13, or final notarized acceptance.

## Connected implementation

- macOS setup now enters `LaunchGate` before any sidecar. Both the early
  supervisor check and its PID-locked spawn check consult this same gate.
  Checking, installing, restarting and recovery reject Retry/new server starts.
- Official plugin configuration is supplied in the admitted native Tauri
  context. `Builder::pubkey` alone was insufficient: plugin Config deserialization
  happens first. Disabled/unbound modes gain no plugin configuration.
- A compiled updater-QA executable now rejects a missing/foreign `--qa-profile`
  before profile creation, WebKit or a sidecar. It cannot silently fall back to
  production HOME/storage when opened without its arguments.
- Only explicit `--qa-update-install` in the matching compile-bound QA app
  actuates the installer in this checkpoint. Its private fixture must have its
  previous process tree independently verified stopped. The loopback-port veto
  is additional evidence, **not a general production owner-absence proof**.
  Public-mode installation and safe manual restart remain gated.
- Preflight reuses native cached-byte/signature/archive/location checks and the
  exact-endpoint official plugin reconstruction. Nonmutating initialization or
  cache failures can defer to A. Present/uncertain install state requires recovery.
- `ScreenState` publishes `(epoch, screen)` atomically. Only the embedded main
  document can acknowledge the current display epoch. The double-RAF callback
  checks the same connected DOM root; old scripts/overwritten screens cannot
  acknowledge Applying. Generic Retry errors cannot overwrite a live updater.
  Applying is acknowledged before the PID-locked installation claim.
- After the official installer returns and complete B verification succeeds,
  `AwaitingHealth` is durable. Restarting presentation is best effort, not a second
  blocking paint gate: a verified replacement must not be stranded by an occluded
  WebKit page. Explicit restart intent bypasses ordinary Quit; preventable Quit/
  Close during mutation is held. Unpreventable termination remains a journalled
  recovery case, not an installer-cancellation claim.
- Successor startup requires the signed cached archive, complete installed-B
  inventory, compiled B/payload identity and the old owner being gone. An opaque
  live successor permit supplies the narrow exception to the presence guard.
- Before exposing the SPA, B is rechecked and the actually owned server passes
  independent health again. Its native sealed health proof includes a live direct
  child with the same UID and pinned process birth identity.
- Completion persists `PreparedSuccess` before retiring the canonical attempt;
  only afterward is schema-2 `Committed` atomically published. Pending/invalid/
  legacy/staging completion state blocks even when the canonical name is absent.
  Proof-backed recovery can restore AwaitingHealth from pending completion data;
  no loaded JSON or version string grants a fresh installation permit.

## Real private A → B result

Evidence root: `/private/tmp/gajae-updater-launch.aWWHUs/`.
QA profile: `/private/var/folders/y6/0bfmyp091_577tb_vpgs9yrw0000gn/T/gajae-update-qa-UAlKNY`.
Private HTTPS feed: `https://127.0.0.1:55750`.

A is product beta.10 / desktop 0.2.4; B is beta.11 / 0.2.5. Both are debug,
ad-hoc-signed builds, with a dedicated disposable QA updater key. B's verified
archive is 164,588,634 bytes, expands to 586,370,560 bytes and has 20,643 entries.
The B artifact/manifest/inventory are recorded in `B-artifact.json` and `assets-B`.
No production key was generated, exported or provisioned.

The accepted autonomous run is **cycle4**, launched through macOS LaunchServices
with output redirected by `open`, not tied to a terminating terminal process.
There was no manual B launch or process interruption between A launch and commit.

| Observation | Recorded result |
| --- | --- |
| Applying gate | A PID 79621 logged `applying-visible` before `install-begin` |
| During mutation | At +44.142s: only A; no server/worker processes |
| Replacement/restart | At +72.201s: AwaitingHealth, A gone and B PID 80818 present |
| B server starts | At +162.384s: B-owned server 81804 and two core processes |
| Health/commit | At +280.595s: schema-2 Committed, canonical attempt absent |
| Receipt | Attempt `8243e9adee41f6df0f8a12ae3e685c88`, completed by 80818, server 81804 |
| Origin | `http://127.0.0.1:56452/` before and after |
| Actual UI | beta.11, same Scratch project, same unsent text and `fixture.svg` |

Native phases are in `cycle4-native.stderr.log`; externally observed process/
journal transitions are in `cycle4.jsonl`. `B-completed.png` records the final
Computer Use UI. Deep strict codesign verification passed after replacement.
The plain-text draft was `QA draft survives the app update 2026-09-08`; no prompt
was submitted to an external provider. Korean static recovery/checking UI was
observed; a failed automation attempt to type Korean is not Korean-input proof.

A further normal B quit/reopen retained the same committed attempt ID, did not
create another canonical attempt, and restored the same project/input/image and
origin. This separately checks that a completed update does not reinstall itself.

After QA, every app/server/worker executable under this fixture and the private
HTTPS feed was confirmed stopped. The five generated app copies were reversibly
renamed from `.app` to `.app.fixture` under the locked QA root; contents and data
backups remain intact. This avoids accidental Finder launches of old intermediate
QA binaries that predate the missing-profile guard. They are evidence fixtures,
not user-installable deliverables.

Debug verification is slow. These elapsed times are not release performance or
the production acceptance ceiling. Release-mode timing and the full signed/
notarized data-survival matrix remain required.

## Earlier runs retained as failures or narrower evidence

- Initial native plugin registration failed before any attempt/app mutation due
  to the missing public Config key. The context fix and a regression test cover it.
- A terminal-hosted run replaced A and spawned B, but B ended before health
  completion. Its termination cause was not proved; manual B recovery afterward
  succeeded, but that run is **not** autonomous-update acceptance.
- One test reset copied the QA app before its failed UI Quit request was noticed.
  That reset is excluded from acceptance. Production installation/data were not
  targeted. Subsequent fixture resets require no QA-owned executable and hold
  the real profile instance lock; full prior synthetic app/data are retained in
  explicitly named backups, not erased.
- Reinstalling older A over a completed B fixture without resetting its update
  history was refused as a different completion chain. That invalid test setup
  is not a normal-update failure or permission to weaken journal checks.
- A verified replacement could remain in A while waiting for Restarting display
  acknowledgment. The final code preserves the strict pre-install Applying
  barrier but cannot let post-install presentation failure prevent restart.

## Verification and remaining scope

Whole `npm run verify` passed during this iteration. The final native suite has
267 passing tests and ten build-binding tests; four opt-in/helpers are excluded
from the default count. The standard `cargo clippy --all-targets -- -D warnings`
gate and formatting pass. The standalone old journal example allows unused
product-journal APIs only at its import boundary; production APIs are wired and
not hidden by a blanket dead-code suppression. Atomic-display/actual paint-script
DOM regressions passed separately.

This is a private debug qualification, not a final same-source release pair:
the recorded A/B working-tree builds differ, and B predates some later hardening.
Product/desktop source versions were restored to beta.10/0.2.4 after constructing
the private B artifact. Public release assets were not changed.

Still required: production previous-owner proof/activation, full runtime/internal
admission and global draft/attachment/send freeze, safe manual restart, final
signed/notarized same-cut A→B including wider auth/transcript/queued-state cases,
real macOS 13 and Linux acceptance, production key custody and initial/subsequent
public releases. The active goal remains open; do not count this checkpoint as
completion of those requirements.
