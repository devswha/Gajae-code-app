# Desktop update admission: safe manual restart

2026-09-08 implementation delta: common HTTP/WS admission and three real owner
readers are partially connected. See
[implementation and remaining gates](DESKTOP-UPDATE-ADMISSION-IMPLEMENTATION.md).
The map below retains its original source-inspection baseline; it is not G3
acceptance and unimplemented readers still block restart.

Status: implementation map, not an implemented contract or a G3 pass.
Source inspection: `7b138efc607b1c0bb8de3b06e72fa5ddc34cae02`, 2026-09-07.
Scope: one reversible backend admission fence and existing execution owners.
No installer, native shutdown, runtime, or UI changes accompany this document.

The approved planning reference is G3 / MU-07 / AC-07 in
`.gjc/_session-01a076d3-db4a-760a-ae8e-1bad69cdb5b8/plans/ralplan/01a076d3-db4a-760a-ae8e-1bad69cdb5b8/stage-03-revision.md`.
See also [the updater handoff](MACOS-UPDATER-HANDOFF.md).
The parent reports an isolated official-updater 2.6 historical signed A-to-B
primitive passed on macOS 26; authorization cancellation is still being probed.
That is not a G0 completion claim or permission to wire product installation.

## Contract to freeze before assigning code

Create one `DesktopRestartAuthority` in `server/index.js` and inject its interface.
Do not create independent update reservation registries in every service. Existing
maps remain the owners of accepted work; add read-only readers and preserve their
entries through settlement. All names below are proposed APIs.

```ts
type OwnerActivity = {
  owner: string;
  generation: string;
  complete: boolean;
  starting: number;
  queued: number;
  running: number;
  settling: number;
  approvals: number;
  retained: number;
  unknown: readonly string[]; // bounded reason codes, never payloads/secrets
};

interface DesktopRestartAuthority {
  enter(source: ProducerKind): ActivityLease; // synchronous check + increment
  snapshot(): Promise<RestartSnapshot>;
  prepare(attempt: BoundNativeAttempt): Promise<PrepareResult>;
  commit(token: string): Promise<CommitResult>;
  cancel(token: string): void; // idempotent, precommit only
}
```

`ProducerKind`, lease/handoff semantics, owner IDs, and result envelopes must be
fixed together; these are not existing exports. A lease is released exactly once
when the actual operation settles, or after synchronous transfer to a registered
live owner. Double-counting during transfer is safe; a zero-count gap is not.
Never release just because a socket closed, a response was sent, or a waiter timed
out. A child-generation change, missing reader, incomplete snapshot, failed
cleanup, or unproven transfer is `unknown`, which blocks commit.
Prepared requires every required reader to be complete, all activity counts to
be zero, and no unknown reasons. Counts may overlap; they are not unique job
totals. Register the required owner set explicitly so a missing reader cannot
silently disappear from the aggregate.

State transition: `open -> preparing -> prepared -> committed`. Busy/error,
cancel, token expiry, or controller loss may return to `open` only before commit.
This state is separate from job-authority health and irreversible Rust shutdown.

1. After native preflight and draft/attachment/queued-intent save acknowledgment,
   `prepare` closes admission synchronously before its first await. Existing busy
   owners return blockers immediately; do not wait for long-running work to end.
2. Collect read-only owner snapshots under that fence. Existing accepted runs may
   finish or continue within their owned lifetime; do not abort/pause/dispose them
   to obtain idle. A rejected prepare releases only its update fence.
3. Bind the prepared token to attempt, current native/child epoch and expiry.
   Prepare/save/snapshot budget is at most five seconds; an uncommitted token
   expires after ten seconds. Expiry is not proof that any operation ended.
4. After the native applying page is visible, `commit` revalidates the token and
   all ownership proofs. Its final zero-ingress/current-proof check and transition
   to `committed` are synchronous, with no intervening await. Async snapshots must
   carry current child generation/epoch, not a cached idle boolean. Any producer
   capable of invalidating an idle proof must remain fenced or invalidate it.
