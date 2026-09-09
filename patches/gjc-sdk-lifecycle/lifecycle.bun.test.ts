import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, rename, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// Run only against an explicitly selected isolated candidate, never installed deps.
const candidate = process.env.GJC_SDK_LIFECYCLE_CANDIDATE;
if (!candidate || !isAbsolute(candidate)) throw new Error('Set GJC_SDK_LIFECYCLE_CANDIDATE to the isolated candidate root.');
const load = (pkg: string, file: string) => import(pathToFileURL(join(candidate, 'node_modules', pkg, file)).href);
const { Agent } = await load('@gajae-code/agent-core', 'src/agent.ts');
const { agentLoop } = await load('@gajae-code/agent-core', 'src/agent-loop.ts');
const lifecycle = await load('@gajae-code/agent-core', 'src/run-resource-ledger.ts');
const { createAgentSession, discoverAuthStorage } = await load('@gajae-code/coding-agent', 'src/sdk/session.ts');
const { ModelRegistry } = await load('@gajae-code/coding-agent', 'src/config/model-registry.ts');
const { refreshModelPresetRegistryInBackground, setModelPresetRegistryDisabled } = await load('@gajae-code/coding-agent', 'src/config/model-preset-registry.ts');
const { Settings } = await load('@gajae-code/coding-agent', 'src/config/settings.ts');
const { withFileLock } = await load('@gajae-code/coding-agent', 'src/config/file-lock.ts');
const { AuthStorage } = await load('@gajae-code/ai', 'src/auth-storage.ts');
const { SessionManager } = await load('@gajae-code/coding-agent', 'src/session/session-manager.ts');
const { SessionDisposalIncompleteError } = await load('@gajae-code/coding-agent', 'src/session/agent-session.ts');
const { AssistantMessageEventStream, runAppStreamProducer, getAppStreamProducer, adoptAppStreamProducer } = await load('@gajae-code/ai', 'src/utils/event-stream.ts');
const { streamPiNative } = await load('@gajae-code/ai', 'src/providers/pi-native-client.ts');
const { streamFromLazyImport, streamSimple } = await load('@gajae-code/ai', 'src/stream.ts');
const builtins = await load('@gajae-code/ai', 'src/providers/register-builtins.ts');
const { iterateWithIdleTimeout } = await load('@gajae-code/ai', 'src/utils/idle-iterator.ts');
const { AppSdkHostOwner } = await load('@gajae-code/coding-agent', 'src/sdk/host/host.ts');
const { SessionSdkSessionRuntime, createSdkSessionRuntimeExtension } = await load('@gajae-code/coding-agent', 'src/sdk/host/session-runtime.ts');
const { createSdkWebSocketTransport } = await load('@gajae-code/coding-agent', 'src/sdk/host/websocket-transport.ts');
const { PromptDeadlineManager } = await load('@gajae-code/coding-agent', 'src/sdk/prompt-deadline-manager.ts');
const { Broker } = await load('@gajae-code/coding-agent', 'src/sdk/broker/broker.ts');
const { createReconciliationStore } = await load('@gajae-code/coding-agent', 'src/sdk/reconciliation-extensions.ts');
const { registerCustomApi, unregisterCustomApis } = await load('@gajae-code/ai', 'src/api-registry.ts');
const { z } = await load('zod', 'index.js');

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const model = { id: 'offline', provider: 'lifecycle-offline', api: 'lifecycle-offline',
  name: 'Offline lifecycle fixture', baseUrl: 'http://127.0.0.1:1', reasoning: false,
  input: ['text'], contextWindow: 100000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function answer(content: unknown[] = [{ type: 'text', text: 'settled' }], stopReason = 'stop') {
  return { ...model, role: 'assistant', model: model.id, content, stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function stream(message = answer()) {
  const result = new AssistantMessageEventStream();
  result.push({ type: 'done', reason: message.stopReason, message }); result.end(message); return result;
}
async function stillPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
}

async function sessionFixture(prewarm?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> },
  persistence?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; error?: Error }) {
  const root = await mkdtemp(join(tmpdir(), 'gjc-lifecycle-contract-'));
  const cwd = join(root, 'project'); const agentDir = join(root, 'agent'); await mkdir(cwd);
  const authStorage = await discoverAuthStorage(agentDir);
  const rawSettings = await Settings.loadForScope({ cwd, agentDir });
  // Public injected Settings facade: no private fields, timer replacement, or
  // SDK command patch. Its held promise delegates to actual flushOrThrow.
  const settings = persistence ? new Proxy(rawSettings, { get(target, property) {
    if (property === 'flushOrThrow') return async () => {
      persistence.entered.resolve(); await persistence.release.promise;
      if (persistence.error) throw persistence.error;
      return target.flushOrThrow();
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) : rawSettings;
  settings.override('memory.enabled', false); settings.override('skills.enabled', false);
  settings.override('startup.networkPrewarm', false);
  settings.override('providers.openaiWebsockets', prewarm ? 'on' : 'off');
  class HeldRegistry extends ModelRegistry {
    async getApiKey(...args: unknown[]) {
      if (!prewarm || args.length > 2) return super.getApiKey(...args);
      prewarm.entered.resolve(); await prewarm.release.promise; return undefined;
    }
  }
  const registry = new HeldRegistry(authStorage, join(agentDir, 'models.yml'), settings, { agentDir });
  registry.registerProvider(model.provider, { api: prewarm ? 'openai-codex-responses' : model.api,
    apiKey: 'offline-unused-key', baseUrl: model.baseUrl,
    models: [{ id: model.id, name: model.name, reasoning: false, input: model.input,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost }] });
  const { session } = await createAgentSession({
    cwd, agentDir, settings, authStorage, modelRegistry: registry,
    agentId: `fixture-${root.split('-').at(-1)}`,
    model: registry.find(model.provider, model.id), sessionManager: SessionManager.create(cwd, join(root, 'sessions')),
    toolNames: ['bash'], spawns: 'deny', enableMcpAutoload: false, enableLsp: false,
    skipPythonPreflight: true, disableExtensionDiscovery: true,
    skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
  });
  session.setDisposeTimeoutForTests(25);
  return { session, registry, settings, async close(expectedRegistryFailure = false) {
    await session.awaitDisposeCompletion().catch(() => {});
    if (expectedRegistryFailure) await registry.dispose().catch(() => {});
    else await registry.dispose();
    authStorage.close(); await settings.close();
    await rm(root, { recursive: true, force: true });
  } };
}

test('physical ledger retains quarantined and late failed-lease promises without changing logical abort proof', async () => {
  assert.equal(lifecycle.GJC_APP_LIFECYCLE_PATCH, 'gjc-sdk-lifecycle-v1');
  const ledger = lifecycle.createRunResourceLedger(); const owner = ledger.open('r');
  const lease = ledger.reserveProducer('r', owner, 'tool', 'fixture'); assert.ok(lease.ok);
  const first = deferred(); const late = deferred();
  lease.lease.track('tool', 'first', first.promise);
  ledger.quarantine('r');
  assert.equal(lease.lease.track('tool', 'late', late.promise), false);
  lease.lease.closeDiscovery();
  const joined = lifecycle.awaitPhysicalRunResources(ledger);
  await stillPending(joined); first.resolve(); await stillPending(joined);
  late.resolve(); await joined;
  assert.equal((await ledger.waitForSettlement('r', { graceMs: 0 })).status, 'unfenced');
  assert.equal(ledger.open('new-root'), undefined);
});

for (const fails of [false, true]) {
  test(`borrowed Settings flush is retained after tool cleanup and ${fails ? 'propagates failure' : 'persists actual writes'}`, async () => {
    const entered = deferred(); const release = deferred();
    const f = await sessionFixture(undefined, { entered, release, ...(fails ? { error: new Error('held persistence failure') } : {}) });
    try {
      let toolClosed = false;
      f.session.registerToolSessionCleanup(() => { toolClosed = true; f.settings.set('defaultThinkingLevel', 'high'); });
      const joined = f.session.awaitDisposeCompletion();
      void joined.catch(() => {});
      await entered.promise;
      assert.equal(toolClosed, true);
      await assert.rejects(f.session.dispose(), (error: unknown) => error instanceof SessionDisposalIncompleteError);
      await stillPending(joined);
      release.resolve();
      if (fails) await assert.rejects(joined, /borrowed settings persistence/);
      else {
        await joined;
        assert.ok(f.settings.getStorage(), 'borrowed storage was flushed, not closed');
        const reloaded = await Settings.loadForScope({ cwd: f.settings.getCwd(), agentDir: f.settings.getAgentDir() });
        try { assert.equal(reloaded.get('defaultThinkingLevel'), 'high'); }
        finally { await reloaded.close(); }
      }
    } finally { release.resolve(); await f.close(); }
  });
}

test('registry catalog listener ownership includes its borrowed settings persistence', async () => {
  const entered = deferred(); const release = deferred();
  const f = await sessionFixture(undefined, { entered, release });
  try {
    f.registry.onCatalogChanged(() => { f.settings.set('defaultThinkingLevel', 'medium'); });
    f.registry.registerProvider('settings-catalog-contract', { api: model.api, apiKey: 'offline', baseUrl: model.baseUrl,
      models: [{ id: 'other', name: 'Other', input: ['text'], reasoning: false,
        contextWindow: 10000, maxTokens: 1000, cost: model.cost }] });
    await entered.promise;
    f.registry.setAppLifecycleAdmission(true);
    const joined = f.registry.awaitAppLifecycleSettlement();
    assert.ok(f.registry.getAppLifecycleActivity().settling > 0);
    await stillPending(joined); release.resolve(); await joined;
    assert.equal(f.registry.getAppLifecycleActivity().settling, 0);
  } finally { release.resolve(); await f.close(); }
});

test('failed registry-owned settings persistence remains incomplete after its promise settles', async () => {
  const entered = deferred(); const release = deferred();
  const f = await sessionFixture(undefined, { entered, release, error: new Error('registry persistence failure') });
  try {
    f.registry.onCatalogChanged(() => { f.settings.set('defaultThinkingLevel', 'medium'); });
    f.registry.registerProvider('failed-settings-contract', { api: model.api, apiKey: 'offline', baseUrl: model.baseUrl,
      models: [{ id: 'other', name: 'Other', input: ['text'], reasoning: false,
        contextWindow: 10000, maxTokens: 1000, cost: model.cost }] });
    await entered.promise;
    f.registry.setAppLifecycleAdmission(true);
    const joined = f.registry.awaitAppLifecycleSettlement(); release.resolve();
    await assert.rejects(joined, /persistence is unconfirmed/);
    const result = f.registry.getAppLifecycleActivity();
    assert.equal(result.complete, false);
    assert.ok(result.unknown.includes('model_registry_settings_unconfirmed'));
    assert.deepEqual(f.registry.getAppLifecycleActivity(), result, 'observation cannot clear persistence failure');
  } finally { release.resolve(); await f.close(true); }
});

test('physical join retains a provider factory after forceAbort logically releases waitForIdle', async () => {
  const entered = deferred(); const released = deferred<unknown>();
  const agent = new Agent({ initialState: { model }, getApiKey: async () => 'offline',
    streamFn: async () => { entered.resolve(); return released.promise; } });
  const prompt = agent.prompt('offline');
  try {
    await entered.promise; assert.equal(agent.forceAbort(), true); await agent.waitForIdle();
    const joined = lifecycle.awaitPhysicalRunResources(agent.resourceLedger);
    await stillPending(joined);
    released.resolve(stream()); await prompt; await joined;
    await assert.rejects(agent.prompt('after terminal close'), /ownership|domain/i);
  } finally { released.resolve(stream()); await prompt; }
});

test('physical join retains an abort-ignoring tool after logical terminal publication', async () => {
  const entered = deferred(); const released = deferred();
  const agent = new Agent({ initialState: { model, tools: [{ name: 'lifecycle_hold', label: 'Hold', description: 'Test only',
    parameters: z.object({}), execute: async () => { entered.resolve(); await released.promise; return { content: [{ type: 'text', text: 'done' }] }; } }] },
    getApiKey: async () => 'offline', streamFn: () => stream(answer([{ type: 'toolCall', id: 'held', name: 'lifecycle_hold', arguments: {} }], 'toolUse')) });
  const prompt = agent.prompt('offline');
  try {
    await entered.promise; agent.forceAbort(); await agent.waitForIdle();
    const joined = lifecycle.awaitPhysicalRunResources(agent.resourceLedger);
    await stillPending(joined); released.resolve(); await prompt; await joined;
  } finally { released.resolve(); await prompt; }
});

test('first-call awaitDisposeCompletion joins abandoned post-prompt tasks while dispose remains bounded', async () => {
  const f = await sessionFixture(); const released = deferred();
  try {
    f.session.trackPostPromptTaskForTests(released.promise);
    await f.session.abort({ timeoutMs: 5 });
    assert.equal(f.session.hasPostPromptWork, false, 'logical recovery behavior is preserved');
    const joined = f.session.awaitDisposeCompletion();
    assert.equal(f.session.awaitDisposeCompletion(), joined, 'same retained owner, no new deadline');
    await assert.rejects(f.session.dispose(), (error: unknown) => error instanceof SessionDisposalIncompleteError);
    await stillPending(joined); released.resolve(); await joined;
  } finally { released.resolve(); await f.close(); }
});

test('normal disposal owns Codex credential/prewarm before resource cleanup without disabling WebSockets', async () => {
  const entered = deferred(); const release = deferred();
  const f = await sessionFixture({ entered, release });
  let resourcesClosed = false;
  try {
    await entered.promise;
    assert.equal(f.session.agent.preferWebsockets, true);
    f.session.registerToolSessionCleanup(() => { resourcesClosed = true; });
    const joined = f.session.awaitDisposeCompletion();
    await assert.rejects(f.session.dispose(), (error: unknown) => error instanceof SessionDisposalIncompleteError);
    assert.equal(resourcesClosed, false); await stillPending(joined);
    release.resolve(); await joined; assert.equal(resourcesClosed, true);
  } finally { release.resolve(); await f.close(); }
});

test('physical owners are session-scoped and real cleanup failures still reject the public retained join', async () => {
  const a = await sessionFixture(); const b = await sessionFixture(); const released = deferred();
  try {
    a.session.trackPostPromptTaskForTests(released.promise);
    await a.session.abort({ timeoutMs: 5 });
    const pending = a.session.awaitDisposeCompletion();
    b.session.registerToolSessionCleanup(() => { throw new Error('cleanup failure fixture'); });
    await assert.rejects(b.session.awaitDisposeCompletion(), /disposal|cleanup/i);
    await stillPending(pending); released.resolve(); await pending;
  } finally { released.resolve(); await a.close(); await b.close(); }
});

test('a real SDK prompt and its normal event/continuation cleanup reach physical settlement', async () => {
  const f = await sessionFixture(); const source = 'app-lifecycle-real-prompt';
  registerCustomApi(model.api, () => stream(), source);
  try {
    await f.session.prompt('offline normal turn');
    await f.session.awaitDisposeCompletion();
    assert.equal(f.session.isDisposed, true);
  } finally { unregisterCustomApis(source); await f.close(); }
});

test('standalone loop physical retention does not add a logical settlement self-dependency', async () => {
  const ledger = lifecycle.createRunResourceLedger();
  const events = agentLoop([{ role: 'user', content: 'offline', timestamp: Date.now() }],
    { systemPrompt: [], messages: [], tools: [] },
    { model, convertToLlm: (messages: unknown[]) => messages, getApiKey: async () => 'offline',
      resourceLedger: ledger, resourceRunId: 'standalone' }, undefined, () => stream());
  for await (const event of events) {
    if (event.type === 'agent_end') {
      assert.equal(ledger.pending('standalone').some((entry: { label: string }) => entry.label === 'agent-loop-body'), false);
      assert.equal((await ledger.waitForSettlement('standalone', { graceMs: 100 })).status, 'settled');
    }
  }
  await lifecycle.awaitPhysicalRunResources(ledger);
});

test('registry maintenance fence defers recurring refresh without aborting its accepted flight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-registry-maintenance-'));
  const entered = deferred(); const release = deferred();
  let calls = 0; let signal: AbortSignal | undefined;
  const control = refreshModelPresetRegistryInBackground({ agentDir: root, startupDelayMs: 0,
    refreshIntervalMs: 20, timeoutMs: 1000, manifestUrl: 'https://registry-lifecycle.invalid/manifest.json',
    fetch: async (_url: unknown, options: { signal?: AbortSignal }) => {
      calls++; signal = options.signal; entered.resolve(); await release.promise;
      return new Response('unavailable', { status: 503 });
    } });
  try {
    await entered.promise;
    control.setAdmissionFence(true);
    const pending = control.getActivity();
    assert.equal(pending.fenced, true); assert.ok(pending.pending > 0);
    assert.equal(signal?.aborted, false, 'a fence is not cancellation');
    const joined = control.awaitSettlement(); await stillPending(joined);
    release.resolve(); await joined;
    const idle = control.getActivity();
    assert.equal(idle.pending, 0); assert.equal(idle.scheduled, false); assert.equal(idle.deferred, true);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(calls, 1, 'periodic work stays deferred while fenced');
    assert.deepEqual(control.getActivity(), idle, 'reads do not invalidate their own revision');
    control.setAdmissionFence(false);
    assert.equal(control.getActivity().scheduled, true, 'normal scheduling resumes without disabling automaticRefresh');
  } finally { release.resolve(); await control(); await rm(root, { recursive: true, force: true }); }
});

