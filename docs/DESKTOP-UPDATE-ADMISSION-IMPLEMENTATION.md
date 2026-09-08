# Desktop updater: partial runtime admission and draft durability

## 2026-09-08 current integration delta

The earlier three-reader checkpoint below is historical. Production composition
now connects fourteen of the fifteen fixed readers. Native-bound `ui-drafts`
remains missing; page receipts do not grant installer authority. The current
handoff is `docs/MACOS-UPDATER-HANDOFF.md`. Public installation remains disabled.

- Worktrees/orchestrator/native jobs, automation/browser/computer, all native
  clients, watchers/notifications, HTTP callbacks and audited auxiliary
  Git/clone/startup producers join the existing chat/worker/shell owners.
- Native `job.activity` is a complete read-only aggregate over jobs AND runs,
  including archived jobs. Exact schema version 1 has `reserved`, `queued`,
  `running`, `aborting`, `unknown`; counters overlap, and unknown durable states
  block admission. It never performs reconciliation or starts a process.
- The common fence closes before the worker's reversible fence. The exact
  fence ID survives through cancellation/timeout/expiry cleanup. Worker close
  and owner snapshots share the original five-second budget; cleanup remains
  counted through the actual late acknowledgement/release. Failed releases stay
  unknown and a committed fence is never reopened. Remote activity binds the
  actual SDK revision and cannot silently adopt another idle baseline.
- Browser child request queues, popup/callback tails, retained pages, evaluations
  and graceful final closure report epoch/revision/request-sequence evidence.
  Successful use then explicit close can become idle; failed launch/download
  ownership is still unknown. No snapshot forcibly closes a browser.
- Project file delivery/upload waits for source/writer close and request-private
  cleanup. Git/clone errors wait for real process close before publishing or
  cleaning staging; shutdown marking cannot become an idle proof. Native client
  failures retain unresolved work instead of treating leader exit as sufficient.
- Notification transport callbacks and dispatch ledger settlement are retained;
  enqueue success is not a claim that a notification was shown in the UI.
- Global page freeze covers durable drafts, exact File bytes, queued intents,
  offscreen/unmounted continuations, upload/allocation, voice recording and
  transcription. Duplicate/stale operation IDs cannot retire another lifetime.

Pinned SDK 0.16.4 still has a reproduced detached prewarm task outside every
public disposal join and forced-recovery physical ownership gaps. Published
0.16.6 retains the relevant implementation. A narrowly version/hash-bound
app-owned dependency patch is being prepared; it is not yet installed or part
of release packaging, and SDK uncertainty remains a blocker. The native/UI
transaction and final signed qualification remain required, not optional scope.

## Earlier checkpoint and evidence

Date: 2026-09-08. Branch: `codex/macos-updater-completion`, based on `49c1010`.
This is implementation progress, **not G0/G3 acceptance or an updater release**.
Native `installation_available` remains false; native `restart` still rejects.
No production installation, user data, signing key or public release was changed.

## Connected paths

`server/index.js` now owns one `DesktopRestartAuthority`, constructed with an
explicit immutable required-owner inventory in `desktop-restart-runtime.ts`.
The app factory injects its admission interface into existing HTTP and chat/PTY
dispatch. There is no new browser prepare/commit endpoint or native authority.

- HTTP handlers use the existing `asyncHandler`. It acquires before invoking the
  handler and releases after its actual returned promise settles, not on response
  `finish`, request abort or socket `close`. Both synchronous and asynchronous
  errors release once and retain Express error handling. A fenced request gets
  HTTP 503, `DESKTOP_RESTART_FENCED` and `Retry-After: 1`.
- Image/audio upload handlers now await their actual storage pipelines and
  cleanup callbacks. Image creation is exclusive and owner-private; an existing
  file or symlink is not overwritten or removed on a collision. Image/TTS streams
  remain accounted through source closure/cancellation and descriptor cleanup.
  The source coverage inventory finds 113 wrapped registration arguments, two
  explicit bootstrap/static exceptions and 14 imported authentication arguments;
  this is a registration check, not proof of detached subprocess settlement.
