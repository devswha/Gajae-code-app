# GJC SDK lifecycle remediation — app-owned patch

Status: producer-completion and enabled-default-host remediation verified in isolation
and applied through a clean checkout `npm ci` on September 8, 2026 for exactly
**0.16.4**. All 32 files passed pristine before-hash validation and installation;
check-only subsequently verified all 32. The app, worker and native validators
share `shared/sdkLifecyclePolicy.json` (maximum 32 files). This is not
an updater/plugin fork, an upstream publication, or permission to clear
`sdk_background_ownership_unproven`. Root and packaging postinstall apply this
same manifest; runtime manifest v2 checks all post-hashes before SDK startup.
The source-integrity receipt does not authorize installation or certify idle.

## Artifact contract and provenance

`manifest.json` uses the agreed schema exactly: schema version 1, id
`gjc-sdk-lifecycle-v1`, exact package versions, and 32 source-file entries with
full before/after SHA-256 digests and ordered replace-once edits. Each `before`
snippet occurs exactly once in the preceding source. The complete transformed
file must match `afterSha256`; snippet matches alone are not sufficient.

Pristine packages were fetched on September 8, 2026 into a new temporary
directory with `npm pack --ignore-scripts --registry=https://registry.npmjs.org`.
The artifact review did not mutate installed dependencies. Parent integration
subsequently applied the original eight verified edits using the guarded applier.
The producer candidate started from independently fetched pristine packages and
that same guarded eight-file application. New edits were made only to the isolated
candidate and encoded as additional replace-once operations. All old replacements
remain in order, including the four otherwise unchanged leaf/registry files;
versions remain pinned to the published 0.16.4 packages.

| Published package | npm tarball SHA-1 | npm integrity |
| --- | --- | --- |
| `@gajae-code/coding-agent@0.16.4` | `4613aba27825509b0be68de5b9eea05fd8c6e841` | `sha512-cnqyYOEGygPp87gCEkqahNiRYoBhL4gxvQnWY16lDADThfNjhrl7VP+5f9cLakevI+pjRbTSdDBw/iZ3Nc6PCw==` |
| `@gajae-code/agent-core@0.16.4` | `64f8c249bad9c0f1ff8574ec476417294ef3c6c9` | `sha512-Ck0TIybhjf7qfWNQMbFEHDXCUiT0xDOq27DCeO2UbRglorI49iBmbw7Lq2J8yWVf8FgtEVD2RXEENX13GwH1Tg==` |
| `@gajae-code/ai@0.16.4` | `e69483ff743d6e9b23e63e1781d3ed099e749f3a` | `sha512-q89+ggA3vWaWxx3u9cEelpdiLtHX2uHFsqHkJtYZDVj40RNgU8PPpYwPvHi3jwJ/THQE49GOwSddAPvT57N5KA==` |

The separately inspected official `coding-agent@0.16.6` tarball has SHA-1
`b72393e4107c69d6cfaf5549e64971c5b8017232`. Its relevant prewarm, disposal and
forced-recovery blocks, plus its async-job manager, are unchanged from 0.16.4.
That comparison is not runtime compatibility qualification for a pin upgrade.

## What changes

1. **`coding-agent/src/sdk/session.ts`: startup ownership.** Model-host preconnect
   and Codex credential/WebSocket prewarm each reserve a promise before their
   operation begins. Session transition cleanup joins these promises before
   credential/provider resources are released. The failed-creation path also
   joins startup work and retained async-job disposal. Transport preferences,
   selected models and enabled tools are unchanged; WebSockets are not disabled.
2. **`coding-agent/src/session/agent-session.ts`: actual retained completion.**
   Calling `awaitDisposeCompletion()` first now starts disposal but returns its
   retained promise, not the bounded caller promise. Separate physical owners
   retain post-prompt work when forced recovery clears the logical queue, and
   retain each prompt through its actual finalizer. Normal disposal joins these
   owners and the core physical ledger before closing session resources. The
   SDK factory also enables a final `flushOrThrow()` for caller-borrowed Settings
   after physical/tool cleanup; it does not close that object. Persistence errors
   reject retained completion.
3. **`agent-core/src/run-resource-ledger.ts`: physical accounting survives
   quarantine.** The existing promise-registration paths also retain physical
   promises independently of visible resources and bounded tombstones. This
   includes promises submitted through already-closed/quarantined leases.
   Logical `waitForSettlement()` results are unchanged: quarantine remains
   `unfenced`, even after a physical join. Terminal physical joining denies
   fresh `open()` calls but never deletes pending promises to become idle.