test('registry publication queued before a fence remains owned, while new publication waits for reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-registry-publication-'));
  const entered = deferred(); const release = deferred(); let calls = 0;
  const control = refreshModelPresetRegistryInBackground({ agentDir: root, startupDelayMs: 60_000 },
    async () => { calls++; entered.resolve(); await release.promise; });
  try {
    control.setAdmissionFence(true);
    // A public control mutation in an isolated fixture creates a real registry
    // notification. No installed config or production feature is disabled.
    await setModelPresetRegistryDisabled({ agentDir: root, disabled: true });
    assert.equal(calls, 0); assert.equal(control.getActivity().deferred, true);
    control.setAdmissionFence(false); // admits a publication microtask
    control.setAdmissionFence(true); // cannot discard that accepted task
    await entered.promise;
    const joined = control.awaitSettlement(); await stillPending(joined);
    assert.ok(control.getActivity().pending > 0);
    release.resolve(); await joined;
    assert.equal(calls, 1); assert.equal(control.getActivity().pending, 0);
  } finally { release.resolve(); await control(); await rm(root, { recursive: true, force: true }); }
});

test('borrowed registry activity is independent from session disposal and joins accepted catalog callbacks', async () => {
  const f = await sessionFixture(); const release = deferred(); const entered = deferred();
  try {
    const initial = f.registry.getAppLifecycleActivity();
    assert.equal(initial.complete, false); assert.ok(initial.unknown.includes('model_registry_admission_open'));
    f.registry.onCatalogChanged(async () => { entered.resolve(); await release.promise; });
    f.registry.registerProvider('catalog-change-contract', { api: model.api, apiKey: 'offline', baseUrl: model.baseUrl,
      models: [{ id: 'other', name: 'Other', input: ['text'], reasoning: false,
        contextWindow: 10000, maxTokens: 1000, cost: model.cost }] });
    await entered.promise;
    f.registry.setAppLifecycleAdmission(true);
    const pending = f.registry.getAppLifecycleActivity();
    assert.ok(pending.settling > 0);
    const joined = f.registry.awaitAppLifecycleSettlement(); await stillPending(joined);
    // Foreground refresh can be an already accepted OAuth/run continuation.
    // Top-level app admission owns new callers; the maintenance fence must
    // not abort an accepted continuation just because it reaches refresh later.
    await f.registry.refreshStatic();
    release.resolve(); await joined;
    const idle = f.registry.getAppLifecycleActivity();
    assert.equal(idle.complete, true);
    assert.equal(idle.starting + idle.queued + idle.running + idle.settling, 0);
    assert.deepEqual(f.registry.getAppLifecycleActivity(), idle);
    f.registry.refreshInBackground('online-if-uncached');
    assert.notEqual(f.registry.getAppLifecycleActivity().generation, idle.generation);
    assert.equal(f.registry.getAppLifecycleActivity().running, 0, 'new maintenance is deferred');
    await f.session.awaitDisposeCompletion();
    assert.equal(f.registry.getAppLifecycleActivity().complete, true, 'borrowed registry is still an independent live owner');
  } finally { release.resolve(); await f.close(); }
});