5. Only the parent native lifecycle proceeds to irreversible shutdown and owned
   server-exit proof, then install/restart. Backend commit itself neither installs
   nor sends SIGTERM. Postcommit controller loss never automatically reopens.

Keep reads/status/cancel/approval completion available, but classify operations by
behavior, not HTTP verb. Completion handlers remain accounted until settled.
Reject new sends/steers/root work while fenced. A read that lazily spawns a worker
is not an inert status read: serve a cached result or explicitly defer that spawn.
The bound prepare/commit/cancel calls and inert snapshot reads must not count
themselves as new work. Define new-root, owned-completion and inert-read producer
classes in the shared contract; callers cannot select a permissive class through
request payloads. Internal continuations need a still-live owner or new admission.

## Composition and ingress sites

| Site | Required ownership/wiring |
| --- | --- |
| `server/index.js`: production authority/orchestrator, `gjcSpawn()`, `createGjcAppFactory()`, `startServer()` | Own the single authority; supply owner readers and inject admission before listeners/startup callbacks. Current `spawnFns` contains only `gjc`. |
| `server/app-factory.js`: `createGjcAppFactory()` | Inject into HTTP/WS composition before `terminalNotificationAdapter.startupCatchUp()` and `/api/gjc` mounting. Later routes mounted by `index.js` must inherit the same instance. |
| `server/routes/gjc-jobs.js`: `createGjcJobsRouter()` and default export | Default router construction accesses production singletons at module import. Do not leave this alternate construction path unfenced. |
| `server/shared/utils.ts`: `asyncHandler()`; plain async route handlers | Common HTTP lease wrapper must observe handler settlement, not just `finish`/`close`. Adapt plain async handlers to that same wrapper. A request middleware alone cannot observe an abandoned handler promise. |
| `server/modules/websocket/services/websocket-server.service.ts`: `createWebSocketServer()` | Connection routing is insufficient: existing `/ws`, `/shell`, and browser sockets remain usable. Gate dispatch/producer calls on each message or subscription action. |
| `server/modules/automation/automation.service.ts`: `handleBridgeLine()` | Unix-socket automation bypasses HTTP and chat WS. Use the same admission authority after authentication and before the first dispatch await. |

At this commit `server/shared/types.ts::LLMProvider` and
`server/modules/providers/provider.registry.ts::knownProviders` are GJC-only,
despite AGENTS' legacy-provider wording. Keep dispatch generic and require an
explicit reader for every configured provider. Unmapped providers fail closed.
Cross-module imports use module barrels; engine-facing types/protocol go through
the existing engine boundary, not imports from engine code into app modules.

## Existing owners and exact producer map

All paths in this table are repository-relative. Snapshot names are proposed.