4. **`agent-core/src/agent-loop.ts`: retain the producer, not only its consumer.**
   Both loop entrypoints reserve their producer-body completion before invoking
   the body. It resolves in the producer's `finally`, not when a consumer sees
   `agent_end`, breaks iteration, or `forceAbort()` clears the busy flag. This
   also covers pre-provider metadata/auth/hook awaits inside that body. This is
   physical-only retention, not a logical ledger entry: it does not add a
   `waitForSettlement()` self-dependency or change standalone sealing.
5. **`coding-agent/src/config/model-preset-registry.ts`: recurring maintenance.**
   This is a recurring six-hour refresh (default startup delay: 30 seconds), not
   a one-shot task. Its callable cancellation handle also exposes read-only
   activity, a reversible admission fence, and a pending-work join. A fence
   pauses future timer dispatch/publication and retains the due time/deferred
   notification. Accepted flights and publication promises keep running through
   callback completion. Reopening resumes scheduling; automatic refresh is not
   disabled.
6. **`coding-agent/src/config/model-registry.ts`: maintenance ownership.**
   Constructor publication returns its catalog-mutation promise instead of
   discarding it. Activity covers helper roots, catalog queue/tail, explicit
   background refresh, async catalog callbacks and their settings persistence.
   Disposal joins these owners, not only the helper. A persistence failure stays
   unknown. Borrowed AuthStorage is accounted separately by its leaf seam.
7. **`ai/src/auth-storage.ts`: actual auth leaf ownership.** Raw OAuth provider/
   broker refresh promises, scoped/shared usage overrides, per-credential usage
   work and cache publication, config-value resolution, and credential-disabled
   callbacks reserve ownership before invocation. Caller timeout/cancellation
   races never release their underlying loser. Existing public timeout and
   synchronous `close()` behavior remain unchanged. A close does not erase
   pending ownership. Data generations and activity revisions remain separate.
8. **`coding-agent/src/config/settings.ts`: reserved background saves.** Every
   real save promise is retained independently of the latest `#savePromise`.
   The getter exposes the reserved debounce and in-flight writes; the join waits
   for the existing timer/save naturally and never invokes flush/close. A failed
  save leaves sticky `settings_persistence_unconfirmed`, even once its promise
  has settled. Normal `flush()`/`flushOrThrow()` semantics are unchanged.

9. **AI stream producer contract (19 additional files).**
   `src/utils/event-stream.ts` holds per-stream physical owners in a module-private
   WeakMap. `runAppStreamProducer` reserves the owner before invoking the actual
   async producer and resolves only after that body, including its real `finally`,
   and adopted child producers settle. `push`, `end`, `fail`, `result` and iterator
   completion do not release it. A lookalike property or a bare
   `AssistantMessageEventStream` is not a registered producer.
   `src/providers/register-builtins.ts` owns module loading and forwarding, and
   adopts the inner producer before consuming it. `src/stream.ts` does likewise
   for lazy imports, custom-provider forwarding and **every** auth-retry attempt.
   `complete`/`completeSimple` also join known producers, so non-streaming callers
   such as title generation retain their tail. `result()` itself stays unchanged.
   `src/utils/idle-iterator.ts` retains raced `next()` and `return()` promises in
   the initiating producer's async-local owner; its timeout/abort still returns
   promptly, without discharging the losing physical operation.

   The 15 actual transport bodies are `amazon-bedrock`, `anthropic`,
   `azure-openai-responses`, `cursor`, `google-gemini-cli`, `google-shared`,
   `kiro-api-key`, `kiro-codewhisperer`, `ollama`, `openai-completions`,
   `openai-responses`, `openai-codex-responses`, `openai-anthropic-shim`,
   `gitlab-duo`, and `pi-native-client` (all `ai/src/providers/*.ts`). Google
   and Vertex share the patched Google body; Kimi/Synthetic delegate through the
   patched shim. Shim/GitLab forwarding adopts their inner transport as well.
   Cursor's body is retained, but its separately dispatched HTTP/2 task/debug
   work is not fully audited and explicitly remains unknown.