test('opaque provider tail stays explicitly unknown after its iterator and result have settled', async () => {
  const released = deferred(); let tailSettled = false;
  let tail: Promise<void> | undefined;
  const agent = new Agent({ initialState: { model }, getApiKey: async () => 'offline', streamFn: () => {
    const output = new AssistantMessageEventStream();
    tail = (async () => {
      const message = answer();
      output.push({ type: 'done', reason: 'stop', message }); output.end(message);
      await released.promise; tailSettled = true;
    })();
    return output;
  } });
  try {
    await agent.prompt('offline');
    await lifecycle.awaitPhysicalRunResources(agent.resourceLedger);
    assert.ok(tail, 'the held task was started by the actual provider factory');
    assert.equal(tailSettled, false, 'stream result/iterator completion is not an all-provider producer-lifetime API');
    const activity = lifecycle.getPhysicalRunResourceActivity(agent.resourceLedger);
    assert.equal(activity.complete, false);
    assert.deepEqual(activity.unknown, ['sdk_provider_producer_unrepresented']);
    released.resolve(); await tail;
    assert.equal(lifecycle.getPhysicalRunResourceActivity(agent.resourceLedger).complete, false, 'unrepresented work cannot clear itself');
  } finally { released.resolve(); await tail; }
});

for (const fails of [false, true]) {
  test(`registered producer retains an early terminal through actual ${fails ? 'rejecting' : 'successful'} finally`, async () => {
    const entered = deferred(); const release = deferred(); let finalized = false;
    const events = new AssistantMessageEventStream();
    runAppStreamProducer(events, async () => {
      assert.ok(getAppStreamProducer(events), 'reserved before invoking producer');
      try {
        const message = answer(); events.push({ type: 'done', reason: 'stop', message });
        if (fails) throw new Error('ordinary producer failure');
      } finally { entered.resolve(); await release.promise; finalized = true; }
    });
    await entered.promise;
    assert.equal((await events.result()).stopReason, 'stop');
    const agent = new Agent({ initialState: { model }, getApiKey: async () => 'offline', streamFn: () => events });
    try {
      await agent.prompt('offline');
      const joined = lifecycle.awaitPhysicalRunResources(agent.resourceLedger);
      await stillPending(joined); assert.equal(finalized, false);
      assert.ok(lifecycle.getPhysicalRunResourceActivity(agent.resourceLedger).running > 0);
      release.resolve(); await joined;
      assert.equal(finalized, true);
      assert.equal(lifecycle.getPhysicalRunResourceActivity(agent.resourceLedger).complete, true);
    } finally { release.resolve(); await getAppStreamProducer(events).completion; }
  });
}