| Owner / reader | Producer entrypoints | Existing accounting and required proof |
| --- | --- | --- |
| `server/modules/websocket/services/chat-run-registry.service.ts`: `chatRunRegistry.snapshotActivity()` | `chat-websocket.service.ts`: `handleChatConnection()` dispatch, `sendChat()`, `steerChat()` | `runsByAppSession`, `pendingApprovals`. Acquire before `await gjcProjection.handle()`. `startRun()` already registers synchronously before model lookup. UI `complete` may precede lower-owner cleanup; retain dispatch/worker ownership through it. |
| Same chat owner, plus worker goal owner | `chat-goal.service.ts::handleChatGoal()`; `chat.goal` callback's `void sendChat(...)` | Scope/goal inspection awaits before starting. Callback calls `sendChat()` immediately, which reserves synchronously: preserve this handoff. Idle-session create/resume and other mutations can open a run; they are not all read/control-only operations. |
| `server/services/session-worktree-runtime.ts`: `snapshotSessionWorktreeActivity()` | `prepareSessionWorktreeRun()`, returned `run()`, `abortSessionWorktreeRun()` | `tickets` is populated before model lookup and spans validation/binding/admission. Preserve a failed/unconfirmed worker's ownership even when the chat ticket is disposed. |
| `server/services/gjc-job-orchestrator.ts`: `JobOrchestrator.snapshotActivity()` | HTTP `POST /api/gjc/jobs`, `/jobs/:jobId/turns`, `/resume`; internal `start()`, `turnStart()`, `resume()`, `serial()`, `dispatch()` | `queues`, `activeRuns`, health transitions, persistence/finalization. `start()` installs a queue synchronously; `turnStart()` first awaits binding resolution, so queue size alone misses preparation. `dispatch()` registers a worker before returning the REST 202 handle. |
| Same orchestrator; durable native authority reader | `enqueueEvent()`, `trackPersistence()`, `completion()`, `appendAdminEvent()`, `authorityHealth()` | Worker terminal is not durable finalization. Count queue tails and pending writes. Keep `admissionBlocked`/health recovery independent of update cancel. Native `job.list/get` must prove no reserved/queued/running/aborting ownership, including archived records; incomplete paging or reconciliation is unknown. |
| `server/gjc-worker-client.ts`: `GjcWorkerSupervisor.snapshotActivity()` | `spawnRun() -> startRun() -> request()`; `ensureWorker()`; `steer()`, `resolveApproval()`, goal/model/OAuth requests | `runs.set()` precedes `void startRun()`. Read all run phases, `starting`, tracker requests, approvals including `inFlight`, expired-request uncertainty, terminating generation and `terminationFailure`. `isActive()` and filtered `pendingApprovals()` are not aggregate proofs. |
| `server/gjc-worker.ts`: host activity contract; `server/gjc-bun-sdk-adapter.ts`: runtime activity reader | `GjcWorkerHost.handle()/#start()`; `GjcBunSdkAdapter.spawnGjc()/#run()/#runInner()` | Host `#runs` and adapter `#starting/#runs` register before awaits. Keep the parent root until goal/ask/delegation/session cleanup and owned background work settle. Cleanup poison stays unknown until verified reap. |
| `server/gjc-goal-session.ts`: goal state within the worker root | `control()`, `invokeTool()`, `onEvent()`; SDK continuation scheduling | Own pending mutation/persistence, timer and stop lifetime. Installed SDK `session/agent-session.ts` has scheduled continuation/post-prompt tasks. Keep these within the root; no updater-driven goal pause/abort to manufacture idle. |
| `server/gjc-delegation-executor.ts`: `snapshotActivity()` | `tools()` task and subagent-resume executors; `#launch()`, nested `#run()`, `serializeGjcDelegationAutomationTools()` | `#jobs.set()` precedes child setup. Count unsettled `job.done`, cleanup failure and the automation promise tail. Receipt status alone is insufficient: child disposal and transcript flush follow completion. Root disposal already joins children; prove this remains gap-free. |
| `server/gjc-bun-oauth-controller.ts`: task-lifetime reader | `start() -> void #run()`; `submit()`, `cancel()`, `#terminate()` | `#active`/last visible phase is not enough: cancellation clears active before login unwinds. Track actual login/refresh settlement without exposing credentials or authorization URLs. |
| `server/modules/automation/automation.service.ts`: `snapshotActivity()` | `openBrowser()`, `commandBrowser()`, `inputBrowser()`, `callComputer()`, authorization methods, `handleBridgeLine()` | Include executing bridge handlers and pre-child setup, not socket count. Public `/api/browser` and legacy `/api/automation/browser` share producers; computer calls are separate. `stopSession()` returning `{closed:false}` is not idle proof. |
| `server/modules/automation/browser-sidecar-client.ts`: `snapshotActivity()` | `request()/ensureStarted()`, `startRecovery()/recoverSessions()/restoreSession()`; `browser-websocket.ts::subscribeFrames()` | Read startup/recovery, requests, retained tabs and uncertainty. Preview connect and state callbacks can start subscriptions. `mode=state`/`cachedState()` is inert; normal preview and `status()` are not. Never use cached empty tabs to certify crashed-child cleanup. |
| `server/modules/automation/browser-sidecar.ts`: child activity contract | `enqueue()/handle()`, `BrowserRuntime.ensureBrowser()/command()/input()/close()`, `onTargetCreated()` | Account global/session queues, realtime bypass handlers, launch/download, popup callbacks and evaluations. Conservative minimal policy: retained live pages are busy until user-requested close is confirmed. No automatic close to make prepare succeed. |
| `server/modules/automation/cua-client.ts`: `snapshotActivity()` plus service session ownership | `call()/ensureStarted()/request()`; service `ensureComputerSession()/endComputerSession()` | Read pending/start/uncertain operations and retained session labels. Ending labels must remain owned through driver acknowledgment. Driver cancellation notification is not cancellation confirmation. |
| `server/modules/websocket/services/shell-websocket.service.ts`: `snapshotShellActivity()` | `handleShellConnection()` local `start()` for `init`/`forceRestart`, input, `detach()`, `clearSavedSession()` | `pty.spawn()` and `sessions.set()` are synchronous. All retained PTYs are busy, including disconnected 30-minute retention. Keep retiring generations until exit/reap proof, not only the currently keyed PTY. |