- API middleware also acquires before downstream implicit-owner authentication;
  this outer lease does not replace the handler's asynchronous lifetime. WebSocket
  upgrade authentication has the same pre-owner guard. `/health` and the already
  authenticated native preparation relay remain independent.
- Existing chat sockets acquire before projection, model, goal and OAuth awaits.
  A disconnected viewer cannot release a still-running dispatch. The goal's
  detached `sendChat` callback retains its own lease. Cached chat replay stays
  available; a validated existing approval or abort completion may finish
  under a reversible fence. Such activity invalidates a prepared token, even if
  it becomes idle again before commit. Nothing is admitted after commit.
  OAuth submit/cancel still uses normal admission: a remembered UI attempt does
  not prove a live worker, and the current API can lazily spawn one. Its future
  completion exception needs generation-bound, non-spawning ownership proof.
- Terminal `init`, input and resize are checked per message, not per connection.
  Old PTYs remain represented while their replacements occupy the same session
  key. Leader exit does not prove detached-descendant termination, so the
  `pty_descendants_unverified` reason stays latched for this server lifetime.

## Read-only ownership

Three real readers are composed: `chat`, `gjc-worker`, and `shell`. Every required
reader not implemented is still an explicit `owner_missing` blocker. Reading
activity never starts a process, interrupts a job or clears a health failure.

The chat registry counts live runs, approvals and asynchronous session/title
publication through settlement. A visible `complete` or registry clear cannot
erase the outstanding publication.

The worker supervisor tracks startup, request/run continuations, approval replies
in flight and reap uncertainty. Eviction of timed-out request details or a late
response does not prove termination. A live worker still reports
`worker_runtime_unaccounted`; an absent process-tree proof cannot become idle.

The SDK adapter and OAuth controller now separately expose bounded, credential-free
activity snapshots. OAuth cancellation/timeout/close retains the actual login and
refresh task. Title generation remains counted after its UI grace period until
the title task and persistence really settle. SDK background containment remains
`sdk_background_ownership_unproven`; these inner readers are not yet an integrated
worker-host quiescence protocol.

## Unsent draft persistence

The actual composer uses `useDurableComposerDraft` and the browser IndexedDB
repository. Only unsent input, image `File`s and queued intents are stored, not
provider messages/transcripts. Project and conversation form the routing key.
Transaction completion is the persistence acknowledgment; per-record revisions
reject stale-window writes. Failed quota/storage operations retain the live input
and prior committed data rather than evicting unrelated unsent drafts.
Empty visits do not consume draft capacity. Explicitly cleared payloads release
space while bounded revision tombstones prevent stale revision reuse. Incomplete
legacy migration preserves the entire original rather than truncating queued
instructions. A storage error has an explicit retry/rebase action in the composer;
retrying recovery does not itself send a message.

Loading cannot overwrite newer keystrokes or files, and a late operation for
project A cannot clear or send project B's draft. Restored queued intents retain
their identifiers and files but require review instead of automatically replaying
an instruction whose previous send outcome might be unknown. The existing edit
action restores the intent and its images to the input.

The legacy localStorage queue remains a compatibility projection. It cannot be
used by the text-only offscreen sender to send a partial File-bearing intent.
Ordinary text-only background auto-send remains supported, including steering
rejection/reconnect. Same-document notifications and consumption reconciliation
prevent old cached queues from resurrecting already-sent instructions. Steering
acknowledgments retain their original project and conversation route.
This is **not** a global freeze/save acknowledgment for native restart: other
windows, offscreen ownership, uploads and in-flight sends still need an integrated
transaction. Browser persistence/eviction is not a native update durability proof.

## Verification and evidence

Evidence directory: `/private/tmp/gajae-updater-admission.4woZhX/`.
Final promotion verification passed on the frozen source set. The before/after
SHA256 inventory of changed source, tests and locales is identical
(`inputs-before.sha256`, `inputs-after.sha256`).