10. **Core/session composition and factory retention.** The core retains each
    authenticated producer promise in the physical ledger, separately from
    logical provider settlement. Missing producers and child coverage failures
    leave sticky `sdk_provider_producer_unrepresented`; quarantine cannot erase
    either retained promises or that reason. The ledger exposes a pure activity
    getter. The session composes it with physical prompt/post-prompt owners and
    the SDK factory's pending work, with disposal/failure generations.
    Parallel workspace/context/prompt-template discovery is now reserved before
    invocation, including workspace deadline losers and early factory failure.
    Direct credential-disabled callbacks and reactive MCP publication reserve
    returned promises, and cleanup joins accepted work before closing shared
    resources. The adapter reads these actual owners from creation through
    retained disposal; it does not turn a source-integrity receipt into coverage.

11. **Enabled default SDK host (five additional files).**
    `coding-agent/src/sdk/host/host.ts` provides a session-local physical owner
    and reserves accepted dispatch, activation and send promises before invoking
    them. Reverse RPC deliveries use the same owned send path. Admission closes
    on ordinary host stop; already-accepted handlers and writes remain owned.
    `src/sdk/host/session-runtime.ts` retains directed deliveries, preflight and
    submission continuations, terminalization/skill recovery, gate resolution,
    lifecycle persistence and the actual startup/shutdown handlers. Retired-owner
    cleanup timers have physical reservations through dispatch; cancelling a
    future timer does not discharge an already-running callback. Existing bounded
    drains still return on their original budgets. SDK session resource cleanup
    then joins the separate physical owners before releasing shared resources.
    `src/sdk/prompt-deadline-manager.ts` similarly retains deadline/retry timers,
    in-flight expiry writes and uncertainty recovery after logical lease clears.
    `src/sdk/host/websocket-transport.ts` preserves the 250ms public stop race but
    retains the actual server-stop loser; its physical join propagates late
    failure. `src/sdk/host/query/revision-store.ts` joins detached snapshot-unlink
    promises before final directory cleanup.

    A real SDK session is tested with its default WebSocket host actively started
    (endpoint creation verified), an offline provider turn, normal disposal and
    endpoint removal. Its receipt is complete with zero activity. The adapter
    contract also proves that the enabled default path becomes eligible after
    cleanup. The fixture pre-starts an isolated **in-process** broker, so no
    detached process is spawned or signalled. These are ownership tests, not a
    transport-disable workaround or a certificate for opaque user extensions.

These APIs are additions to the Bun source runtime, not changes to npm declaration
files. The async-local iterator retention is qualified for the pinned Bun runtime;
it does not constitute browser or other JavaScript-runtime qualification.

## Public registry seam

```ts
getAppLifecycleActivity(): {
  generation: string;
  complete: boolean;
  starting: number;
  queued: number;
  running: number;
  settling: number;
  unknown: string[];
}
setAppLifecycleAdmission(closed: boolean): void;
awaitAppLifecycleSettlement(): Promise<void>;
```

The getter is pure and detached; counts may overlap. It is incomplete while
maintenance admission is open, if a required settings flush capability is
missing, or after unconfirmed persistence. Deferred future maintenance is not an
accepted root and is not busy while fenced. The explicit join requires a held
fence and rejects if reopened during its wait. This is **registry maintenance**,
not an AuthStorage, settings-global, or whole-worker receipt.

Foreground `refresh`/`refreshStatic`/`refreshProvider` retain their behavior: they
may be required continuations of accepted OAuth/session work. Top-level app
admission must gate genuinely new callers; every accepted catalog mutation is
counted before its first await. `refreshInBackground` and helper timer/notification
roots defer while fenced. Parent must include registry generation/counts from
adapter construction, not only after first session creation. A missing seam is
unknown. The new runtime methods need a narrow public capability type at the app
boundary; the npm declaration files are deliberately not rewritten.

## AuthStorage and Settings leaf seams

Both classes expose the same seven-field `getAppLifecycleActivity()` shape above
and `awaitAppLifecycleSettlement(): Promise<void>`. **Neither gets an admission
fence.** New roots are already gated by the worker, registry and OAuth owners;
an accepted registry flight must be allowed to reach a later auth dependency or
settings write. Leaf starts/completions revise their own generation.

Source audit found no autonomous recurring dispatcher in AuthStorage: its timers
bound requests. Settings' autonomous save debounce belongs to a reservation
created synchronously by a writer. Its complete save promise remains owned from
reservation through persistence/failure cleanup. Thus these constructor/global
leaf owners need no perpetual blanket unknown once their real pending sets are
empty (unless Settings persistence failed). These are component receipts, not a
full SDK certificate. Missing APIs remain unknown; the adapter must aggregate
leaf generations/counts from construction and retain references to every owner
that can still have pending work.