### Auxiliary producers: do not omit from an all-idle claim

| Site | Minimum accounting hook |
| --- | --- |
| `server/modules/projects/projects.routes.ts`: `GET /clone-progress`; `project-clone.service.ts::startCloneProject()` | Lease through `waitForCompletion`, including checkout publication, project registration and cleanup. GET and response disconnect do not imply read-only/finished. |
| `server/services/gjc-job-git.service.ts`: `publish()`, `commit()`, `createPullRequest()`, `execute()` | Hold HTTP/internal ownership through subprocess completion and admin-event persistence. These are not active chat runs. |
| `server/services/gjc-git-client.ts`: `GjcNativeClient.request()/start()/failed()` | Native request/start/restart owner and generation. Automatic restart timer is an internal producer. Orchestrator and job-Git service factories have separate native-client maps; include both. |
| `server/modules/providers/services/sessions-watcher.service.ts`: `startGjcSessionWatcher()`, `openGjcWatcher()`, `synchronizeFile()`, `deliverQueuedUpdates()`, `scheduleRestart()` | Read startup tasks, pending synchronization/flush/restart; underlying `GjcSessionWatcher` owns pending events and `draining`. Defer new producer dispatch while fenced without discarding accepted writes. |
| `server/modules/notifications/services/gjc-terminal-notification-adapter.service.ts`: `startupCatchUp()` | Keep catch-up reads and dispatch-ledger writes accounted. Heartbeats and pure replayable fan-out are not permanent busy owners; do not extend this exemption to pending writes. |
| `server/index.js` file/upload handlers; `server/routes/{git,user,system}.js`; assets/project/provider/voice routers | Common actual-handler lease covers operations outside chat. Audit callbacks that outlive the handler. GET model/status probes can spawn processes; no blanket GET exemption. |

## Missing proofs that block G3

| ID | Concrete gap | Smallest closure/proof obligation |
| --- | --- | --- |
| A1 | SDK adapter `titleTask` races a ten-second grace timer and may write a title after run terminal. | Keep independent background ownership until the task really settles; report it before releasing the worker root. Do not turn the UI grace timeout into cancellation proof. |
| A2 | Browser/CUA client timeout/abort deletes pending entries. Browser `command('run')` times out its waiter without stopping evaluation. Supervisor expired-request entries can be evicted. | Retain unresolved-generation uncertainty through late terminal acknowledgment or verified reap. Never infer zero from these pending maps alone. |
| A3 | PTY grace expiry/restart removes the owner around `kill()`, before confirmed exit; old generation can be replaced at the same key. | Preserve retiring generations in the PTY owner. Leader exit does not establish arbitrary detached-descendant termination: unresolved process ownership blocks, coordinated with the parent's native proof. |
| A4 | Withholding SDK `job`/`cron` tools does not disable background bash. Installed SDK `tools/bash.ts` supports `async`; `async/job-manager.ts` owns registrations, admissions, resumes and deliveries. | Prove root containment through cleanup, including pending callbacks/continuations. Public `getAsyncJobSnapshot()`/`pendingMessageCounts` aid diagnosis but do not establish complete quiescence. Missing SDK ownership surface is unknown. |
| A5 | OAuth `#terminate()` clears active state before asynchronous login/refresh settlement. | Preserve actual task ownership through cancellation unwind. A terminal UI phase alone is insufficient. |
| A6 | Browser session/cache and CUA label removal can precede physical closure. Browser/native clients may respawn from recovery callbacks. | Count closing/recovering work; close admission before callback dispatch. Failed/ambiguous cleanup remains unknown; update prepare must not trigger forced shutdown. |
| A7 | `listRunningSessions()` is only the chat registry; authority health, REST jobs, approvals in flight and auxiliary work are missing. | Aggregate all registered owners. Native job reads require complete pagination within budget or a compact read-only aggregate. No `reconcile()`/`interruptForShutdown()` as an idle query. |
| A8 | `src/components/chat/hooks/useChatComposerState.ts` owns queued sends/steering/dispatch timers; queue persistence omits `File[]` attachments. | Parent/UI lane must freeze new sends and acknowledge durable draft, attachment and queued intent before prepare. Backend idle cannot supply this acknowledgment. |
| A9 | Watcher initialization is in async `server.listen()` callback; `closeSessionsWatcher()` currently runs outside the later shutdown function. | Account readiness/startup/restart independently; do not infer watcher shutdown or idle from this ordering. |