- **Full `npm run verify` passed**, including audit/license/notices, both TypeScript
  projects, Rust core, all test lanes, lint, identity and client/server/core build
  (`verify-promotion.log`). Earlier `verify-union.log` also passed; the promotion
  run includes the final review fixes and locale/UI changes.
- Focused final composer/storage/background-queue DOM tests: 62 pass
  (`frontend-final.log`). Recovery/retry UI is tested in English and Korean, with
  locale key parity maintained across ten chat locales.

- Reviewed HTTP/chat/authority/authentication/runtime tests: 123 pass
  (`admission-reviewed.log`). Expanded backend union including image/voice/PTY,
  chat registry and route coverage: 237 pass (`backend-union.log`).
- Unchanged desktop shell: cargo fmt check; locked Rust tests 182 pass with one
  opt-in archive test ignored, and 10 build-binding tests pass (`native-tests.log`).
- GJC wire/browser e2e: 8 pass; browser sidecar e2e: 3 pass (`gjc-e2e.log`,
  `browser-e2e.log`). These are separate from native installation acceptance.
- Worker tests: 63 pass, including cancelled enrichment resolving successfully,
  reused run IDs, worker replacement and shutdown (`worker-final.log`). OAuth/SDK
  tests: 102 pass plus one optional live test skipped (`sdk-final.log`).
- The first aggregate verification caught a legacy background-steering queue
  regression (`verify-final.log`). It is retained as failed evidence, not described
  as a passing full gate. Subsequent fixes passed the promotion gate above.
- Independent frontend review reproduced and then closed duplicate legacy sends,
  cross-project steering acknowledgments, un-retryable recovery/conflict,
  incomplete migration loss and missing queue notifications. A late OAuth UI
  owner also no longer qualifies as a non-spawning completion exception.

Browser skill QA used a separate loopback origin, `http://127.0.0.1:5197`, with
synthetic project/session IDs and no real backend requests. The local fixtures are
`.gjc/updater-draft-qa-20260908/`; the checked-in production-composer harness is
`src/components/chat/tests/fixtures/ComposerDraftPersistenceHarness.tsx`.

Observed through rendered UI:

1. Input plus both draft/queued image Files survived a full page reload. The queue
   ID was unchanged and the restored intent required review.
2. The 95-byte synthetic `qa-image.svg` had SHA256
   `1303e66ce1e0c759517db95d30f91413f342abd8c740e72b9813c863a90c9e87`
   before and after restoration, including the queued copy.
3. Project B using the same conversation identifier did not receive A's input or
   attachment. Returning to A restored A's data.
4. A second stale window received `error conflict`; reloading it restored the
   newer committed text, not the stale attempted overwrite.
5. The actual production composer hook queued a pasted File, restored the same
   identifier/File after reload, sent nothing when busy became idle, and returned
   the File to the input via its existing edit action.

These are browser/HTTP/runtime tests, not installed WKWebView, application
replacement, minimum-OS, authorization-dialog or signed A-to-B acceptance.
The private QA browser tabs and Vite listener were closed after testing. During
development, hot replacement of changed hook signatures invalidated the fixture;
full reload restored the final component normally. That transient development
state was not used as passing UI evidence.

## Still required before installation/release

- G0's actual macOS 13 qualification and official installer authorization/cancel,
  interrupted-write/error classification and writer-termination proof.
- Remaining producer admission and owner readers: worktree/orchestrator/native
  job state, internal continuations, automation/browser/CUA, native clients,
  watchers/notifications and detached callbacks. A source-wrapper coverage test
  does not establish all of these lifetimes.
- Global draft/attachment/queued-intent freeze and native-bound acknowledgment;
  safe shutdown with proven owned-server exit and single-instance handoff.
- Product attempt writer/resolver, next-launch pre-server official installation,
  embedded applying/recovery and interrupted-install behavior. The earlier
  example journal is still QA-only.
- Integrated signed/notarized QA A→B with origin/auth/settings/transcripts/projects
  and draft survival; production updater-key custody/backup and release gates.

The first updater-enabled DMG still requires one manual installation, followed
by a distinct later release to prove public-channel auto-updating. Neither
missing validation nor a passing build authorizes weakening these gates.