The joins are physical-promise joins with no artificial timeout, no mutation of
admission, and no forced flush. They must be called by an outer owner, not awaited
from a callback that they themselves own. The read-only getters are bounded and
do not inspect credentials or the filesystem.

The new runtime helper `awaitPhysicalRunResources(ledger)` is a **terminal join**,
not a read-only observer. It is called only by normal SDK disposal. Its optional
exported marker `GJC_APP_LIFECYCLE_PATCH = 'gjc-sdk-lifecycle-v1'` is useful for
debugging, but is neither a quiescence certificate nor proof that all patch files
are present. A bundler may elide the marker if unused. Use the manifest inventory
to verify source bytes before compilation. The SDK accesses the additive helper
through a narrow public namespace type; existing app-facing declaration files and
the public `awaitDisposeCompletion(): Promise<void>` signature are unchanged.

## Preserved behavior

- `abort()` and `forceAbort()` keep their existing bounded/logical behavior.
  They may free the interactive busy state while physical work remains retained.
- `dispose()` keeps its existing caller deadline and
  `SessionDisposalIncompleteError`. The retained join has no invented timeout:
  a task that never settles must keep it pending.
- Existing disposal failures still reject. Physical completion is not success
  of the user's tool/provider operation; an ordinary failed operation can settle.
- Ownership is per ledger/session. One session's completed teardown does not
  discharge another session's pending work.
- No process-tree kill, updater admission change, SDK-command replacement, timer
  monkeypatch, or installed private-field inspection is used to manufacture idle.

## Physical evidence and reproduction

`lifecycle.bun.test.ts` imports an explicitly selected isolated candidate SDK and
core/AI. Only their 32 manifest-listed source files differ from pristine published packages.
Other dependencies are read-only links to the existing 0.16.4 dependency closure;
this is not a clean-install, cross-platform or packaged-binary qualification.
All session data goes into independent temporary fixtures. No live credentials,
provider requests or shell commands are needed.

The tests hold actual promise gates, verify the retained join remains unresolved,
then release the gates and await completion. They do not infer physical completion
from generation changes or empty diagnostic counters. Coverage includes:

- quarantined and late failed-lease resources;
- a provider factory still pending after `forceAbort()`/`waitForIdle()`;
- an abort-ignoring tool;
- abandoned post-prompt work with a bounded public disposal timeout;
- Codex prewarm before resource cleanup, with WebSockets still enabled;
- independent sessions and preserved cleanup failure;
- a real SDK prompt reaching normal disposal;
- standalone logical settlement while its loop body is retained physically;
- recurring refresh and publication deferral without aborting accepted work;
- independent borrowed-registry activity and catalog callback completion;
- borrowed Settings flush ordering, held public persistence promises, actual
  durable reload, error propagation and preservation of borrowed storage;
- auth scoped/shared usage timeout losers, provider deadlines, OAuth cancellation
  losers, config resolver reservation-before-invocation, and callback completion;
- real Settings debounce and file-lock-blocked persistence, overlapping saves,
  durable reload, and actual background-save failure;
- physical producer `finally` on success/failure after an early terminal event;
- an **actual pi-native transport** publishing terminal SSE before EOF, through
  both a core join and real session disposal with its caller deadline;
- lazy built-in dispatch, nested/custom forwarding and auth-retry loser tails;
- physical idle-iterator timeout/abort losers, and rejection of forged receipts;
- accepted host control/response/delivery callbacks after logical stop, independent
  host owners, actual WebSocket shutdown timeout losers and late failure;
- a real hosted lifecycle drain exceeding its public budget while persistence
  and retired-owner timers remain retained, plus physical deadline writes after
  logical clears and future-vs-running timer cancellation;
- enabled default-host SDK and adapter cleanup reaching complete, zero activity;
- the unregistered-provider-tail limitation below.

From the repository, run the read-only/replay tests with the supported Node:

```sh
node --test patches/gjc-sdk-lifecycle/manifest.test.mjs
```

During parent integration, set `GJC_SDK_LIFECYCLE_CANDIDATE` to the isolated
pristine or known-after install root for replay tests; this avoids treating the
checkout's previous eight-file state as the new manifest's known-after state.
The full parent-applier tests use the shared policy and require capacity for 32 files.