Do not invoke `server/index.js::shutdownRuntimeServices()`,
`JobOrchestrator.interruptForShutdown()`, `shutdownGjcWorker()`, automation shutdown,
or PTY kill during prepare: these interrupt work or destroy ownership evidence.
Normal shutdown has forceful/error fallback behavior and is not a safe-idle probe.

## Native/UI transport boundary (parent-owned candidate)

The proposed transport is a supervisor-owned stdin initialization secret and
authenticated, bounded stdout control frames. No new remote Tauri grants.
Treat this as a candidate pending G0 framing/ownership proof, not an implemented
security guarantee. Admission receives already-bound native requests; it must
not accept arbitrary browser-supplied URLs, paths, executable names or commands.

- Bind control frames to current child/spawn epoch, request ID and direction;
  enforce byte/queue/deadline limits, authentication and replay rejection.
  Retire keys/epochs on child replacement. Ordinary logs/descendant stdout must
  not impersonate control frames; the secret must not enter logs or inherited
  child environment. Parent owns this proof and the final envelope schema.
- Require desktop cookie, exact mutation Origin, and a separate memory-only
  current-main-view/navigation capability held in the authorized page's closure.
  Do not expose it through cookies, URLs, generic API responses or other windows.
  Cookie possession/custom headers alone do not establish native authority.
- Copied cookie without the capability, external browser, stale page/child epoch,
  other window and forged log frame must fail. An XSS already running inside the
  authorized page is not claimed solved by this binding.
- Precommit controller loss cancels only the update fence. After commit, retain
  the committed fence and let native recovery own the outcome. Never restart on
  a stale/unauthenticated stdout message or on a failed health probe.

## Assignment and acceptance checklist

Freeze the lease/owner/result schema first, then assign disjoint slices:

1. Composition authority + common HTTP wrapper + native-bound control adapter.
2. Chat/goal dispatch + worktree/orchestrator readers + PTY ownership.
3. Worker protocol/supervisor + SDK/title/OAuth/approval/background lifetime.
4. Automation bridge/client/sidecar/preview + timeout/recovery uncertainty.
5. Auxiliary native clients, watcher/catch-up, clone/Git/file route accounting.

Required isolated race fixtures (not executed for this document): pause handlers
before first await/owner handoff; race prepare/commit with REST/WS send, goal
continuation, delegated task, background bash, bridge command and PTY init/input;
disconnect an accepted request; deliver a late timeout response; race recovery
and forceRestart with owner snapshots; retain approval and OAuth cancellation
settlement; lose the controller before/after commit; expire/replay a token; fail
health and cancel update. Assert no accepted work/restart double success, no
lost ownership, and no force-drain. Verify inert status/state observers still work.

Document validation is static source/path/diff inspection only. This document
does not certify G0/G3, installed-app updating, process exit, authentication
cancellation, OS compatibility, or user-data survival. Every uncovered producer
or unknown owner continues to block manual restart; preparation/download work
can remain independently available.
