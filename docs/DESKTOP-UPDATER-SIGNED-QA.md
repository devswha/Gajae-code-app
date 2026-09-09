# Same-source signed updater qualification — automatic path passed

On September 9, 2026, the same-source signed/notarized A → B next-launch
automatic update passed on macOS 26.6.2 arm64. Off/on behavior, successor health,
data preservation and an additional ordinary B quit/reopen were verified.
The full public-distribution goal remains open; this is private QA, not a public
release-completion record.

## Frozen source and signed artifacts

- Source cut: `f69ec4fa910af64fefe63024162dde37a08256e6`.
- A: product `2.0.0-beta.10`, desktop `0.2.4`.
- B: product `2.0.0-beta.11`, desktop `0.2.5`.
- Both release-mode builds normalize only the four product/desktop version
  fields before hashing **all tracked source files**. Both returned
  `a959d64fe104a43abac0d6a5126c40e327f72a0289e4606cc1acc3f686da2629`.
- Both are Developer ID signed, hardened, timestamped and notarized. The native
  shell was rebuilt against the finalized payload runtime-manifest hash before
  the outer signature. Stapler and strict/deep codesign pass; Gatekeeper reports
  `accepted`, `Notarized Developer ID`.
- Apple submissions: A `6ea59667-a710-45e3-b0a1-91206ab404f5`, B
  `745c9080-5946-4471-9595-3f48c77f8364`, both Accepted.
- B updater archive: 157,856,407 bytes, SHA-256
  `0ce670552bef334113c4f64492fdcae1faff46761f3b367109f919bae27c0202`.
  Dedicated QA updater key only; no production key or public release was changed.
- B packaged-server smoke and separate data-survival smoke pass.

Evidence root: `/private/tmp/gajae-signed-update.CRJaMk/`.
QA profile: `/private/var/folders/y6/0bfmyp091_577tb_vpgs9yrw0000gn/T/gajae-update-qa-nRUrGS`.
App copies: `builds/A/Gajae Code App.app`, `builds/B/Gajae Code App.app` beneath
that profile. The exact compiled root `Gajae Code App.app` now contains installed
B. Temporary source versions were restored; the source cut was clean before
this documentation update. After acceptance the QA app was quit normally and
the private feed, model and passive observer were stopped. All fixture files,
cached bytes and journals are retained; the production app was not changed.

## Actual data and busy-restart checks

The private update feed is `https://127.0.0.1:49741`, serving signed B. The app's
stable origin is `http://127.0.0.1:51693`. A local synthetic model at
`http://127.0.0.1:50896` uses the real built-in pi-native transport and default
SDK hosting; it never forwards requests to an external model/account.

The first fixture held SSE too long and the SDK timed out. Its raw request log
also exposed concurrent fixture log writes; those failures are retained, not
passing evidence. The fixture was corrected to serialize atomic log writes and
emit valid empty text deltas while held. `model-requests-2.json` records two
subsequent successful responses, neither aborted.

Actual UI session: `4a804db1-9b21-4cc9-851b-8f1f274834c1`, project Scratch.
It contains the failed first run plus two successful assistant responses. The
review-paused queue contains `QA signed update keeps this draft and attachment.`
and one SVG. Current unsent input is
`QA final draft remains after the signed update.`

While the second successful run was held, clicking Update and restart did not
stop A (PID 97073) or its server (97142), did not abort the model request, and
created no installation attempt. The run completed after the fixture was released.
This proves that particular busy deferral, not every approval/cancellation case.

`before-update-data.json` captures the actual private WebKit IndexedDB record
through read-only SQLite, not a DOM mock. Its 745-byte serialized draft/queue
record includes the exact 164-byte SVG payload. SVG SHA-256:
`b74f50a8e7962eb50745265ca66d1b6361a698520cbb516a7212045153bfd71b`.
Draft record hash: `a54c78399f59f22b866c84af21662b158390157e2dd815d27f4cb80ee16a6050`.
The provider transcript is 8,280 bytes with hash
`6a224156ca0f4f20ee52d42f4cde3588600ec761559fdccc7f58a258419f75d4`.
Model configuration and automatic preference are captured too. The comparisons
below establish that these exact recorded bytes survived every accepted stage.

The WebKit data store is UUID `3E12807D-3CDB-4540-ADCF-B8434D0B61DD`, separate
from the QA home/browser directories. `snapshot-data.mjs` targets only that
store and is read-only. Do not inspect a default/production WebKit store.

## Accepted Off/on and normal-reopen sequence

1. After manual Mac unlock, Computer Use confirmed the exact `— QA` app and
   existing session. With B already cached, automatic updates were turned off
   through About. Normal Cmd-Q stopped A/native 97073 and server 97142.
2. Launching the same app with only `--qa-profile` started A/native 21875 and
   server 22012. Product beta.10 / desktop 0.2.4 remained installed; automatic
   stayed false and no canonical attempt existed. The same session, paused
   queue, one image and unsent draft were visible after opening the conversation.
3. Automatic updates were enabled through About. After normal Cmd-Q and observed
   native/server exit, the same app was launched with only `--qa-profile`:
   **no manual restart button and no `--qa-update-install` flag** were used.
4. `automatic-cycle.jsonl` captured attempt
   `d5b3a37a3f728dad88ff942ca69400f8`: installer owner 23709, `installing` before
   any server marker, then `awaiting_health`. The old owner exited; B/native
   23998 and server 24006 completed the schema-2 `committed` health record.
   No manual intent appeared anywhere in the observed cycle.