For physical tests, extract the exact published packages into a fresh temporary
install layout (`node_modules/@gajae-code/{coding-agent,agent-core,ai}`), supply their
unchanged transitive dependencies, and use the parent's exported
`applySdkLifecyclePatch(tempRoot, manifest)` function on **that temporary root**.
Do not run the applier CLI against the checkout as part of artifact review.
For normal development, `npm ci` applies it through postinstall; `npm run
apply:sdk-patch` applies the checked manifest explicitly, and `npm run
check:sdk-patch` is read-only. An unknown/local modification is refused, not
overwritten. `npm test` runs these same lifecycle tests against the installed
patched code through `scripts/sdk-lifecycle-contract.test.mjs`, using separate
temporary data directories and offline providers.

```sh
GJC_SDK_LIFECYCLE_CANDIDATE=/absolute/temporary/install-root \
  dist-native/bun test patches/gjc-sdk-lifecycle/lifecycle.bun.test.ts
```

`manifest.test.mjs` verifies exact replay/full hashes and invokes the parent's
applier only on temporary fixtures. It checks unapplied `--check` semantics,
known-after idempotence, version rejection, and all-file prevalidation. Installed
source is read only; known-after fixtures can be reconstructed in memory.

## Concrete remaining proof limits

This patch is **not yet an all-feature SDK quiescence certificate**.

- **Leaf receipts require upstream root admission.** Auth and Settings do not
  reject an accepted continuation. A future external caller can create new work;
  the app must gate those callers and compose each leaf generation. Per-instance
  leaf activity is not evidence for a different AuthStorage/Settings instance.
  Synchronous request APIs or external stores remain owned by their calling root;
  the leaf seam specifically retains asynchronous work which may escape a raced
  waiter. It does not certify unrepresented work hidden behind a third-party
  provider/store callback's returned promise.
- The built-in **producer-body tail gap is closed**, including forwarding and
  iterator timeout losers. An unregistered custom/extension provider, including
  the bundled Grok provider's independent implementation, remains unknown. A
  returned promise is a contract for represented work, not evidence for detached
  effects hidden by a custom fetch/callback implementation.
- **Default SDK hosting now has physical ownership, not a blanket exception.**
  Its bounded return is still not physical completion: the session joins its
  retained owners and the real WebSocket stop promise. Missing host registration
  remains `sdk_host_effects_unrepresented`; a custom transport without a physical
  join is `sdk_host_transport_unrepresented`. Joining a host from the callback it
  would itself wait for fails explicitly with `sdk_host_reentrant_settlement`
  instead of manufacturing idle or deadlocking. This does not claim coverage of
  separate generic notification hosting, which still reports
  `sdk_notification_effects_unrepresented` when enabled.
- Explicit/preloaded extensions and discovered hook/plugin factories may detach
  arbitrary effects; those sessions report `sdk_extension_effects_unrepresented`.
  `ExtensionRunner.initialize()` can also flush buffered credential-disabled
  events through unretained microtasks. Although direct returned callback
  promises are now retained, a session receiving these events reports
  `sdk_extension_credential_dispatch_unrepresented`. Runner-level queue/finally
  retention is still required for that buffered path. Borrowed arbitrary runtime
  services/event buses/MCP managers report `sdk_injected_services_unrepresented`.
- Cursor's producer is retained, but its HTTP/2 coordinator subtasks and async
  debug writer still require independent validation and joins; its receipt
  includes `sdk_cursor_subtasks_unrepresented`.
- A shell/tool can intentionally detach a descendant or create an external
  effect not represented by its returned promise. Physical promise settlement
  alone is not OS process-tree proof.
- Failed factories have no returned whole-session receipt. The enumerated
  parallel discoveries, prewarm and async-job cleanup now join on failure, but
  all fallible extension/host/discovery implementations have not been certified.
  The adapter therefore retains `sdk_background_ownership_unproven` for a failed
  factory rather than inferring coverage from rejection.

Accordingly, do **not** blanket-remove `sdk_background_ownership_unproven` based
on the marker or this patch. Parent integration must preserve unknown for these
unproven paths. Guarded application, postinstall/build wiring and runtime manifest
v2 are connected. Final frozen-source promotion, real packaged/platform checks,
native restart/previous-owner proof and public release still require their own
evidence; this artifact is not a waiver of any of them.
