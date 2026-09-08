# Same-source signed updater qualification — in progress

The full goal remains automatic updates and public distribution. This is not a
release-completion record. The current interactive step is waiting for the
operator to unlock the Mac; do not terminate/relaunch the running QA app to
bypass that pause.

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
that profile. A is copied to its exact compiled root `Gajae Code App.app` and
is currently running. Temporary source versions were restored; the source cut
was clean before this documentation update.

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
Model configuration and automatic preference are captured too. This is only
the **before** snapshot; after-update comparison is still required.

The WebKit data store is UUID `3E12807D-3CDB-4540-ADCF-B8434D0B61DD`, separate
from the QA home/browser directories. `snapshot-data.mjs` targets only that
store and is read-only. Do not inspect a default/production WebKit store.

## Resume after manual unlock

1. Use Computer Use with the full QA app path and confirm the `— QA` window.
   Do not launch a closed QA app without its exact `--qa-profile` argument.
2. Test Off with prepared B: persist the setting, quit normally, relaunch A
   without `--qa-update-install`, confirm no replacement and the same data.
3. Enable automatic updates, quit A normally, capture a final before snapshot,
   then relaunch A with only its QA profile. The new common consent path must
   apply B before starting its server and complete successor health.
4. Verify B signature/ticket/version, unchanged origin, transcript/model config,
   draft/queue/SVG bytes, and no unintended queued send. Capture a further
   ordinary quit/reopen. Preserve failure evidence instead of resetting journals.

At the pause, A is running, B is fully cached, automatic is true and there is no
manual install intent/canonical attempt. The private feed and local model stay
running for resumption. Model requests are complete and its hold is false.
No production app or data was used. Do not change the source under this pair.

Remaining release requirements include this actual signed transition, wider
failure/authorization qualification, production owner/OS13 acceptance, updater
key custody/backup, and initial plus subsequent public distributions. Source
supports explicit production bindings, but default builds stay disabled and
this QA does not yet authorize publishing an updater-enabled installer.