5. Installed B reported product beta.11 / desktop 0.2.5. Strict/deep codesign,
   stapler validation and Gatekeeper all passed again on the **installed** app.
   Origin remained `http://127.0.0.1:51693`; the session, two successful responses,
   review-paused queue/image and unsent draft were visible. Model request count
   stayed two, both complete and not aborted: the queue was not auto-sent.
6. A further ordinary Cmd-Q/reopen started B/native 25074 and server 25198,
   retained the same version/origin and all data, and did not start another
   installation. The final normal Quit stopped both processes.

`accept-results.mjs` compared `off-before-quit`, `off-reopen`, `before-auto`,
`after-auto` and `b-normal-reopen` snapshots with `before-update-data.json`.
All five retain the identical 745-byte draft/queue record, exact SVG bytes,
8,280-byte provider transcript and model configuration hash. It also checks
consent values, installed version, the recorded install/server ordering,
absence of manual intent, successor completion and installed signing acceptance.
Results are saved in `accepted-results.json`. UI evidence includes
`off-reopen-session-ax.txt`, `after-auto-session-ax.txt` / `.png`, and
`B-normal-reopen-session-ax.txt` / `.png`.

The UI capture during process replacement briefly returned Computer Use
`timeoutReached`; no extra app launch or installer retry was issued. The journal
then committed normally and the successor UI was inspected. The transcript's
failed initial fixture run remains failure evidence, not a successful model run.

## Remaining public-release boundary

The post-acceptance source gate was rerun and stopped at the dependency audit:
new blocking advisories affect `extract-zip`, both `js-yaml` majors and `multer`.
That failed run is retained as `verify-after-acceptance.log`; the earlier frozen
source gate must not be represented as today's clean security audit. Security
dependency changes need their own verification and final release artifacts.

The compatible dependency fixes now require Multer 2.3.0 and constrain installed
YAML 3/4 to 3.15.2/4.3.2. Regression tests cover locked version floors, empty
merge-source limits and frontmatter compatibility; shipped third-party notices
were regenerated. SDK/Puppeteer versions and the SDK runtime manifest did not
change. The remaining ZIP advisory was then addressed with a separate canonical
backport of upstream PR160 (commit `148750acb10c574818906de2a99aa13d457d5329`),
which is open/unmerged, not a published dependency release. The manifest/helper
pin exact version, package metadata and full before/after source hashes; unknown,
linked, aliased and nested installations fail closed. Postinstall applies it;
dev/build/test/audit and both server/desktop staging plus out-of-tree smokes
verify rather than silently apply it. The independent SDK32 manifest is unchanged.

The archive-only regression proves an unpatched ZIP can overwrite an outside
canary and the patched extractor refuses it. Normal/duplicate files, directories
and safe symlinks remain supported. The upstream change does not protect against
a concurrent local writer swapping the path after lstat, nor later consumers
following extracted symlinks. Neither property is claimed. Audit recognition of
the new advisory requires the installed canonical patch and a current review;
the older advisory additionally retains its existing pinned-vendor-download
restriction. This is not an unconditional vulnerability waiver.

The focused union passed 46 tests (`security-focused-tests.log`), covering real
archive bytes, integrity and audit-negative cases, staging and the actual copied
checker. A clean `npm ci` applied all 32 SDK files and the one ZIP patch
(`security-clean-install.log`). Final source verification is recorded separately
from the frozen signed artifacts above; any public candidate must be rebuilt
with this security delta.

The final clean-install **full `npm run verify` passed**, including audit,
licenses/notices, typecheck, core, all tests, lint, identity and build
(`security-final-verify.log`). Audit explicitly reports two patch-verified,
time-bounded extract-zip records and four moderate entries below its gate; this
is not a claim that raw `npm audit` reports zero advisories. No production key,
public release or installed production app was changed by the security work.
The security delta is committed as `5aecb49`; it must not be confused with the
earlier signed updater qualification cut `f69ec4f`.

With the compatible dependency updates, the parent ran the complete non-audit
verification chain: SDK integrity, licenses/notices, typecheck, Rust core,
all Node/Bun tests, lint, identity and build all passed. The separately rerun
audit at that intermediate point failed on the ZIP advisory, so that intermediate
run is not a full `npm run verify` pass. Before this dependency delta, HEAD
`6280f49`'s Linux server CI retry
`34250378830` (attempt 2) passed archive build and Ubuntu 22.04/24.04 acceptance;
attempt 1 failed only at GitHub artifact finalization with HTTP 403. Its other
Node 22/24 and Linux desktop/GUI checks also passed. Those remote results are
not transferred to a later source cut.

The native owner suite passed 31 tests (one opt-in test ignored). An explicit
read-only live shared-domain census then failed closed because process/foreign
evidence changed after census (`owner-census-after-qa.log`). This is not a
production owner-absence acceptance; no process was terminated to force a pass.
The QA app had already been closed normally; only the task-owned fixture
services were stopped.

Remaining release requirements include wider failure/authorization qualification,
production owner/OS13 acceptance, updater-key custody/backup, and initial plus
subsequent public distributions. No real external-provider credential/login
migration was exercised by this synthetic model fixture. Source
supports explicit production bindings, but default builds stay disabled and
this QA does not by itself authorize publishing an updater-enabled installer.