test('structurally forged completion and a terminal-only class instance confer no producer authority', () => {
  const events = stream();
  events.getAppStreamProducer = () => ({ completion: Promise.resolve(), getUnknown: () => [] });
  events.producerCompletion = Promise.resolve();
  assert.equal(getAppStreamProducer(events), undefined);
  assert.equal(getAppStreamProducer({ completion: Promise.resolve() }), undefined);
});

test('wrapper completion joins nested producers and preserves missing child coverage', async () => {
  const release = deferred(); const inner = new AssistantMessageEventStream(); const outer = new AssistantMessageEventStream();
  runAppStreamProducer(inner, async () => { try { inner.end(answer()); } finally { await release.promise; } });
  runAppStreamProducer(outer, async () => {
    adoptAppStreamProducer(outer, inner);
    adoptAppStreamProducer(outer, stream());
    outer.end(answer());
  });
  try {
    await outer.result(); await stillPending(getAppStreamProducer(outer).completion);
    release.resolve(); await getAppStreamProducer(outer).completion;
    assert.deepEqual(getAppStreamProducer(outer).getUnknown(), ['sdk_provider_producer_unrepresented']);
  } finally { release.resolve(); }
});

// An actual built-in transport publishes the terminal event before draining the
// response body. The injected fetch never makes a network request.
function heldNativeTransport() {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const transportModel = { ...model, transport: 'pi-native' };
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }),
    { headers: { 'content-type': 'text/event-stream' } });
  const make = () => streamPiNative(transportModel, { messages: [] }, { fetch: async () => response });
  body.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'done', reason: 'stop', message: answer() })}\n\n`));
  return { make, release: () => body.close() };
}

test('real pi-native built-in retains terminal-before-EOF through core physical join', async () => {
  const transport = heldNativeTransport(); const events = transport.make();
  const agent = new Agent({ initialState: { model }, getApiKey: async () => 'offline', streamFn: () => events });
  try {
    await events.result(); await agent.prompt('offline');
    const joined = lifecycle.awaitPhysicalRunResources(agent.resourceLedger);
    await stillPending(joined); transport.release(); await joined;
    assert.equal(lifecycle.getPhysicalRunResourceActivity(agent.resourceLedger).complete, true);
  } finally { if (lifecycle.getPhysicalRunResourceActivity(agent.resourceLedger).running) transport.release(); }
});

test('real built-in producer survives lazy import and a real SDK session disposal deadline', async () => {
  const f = await sessionFixture(); const transport = heldNativeTransport(); const source = 'app-physical-native';
  registerCustomApi(model.api, () => streamFromLazyImport(async () => transport.make()), source);
  let released = false;
  try {
    await f.session.prompt('offline terminal-before-tail');
    const joined = f.session.awaitDisposeCompletion();
    await assert.rejects(f.session.dispose(), (error: unknown) => error instanceof SessionDisposalIncompleteError);
    await stillPending(joined);
    assert.ok(f.session.getAppLifecycleActivity().running > 0);
    transport.release(); released = true; await joined;
    const activity = f.session.getAppLifecycleActivity();
    assert.equal(activity.running + activity.starting + activity.settling, 0);
    assert.equal(activity.unknown.includes('sdk_provider_producer_unrepresented'), false);
    assert.deepEqual(activity.unknown, []);
    assert.equal(activity.complete, true, 'the enabled default host and built-in producer now have physical owners');
  } finally { if (!released) transport.release(); unregisterCustomApis(source); await f.close(); }
});

test('normal built-in lazy dispatch exposes a retained completion without provider requests', async () => {
  const events = builtins.streamOllama({ ...model, provider: 'ollama', api: 'ollama-chat' }, { messages: [] }, {
    fetch: async () => new Response('{"message":{"role":"assistant","content":"offline"},"done":true}\n'),
  });
  for await (const _event of events) { /* exercise the wrapper consumer */ }
  const owner = getAppStreamProducer(events); assert.ok(owner);
  await owner.completion; assert.deepEqual(owner.getUnknown(), []);
});

test('forceAbort cannot discharge a late factory response with a real built-in producer tail', async () => {
  const transport = heldNativeTransport(); const events = transport.make();
  const entered = deferred(); const factory = deferred(); let released = false;
  const agent = new Agent({ initialState: { model }, getApiKey: async () => 'offline', streamFn: async () => {
    entered.resolve(); await factory.promise; return events;
  } });
  const prompt = agent.prompt('offline late factory');
  try {
    await entered.promise; agent.forceAbort(); await agent.waitForIdle();
    const joined = lifecycle.awaitPhysicalRunResources(agent.resourceLedger);
    await stillPending(joined); factory.resolve(); await prompt;
    await stillPending(joined); transport.release(); released = true; await joined;
    assert.equal(lifecycle.getPhysicalRunResourceActivity(agent.resourceLedger).complete, true);
  } finally { factory.resolve(); if (!released) transport.release(); await prompt; }
});

test('failed SDK factory joins its already-started workspace discovery before rejecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-factory-discovery-'));
  const cwd = join(root, 'project'); const agentDir = join(root, 'agent'); await mkdir(cwd);
  const authStorage = await discoverAuthStorage(agentDir);
  const settings = await Settings.loadForScope({ cwd, agentDir });
  settings.override('workspaceTree.mode', 'eager'); settings.override('startup.networkPrewarm', false);
  const registry = new ModelRegistry(authStorage, join(agentDir, 'models.yml'), settings, { agentDir });
  const entered = deferred(); const failReached = deferred(); const release = deferred(); let started = false;
  const facade = new Proxy(settings, { get(target, property) {
    if (property === 'get') return (key: string) => {
      if (started && key === 'providers.webSearch') { failReached.resolve(); throw new Error('offline creation failure after discovery'); }
      return target.get(key);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const pending = createAgentSession({ cwd, agentDir, settings: facade, authStorage, modelRegistry: registry,
    contextFiles: [], promptTemplates: [], slashCommands: [],
    runtimeServices: { workspaceTree: { get: async () => {
      started = true; entered.resolve(); await release.promise;
      return { snapshot: { rootPath: cwd, rendered: '', truncated: false, totalLines: 0, agentsMdFiles: [] } };
    } } },
  });
  void pending.catch(() => {});
  try {
    await entered.promise; await failReached.promise; await stillPending(pending);
    release.resolve(); await assert.rejects(pending, /offline creation failure after discovery/);
  } finally {
    release.resolve(); await pending.catch(() => {}); await registry.dispose(); authStorage.close(); await settings.close();
    await rm(root, { recursive: true, force: true });
  }
});

function memorySdkTransport(send: () => Promise<void> = async () => {}) {
  let handler: ((id: string, frame: Record<string, unknown>) => void) | undefined;
  return {
    sessionId: 'physical-host', stateRoot: '/tmp/unused-physical-host', token: 'offline-only',
    onFrame(next: typeof handler) { handler = next; return () => { handler = undefined; }; },
    sendFrame: send, start: async () => ({ url: 'ws://127.0.0.1:1' }), stop: async () => {},
    awaitAppLifecycleSettlement: async () => {},
    feed(frame: Record<string, unknown>) { handler?.('local-fixture', frame); },
  };
}

test('host physical owner keeps dispatched control, response delivery and its callback after logical stop', async () => {
  const work = deferred(); const workEntered = deferred(); const write = deferred(); const writeEntered = deferred();
  const publication = deferred(); const publicationEntered = deferred();
  const transport = memorySdkTransport(async () => { writeEntered.resolve(); await write.promise; });
  const runtime = new SessionSdkSessionRuntime({ transport,
    control: async () => { workEntered.resolve(); await work.promise; return { ok: true }; },
    onControlResponseDelivery: async () => { publicationEntered.resolve(); await publication.promise; },
  });
  try {
    await runtime.start(); transport.feed({ type: 'control_request', id: 'held-control', operation: 'fixture' });
    await workEntered.promise; await runtime.stop();
    const joined = runtime.awaitAppLifecycleSettlement(); await stillPending(joined);
    work.resolve(); await writeEntered.promise; await stillPending(joined);
    write.resolve(); await publicationEntered.promise; await stillPending(joined);
    publication.resolve(); await joined;
    assert.equal(runtime.appLifecycleOwner.getAppLifecycleActivity().running, 0);
  } finally { work.resolve(); write.resolve(); publication.resolve(); await runtime.stop(); await runtime.awaitAppLifecycleSettlement(); }
});

test('host directed deliveries are session-local and cannot escape through sendFrameTo', async () => {
  const release = deferred(); const entered = deferred();
  const a = new SessionSdkSessionRuntime({ transport: memorySdkTransport(async () => { entered.resolve(); await release.promise; }) });
  const b = new SessionSdkSessionRuntime({ transport: memorySdkTransport() });
  try {
    await a.start(); await b.start(); a.sendFrameTo(['fixture'], { type: 'message_update' }); await entered.promise;
    await a.stop(); await b.stop(); await b.awaitAppLifecycleSettlement();
    const joined = a.awaitAppLifecycleSettlement(); await stillPending(joined);
    release.resolve(); await joined;
  } finally { release.resolve(); await a.stop(); await b.stop(); await a.awaitAppLifecycleSettlement(); }
});

for (const fails of [false, true]) {
  test(`real WebSocket transport retains its 250ms shutdown loser through ${fails ? 'late rejection' : 'completion'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'gjc-owned-websocket-'));
    const release = deferred(); const entered = deferred(); let actualServer: ReturnType<typeof Bun.serve> | undefined;
    const transport = await createSdkWebSocketTransport({ sessionId: 'held-stop', stateRoot: root, token: 'offline-only',
      serve(options: Parameters<typeof Bun.serve>[0]) {
        const server = Bun.serve(options); actualServer = server;
        return new Proxy(server, { get(target, property) {
          if (property === 'stop') return async () => {
            entered.resolve(); await release.promise; await target.stop(true);
            if (fails) throw new Error('late physical server stop failure');
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
    });
    try {
      const endpoint = await transport.start(); assert.match(endpoint.url, /^ws:\/\/127\.0\.0\.1:/);
      const stopped = transport.stop(); await entered.promise; await stopped;
      const joined = transport.awaitAppLifecycleSettlement(); void joined.catch(() => {});
      await stillPending(joined); release.resolve();
      if (fails) await assert.rejects(joined, /late physical server stop failure/);
      else await joined;
      await assert.rejects(stat(join(root, 'sdk/held-stop.json')), { code: 'ENOENT' });
    } finally { release.resolve(); await transport.stop().catch(() => {}); await actualServer?.stop(true); await rm(root, { recursive: true, force: true }); }
  });
}

test('deadline logical clear does not discharge an in-flight reconciliation write', async () => {
  const entered = deferred(); const release = deferred(); const owner = new AppSdkHostOwner();
  const manager = new PromptDeadlineManager({ appLifecycleOwner: owner, getLeaseMs: () => 1, getMaxMs: () => 1,
    reconciliation: { lookup: () => ({ status: 'accepted' }),
      claimPendingOutcome: async () => { entered.resolve(); await release.promise; }, finalizeOutcome: async () => {},
    },
  });
  try {
    manager.onAccepted({ commandId: 'physical-deadline', turnId: 'one' }); await entered.promise;
    manager.clearAll(); const joined = owner.awaitAppLifecycleSettlement(); await stillPending(joined);
    release.resolve(); await joined;
    const activity = owner.getAppLifecycleActivity(); assert.equal(activity.queued + activity.running, 0);
  } finally { manager.clearAll(); release.resolve(); await owner.awaitAppLifecycleSettlement(); }
});

test('retired-owner timer cancellation releases only the future callback, not accepted async work', async () => {
  const owner = new AppSdkHostOwner(); const entered = deferred(); const release = deferred();
  let dispatched = false;
  const future = owner.schedule(() => { dispatched = true; }, 60_000);
  const active = owner.schedule(async () => { entered.resolve(); await release.promise; }, 0);
  try {
    await entered.promise; owner.cancelTimer(future); owner.cancelTimer(active);
    const joined = owner.awaitAppLifecycleSettlement(); await stillPending(joined);
    assert.equal(dispatched, false); release.resolve(); await joined;
    assert.equal(owner.getAppLifecycleActivity().running, 0);
  } finally { owner.cancelTimer(future); release.resolve(); }
});

test('actual hosted lifecycle drain retains retired-owner timers and persistence after bounded shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-host-retired-'));
  const broker = new Broker({ agentDir: root });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const submitted = deferred(); const accepted = deferred(); const writeEntered = deferred(); const writeRelease = deferred();
  const drainTimeout = deferred(); let holdWrites = false; let owner!: InstanceType<typeof AppSdkHostOwner>;
  const transport = memorySdkTransport();
  const store = createReconciliationStore({ sessionFile: join(root, 'session.jsonl'), sessionId: transport.sessionId });
  const heldStore = new Proxy(store, { get(target, property) {
    if (property === 'transact') return async (...args: unknown[]) => {
      if (holdWrites) { writeEntered.resolve(); await writeRelease.promise; }
      return target.transact(...args);
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  createSdkSessionRuntimeExtension({
    on(name: string, callback: (event: unknown, ctx: unknown) => Promise<void>) { handlers.set(name, callback); },
    sendUserMessage: async (_text: unknown, options: { onPreflightAcceptCommit?: () => Promise<void> }) => {
      await options.onPreflightAcceptCommit?.(); accepted.resolve(); await submitted.promise; return 'finished';
    },
  }, { agentDir: root, createTransport: async () => transport, registerAppLifecycleOwner: (value: typeof owner) => { owner = value; },
    onLifecycleDrainTimeoutForTests: () => drainTimeout.resolve(),
    terminalAbortSeams: { getReconciliationStore: () => heldStore },
  });
  const ctx = { cwd: root, sdkBindings: () => [], isIdle: () => true, abort: () => {},
    sessionManager: { getSessionId: () => transport.sessionId, getSessionFile: () => join(root, 'session.jsonl'),
      getSessionName: () => undefined, getBranch: () => [] },
  };
  let end: Promise<void> | undefined;
  try {
    await broker.start(); await handlers.get('session_start')!({}, ctx);
    transport.feed({ type: 'control_request', id: 'accepted-physical', operation: 'turn.prompt', input: { text: 'offline' } });
    await accepted.promise; await handlers.get('agent_start')!({ type: 'agent_start' }, ctx);
    holdWrites = true;
    end = handlers.get('agent_end')!({ type: 'agent_end', messages: [], stopReason: 'stop' }, ctx);
    await writeEntered.promise;
    const shutdown = handlers.get('session_shutdown')!({}, ctx);
    await drainTimeout.promise; await shutdown;
    assert.ok(owner.getAppLifecycleActivity().queued > 0, 'the actual retired owner cleanup timer is reserved');
    const joined = owner.awaitAppLifecycleSettlement(); await stillPending(joined);
    holdWrites = false; writeRelease.resolve(); await end; await stillPending(joined);
    submitted.resolve(); await joined;
    const activity = owner.getAppLifecycleActivity(); assert.equal(activity.running + activity.queued, 0);
    assert.deepEqual(activity.unknown, []);
  } finally {
    holdWrites = false; writeRelease.resolve(); submitted.resolve(); await end;
    await handlers.get('session_shutdown')?.({}, ctx); await owner?.awaitAppLifecycleSettlement();
    await broker.stop(); await rm(root, { recursive: true, force: true });
  }
});

test('a real SDK session with its default WebSocket host actively enabled reaches physical completion', async () => {
  assert.notEqual(process.env.GJC_SDK_DISABLE, '1', 'this test must exercise enabled hosting');
  const f = await sessionFixture(); const source = 'app-host-enabled';
  // Pre-start an in-process broker in this isolated root. ensureBroker can reuse
  // it without spawning or signalling a detached process.
  const broker = new Broker({ agentDir: f.settings.getAgentDir() });
  const endpointFile = join(f.settings.getCwd(), '.gjc/state/sdk', `${f.session.sessionManager.getSessionId()}.json`);
  registerCustomApi(model.api, () => {
    const events = new AssistantMessageEventStream();
    runAppStreamProducer(events, async () => { events.push({ type: 'done', reason: 'stop', message: answer() }); });
    return events;
  }, source);
  try {
    await broker.start(); await f.session.extensionRunner.emit({ type: 'session_start' });
    const endpoint = JSON.parse(await readFile(endpointFile, 'utf8'));
    assert.match(endpoint.url, /^ws:\/\/127\.0\.0\.1:/);
    await f.session.prompt('offline with live default host');
    await f.session.awaitDisposeCompletion();
    await assert.rejects(stat(endpointFile), { code: 'ENOENT' });
    const activity = f.session.getAppLifecycleActivity();
    assert.equal(activity.starting + activity.running + activity.settling, 0);
    assert.equal(activity.complete, true); assert.deepEqual(activity.unknown, []);
  } finally { unregisterCustomApis(source); await f.session.awaitDisposeCompletion().catch(() => {}); await broker.stop(); await f.close(); }
});

for (const cancel of [false, true]) {
  test(`producer owns idle-iterator ${cancel ? 'abort' : 'timeout'} losers through their physical settlement`, async () => {
    const next = deferred<IteratorResult<unknown>>(); const returned = deferred<IteratorResult<unknown>>();
    const started = deferred(); const controller = new AbortController(); const events = new AssistantMessageEventStream();
    runAppStreamProducer(events, async () => {
      try {
        const input = { [Symbol.asyncIterator]() { return {
          next: () => { started.resolve(); return next.promise; }, return: () => returned.promise,
        }; } };
        for await (const _value of iterateWithIdleTimeout(input, {
          idleTimeoutMs: cancel ? 60_000 : 5, abortSignal: controller.signal, errorMessage: 'held iterator',
        })) { /* no value until the held read settles */ }
      } catch { events.push({ type: 'done', reason: 'stop', message: answer() }); }
    });
    try {
      await started.promise; if (cancel) controller.abort();
      await events.result(); const owner = getAppStreamProducer(events);
      await stillPending(owner.completion);
      next.resolve({ done: true, value: undefined }); await stillPending(owner.completion);
      returned.resolve({ done: true, value: undefined }); await owner.completion;
      assert.deepEqual(owner.getUnknown(), []);
    } finally { next.resolve({ done: true, value: undefined }); returned.resolve({ done: true, value: undefined }); }
  });
}

test('auth retry wrapper retains the first attempt tail even when a later attempt is terminal', async () => {
  const release = deferred(); const source = 'app-auth-retry-physical'; let attempts = 0;
  registerCustomApi(model.api, () => {
    const events = new AssistantMessageEventStream(); const first = attempts++ === 0;
    runAppStreamProducer(events, async () => {
      try {
        if (first) {
          const error = { ...answer([], 'error'), errorStatus: 401, errorMessage: 'Unauthorized' };
          events.push({ type: 'error', reason: 'error', error });
        } else events.push({ type: 'done', reason: 'stop', message: answer() });
      } finally { if (first) await release.promise; }
    });
    return events;
  }, source);
  try {
    const events = streamSimple(model, { messages: [] }, { apiKey: 'offline-first', onAuthError: async () => 'offline-second' });
    await events.result(); assert.equal(attempts, 2);
    const owner = getAppStreamProducer(events); assert.ok(owner);
    await stillPending(owner.completion); release.resolve(); await owner.completion;
    assert.deepEqual(owner.getUnknown(), []);
  } finally { release.resolve(); unregisterCustomApis(source); }
});

async function authFixture(options: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gjc-auth-leaf-'));
  const storage = await AuthStorage.create(join(root, 'credentials.db'), { usageProviderResolver: () => undefined, ...options });
  return { storage, async close() {
    await storage.awaitAppLifecycleSettlement(); storage.close(); await rm(root, { recursive: true, force: true });
  } };
}

for (const scoped of [false, true]) {
  test(`AuthStorage ${scoped ? 'scoped' : 'shared'} usage timeout retains its actual loser and admits continuations`, async () => {
    const entered = deferred(); const release = deferred(); let calls = 0;
    const fetchUsage = async () => { calls++; entered.resolve(); await release.promise; return []; };
    const f = await authFixture(scoped ? { fetchUsageReportsForProvider: fetchUsage } : { fetchUsageReports: fetchUsage });
    try {
      const before = f.storage.getAppLifecycleActivity();
      assert.equal(before.complete, true);
      const input = scoped ? { provider: 'openai-codex' } : {};
      const request = f.storage.fetchUsageReports({ ...input, signal: AbortSignal.timeout(10) });
      const timedOut = assert.rejects(request, /usage fetch aborted/);
      await entered.promise; await timedOut;
      const losing = f.storage.getAppLifecycleActivity();
      assert.ok(losing.running > 0); assert.notEqual(losing.generation, before.generation);
      const joined = f.storage.awaitAppLifecycleSettlement(); await stillPending(joined);
      // No leaf fence may reject a dependency of an accepted registry/OAuth root.
      const continuation = f.storage.fetchUsageReports(input);
      if (!scoped) assert.equal(calls, 1, 'the original shared single-flight is retained');
      release.resolve(); await continuation; await joined;
      const idle = f.storage.getAppLifecycleActivity();
      assert.equal(idle.running + idle.settling, 0); assert.equal(idle.complete, true);
      assert.notEqual(idle.generation, losing.generation);
      assert.deepEqual(f.storage.getAppLifecycleActivity(), idle);
    } finally { release.resolve(); await f.close(); }
  });
}

test('AuthStorage OAuth caller cancellation retains the underlying refresh and close does not erase it', async () => {
  const entered = deferred(); const release = deferred();
  const f = await authFixture({ refreshOAuthCredential: async () => {
    entered.resolve(); await release.promise;
    return { access: 'new-offline-access', refresh: 'new-offline-refresh', expires: Date.now() + 3600000 };
  } });
  try {
    await f.storage.set('openai-codex', { type: 'oauth', access: 'offline-access', refresh: 'offline-refresh', expires: 0 });
    const id = f.storage.exportSnapshot().credentials[0].id;
    const controller = new AbortController();
    const request = f.storage.refreshCredentialById(id, controller.signal);
    const cancelled = assert.rejects(request, /abort/);
    await entered.promise; controller.abort(); await cancelled;
    const pending = f.storage.getAppLifecycleActivity(); assert.ok(pending.running > 0);
    const joined = f.storage.awaitAppLifecycleSettlement(); await stillPending(joined);
    f.storage.close();
    assert.ok(f.storage.getAppLifecycleActivity().running > 0, 'close remains synchronous but cannot manufacture idle');
    await stillPending(joined); release.resolve(); await joined;
    assert.equal(f.storage.getAppLifecycleActivity().running, 0);
  } finally { release.resolve(); await f.close(); }
});

test('AuthStorage keeps a per-credential provider task after real caller and provider deadlines fire', async () => {
  const entered = deferred(); const release = deferred(); let providerSignal: AbortSignal | undefined;
  const f = await authFixture({ usageRequestTimeoutMs: 15,
    usageProviderResolver: () => ({ supports: () => true, fetchUsage: async (params: { signal?: AbortSignal }) => {
      providerSignal = params.signal; entered.resolve(); await release.promise; return null;
    } }) });
  try {
    await f.storage.set('leaf-usage-provider', { type: 'api_key', key: 'offline-usage-key' });
    const request = f.storage.fetchUsageReports({ signal: AbortSignal.timeout(10), logDetails: false });
    const timedOut = assert.rejects(request, /usage fetch aborted/);
    await entered.promise; await timedOut;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(providerSignal?.aborted, true);
    assert.ok(f.storage.getAppLifecycleActivity().running > 0);
    const joined = f.storage.awaitAppLifecycleSettlement(); await stillPending(joined);
    release.resolve(); await joined;
    assert.equal(f.storage.getAppLifecycleActivity().running, 0);
  } finally { release.resolve(); await f.close(); }
});

test('AuthStorage reserves ownership before calling a held config-value resolver', async () => {
  const entered = deferred(); const release = deferred();
  let inside = 0;
  const f = await authFixture({ configValueResolver: async () => {
    inside = f.storage.getAppLifecycleActivity().running;
    entered.resolve(); await release.promise; return 'offline-resolved-key';
  } });
  try {
    await f.storage.set('leaf-config-provider', { type: 'api_key', key: '!offline-fixture' });
    const request = f.storage.getApiKey('leaf-config-provider');
    await entered.promise; assert.ok(inside > 0);
    const joined = f.storage.awaitAppLifecycleSettlement(); await stillPending(joined);
    release.resolve(); assert.equal(await request, 'offline-resolved-key'); await joined;
    assert.equal(f.storage.getAppLifecycleActivity().running, 0);
  } finally { release.resolve(); await f.close(); }
});

test('AuthStorage retains credential-disabled callback completion independently of its caller', async () => {
  const entered = deferred(); const release = deferred();
  const f = await authFixture({
    refreshOAuthCredential: async () => { throw new Error('invalid_grant'); },
    onCredentialDisabled: async () => { entered.resolve(); await release.promise; },
  });
  try {
    await f.storage.set('openai-codex', { type: 'oauth', access: 'offline-access', refresh: 'offline-refresh', expires: 0 });
    await f.storage.getApiKey('openai-codex').catch(() => undefined);
    await entered.promise;
    assert.ok(f.storage.getAppLifecycleActivity().settling > 0);
    const joined = f.storage.awaitAppLifecycleSettlement(); await stillPending(joined);
    release.resolve(); await joined;
    assert.equal(f.storage.getAppLifecycleActivity().settling, 0);
  } finally { release.resolve(); await f.close(); }
});

test('Settings leaf counts reserve the real debounce and remain owned behind a real file lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-settings-leaf-'));
  const settings = await Settings.loadForScope({ cwd: root, agentDir: root });
  const locked = deferred(); const release = deferred();
  const lock = withFileLock(join(root, 'config.yml'), async () => { locked.resolve(); await release.promise; });
  try {
    await locked.promise;
    const before = settings.getAppLifecycleActivity();
    settings.set('defaultThinkingLevel', 'high');
    const queued = settings.getAppLifecycleActivity(); assert.ok(queued.queued > 0); assert.ok(queued.running > 0);
    assert.notEqual(queued.generation, before.generation);
    const joined = settings.awaitAppLifecycleSettlement();
    assert.deepEqual(settings.getAppLifecycleActivity(), queued, 'joining does not flush or release the debounce');
    await new Promise<void>((resolve) => setTimeout(resolve, 130));
    assert.ok(settings.getAppLifecycleActivity().running > 0); await stillPending(joined);
    settings.set('defaultThinkingLevel', 'medium');
    assert.ok(settings.getAppLifecycleActivity().running >= 2, 'an older save is not forgotten when savePromise is replaced');
    release.resolve(); await lock; await joined;
    const idle = settings.getAppLifecycleActivity();
    assert.equal(idle.complete, true); assert.equal(idle.queued + idle.running, 0);
    assert.notEqual(idle.generation, queued.generation); assert.deepEqual(settings.getAppLifecycleActivity(), idle);
    const reloaded = await Settings.loadForScope({ cwd: root, agentDir: root });
    try { assert.equal(reloaded.get('defaultThinkingLevel'), 'medium'); }
    finally { await reloaded.close(); }
  } finally { release.resolve(); await lock; await settings.close(); await rm(root, { recursive: true, force: true }); }
});

test('Settings failed background persistence remains unknown after its actual save promise settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-settings-failed-leaf-'));
  const settings = await Settings.loadForScope({ cwd: root, agentDir: root });
  const file = join(root, 'config.yml'); const backup = join(root, 'saved-config.yml');
  let replaced = false;
  try {
    settings.set('defaultThinkingLevel', 'low'); await settings.flushOrThrow(); await settings.awaitAppLifecycleSettlement();
    await rename(file, backup); await mkdir(file); replaced = true;
    settings.set('defaultThinkingLevel', 'high');
    await assert.rejects(settings.awaitAppLifecycleSettlement(), /persistence is unconfirmed/);
    const failed = settings.getAppLifecycleActivity();
    assert.equal(failed.complete, false); assert.ok(failed.unknown.includes('settings_persistence_unconfirmed'));
    assert.deepEqual(settings.getAppLifecycleActivity(), failed, 'reads cannot clear failed persistence');
  } finally {
    if (replaced) { await rm(file, { recursive: true, force: true }); await rename(backup, file); }
    await settings.close().catch(() => {}); await rm(root, { recursive: true, force: true });
  }
});
