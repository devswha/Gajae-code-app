import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';

import { ACP_BUILTIN_SLASH_COMMANDS } from '@gajae-code/coding-agent/slash-commands/acp-builtins';
import { createAgentSession, discoverAuthStorage, type AutomationTools } from '@gajae-code/coding-agent/sdk/session';
import { ModelRegistry } from '@gajae-code/coding-agent/config/model-registry';
import { Settings } from '@gajae-code/coding-agent/config/settings';
import { SessionManager } from '@gajae-code/coding-agent/session/session-manager';
import { SessionDisposalIncompleteError } from '@gajae-code/coding-agent/session/agent-session';
import { AsyncJobManager } from '@gajae-code/coding-agent/async/job-manager';
import { registerCustomApi, unregisterCustomApis } from '@gajae-code/ai/api-registry';
import { AssistantMessageEventStream } from '@gajae-code/ai/utils/event-stream';
import type { AssistantMessage, Context } from '@gajae-code/ai/types';


import {
  GJC_APP_BUILTIN_COMMANDS,
  GJC_APP_BUILTIN_COMMAND_ALIASES,
  GJC_APP_BUILTIN_COMMAND_NAMES,
} from './gjc-command-surface.generated.js';
import {
  GjcBunSdkAdapter,
  createGjcBunSdkAdapter,
  ensureSdkThemeInitialized,
  type GjcAgentSessionFactory,
  type GjcBunSdkAdapterOptions,
} from './gjc-bun-sdk-adapter.js';
import { GjcBunAskController } from './gjc-bun-ask-controller.js';
import {
  GJC_WORKER_PROTOCOL_VERSION,
  parseGjcWorkerFrame,
  type GjcWorkerRequestFrame,
} from './gjc-worker-protocol.js';
import { GjcWorkerHost } from './gjc-worker.js';
import { GJC_MODEL_UNRESOLVED_CODE, GJC_MODEL_UNRESOLVED_MESSAGE } from './gjc-model-resolution.js';
import { GJC_CLEANUP_UNCONFIRMED_CODE } from './gjc-cleanup-error.js';
import { isVerifiedSdkPatch, verifyRuntimeManifest } from './gjc-runtime-manifest.js';

type Listener = (event: unknown) => void;
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type OAuthCallbacks = {
  onAuth(info: { url: string; instructions?: string }): void;
  onProgress?(message: string): void;
  onManualCodeInput?(): Promise<string>;
  onPrompt(prompt: { message: string; placeholder?: string }): Promise<string>;
  signal?: AbortSignal;
};
type OAuthLogin = (provider: string, callbacks: OAuthCallbacks) => Promise<void>;

const globalMethods = new Set([
  'worker.initialize',
  'worker.activity',
  'worker.admission',
  'worker.shutdown',
  'models.catalog',
  'oauth.providers',
  'oauth.status',
  'oauth.start',
  'oauth.submit',
  'oauth.cancel',
]);

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Expected value was not observed.');
}

/**
 * The catalog is generated from the installed runtime, so the thing worth
 * asserting is no longer "does the list match" — the prebuild check enforces
 * that — but that every DIVERGENCE is explained where a reader will find it.
 *
 * An unexplained omission is the dangerous one: a command dropped by accident
 * looks exactly like one excluded on purpose, and the app's fallback for a
 * command it does not know is to forward the raw text to the model as a prompt.
 */
const generatedSurface = await readFile(
  join(process.cwd(), 'server/gjc-command-surface.generated.ts'),
  'utf8',
);

test('every text builtin missing from the catalog is excluded with a written reason', () => {
  const catalog = new Set(GJC_APP_BUILTIN_COMMANDS.map((command) => command.name));
  const header = generatedSurface.slice(0, generatedSurface.indexOf('export type'));

  for (const command of ACP_BUILTIN_SLASH_COMMANDS) {
    if (catalog.has(command.name)) continue;
    assert.match(
      header,
      new RegExp(`^//\\s+${command.name}: \\S.*`, 'm'),
      `${command.name} is absent from the catalog with no recorded reason`,
    );
    assert.equal(
      GJC_APP_BUILTIN_COMMAND_NAMES.has(command.name),
      false,
      `${command.name} is documented as excluded but still dispatches`,
    );
  }
});

test('the catalog claims the desktop login aliases the runtime does not expose as text', () => {
  const advertised = new Set(ACP_BUILTIN_SLASH_COMMANDS.map((command) => command.name));
  for (const name of ['login', 'logout']) {
    // TUI-only upstream; the app claims them so the desktop answers with
    // guidance instead of forwarding the slash command to the model.
    assert.equal(advertised.has(name), false, `${name} is now a text builtin; drop the addition`);
    assert.equal(GJC_APP_BUILTIN_COMMAND_NAMES.has(name), true, `${name} must stay dispatched`);
  }
});

test('runtime aliases with text handlers are dispatchable but not advertised', () => {
  const advertised = new Set(GJC_APP_BUILTIN_COMMANDS.map((command) => command.name));
  for (const [alias, canonical] of Object.entries(GJC_APP_BUILTIN_COMMAND_ALIASES)) {
    // Dispatchable: without this the raw text reaches the model as a prompt.
    assert.equal(GJC_APP_BUILTIN_COMMAND_NAMES.has(alias), true, `${alias} must dispatch`);
    // Not advertised: the slash menu shows the canonical name only.
    assert.equal(advertised.has(alias), false, `${alias} must not be advertised`);
    assert.equal(advertised.has(canonical), true, `${canonical} must be advertised`);
  }
});

/** Scriptable SDK-shaped session; prompt owns the turn lifetime exactly as production does. */
class FakeAgentSession {
  readonly sessionFile = 'fake-session.jsonl';
  readonly promptStarted = deferred<void>();
  readonly abortStarted = deferred<void>();
  readonly #listeners = new Set<Listener>();
  readonly #prompt = deferred<void>();
  uiContext: { select(title: string, options: string[]): Promise<string | undefined> } | undefined;
  disposed = false;
  aborted = false;
  abortError: Error | undefined;
  neverSettleAbort = false;
  /** Mirrors the SDK's own flag: true while a turn is in flight. */
  isStreaming = true;
  abortDeferred: Deferred<void> | undefined;
  disposeError: Error | undefined;
  disposeDeferred: Deferred<void> | undefined;
  promptCalls = 0;
  /** Messages that arrived while a turn was already running. */
  readonly steeredMessages: string[] = [];
  /** Which queue each of those messages asked for. */
  readonly steerBehaviors: Array<'steer' | 'followUp'> = [];
  readonly temporaryModelSelections: Array<{
    model: unknown;
    thinkingLevel: unknown;
    options: unknown;
  }> = [];
  readonly configuredModelChains: Array<{
    role: string;
    entries: string[];
    origin: string;
    identity: unknown;
    explicitHead: unknown;
  }> = [];
  readonly fallbackResolutions: Array<{ index: number; skipped: unknown[] }> = [];
  #turnInFlight = false;

  /** Mirrors the SDK gate: `allow` until the host says otherwise. */
  sdkPermissionMode: 'prompt' | 'allow' | 'deny' = 'allow';
  sdkPermissionProvider: ((toolCall: unknown, options: unknown, signal?: AbortSignal) => Promise<unknown>) | undefined;

  subscribe(listener: Listener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  setToolUIContext(context: typeof this.uiContext): void { this.uiContext = context; }
  setSdkPermissionMode(mode: 'prompt' | 'allow' | 'deny'): void { this.sdkPermissionMode = mode; }
  setSdkPermissionProvider(provider: typeof this.sdkPermissionProvider): void { this.sdkPermissionProvider = provider; }
  readonly promptTexts: string[] = [];
  async prompt(message: string, options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    this.promptCalls += 1;
    this.promptTexts.push(message);
    // Mirrors the SDK: a busy agent refuses a bare prompt and requires the
    // caller to name the queue; a steer resolves as soon as it is queued rather
    // than waiting for the turn it joined.
    if (this.#turnInFlight) {
      if (!options?.streamingBehavior) {
        throw new Error('Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.');
      }
      this.steeredMessages.push(message);
      this.steerBehaviors.push(options.streamingBehavior!);
      return;
    }
    this.#turnInFlight = true;
    this.promptStarted.resolve();
    return this.#prompt.promise;
  }
  async abort(): Promise<void> {
    this.abortStarted.resolve();
    if (this.neverSettleAbort) return new Promise<void>(() => {});
    if (this.abortError) throw this.abortError;
    await this.abortDeferred?.promise;
    this.aborted = true;
    this.#prompt.resolve();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.disposeDeferred?.promise;
    if (this.disposeError) throw this.disposeError;
  }
  async setModelTemporary(model: unknown, thinkingLevel: unknown, options: unknown): Promise<void> {
    this.temporaryModelSelections.push({ model, thinkingLevel, options });
  }
  setConfiguredModelChain(
    role: string,
    entries: string[],
    origin: string,
    identity: unknown,
    explicitHead: unknown,
  ): void {
    this.configuredModelChains.push({ role, entries, origin, identity, explicitHead });
  }
  seedDefaultFallbackResolution(index: number, skipped: unknown[]): void {
    this.fallbackResolutions.push({ index, skipped });
  }
  emit(event: unknown): void { for (const listener of this.#listeners) listener(event); }
  complete(): void { this.#prompt.resolve(); }
  fail(error = new Error('fake failure')): void { this.#prompt.reject(error); }
}

const request = (method: string, id: string, payload: Record<string, unknown> = {}, sessionId = 'contract-scope') => ({
  protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
  kind: 'request' as const,
  id,
  method,
  payload,
  ...(globalMethods.has(method) ? {} : { sessionId }),
}) as GjcWorkerRequestFrame;

async function fixture(
  defaultModel: string | string[] = 'contract-model',
  modelProfile?: string,
  modelOrModels: { id: string; provider: string } | Array<{ id: string; provider: string }> = {
    id: 'contract-model',
    provider: 'contract-provider',
  },
  executeBuiltinCommand?: GjcBunSdkAdapterOptions['executeBuiltinCommand'],
  oauthLogin?: OAuthLogin,
  oauthTimeoutMs?: number,
  adapterOptionOverrides: Partial<GjcBunSdkAdapterOptions> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'gjc-contract-'));
  const sessions: FakeAgentSession[] = [];
  const factoryOptions: Array<Record<string, unknown>> = [];
  const trace: string[] = [];
  // These objects have no autonomous SDK work. Explicit fixture owners keep
  // adapter tests honest without treating absent production readers as idle.
  const idleLeaf = (name: string) => ({ generation: `fixture:${name}`, complete: true,
    starting: 0, queued: 0, running: 0, settling: 0, unknown: [] as string[] });
  const authStorage = {
    getAppLifecycleActivity: () => idleLeaf('auth'),
    credentials: [] as Array<{ id: number; provider: string }>,
    /** Providers `peekApiKey` reports a key for (models.yml apiKey/apiKeyEnv, env fallback). */
    resolvableProviders: new Set<string>(),
    exportSnapshot() { return { credentials: this.credentials }; },
    async peekApiKey(provider: string) { return this.resolvableProviders.has(provider) ? 'peeked-key' : undefined; },
    async login(provider: string, callbacks: OAuthCallbacks) {
      await oauthLogin?.(provider, callbacks);
      this.credentials.push({ id: this.credentials.length + 1, provider });
      trace.push('login.persist');
    },
    setRuntimeApiKey: () => {},
    removeRuntimeApiKey: () => {},
  };
  const models = Array.isArray(modelOrModels) ? modelOrModels : [modelOrModels];
  const modelRegistry = {
    getAppLifecycleActivity: () => idleLeaf('registry'),
    setAppLifecycleAdmission: (_closed: boolean) => {},
    authStorage,
    getAll: () => models,
    getAvailable: () => models,
    getCanonicalId: (model: typeof models[number]): string | undefined => model.id,
    getCanonicalModelSelections: (query: { candidates?: typeof models } = {}) => {
      // The SDK selects one concrete provider per canonical record. Returning
      // every candidate here hid the catalog's original variant collapse.
      const groups = new Map<string, typeof models>();
      for (const model of query.candidates ?? models) {
        const variants = groups.get(model.id) ?? [];
        variants.push(model);
        groups.set(model.id, variants);
      }
      return [...groups].map(([id, variants]) => ({
        record: {
          id,
          name: 'name' in variants[0] && typeof variants[0].name === 'string' ? variants[0].name : id,
          variants: variants.map((model) => ({ canonicalId: id, selector: `${model.provider}/${model.id}`, model, source: 'bundled' })),
        },
        model: variants[0],
      }));
    },
    getModelProfile: (name: string) => name === 'contract-profile' ? {
      name,
      requiredProviders: ['contract-provider'],
      modelMapping: { default: 'contract-provider/contract-model:xhigh' },
      source: 'user' as const,
    } : undefined,
    async refresh() { trace.push('modelRegistry.refresh'); },
  };
  const factory = (async (input: Record<string, unknown>) => {
    factoryOptions.push(input);
    const session = new FakeAgentSession();
    sessions.push(session);
    return { session, setToolUIContext: session.setToolUIContext.bind(session) };
  }) as unknown as GjcAgentSessionFactory;
  // The per-run clone is what the adapter applies its tool policy to, so the
  // fake has to carry `override` like the real Settings does. Without it every
  // session creation threw and the whole file failed on "Fake session was not
  // created", which named the symptom and hid the cause.
  const overrides = new Map<string, unknown>();
  const settingsClone = () => ({
    getModelRole: () => defaultModel || undefined,
    override: (key: string, value: unknown) => { overrides.set(key, value); },
    get: (key: string) => overrides.get(key),
  });
  const settings = {
    getAppLifecycleActivity: () => idleLeaf('settings'),
    getModelRole: () => defaultModel || undefined,
    get: (key: string) => key === 'modelProfile.default' ? modelProfile : undefined,
    cloneForCwd: async () => settingsClone(),
    toolPolicyOverrides: overrides,
  };
  const adapter = new GjcBunSdkAdapter(authStorage as never, modelRegistry as never, {
    createSessionFactory: factory,
    // The real generator would reach for a model through the fake registry;
    // tests that care about titles supply their own.
    generateSessionTitle: async () => null,
    ...(adapterOptionOverrides.loadSettings ? {} : { settings: settings as never }),
    executeBuiltinCommand,
    ...(oauthTimeoutMs === undefined ? {} : { oauth: { timeoutMs: oauthTimeoutMs } }),
    ...adapterOptionOverrides,
  });
  const frames: Array<Record<string, unknown>> = [];
  const host = new GjcWorkerHost({ runtime: async () => adapter, emit: (frame) => frames.push(frame as Record<string, unknown>) });
  await host.handle(request('worker.initialize', 'init'));
  const options = {
    cwd: process.cwd(),
    sessionRoot: root,
    credential: { kind: 'runtime-env', envVar: 'GJC_RUNTIME_API_KEY' },
    modelId: 'contract-model',
    toolNames: [],
    spawns: 'deny',
    bashPolicy: { allowedPrefixes: [] },
  };
  return { root, adapter, authStorage, modelRegistry, settings, trace, factoryOptions, sessions, frames, host, options, toolPolicyOverrides: overrides, close: () => rm(root, { recursive: true, force: true }) };
}

function methods(frames: Array<Record<string, unknown>>): string[] { return frames.filter((frame) => frame.kind === 'event').map((frame) => frame.method as string); }
function response(frames: Array<Record<string, unknown>>, id: string): Record<string, unknown> { return frames.find((frame) => frame.kind === 'response' && frame.id === id)!; }
async function firstSession(sessions: FakeAgentSession[]): Promise<FakeAgentSession> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sessions[0]) return sessions[0];
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Fake session was not created.');
}
type ProductionWorkerResult = {
  frames: Array<Record<string, unknown>>;
  stderr: string;
  exitCode: number | null;
};

async function runProductionWorker(env: NodeJS.ProcessEnv = {}): Promise<ProductionWorkerResult> {
  const bun = join(process.cwd(), 'dist-native', 'bun');
  const worker = join(process.cwd(), 'server', 'gjc-bun-worker.ts');
  const home = await mkdtemp(join(tmpdir(), 'gjc-worker-home-'));
  const agentDirectory = env.GJC_WORKER_AGENT_DIR ?? join(home, 'agent');
  // GJC_WORKER_AGENT_DIR isolates AuthStorage, but the SDK's global registry
  // and preset cache use getAgentDir(). Inheriting the operator's profile made
  // this handshake load their accepted model registry and exceed Bun's 5s
  // test deadline. Provider keys also triggered unrelated online discovery.
  const inherited = Object.fromEntries(
    ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(bun, ['--no-env-file', worker], {
        cwd: process.cwd(),
        env: {
          ...inherited,
          ...env,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_DATA_HOME: join(home, '.local', 'share'),
          XDG_STATE_HOME: join(home, '.local', 'state'),
          XDG_CACHE_HOME: join(home, '.cache'),
          GJC_WORKER_AGENT_DIR: agentDirectory,
          GJC_CODING_AGENT_DIR: agentDirectory,
          PI_CODING_AGENT_DIR: agentDirectory,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const frames: Array<Record<string, unknown>> = [];
      let stderr = '';
      let stdout = '';
      let initialized = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Production Bun worker timed out.'));
      }, 10_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        const lines = stdout.split('\n');
        stdout = lines.pop()!;
        for (const line of lines) {
          if (line) frames.push(JSON.parse(line) as Record<string, unknown>);
        }
        const init = frames.find((frame) => frame.kind === 'response' && frame.id === 'entry-init');
        if (init && !initialized) {
          initialized = true;
          child.stdin.write(`${JSON.stringify(request('worker.shutdown', 'entry-shutdown'))}\n`);
          child.stdin.end();
        }
      });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (exitCode) => {
        clearTimeout(timeout);
        resolve({ frames, stderr, exitCode });
      });
      child.stdin.write(`${JSON.stringify(request('worker.initialize', 'entry-init'))}\n`);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

process.env.GJC_RUNTIME_API_KEY ??= 'contract-test-key';

test('golden protocol order: session, stream, tool, ask, usage, terminal, response', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'golden', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'one' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'two' } });
    session.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: {} });
    session.emit({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: 'ok' });
    const ask = session.uiContext!.select('Proceed?', ['Yes']);
    await Promise.resolve();
    const askFrame = f.frames.at(-1)!;
    const requestId = ((askFrame.payload as Record<string, unknown>).message as Record<string, unknown>).requestId as string;
    await f.host.handle(request('ask.reply', 'reply', { runId: 'golden', requestId, decision: { allow: true, message: 'Yes' } }));
    assert.equal(await ask, 'Yes');
    // `usage` must be the SDK's own `Usage` shape (input/output/cacheRead/
    // cacheWrite/totalTokens); the adapter translates it onto the browser's
    // used/inputTokens contract, so a made-up shape here would not exercise it.
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ text: 'done' }], usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4 } } });
    session.complete();
    await run;
    // Two `usage.updated` close the turn: the token budget, then the session
    // snapshot (model, reasoning level, cwd, context window) the composer
    // footer needs. Same method because they update at the same instant, but
    // separate payloads — the budget comes off the message, the snapshot off
    // the live session, which is the only place the context window exists.
    assert.deepEqual(methods(f.frames), ['session.created', 'message.delta', 'message.delta', 'tool.started', 'tool.completed', 'ask.presented', 'message.completed', 'usage.updated', 'usage.updated', 'turn.completed', 'worker.status']);
    assert.equal(methods(f.frames).filter((method) => method === 'turn.completed').length, 1);
    assert.equal(response(f.frames, 'golden').payload instanceof Object, true);
  } finally { await f.close(); }
});

test('streaming tool metadata and errors survive the app worker protocol', async () => {
  const f = await fixture('astra', undefined, { id: 'astra', provider: 'contract-provider' });
  const run = f.host.handle(request('session.start', 'tool-updates', {
    message: 'Offline tool event delivery', options: { ...f.options, modelId: 'astra', effort: 'xhigh' },
  }));
  try {
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    const details = { terminalId: 'terminal-1' };
    session.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'pwd' } });
    session.emit({ type: 'tool_execution_update', toolCallId: 'call-1', partialResult: { content: [], details } });
    session.emit({ type: 'tool_execution_update', toolCallId: 'call-1', partialResult: {
      content: [{ type: 'text', text: 'Partial execution failed' }], details, isError: true,
    } });
    session.emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: {
      content: [{ type: 'text', text: 'Execution failed' }], details,
    }, isError: true });
    session.complete();
    await run;
    const messages = f.frames.map((frame) => parseGjcWorkerFrame(JSON.stringify(frame)))
      .flatMap((frame) => frame.kind === 'event' ? [frame.payload.message as Record<string, unknown> | undefined] : []);
    const results = messages.filter((message) => message?.kind === 'tool_result');
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((result) => ({
      toolId: result!.toolId, content: result!.content, isError: result!.isError,
      isFinal: result!.isFinal, toolUseResult: result!.toolUseResult,
    })), [
      { toolId: 'call-1', content: '', isError: false, isFinal: false, toolUseResult: details },
      { toolId: 'call-1', content: 'Partial execution failed', isError: true, isFinal: false, toolUseResult: details },
      { toolId: 'call-1', content: 'Execution failed', isError: true, isFinal: true, toolUseResult: details },
    ]);
    assert.equal((response(f.frames, 'tool-updates').payload as { ok: boolean }).ok, true);
  } finally {
    f.sessions.forEach((session) => session.complete());
    await run;
    await f.close();
  }
});

test('advertised GJC builtins execute in the SDK worker without becoming model prompts', async () => {
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    async (_text, runtime) => {
      await runtime.output('background jobs: none');
      return { consumed: true };
    },
  );
  try {
    await f.host.handle(request('session.start', 'builtin-command', {
      message: '/jobs',
      options: f.options,
    }));
    const session = await firstSession(f.sessions);

    assert.equal(session.promptCalls, 0);
    assert.deepEqual(methods(f.frames), [
      'session.created',
      'message.completed',
      'turn.completed',
      'worker.status',
    ]);
  } finally {
    await f.close();
  }
});


test('builtin stdout is terminal-safe, preserves Unicode, and retains export path provenance', async () => {
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    async (text, runtime) => {
      if (text.startsWith('/export')) {
        await runtime.output('Export failed: \uFFFD');
      } else {
        await runtime.output('\u001B[31m$5\t中🙂 `code` <markup>\u001B[0m\n\u001B]8;;https://example.test\u0007link\u001B]8;;\u0007');
      }
      return { consumed: true };
    },
  );
  try {
    await f.host.handle(request('session.start', 'builtin-stdout', {
      message: '/jobs',
      options: f.options,
    }));
    await f.host.handle(request('session.start', 'export-corruption', {
      message: '/export nested/報告.html',
      options: f.options,
    }));

    const outputs = f.frames
      .filter((frame) => frame.kind === 'event' && frame.method === 'message.completed')
      .map((frame) => ((frame.payload as Record<string, unknown>).message as Record<string, unknown>))
      .filter((message) => message.isLocalCommandStdout === true);
    assert.deepEqual(outputs, [
      {
        kind: 'text',
        role: 'assistant',
        content: '$5\t中🙂 `code` <markup>\nlink',
        isLocalCommandStdout: true,
      },
      {
        kind: 'text',
        role: 'assistant',
        content: 'Failed to export "nested/報告.html": the upstream export command returned a corrupted path.',
        isLocalCommandStdout: true,
      },
    ]);
  } finally {
    await f.close();
  }
});

/*
 * `/export` containment across a shared worker.
 *
 * One worker process serves every session, so its cwd is fixed at spawn time
 * and cannot describe the run. These two tests pin the destination to the
 * per-run project directory instead: the first proves the rewrite happens at
 * the command boundary, the second proves it still tracks the run after the
 * adapter is already warm and has served a different project.
 */
test('/export is rewritten to an absolute path inside the run project directory', async () => {
  let executedText = '';
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    async (text, runtime) => {
      executedText = text;
      await runtime.output('Session exported to: ok');
      return { consumed: true };
    },
  );
  const projectCwd = await mkdtemp(join(tmpdir(), 'gjc-export-project-'));
  try {
    await f.host.handle(request('session.start', 'export-bare', {
      message: '/export',
      options: { ...f.options, cwd: projectCwd },
    }));

    const argument = executedText.replace(/^\/export\s+/, '');
    assert.notEqual(executedText, '/export');
    assert.ok(isAbsolute(argument), `expected an absolute export path, got ${argument}`);
    const containment = relative(await realpath(projectCwd), await realpath(join(argument, '..')));
    assert.equal(containment, '');
    assert.match(argument, /gjc-session-.*\.html$/);
  } finally {
    await rm(projectCwd, { recursive: true, force: true });
    await f.close();
  }
});

test('a warm adapter contains /export per run, not per worker lifetime', async () => {
  const executed: string[] = [];
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    async (text, runtime) => {
      executed.push(text);
      await runtime.output('Session exported to: ok');
      return { consumed: true };
    },
  );
  const firstCwd = await mkdtemp(join(tmpdir(), 'gjc-export-one-'));
  const secondCwd = await mkdtemp(join(tmpdir(), 'gjc-export-two-'));
  try {
    // A prose turn first, so the adapter is already warm and has been bound to
    // a project before either export runs.
    const warmup = f.host.handle(request('session.start', 'export-warmup', {
      message: 'hello',
      options: { ...f.options, cwd: firstCwd },
    }));
    const warmupSession = await firstSession(f.sessions);
    await warmupSession.promptStarted.promise;
    warmupSession.complete();
    await warmup;

    await f.host.handle(request('session.start', 'export-run-one', {
      message: '/export',
      options: { ...f.options, cwd: firstCwd },
    }));
    await f.host.handle(request('session.start', 'export-run-two', {
      message: '/export',
      options: { ...f.options, cwd: secondCwd },
    }));

    assert.equal(executed.length, 2);
    const [first, second] = executed.map((text) => text.replace(/^\/export\s+/, ''));
    assert.notEqual(first, second);
    assert.equal(relative(await realpath(firstCwd), await realpath(join(first!, '..'))), '');
    assert.equal(relative(await realpath(secondCwd), await realpath(join(second!, '..'))), '');
  } finally {
    await rm(firstCwd, { recursive: true, force: true });
    await rm(secondCwd, { recursive: true, force: true });
    await f.close();
  }
});

test('/login is rejected before builtin handling or model prompting', async () => {
  let executedText = '';
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    async (text, runtime) => {
      executedText = text;
      await runtime.output('unexpected');
      return { consumed: true };
    },
  );
  try {
    await f.host.handle(request('session.start', 'login-command', {
      message: '/login openai-codex',
      options: f.options,
    }));
    await f.host.handle(request('session.start', 'logout-command', {
      message: '/logout openai-codex',
      options: f.options,
    }));

    assert.equal(executedText, '');
    assert.equal(f.sessions.length, 0);
    assert.equal((response(f.frames, 'login-command').payload as Record<string, unknown>).ok, false);
    assert.equal((response(f.frames, 'logout-command').payload as Record<string, unknown>).ok, false);
  } finally {
    await f.close();
  }
});
test('OAuth Protocol v1 frames are global and exact', () => {
  for (const method of ['oauth.providers', 'oauth.status', 'oauth.start', 'oauth.submit', 'oauth.cancel']) {
    const frame = parseGjcWorkerFrame(JSON.stringify({
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'request',
      id: `oauth-${method}`,
      method,
      payload: {},
    }));
    assert.equal(frame.kind, 'request');
    assert.equal('sessionId' in frame, false);
    assert.throws(
      () => parseGjcWorkerFrame(JSON.stringify({ ...frame, sessionId: 'contract-scope' })),
      { code: 'invalid_session_scope' },
    );
    const response = parseGjcWorkerFrame(JSON.stringify({
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'response',
      id: `response-${method}`,
      method,
      payload: { ok: true },
    }));
    assert.equal(response.kind, 'response');
    assert.equal('sessionId' in response, false);
    assert.throws(
      () => parseGjcWorkerFrame(JSON.stringify({ ...response, sessionId: 'contract-scope' })),
      { code: 'invalid_session_scope' },
    );
  }
  for (const method of ['oauth.phase', 'oauth.providers.updated', 'provider.auth.updated']) {
    const frame = parseGjcWorkerFrame(JSON.stringify({
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      id: `event-${method}`,
      method,
      payload: {},
    }));
    assert.equal(frame.kind, 'event');
    assert.equal('sessionId' in frame, false);
    assert.throws(
      () => parseGjcWorkerFrame(JSON.stringify({ ...frame, sessionId: 'contract-scope' })),
      { code: 'invalid_session_scope' },
    );
  }
});

test('model catalog reports the runtime-supported reasoning levels', async () => {
  const f = await fixture(
    'reasoning-model',
    undefined,
    {
      id: 'reasoning-model',
      name: 'Reasoning Model',
      provider: 'contract-provider',
      reasoning: true,
      thinking: {
        minLevel: 'low',
        maxLevel: 'high',
        levels: ['low', 'high'],
        mode: 'effort',
      },
    } as never,
  );
  try {
    f.authStorage.credentials.push({ id: 1, provider: 'contract-provider' });
    await f.host.handle(request('models.catalog', 'model-catalog'));
    const payload = response(f.frames, 'model-catalog').payload as Record<string, unknown>;
    assert.deepEqual(payload, {
      ok: true,
      result: {
        models: [{
          value: 'contract-provider/reasoning-model',
          label: 'Reasoning Model',
          group: 'contract-provider',
          canonicalId: 'reasoning-model',
          effort: { values: [{ value: 'low' }, { value: 'high' }] },
        }],
      },
    });
  } finally {
    await f.close();
  }
});

test('model catalog preserves credentialed provider-qualified models with the same bare id', async () => {
  const f = await fixture(
    'cliproxy/gpt-5.6-terra',
    undefined,
    [
      { id: 'gpt-5.6-terra', name: 'CLiProxy Terra', provider: 'cliproxy', reasoning: true, thinking: { minLevel: 'low', maxLevel: 'high', levels: ['low', 'high'], mode: 'effort' } },
      { id: 'gpt-5.6-terra', name: 'ChatGPT Terra', provider: 'openai-codex', reasoning: true, thinking: { minLevel: 'medium', maxLevel: 'xhigh', levels: ['medium', 'xhigh'], mode: 'effort' } },
      { id: 'gpt-5.6-terra', name: 'Unavailable Terra', provider: 'other-provider' },
    ] as never,
  );
  try {
    f.authStorage.credentials.push({ id: 1, provider: 'cliproxy' }, { id: 2, provider: 'openai-codex' });
    await f.host.handle(request('models.catalog', 'distinct-provider-models'));
    const payload = response(f.frames, 'distinct-provider-models').payload as { result: { models: Array<{ value: string; label: string; group: string; effort: { values: Array<{ value: string }> } }> } };

    assert.deepEqual(payload.result.models, [
      { value: 'cliproxy/gpt-5.6-terra', label: 'CLiProxy Terra', group: 'cliproxy', canonicalId: 'gpt-5.6-terra', effort: { values: [{ value: 'low' }, { value: 'high' }] } },
      { value: 'openai-codex/gpt-5.6-terra', label: 'ChatGPT Terra', group: 'openai-codex', canonicalId: 'gpt-5.6-terra', effort: { values: [{ value: 'medium' }, { value: 'xhigh' }] } },
    ]);
  } finally {
    await f.close();
  }
});

test('model catalog deduplicates qualified IDs and preserves aliases and uncanonicalized models', async () => {
  const primary = { id: 'gpt-6-astra', name: 'Astra', provider: 'openai-codex' };
  const alias = { id: 'gpt-6-astra-xhigh', name: 'Astra xhigh', provider: 'openai-codex' };
  const custom = { id: 'openai/gpt-6-astra', provider: 'custom' };
  const f = await fixture('openai-codex/gpt-6-astra', undefined, [primary, alias, { ...primary }, custom]);
  try {
    f.authStorage.credentials.push({ id: 9, provider: 'openai-codex' }, { id: 4, provider: 'openai-codex' });
    f.authStorage.resolvableProviders.add('custom');
    f.modelRegistry.getCanonicalId = (model) => model.provider === 'custom' ? undefined : 'gpt-6-astra';

    const first = await f.adapter.modelCatalog();
    assert.deepEqual(first.models, [
      { value: 'openai-codex/gpt-6-astra', label: 'Astra', group: 'openai-codex', canonicalId: 'gpt-6-astra', effort: { values: [] } },
      { value: 'openai-codex/gpt-6-astra-xhigh', label: 'Astra xhigh', group: 'openai-codex', canonicalId: 'gpt-6-astra', effort: { default: 'xhigh', values: [] } },
      { value: 'custom/openai/gpt-6-astra', label: 'openai/gpt-6-astra', group: 'custom', effort: { values: [] } },
    ]);
    assert.deepEqual(await f.adapter.modelCatalog(), first);

    // Registry order and credential order must not change a model's ID or
    // metadata, even when the same canonical model has several selectors.
    f.modelRegistry.getAvailable = () => [custom, { ...primary }, alias, primary];
    f.authStorage.credentials.reverse();
    const reordered = await f.adapter.modelCatalog();
    const byValue = (a: { value: string }, b: { value: string }) => a.value.localeCompare(b.value);
    assert.deepEqual([...reordered.models].sort(byValue), [...first.models].sort(byValue));
  } finally {
    await f.close();
  }
});

test('model catalog honors registry availability and credential changes independently for each provider', async () => {
  const codex = { id: 'gpt-6-astra', provider: 'openai-codex' };
  const proxy = { id: 'gpt-6-astra', provider: 'cliproxy' };
  const disabled = { id: 'gpt-6-astra', provider: 'disabled-provider' };
  const f = await fixture('openai-codex/gpt-6-astra', undefined, [codex, proxy, disabled]);
  try {
    f.authStorage.credentials.push({ id: 4, provider: 'openai-codex' }, { id: 5, provider: 'disabled-provider' });
    f.authStorage.resolvableProviders.add('cliproxy');
    f.modelRegistry.getAvailable = () => [codex, proxy];
    assert.deepEqual((await f.adapter.modelCatalog()).models.map((model) => model.value), [
      'openai-codex/gpt-6-astra', 'cliproxy/gpt-6-astra',
    ]);

    f.authStorage.credentials = [];
    assert.deepEqual((await f.adapter.modelCatalog()).models.map((model) => model.value), ['cliproxy/gpt-6-astra']);
    f.authStorage.resolvableProviders.clear();
    assert.deepEqual((await f.adapter.modelCatalog()).models, []);
  } finally {
    await f.close();
  }
});

test('provider-qualified catalog choices and the default select the matching stored credential', async (t) => {
  const cases = [
    { name: 'explicit proxy', modelId: 'cliproxy/gpt-6-astra', credential: { kind: 'stored' }, provider: 'cliproxy', credentialId: 1 },
    { name: 'explicit codex', modelId: 'openai-codex/gpt-6-astra', credential: { kind: 'stored' }, provider: 'openai-codex', credentialId: 4 },
    { name: 'pinned codex credential', modelId: 'openai-codex/gpt-6-astra', credential: { kind: 'stored', providerId: 'openai-codex', credentialId: 9 }, provider: 'openai-codex', credentialId: 9 },
    { name: 'configured default', modelId: 'default', credential: { kind: 'stored' }, provider: 'openai-codex', credentialId: 4 },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const f = await fixture('openai-codex/gpt-6-astra:xhigh', undefined, [
        { id: 'gpt-6-astra', provider: 'cliproxy' },
        { id: 'gpt-6-astra', provider: 'openai-codex' },
      ]);
      try {
        f.authStorage.credentials.push({ id: 9, provider: 'openai-codex' }, { id: 1, provider: 'cliproxy' }, { id: 4, provider: 'openai-codex' });
        const run = f.host.handle(request('session.start', 'variant-credential', {
          message: 'hello',
          options: { ...f.options, modelId: scenario.modelId, credential: scenario.credential, effort: 'xhigh' },
        }));
        const session = await firstSession(f.sessions);
        session.complete();
        await run;
        assert.deepEqual(f.factoryOptions[0]!.model, { id: 'gpt-6-astra', provider: scenario.provider });
        assert.deepEqual(f.factoryOptions[0]!.credentialSelector, {
          provider: scenario.provider,
          selector: { kind: 'id', value: String(scenario.credentialId) },
          raw: `id:${scenario.credentialId}`,
        });
        const payload = response(f.frames, 'variant-credential').payload as { ok: boolean; result: { credential: unknown } };
        assert.equal(payload.ok, true);
        assert.deepEqual(payload.result.credential, { kind: 'stored', providerId: scenario.provider, credentialId: scenario.credentialId });
      } finally {
        await f.close();
      }
    });
  }
});

test('same-name provider variants reject ambiguous bare IDs and mismatched credential pins', async (t) => {
  const cases = [
    { name: 'ambiguous bare ID', modelId: 'gpt-6-astra', credential: { kind: 'stored' } },
    { name: 'mismatched provider', modelId: 'openai-codex/gpt-6-astra', credential: { kind: 'stored', providerId: 'cliproxy' } },
    { name: 'other provider credential ID', modelId: 'openai-codex/gpt-6-astra', credential: { kind: 'stored', credentialId: 1 } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const f = await fixture('openai-codex/gpt-6-astra', undefined, [
        { id: 'gpt-6-astra', provider: 'cliproxy' },
        { id: 'gpt-6-astra', provider: 'openai-codex' },
      ]);
      try {
        f.authStorage.credentials.push({ id: 1, provider: 'cliproxy' }, { id: 4, provider: 'openai-codex' });
        await f.host.handle(request('session.start', 'invalid-variant', {
          message: 'hello',
          options: { ...f.options, modelId: scenario.modelId, credential: scenario.credential, effort: 'xhigh' },
        }));
        assert.equal((response(f.frames, 'invalid-variant').payload as { ok: boolean }).ok, false);
        assert.equal(f.factoryOptions.length, 0);
      } finally {
        await f.close();
      }
    });
  }
});

test('model catalog only exposes models backed by a stored subscription', async () => {
  const f = await fixture(
    'subscribed-model-high',
    undefined,
    [
      { id: 'subscribed-model-high', name: 'Subscribed', provider: 'cursor' },
      { id: 'unavailable-model', name: 'Unavailable', provider: 'openai-codex' },
    ] as never,
  );
  try {
    f.authStorage.credentials.push({ id: 25, provider: 'cursor' });
    await f.host.handle(request('models.catalog', 'stored-model-catalog'));
    const payload = response(f.frames, 'stored-model-catalog').payload as {
      result: { models: Array<{ value: string; effort: { default?: string } }> };
    };

    assert.deepEqual(payload.result.models.map((model) => model.value), ['cursor/subscribed-model-high']);
    assert.equal(payload.result.models[0]?.effort.default, 'high');
  } finally {
    await f.close();
  }
});

test('OAuth provider list exposes canonical safe descriptors', async () => {
  const f = await fixture();
  try {
    f.authStorage.credentials.push({ id: 7, provider: 'openai-codex' });
    await f.host.handle(request('oauth.providers', 'oauth-providers'));
    const result = ((response(f.frames, 'oauth-providers').payload as Record<string, unknown>).result ?? {}) as Record<string, unknown>;
    const providers = result.providers as Array<Record<string, unknown>>;
    const provider = providers.find((candidate) => candidate.id === 'openai-codex');

    assert.deepEqual(Object.keys(provider ?? {}).slice(0, 4), ['id', 'name', 'available', 'authenticated']);
    assert.equal(provider?.authenticated, true);
    assert.equal(JSON.stringify(result).includes('credential'), false);
  } finally {
    await f.close();
  }
});

test('OAuth callbacks emit safe phases and refresh before auth update completion', async () => {
  const manualCanary = 'manual-oauth-canary';
  const promptCanary = 'prompt-oauth-canary';
  const passwordCanary = 'password-oauth-canary';
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    undefined,
    async (provider, callbacks) => {
      assert.equal(provider, 'openai-codex');
      callbacks.onAuth({ url: 'https://login.example.test/authorize', instructions: 'Complete browser sign-in.' });
      callbacks.onProgress?.('Waiting for browser authentication.');
      assert.equal(await callbacks.onManualCodeInput!(), manualCanary);
      assert.equal(await callbacks.onPrompt({ message: 'Enter the displayed code', placeholder: 'Code' }), promptCanary);
      assert.equal(await callbacks.onPrompt({ message: 'Enter your password', placeholder: 'Password' }), passwordCanary);
    },
  );
  try {
    await f.host.handle(request('oauth.start', 'oauth-start', { providerId: 'openai-codex' }));
    const start = ((response(f.frames, 'oauth-start').payload as Record<string, unknown>).result ?? {}) as Record<string, unknown>;
    const attemptId = start.attemptId as string;

    await waitFor(() => (f.frames
      .filter((frame) => frame.method === 'oauth.phase')
      .map((frame) => frame.payload as Record<string, unknown>)
      .find((phase) => phase.attemptId === attemptId && phase.valueKind === 'manual_code')));
    await f.host.handle(request('oauth.submit', 'oauth-submit-manual', { attemptId, value: manualCanary }));
    const promptPhase = await waitFor(() => f.frames
      .filter((frame) => frame.method === 'oauth.phase')
      .map((frame) => frame.payload as Record<string, unknown>)
      .find((phase) => phase.attemptId === attemptId && phase.valueKind === 'prompt'));
    assert.equal(promptPhase.password, undefined);
    await f.host.handle(request('oauth.submit', 'oauth-submit-prompt', { attemptId, value: promptCanary }));


    const passwordPhase = await waitFor(() => f.frames
      .filter((frame) => frame.method === 'oauth.phase')
      .map((frame) => frame.payload as Record<string, unknown>)
      .find((phase) => phase.attemptId === attemptId && phase.valueKind === 'password'));
    assert.equal(passwordPhase.password, true);
    await f.host.handle(request('oauth.submit', 'oauth-submit-password', { attemptId, value: passwordCanary }));

    await waitFor(() => f.frames
      .filter((frame) => frame.method === 'oauth.phase')
      .map((frame) => frame.payload as Record<string, unknown>)
      .find((phase) => phase.attemptId === attemptId && phase.phase === 'completed'));

    assert.deepEqual(f.trace, ['login.persist', 'modelRegistry.refresh']);
    const providerAuthEvent = f.frames.findIndex((frame) => frame.method === 'provider.auth.updated');
    const completedPhase = f.frames.findIndex((frame) => frame.method === 'oauth.phase'
      && (frame.payload as Record<string, unknown>).phase === 'completed');
    assert.ok(providerAuthEvent >= 0 && providerAuthEvent < completedPhase);
    assert.equal(JSON.stringify(f.frames).includes(manualCanary), false);
    assert.equal(JSON.stringify(f.frames).includes(promptCanary), false);
    assert.equal(JSON.stringify(f.frames).includes(passwordCanary), false);
  } finally {
    await f.close();
  }
});
test('attached images reach the model as an images_input block while the title uses the bare text', async () => {
  const titleCalls: Array<{ firstMessage: string }> = [];
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, undefined, {
    generateSessionTitle: async (firstMessage: string) => { titleCalls.push({ firstMessage }); return 'A title'; },
  });
  try {
    const run = f.host.handle(request('session.start', 'images-first', {
      message: 'what is in this screenshot?',
      options: { ...f.options, images: [{ path: '/assets/images/shot.png', name: 'shot.png', mimeType: 'image/png' }] },
    }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.complete();
    await run;

    assert.equal(session.promptTexts.length, 1);
    const prompt = session.promptTexts[0]!;
    assert.match(prompt, /^what is in this screenshot\?/);
    assert.match(prompt, /<images_input>/);
    assert.match(prompt, /The user attached 1 image\(s\)/);
    assert.match(prompt, /0\. \/assets\/images\/shot\.png \(original name: shot\.png\)/);
    // The title generator saw the user's words, not the attachment block.
    assert.deepEqual(titleCalls.map((call) => call.firstMessage), ['what is in this screenshot?']);
  } finally { await f.close(); }
});

test('OAuth refresh failure preserves persisted auth state and reports a distinct safe error', async () => {
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    undefined,
    async () => {},
  );
  f.modelRegistry.refresh = async () => {
    f.trace.push('modelRegistry.refresh');
    throw new Error('refresh canary must not cross the worker protocol');
  };

  try {
    await f.host.handle(request('oauth.start', 'oauth-refresh-failure', { providerId: 'openai-codex' }));
    const start = ((response(f.frames, 'oauth-refresh-failure').payload as Record<string, unknown>).result ?? {}) as Record<string, unknown>;
    const attemptId = start.attemptId as string;
    const failed = await waitFor(() => f.frames
      .filter((frame) => frame.method === 'oauth.phase')
      .map((frame) => frame.payload as Record<string, unknown>)
      .find((phase) => phase.attemptId === attemptId && phase.phase === 'failed'));

    assert.deepEqual(f.trace, ['login.persist', 'modelRegistry.refresh']);
    assert.equal(f.authStorage.credentials.some((credential) => credential.provider === 'openai-codex'), true);
    assert.equal(failed.errorCode, 'oauth_model_refresh_failed');
    assert.equal(f.frames.some((frame) => frame.method === 'provider.auth.updated'
      && (frame.payload as Record<string, unknown>).authenticated === true), true);
    assert.equal(f.frames.some((frame) => frame.method === 'oauth.providers.updated'), true);
    assert.equal(JSON.stringify(f.frames).includes('refresh canary'), false);
  } finally {
    await f.close();
  }
});

test('a callback from an earlier attempt fails as a state mismatch, named but never quoted', async () => {
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    undefined,
    async () => { throw new Error('State mismatch - possible CSRF attack (canary)'); },
  );
  try {
    await f.host.handle(request('oauth.start', 'oauth-state-mismatch', { providerId: 'openai-codex' }));
    const start = ((response(f.frames, 'oauth-state-mismatch').payload as Record<string, unknown>).result ?? {}) as Record<string, unknown>;
    const attemptId = start.attemptId as string;
    const failed = await waitFor(() => f.frames
      .filter((frame) => frame.method === 'oauth.phase')
      .map((frame) => frame.payload as Record<string, unknown>)
      .find((phase) => phase.attemptId === attemptId && phase.phase === 'failed'));

    assert.equal(failed.errorCode, 'oauth_state_mismatch');
    assert.equal(JSON.stringify(f.frames).includes('canary'), false);
    assert.equal(JSON.stringify(f.frames).includes('CSRF'), false);
  } finally {
    await f.close();
  }
});

test('OAuth automatic callback flow completes without a manual submit', async () => {
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    undefined,
    async (_provider, callbacks) => {
      callbacks.onAuth({
        url: 'https://login.example.test/authorize',
        instructions: 'Complete sign-in in the browser.',
      });
    },
  );

  try {
    await f.host.handle(request('oauth.start', 'oauth-automatic-start', { providerId: 'openai-codex' }));
    const start = ((response(f.frames, 'oauth-automatic-start').payload as Record<string, unknown>).result ?? {}) as Record<string, unknown>;
    const attemptId = start.attemptId as string;
    const phases = () => f.frames
      .filter((frame) => frame.method === 'oauth.phase')
      .map((frame) => frame.payload as Record<string, unknown>)
      .filter((phase) => phase.attemptId === attemptId);

    await waitFor(() => phases().find((phase) => phase.phase === 'completed'));
    assert.equal(phases().some((phase) => phase.phase === 'awaiting_browser'
      && phase.authorizationUrl === 'https://login.example.test/authorize'), true);
    assert.deepEqual(f.trace, ['login.persist', 'modelRegistry.refresh']);
    assert.equal(f.frames.some((frame) => frame.method === 'provider.auth.updated'), true);
  } finally {
    await f.close();
  }
});

test('OAuth rejects concurrent, wrong, oversized, and duplicate submissions with safe errors', async () => {
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    undefined,
    async (_provider, callbacks) => {
      await callbacks.onPrompt({ message: 'Enter a password', placeholder: 'Password' });
    },
  );

  try {
    await f.host.handle(request('oauth.start', 'oauth-adversarial-start', { providerId: 'openai-codex' }));
    const start = ((response(f.frames, 'oauth-adversarial-start').payload as Record<string, unknown>).result ?? {}) as Record<string, unknown>;
    const attemptId = start.attemptId as string;
    await waitFor(() => f.frames
      .filter((frame) => frame.method === 'oauth.phase')
      .map((frame) => frame.payload as Record<string, unknown>)
      .find((phase) => phase.attemptId === attemptId && phase.phase === 'awaiting_input'));

    await f.host.handle(request('oauth.start', 'oauth-concurrent-start', { providerId: 'openai-codex' }));
    assert.equal(((response(f.frames, 'oauth-concurrent-start').payload as Record<string, unknown>).error as Record<string, unknown>).code, 'oauth_attempt_active');

    const wrongCanary = 'wrong-attempt-secret-canary';
    await f.host.handle(request('oauth.submit', 'oauth-wrong-submit', {
      attemptId: 'oauth-wrong-attempt',
      value: wrongCanary,
    }));
    assert.equal(((response(f.frames, 'oauth-wrong-submit').payload as Record<string, unknown>).error as Record<string, unknown>).code, 'oauth_attempt_not_found');

    const oversizedCanary = `oversized-${'x'.repeat(16 * 1024)}`;
    await f.host.handle(request('oauth.submit', 'oauth-oversized-submit', {
      attemptId,
      value: oversizedCanary,
    }));
    assert.equal(((response(f.frames, 'oauth-oversized-submit').payload as Record<string, unknown>).error as Record<string, unknown>).code, 'oauth_submit_too_large');

    const acceptedCanary = 'accepted-secret-canary';
    await f.host.handle(request('oauth.submit', 'oauth-valid-submit', { attemptId, value: acceptedCanary }));
    const duplicateCanary = 'duplicate-secret-canary';
    await f.host.handle(request('oauth.submit', 'oauth-duplicate-submit', { attemptId, value: duplicateCanary }));
    const duplicateCode = ((response(f.frames, 'oauth-duplicate-submit').payload as Record<string, unknown>).error as Record<string, unknown>).code;
    assert.equal(['oauth_input_not_requested', 'oauth_attempt_not_active'].includes(String(duplicateCode)), true);

    const serializedFrames = JSON.stringify(f.frames);
    for (const canary of [wrongCanary, oversizedCanary, acceptedCanary, duplicateCanary]) {
      assert.equal(serializedFrames.includes(canary), false);
    }
  } finally {
    await f.close();
  }
});
test('OAuth cancel aborts the active canonical login and replays safe status', async () => {
  let callbacks: OAuthCallbacks | undefined;
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    undefined,
    async (_provider, current) => {
      callbacks = current;
      await current.onPrompt({ message: 'Enter your password' });
    },
  );
  try {
    await f.host.handle(request('oauth.start', 'oauth-cancel-start', { providerId: 'openai-codex' }));
    const start = ((response(f.frames, 'oauth-cancel-start').payload as Record<string, unknown>).result ?? {}) as Record<string, unknown>;
    const attemptId = start.attemptId as string;
    await waitFor(() => callbacks);

    await waitFor(() => f.frames
      .filter((frame) => frame.method === 'oauth.phase')
      .map((frame) => frame.payload as Record<string, unknown>)
      .find((phase) => phase.attemptId === attemptId && phase.phase === 'awaiting_input'));
    await f.host.handle(request('oauth.cancel', 'oauth-cancel', { attemptId }));
    assert.equal(callbacks?.signal?.aborted, true);

    await f.host.handle(request('oauth.status', 'oauth-cancel-status'));
    const status = ((response(f.frames, 'oauth-cancel-status').payload as Record<string, unknown>).result ?? {}) as Record<string, unknown>;
    assert.equal((status.attempt as Record<string, unknown>).phase, 'cancelled');

    const canary = 'cancelled-oauth-secret';
    await f.host.handle(request('oauth.submit', 'oauth-cancel-late-submit', { attemptId, value: canary }));
    const lateSubmit = response(f.frames, 'oauth-cancel-late-submit').payload as Record<string, unknown>;
    assert.equal((lateSubmit.error as Record<string, unknown>).code, 'oauth_attempt_not_active');
    assert.equal(JSON.stringify(f.frames).includes(canary), false);
  } finally {
    await f.close();
  }
});

test('OAuth timeout rejects late secret submission without refreshing models', async () => {
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    undefined,
    async (_provider, callbacks) => {
      await callbacks.onPrompt({ message: 'Enter a code' });
    },
    5,
  );
  try {
    await f.host.handle(request('oauth.start', 'oauth-timeout-start', { providerId: 'openai-codex' }));
    const start = ((response(f.frames, 'oauth-timeout-start').payload as Record<string, unknown>).result ?? {}) as Record<string, unknown>;
    const attemptId = start.attemptId as string;

    await waitFor(() => f.frames
      .filter((frame) => frame.method === 'oauth.phase')
      .map((frame) => frame.payload as Record<string, unknown>)
      .find((phase) => phase.attemptId === attemptId && phase.phase === 'timed_out'));

    const canary = 'timed-out-oauth-secret';
    await f.host.handle(request('oauth.submit', 'oauth-timeout-late-submit', { attemptId, value: canary }));
    const lateSubmit = response(f.frames, 'oauth-timeout-late-submit').payload as Record<string, unknown>;
    assert.equal((lateSubmit.error as Record<string, unknown>).code, 'oauth_attempt_not_active');
    assert.deepEqual(f.trace, []);
    assert.equal(JSON.stringify(f.frames).includes(canary), false);
  } finally {
    await f.close();
  }
});

test('resume fails closed when the injected session root has no exact session file match', async () => {
  const f = await fixture();
  try {
    await f.host.handle(request('session.resume', 'resume-missing', { message: 'resume', options: f.options, providerSessionId: 'not-present' }));
    assert.equal(f.sessions.length, 0);
    assert.equal((response(f.frames, 'resume-missing').payload as Record<string, unknown>).ok, false);
    assert.equal(methods(f.frames).includes('session.created'), false);
  } finally { await f.close(); }
});
test('resume opens the sole exact session file and never re-emits session.created', async () => {
  const f = await fixture();
  try {
    const providerSessionId = 'exact-resume';
    await writeFile(join(f.root, 'only.jsonl'), `${JSON.stringify({
      type: 'session', version: 3, id: providerSessionId, timestamp: new Date().toISOString(), cwd: f.root,
    })}\n`);
    const run = f.host.handle(request('session.resume', 'resume-exact', {
      message: 'resume',
      options: f.options,
      providerSessionId,
    }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.complete();
    await run;
    assert.equal((f.factoryOptions[0]!.sessionManager as { getSessionId(): string }).getSessionId(), providerSessionId);
    assert.equal(Object.hasOwn(f.factoryOptions[0]!, 'providerSessionId'), false,
      'the SDK must derive provider identity from the resumed logical session');
    assert.equal(methods(f.frames).includes('session.created'), false);
  } finally { await f.close(); }
});

/** Real SDK construction; prompts are intercepted before any model transport can run. */
async function identityFixture(behavior: {
  realPrompts?: boolean;
  onCreated?: (session: Awaited<ReturnType<typeof createAgentSession>>['session']) => void;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gjc-sdk-identity-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  const authStorage = await discoverAuthStorage(agentDir);
  const settings = await Settings.loadForScope({ cwd, agentDir });
  settings.override('memory.enabled', false);
  settings.override('skills.enabled', false);
  const registry = new ModelRegistry(authStorage, join(agentDir, 'models.yml'), settings, { agentDir });
  // This synthetic Astra fixture has no registered transport and no real credentials.
  registry.registerProvider('identity-contract', {
    api: 'identity-contract',
    apiKey: 'offline-identity-test-key',
    baseUrl: 'http://127.0.0.1:1',
    models: [{
      id: 'astra', name: 'Offline Astra identity fixture', reasoning: true,
      thinking: { mode: 'effort', minLevel: 'xhigh', maxLevel: 'xhigh', levels: ['xhigh'] },
      input: ['text'], contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  });
  type Session = Awaited<ReturnType<typeof createAgentSession>>['session'];
  const sessions: Session[] = [];
  const factoryOptions: Array<Parameters<typeof createAgentSession>[0]> = [];
  const inspections: Array<(session: Session) => Promise<void>> = [];
  const failures: unknown[] = [];
  const adapter = new GjcBunSdkAdapter(authStorage, registry, {
    settings,
    generateSessionTitle: async () => null,
    createSessionFactory: async (input) => {
      const sdkOptions = {
        ...input,
        agentDir,
        enableMcpAutoload: false,
        enableLsp: false,
        skipPythonPreflight: true,
        disableExtensionDiscovery: true,
        skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
        systemPrompt: ['Offline session identity contract.'],
      };
      factoryOptions.push(sdkOptions);
      try {
        const result = await createAgentSession(sdkOptions);
        sessions.push(result.session);
        behavior.onCreated?.(result.session);
        if (!behavior.realPrompts) {
          const inspect = inspections.shift();
          assert.ok(inspect, 'each SDK session needs an explicit offline prompt handler');
          result.session.prompt = async () => {
            try { await inspect(result.session); }
            catch (error) { failures.push(error); throw error; }
          };
        }
        return result;
      } catch (error) { failures.push(error); throw error; }
    },
  });
  const frames: Array<Record<string, unknown>> = [];
  const host = new GjcWorkerHost({ runtime: async () => adapter, emit: (frame) => frames.push(frame as Record<string, unknown>) });
  await host.handle(request('worker.initialize', 'identity-init'));
  const options = {
    cwd, sessionRoot: join(root, 'sessions'),
    credential: { kind: 'runtime-env', envVar: 'GJC_RUNTIME_API_KEY' },
    modelId: 'identity-contract/astra', effort: 'xhigh',
    toolNames: ['bash', 'skill'], spawns: 'deny', bashPolicy: { allowedPrefixes: [] },
  };
  return {
    root, options, factoryOptions, host, frames, adapter, sessions,
    enqueueInspection(inspect: (session: Session) => Promise<void>) { inspections.push(inspect); },
    async run(id: string, inspect: (session: Session) => Promise<void>, providerSessionId?: string) {
      inspections.push(inspect);
      await host.handle(request(providerSessionId ? 'session.resume' : 'session.start', id, {
        message: 'offline identity inspection', options,
        ...(providerSessionId ? { providerSessionId } : {}),
      }));
      if (failures.length) throw failures[0];
      assert.equal((response(frames, id).payload as { ok: boolean }).ok, true);
    },
    async close() {
      for (const session of sessions) await session.dispose();
      await registry.dispose();
      authStorage.close();
      await settings.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('goal-capable production sessions delegate safely and defer worktree abort to their owner', async () => {
  const f = await identityFixture();
  Object.assign(f.options, { toolNames: ['read', 'task', 'subagent'], spawns: '*', goalUiVersion: 1, goalOwner: 'number:1' });
  try {
    await f.run('goal-delegation', async (parent) => {
      assert.equal(parent.settings.get('goal.enabled'), true);
      const rootOptions = f.factoryOptions[0];
      assert.ok(rootOptions);
      assert.equal(rootOptions.spawns, 'deny', 'native SDK spawning stays denied');
      const created = await parent.getToolByName('goal')!.execute('create-goal', { op: 'create', objective: 'Delegate one bounded check' });
      let checkedChild = false;
      f.enqueueInspection(async (child) => {
        assert.equal(child.settings.get('goal.enabled'), false);
        assert.equal(child.getActiveToolNames().includes('goal'), false);
        assert.equal(child.thinkingLevel, 'xhigh');
        checkedChild = true;
      });
      const launched = await parent.getToolByName('task')!.execute('start-child', {
        agent: 'planner', context: null, tasks: [{ id: 'inspect', description: 'Bounded check', assignment: 'Return after the offline check.', executionMode: 'default', repositoryBinding: null }],
      });
      const childId = launched.details.subagents[0].id;
      const settled = await parent.getToolByName('subagent')!.execute('await-child', { action: 'await', id: childId, timeout_ms: 5000 });
      assert.equal(settled.details.subagents[0].status, 'completed');
      assert.equal(checkedChild, true);
      let aborts = 0;
      const originalAbort = parent.abort.bind(parent);
      parent.abort = async () => { aborts++; await originalAbort(); };
      await f.host.handle(request('goal.control', 'pause-goal-native', {
        owner: 'number:1', cwd: await realpath(f.options.cwd), runId: 'goal-delegation',
        command: { operation: 'pause', goalId: created.details.goal.id }, stopAfterMutation: false,
      }));
      assert.equal((response(f.frames, 'pause-goal-native').payload as { ok: boolean }).ok, true);
      assert.equal(aborts, 0, 'the SDK does not bypass the native job abort authority');
      await assert.rejects(parent.getToolByName('goal')!.execute('resume-too-soon', { op: 'resume' }), /app goal controls/);
      await f.host.handle(request('turn.abort', 'owner-abort', { runId: 'goal-delegation' }));
      assert.equal(aborts, 1);
    });
    assert.equal((response(f.frames, 'goal-delegation').payload as { result: { aborted?: boolean } }).result.aborted, true);
  } finally { await f.close(); }
});

test('a goal-owned stop reports an aborted worker outcome without a separate turn.abort request', async () => {
  const f = await identityFixture();
  Object.assign(f.options, { goalUiVersion: 1, goalOwner: 'number:1' });
  try {
    await f.run('goal-internal-stop', async (session) => {
      const created = await session.getToolByName('goal')!.execute('create', { op: 'create', objective: 'Stop this scoped goal' });
      await f.host.handle(request('goal.control', 'stop-from-goal', {
        owner: 'number:1', cwd: await realpath(f.options.cwd), runId: 'goal-internal-stop',
        command: { operation: 'pause', goalId: created.details.goal.id },
      }));
      assert.equal((response(f.frames, 'stop-from-goal').payload as { ok: boolean }).ok, true);
    });
    assert.equal((response(f.frames, 'goal-internal-stop').payload as { result: { aborted?: boolean } }).result.aborted, true);
  } finally { await f.close(); }
});

async function assertSdkIdentity(
  session: Awaited<ReturnType<typeof createAgentSession>>['session'],
  providerId = session.sessionManager.getSessionId(),
) {
  const id = session.sessionManager.getSessionId();
  const bash = session.getToolByName('bash');
  assert.ok(bash, 'the real SDK must construct its bash tool');
  const output: { content: Array<{ type: string; text?: string }> } =
    await bash.execute('identity-env', { command: 'printenv GJC_SESSION_ID' });
  const text = output.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  assert.equal(text.trim(), id,
    'workflow tools and GJC_SESSION_ID need the logical ID, never an async endpoint tuple');
  assert.equal(session.sessionId, id);
  assert.equal(session.agent.sessionId, id);
  assert.equal(session.agent.providerSessionId, providerId, 'omission must preserve provider cache identity');
  assert.equal(session.credentialSessionId, providerId, 'omission must preserve credential affinity');
  const manager = AsyncJobManager.forEndpoint(id);
  assert.ok(manager);
  assert.equal(AsyncJobManager.endpointIdOf(manager), id);
  return { id, manager };
}

function identityAnswer(text: string): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text }],
    api: 'identity-contract', provider: 'identity-contract', model: 'astra',
    stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

async function persistIdentityTurn(session: Awaited<ReturnType<typeof createAgentSession>>['session']) {
  session.sessionManager.appendMessage({ role: 'user', content: 'persist for resume', timestamp: Date.now() });
  session.sessionManager.appendMessage(identityAnswer('offline answer'));
  await session.sessionManager.flush();
}

test('app-shaped real SDK start and resume keep workflow, provider and async identities aligned', async () => {
  const f = await identityFixture();
  try {
    let first: Awaited<ReturnType<typeof assertSdkIdentity>> | undefined;
    await f.run('identity-start', async (session) => {
      first = await assertSdkIdentity(session);
      assert.equal(Object.hasOwn(f.factoryOptions[0]!, 'providerSessionId'), false);
      await persistIdentityTurn(session);
    });
    assert.ok(first);
    assert.equal(AsyncJobManager.forEndpoint(first.id), undefined, 'completed runs release ownership');
    await f.run('identity-resume', async (session) => {
      const resumed = await assertSdkIdentity(session);
      assert.equal(resumed.id, first!.id);
      assert.notEqual(resumed.manager, first!.manager, 'resume must acquire a fresh manager');
    }, first.id);
    assert.equal(AsyncJobManager.forEndpoint(first.id), undefined);
  } finally { await f.close(); }
});

test('app-shaped real SDK sessions isolate async ownership and reject duplicate live resumes', async () => {
  const a = await identityFixture();
  const b = await identityFixture();
  b.options.cwd = a.options.cwd;
  b.options.sessionRoot = a.options.sessionRoot;
  try {
    await a.run('identity-a', async (sessionA) => {
      const first = await assertSdkIdentity(sessionA);
      await persistIdentityTurn(sessionA);
      await b.run('identity-b', async (sessionB) => {
        const second = await assertSdkIdentity(sessionB);
        assert.notEqual(first.id, second.id);
        assert.notEqual(first.manager, second.manager);
        assert.equal(AsyncJobManager.forEndpoint(first.id), first.manager);
        const duplicate = await SessionManager.open(sessionA.sessionFile!, a.options.sessionRoot);
        await assert.rejects(
          createAgentSession({ ...a.factoryOptions[0], sessionManager: duplicate }),
          /endpoint id is already held by another live async job manager/,
        );
        assert.equal(AsyncJobManager.forEndpoint(first.id), first.manager);
        assert.equal(AsyncJobManager.forEndpoint(second.id), second.manager);
        assert.equal(AsyncJobManager.instance(), second.manager,
          'a rejected duplicate must not replace the active global manager');
      });
      assert.equal(AsyncJobManager.forEndpoint(first.id), first.manager,
        'disposing a different session must not release this session');
    });
  } finally { await b.close(); await a.close(); }
});

test('app-shaped real SDK handoff rekeys logical ownership while retaining provider affinity', async () => {
  const f = await identityFixture();
  let handoffCalls = 0;
  let successorId: string | undefined;
  // Deterministic local completion exercises the actual handoff transaction;
  // there is no network transport or live model call in this test.
  registerCustomApi('identity-contract', (model) => {
    assert.equal(model.id, 'astra');
    handoffCalls += 1;
    const stream = new AssistantMessageEventStream();
    const message = identityAnswer('Offline handoff document.');
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end(message);
    return stream;
  }, f.root);
  try {
    await f.run('identity-handoff', async (session) => {
      const before = await assertSdkIdentity(session);
      await persistIdentityTurn(session);
      const handoff = await session.handoff('Offline identity contract');
      assert.ok(handoff);
      assert.equal(handoffCalls, 1);
      const after = await assertSdkIdentity(session, before.id);
      successorId = after.id;
      assert.notEqual(after.id, before.id);
      assert.equal(after.manager, before.manager, 'handoff rekeys the existing owner');
      assert.equal(AsyncJobManager.forEndpoint(before.id), undefined);
    });
    assert.ok(successorId);
    assert.equal(AsyncJobManager.forEndpoint(successorId), undefined);
    await f.run('identity-handoff-resume', async (session) => {
      assert.equal((await assertSdkIdentity(session)).id, successorId);
    }, successorId);
  } finally { unregisterCustomApis(f.root); await f.close(); }
});

/** Direct SDK construction: this fixture never passes through the app adapter. */
async function rawSdkDelegationFixture() {
  const scratch = join(await realpath(process.cwd()), '.tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'raw-sdk-delegation-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  const authStorage = await discoverAuthStorage(agentDir);
  const settings = await Settings.loadForScope({ cwd, agentDir });
  settings.override('memory.enabled', false);
  settings.override('skills.enabled', false);
  settings.override('goal.enabled', false);
  settings.override('task.agentModelOverrides', { executor: 'openai-codex/gpt-6-astra' });
  settings.override('task.maxRuntimeMs', 3000);
  settings.override('task.maxRecursionDepth', 1);
  const registry = new ModelRegistry(authStorage, join(agentDir, 'models.yml'), settings, { agentDir });
  registry.registerProvider('openai-codex', {
    api: 'raw-sdk-delegation-contract', apiKey: 'offline-raw-sdk-key', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'gpt-6-astra', name: 'Offline Astra contract', reasoning: true,
      thinking: { mode: 'effort', minLevel: 'xhigh', maxLevel: 'xhigh', levels: ['xhigh'] },
      input: ['text'], contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const { session } = await createAgentSession({
    cwd, agentDir, settings, authStorage, modelRegistry: registry,
    model: registry.find('openai-codex', 'gpt-6-astra'), thinkingLevel: 'xhigh',
    sessionManager: SessionManager.create(cwd, join(root, 'sessions')),
    toolNames: ['bash', 'task', 'subagent'], spawns: 'executor',
    enableMcpAutoload: false, enableLsp: false, skipPythonPreflight: true, disableExtensionDiscovery: true,
    skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
  });
  return { root, session, async close() {
    await session.dispose(); await registry.dispose(); authStorage.close(); await settings.close();
    await rm(root, { recursive: true, force: true });
  } };
}

test('raw SDK builtin delegation bypasses parent permissions; app replacement remains necessary', { timeout: 15_000 }, async () => {
  const f = await rawSdkDelegationFixture();
  let calls = 0;
  let issuedTool = false;
  const observedToolResults: Array<{ isError: boolean; content: unknown }> = [];
  // Exercise the pinned SDK's real child lifecycle with a deterministic local
  // transport. Its only shell command prints a fixed canary to stdout.
  registerCustomApi('raw-sdk-delegation-contract', (model, context: Context, options) => {
    assert.equal(model.provider, 'openai-codex');
    assert.equal(model.id, 'gpt-6-astra');
    assert.equal(options?.reasoning, 'xhigh');
    calls += 1;
    observedToolResults.push(...context.messages.filter((message) => message.role === 'toolResult'));
    const message = identityAnswer('Offline child finished.');
    message.api = 'raw-sdk-delegation-contract';
    message.provider = 'openai-codex';
    message.model = 'gpt-6-astra';
    if (!issuedTool && context.tools?.some((tool) => tool.name === 'bash')) {
      issuedTool = true;
      message.content = [{
        type: 'toolCall', id: 'child-permission-canary', name: 'bash',
        arguments: { command: 'printf child-allowed' },
      }];
      message.stopReason = 'toolUse';
    }
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    stream.end(message);
    return stream;
  }, f.root);
  try {
    const session = f.session;
      session.setSdkPermissionMode('deny');
      const bash = session.getToolForExecution('bash');
      assert.ok(bash);
      await assert.rejects(
        bash.execute('parent-permission-canary', { command: 'printf child-allowed' }),
        /rejected by session permission policy/,
      );
      const task = session.getToolByName('task');
      const subagent = session.getToolByName('subagent');
      assert.ok(task);
      assert.ok(subagent);
      const launch = await task.execute('offline-delegation', {
        agent: 'executor', tasks: [{ id: 'permission-probe', description: 'Offline permission contract', assignment: 'Offline fixture.' }],
      });
      const settled = await subagent.execute('offline-await', { action: 'await', timeout_ms: 5000 });
      assert.ok(calls > 0, JSON.stringify({ launch, settled }));
      assert.ok(observedToolResults.some((result) => !result.isError
        && JSON.stringify(result.content).includes('child-allowed')),
      JSON.stringify({ calls, issuedTool, observedToolResults, launch, settled }));
      // The application has its own independent positive safety fixture in
      // gjc-delegation-executor.bun.test.ts. Never convert this unsafe SDK
      // result into an assertion about the app's current tool names.
  } finally { unregisterCustomApis(f.root); await f.close(); }
});
test('session effort is passed to the SDK as the turn thinking level', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'reasoning-effort', {
      message: 'reason',
      options: { ...f.options, effort: 'high' },
    }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.complete();
    await run;
    assert.equal(f.factoryOptions[0]!.thinkingLevel, 'high');
    assert.deepEqual(session.temporaryModelSelections, [{
      model: { id: 'contract-model', provider: 'contract-provider' },
      thinkingLevel: 'high',
      options: { persistAsSessionDefault: true, cause: 'startup-override' },
    }]);
  } finally { await f.close(); }
});
test('a resumed session applies the app-pinned model as the authoritative default chain', async () => {
  const f = await fixture(
    ['glm-zcode53/glm-5.3:high', 'glm-zcode/glm-5.2:high'],
    undefined,
    [
      { id: 'gpt-5.6-sol', provider: 'openai-codex' },
      { id: 'glm-5.3', provider: 'glm-zcode53' },
      { id: 'glm-5.2', provider: 'glm-zcode' },
    ],
  );
  try {
    const providerSessionId = 'resume-with-pinned-sol';
    await writeFile(join(f.root, 'pinned.jsonl'), `${JSON.stringify({
      type: 'session', version: 3, id: providerSessionId, timestamp: new Date().toISOString(), cwd: f.root,
    })}\n`);
    const run = f.host.handle(request('session.resume', 'resume-pinned-model', {
      message: 'continue with sol',
      options: { ...f.options, modelId: 'openai-codex/gpt-5.6-sol', effort: 'medium' },
      providerSessionId,
    }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.complete();
    await run;

    assert.deepEqual(session.temporaryModelSelections, [{
      model: { id: 'gpt-5.6-sol', provider: 'openai-codex' },
      thinkingLevel: 'medium',
      options: { persistAsSessionDefault: true, cause: 'startup-override' },
    }]);
    assert.deepEqual(session.configuredModelChains, [{
      role: 'default',
      entries: ['openai-codex/gpt-5.6-sol'],
      origin: 'startup-override',
      identity: undefined,
      explicitHead: true,
    }]);
    assert.deepEqual(session.fallbackResolutions, [{ index: 0, skipped: [] }]);
  } finally { await f.close(); }
});
test('sequential runs clone global settings for each cwd while retaining the session root', async () => {
  const f = await fixture();
  const firstCwd = await mkdtemp(join(tmpdir(), 'gjc-cwd-one-'));
  const secondCwd = await mkdtemp(join(tmpdir(), 'gjc-cwd-two-'));
  try {
    const first = f.host.handle(request('session.start', 'cwd-one', { message: 'one', options: { ...f.options, cwd: firstCwd } }));
    const firstRunSession = await firstSession(f.sessions);
    await firstRunSession.promptStarted.promise;
    firstRunSession.complete();
    await first;
    const second = f.host.handle(request('session.start', 'cwd-two', { message: 'two', options: { ...f.options, cwd: secondCwd } }));
    for (let attempt = 0; attempt < 100 && !f.sessions[1]; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    const secondSession = f.sessions[1]!;
    await secondSession.promptStarted.promise;
    secondSession.complete();
    await second;
    assert.equal(f.factoryOptions[0]!.cwd, firstCwd);
    assert.equal(f.factoryOptions[1]!.cwd, secondCwd);
    assert.notEqual(f.factoryOptions[0]!.settings, f.factoryOptions[1]!.settings);
    // The SDK reports session files as realpaths, so containment is compared
    // against the resolved root (macOS /var is a symlink to /private/var).
    const resolvedRoot = await realpath(f.root);
    for (const factoryInput of f.factoryOptions) {
      const sessionFile = (factoryInput.sessionManager as { getSessionFile(): string | undefined }).getSessionFile();
      assert.ok(sessionFile);
      const relativeSessionFile = relative(resolvedRoot, sessionFile);
      assert.ok(relativeSessionFile && !relativeSessionFile.startsWith('..') && !isAbsolute(relativeSessionFile));
    }
  } finally {
    await Promise.all([f.close(), rm(firstCwd, { recursive: true, force: true }), rm(secondCwd, { recursive: true, force: true })]);
  }
});
test('default model role resolves deterministically and is reported in the start result', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'default-model', {
      message: 'hello',
      options: { ...f.options, modelId: 'default' },
    }));
    const session = await firstSession(f.sessions);
    session.complete();
    await run;
    assert.equal(f.factoryOptions[0]!.model && (f.factoryOptions[0]!.model as { id: string }).id, 'contract-model');
    assert.equal(((response(f.frames, 'default-model').payload as Record<string, unknown>).result as Record<string, unknown>).model, 'contract-model');
  } finally { await f.close(); }
});
test('settings loader resolves the current default model role for each run', async () => {
  let loads = 0;
  const settingsFor = (modelId: string) => ({
    getModelRole: () => `contract-provider/${modelId}`,
    get: () => undefined,
    cloneForCwd: async () => ({
      getModelRole: () => `contract-provider/${modelId}`,
      override: () => undefined,
      get: () => undefined,
    }),
  });
  const f = await fixture(
    'first-model',
    undefined,
    [
      { id: 'first-model', provider: 'contract-provider' },
      { id: 'second-model', provider: 'contract-provider' },
    ],
    undefined,
    undefined,
    undefined,
    {
      loadSettings: async () => {
        loads += 1;
        return settingsFor(loads === 1 ? 'first-model' : 'second-model') as never;
      },
    },
  );
  try {
    const first = f.host.handle(request('session.start', 'fresh-default-first', {
      message: 'first',
      options: { ...f.options, modelId: 'default' },
    }));
    const initialSession = await firstSession(f.sessions);
    initialSession.complete();
    await first;

    const second = f.host.handle(request('session.start', 'fresh-default-second', {
      message: 'second',
      options: { ...f.options, modelId: 'default' },
    }));
    const secondSession = await waitFor(() => f.sessions[1]);
    secondSession.complete();
    await second;

    assert.equal(loads, 2);
    assert.equal((f.factoryOptions[0]!.model as { id: string }).id, 'first-model');
    assert.equal((f.factoryOptions[1]!.model as { id: string }).id, 'second-model');
  } finally { await f.close(); }
});
test('default model role resolves its selector without the thinking suffix', async () => {
  const f = await fixture('openai-codex/gpt-5.6-sol:medium', undefined, {
    id: 'gpt-5.6-sol',
    provider: 'openai-codex',
  });
  try {
    const run = f.host.handle(request('session.start', 'default-model-role-suffix', {
      message: 'hello',
      options: { ...f.options, modelId: 'default' },
    }));
    const session = await firstSession(f.sessions);
    session.complete();
    await run;
    assert.equal(f.factoryOptions[0]!.model && (f.factoryOptions[0]!.model as { id: string }).id, 'gpt-5.6-sol');
    assert.equal(((response(f.frames, 'default-model-role-suffix').payload as Record<string, unknown>).result as Record<string, unknown>).model, 'gpt-5.6-sol');
  } finally { await f.close(); }
});
test('default model role uses the primary selector from a fallback chain', async () => {
  const f = await fixture(['missing/model:high', 'openai-codex/gpt-5.6-terra:high'], undefined, {
    id: 'gpt-5.6-terra',
    provider: 'openai-codex',
  });
  try {
    const run = f.host.handle(request('session.start', 'default-model-role-chain', {
      message: 'hello',
      options: { ...f.options, modelId: 'default' },
    }));
    const session = await firstSession(f.sessions);
    session.complete();
    await run;
    assert.equal(f.factoryOptions[0]!.model && (f.factoryOptions[0]!.model as { id: string }).id, 'gpt-5.6-terra');
  } finally { await f.close(); }
});
test('default model fallback skips providers that do not match the stored credential', async () => {
  const f = await fixture(
    ['glm-zcode53/glm-5.3:high', 'glm-zcode/glm-5.2:high'],
    undefined,
    [
      { id: 'glm-5.3', provider: 'glm-zcode53' },
      { id: 'glm-5.2', provider: 'glm-zcode' },
    ],
  );
  f.authStorage.credentials.push({ id: 28, provider: 'glm-zcode' });
  try {
    const run = f.host.handle(request('session.start', 'default-model-stored-fallback', {
      message: 'hello',
      options: { ...f.options, modelId: 'default', credential: { kind: 'stored' } },
    }));
    const session = await firstSession(f.sessions);
    session.complete();
    await run;
    assert.equal((f.factoryOptions[0]!.model as { provider: string }).provider, 'glm-zcode');
  } finally { await f.close(); }
});
test('default model profile resolves its selector without the thinking suffix', async () => {
  const f = await fixture('', 'contract-profile');
  try {
    const run = f.host.handle(request('session.start', 'default-model-profile', {
      message: 'hello',
      options: { ...f.options, modelId: 'default' },
    }));
    const session = await firstSession(f.sessions);
    session.complete();
    await run;
    assert.equal(f.factoryOptions[0]!.model && (f.factoryOptions[0]!.model as { id: string }).id, 'contract-model');
    assert.equal(((response(f.frames, 'default-model-profile').payload as Record<string, unknown>).result as Record<string, unknown>).model, 'contract-model');
  } finally { await f.close(); }
});
test('default model role fails closed when settings do not configure it', async () => {
  const f = await fixture('');
  try {
    await f.host.handle(request('session.start', 'missing-default-model', {
      message: 'hello',
      options: { ...f.options, modelId: 'default' },
    }));
    assert.equal((response(f.frames, 'missing-default-model').payload as Record<string, unknown>).ok, false);
    assert.equal(f.sessions.length, 0);
  } finally { await f.close(); }
});
test('default model role resolves through a provider only the auth layer can sign in', async () => {
  const f = await fixture(['glm-zcode53/glm-5.3:high'], undefined, [{ id: 'glm-5.3', provider: 'glm-zcode53' }]);
  f.authStorage.resolvableProviders.add('glm-zcode53');
  try {
    const run = f.host.handle(request('session.start', 'default-model-auth-layer', {
      message: 'hello',
      options: { ...f.options, modelId: 'default', credential: { kind: 'stored' } },
    }));
    const session = await firstSession(f.sessions);
    session.complete();
    await run;
    assert.equal((f.factoryOptions[0]!.model as { provider: string }).provider, 'glm-zcode53');
    // No stored row exists to pin, so no selector is installed and the runtime
    // resolves the provider's own credential (models.yml apiKey/apiKeyEnv).
    assert.equal(f.factoryOptions[0]!.credentialSelector, undefined);
  } finally { await f.close(); }
});
test('unresolvable default model answers with the model_unresolved code', async () => {
  const f = await fixture(['glm-zcode53/glm-5.3:high'], undefined, [{ id: 'glm-5.3', provider: 'glm-zcode53' }]);
  try {
    await f.host.handle(request('session.start', 'default-model-unresolved', {
      message: 'hello',
      options: { ...f.options, modelId: 'default', credential: { kind: 'stored' } },
    }));
    const payload = response(f.frames, 'default-model-unresolved').payload as Record<string, unknown>;
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.error, { code: GJC_MODEL_UNRESOLVED_CODE, message: GJC_MODEL_UNRESOLVED_MESSAGE });
    assert.equal(f.sessions.length, 0);
  } finally { await f.close(); }
});
test('a default model the warm registry has lost is found again after one refresh', async () => {
  const model = { id: 'glm-5.3', provider: 'glm-zcode53' };
  const f = await fixture(['glm-zcode53/glm-5.3:high'], undefined, [model]);
  f.authStorage.resolvableProviders.add('glm-zcode53');
  // The registry has dropped the role's model, as a warm worker's does after a
  // turn, and only a refresh brings it back.
  let refreshed = false;
  f.modelRegistry.getAvailable = () => (refreshed ? [model] : []);
  f.modelRegistry.getAll = () => (refreshed ? [model] : []);
  const refresh = f.modelRegistry.refresh.bind(f.modelRegistry);
  f.modelRegistry.refresh = async () => { refreshed = true; await refresh(); };
  try {
    const run = f.host.handle(request('session.start', 'default-model-refreshed', {
      message: 'hello',
      options: { ...f.options, modelId: 'default', credential: { kind: 'stored' } },
    }));
    const session = await firstSession(f.sessions);
    session.complete();
    await run;
    assert.deepEqual(f.trace.filter((entry) => entry === 'modelRegistry.refresh'), ['modelRegistry.refresh']);
    assert.equal(((response(f.frames, 'default-model-refreshed').payload as Record<string, unknown>).result as Record<string, unknown>).model, 'glm-5.3');
  } finally { await f.close(); }
});
test('a pinned model on a provider with no stored row runs without a credential selector', async () => {
  const f = await fixture('glm-zcode53/glm-5.3:high', undefined, [{ id: 'glm-5.3', provider: 'glm-zcode53' }]);
  f.authStorage.resolvableProviders.add('glm-zcode53');
  try {
    const run = f.host.handle(request('session.start', 'pinned-model-auth-layer', {
      message: 'hello',
      options: { ...f.options, modelId: 'glm-zcode53/glm-5.3', credential: { kind: 'stored' } },
    }));
    const session = await firstSession(f.sessions);
    session.complete();
    await run;
    assert.equal(f.factoryOptions[0]!.credentialSelector, undefined);
  } finally { await f.close(); }
});
test('resume fails closed when multiple files claim the provider session id', async () => {
  const f = await fixture();
  try {
    const providerSessionId = 'ambiguous-resume';
    const sessionFile = join(f.root, 'first.jsonl');
    await writeFile(sessionFile, `${JSON.stringify({
      type: 'session', version: 3, id: providerSessionId, timestamp: new Date().toISOString(), cwd: f.root,
    })}\n`);
    await copyFile(sessionFile, join(f.root, 'duplicate.jsonl'));
    await f.host.handle(request('session.resume', 'resume-ambiguous', {
      message: 'resume',
      options: f.options,
      providerSessionId,
    }));
    assert.equal(f.sessions.length, 0);
    assert.equal((response(f.frames, 'resume-ambiguous').payload as Record<string, unknown>).ok, false);
  } finally { await f.close(); }
});

for (const phase of ['before-first-event', 'during-ask', 'vs-prompt-resolve'] as const) {
  test(`abort ${phase} emits no terminal and reports aborted only after SDK abort`, async () => {
    const f = await fixture();
    try {
      const run = f.host.handle(request('session.start', `abort-${phase}`, { message: 'hello', options: f.options }));
      const session = await firstSession(f.sessions);
      await session.promptStarted.promise;
      if (phase === 'during-ask') {
        void session.uiContext!.select('Wait?', ['Continue']).catch(() => {});
        await Promise.resolve();
      }
      const abort = f.host.handle(request('turn.abort', `abort-request-${phase}`, { runId: `abort-${phase}` }));
      await session.abortStarted.promise;
      if (phase === 'vs-prompt-resolve') session.complete();
      await abort;
      await run;
      const abortPayload = response(f.frames, `abort-request-${phase}`).payload as Record<string, unknown>;
      assert.deepEqual(abortPayload, { ok: true, result: { runId: `abort-${phase}`, aborted: true } });
      assert.equal(methods(f.frames).filter((method) => method === 'turn.completed' || method === 'turn.failed').length, 0);
      assert.equal(session.disposed, true);
    } finally { await f.close(); }
  });
}
test('app automation is injected through the SDK built-in automationTools contract', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'automation-tools', {
      message: 'hello',
      options: f.options,
    }, 'app-session-a'));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    const factoryInput = f.factoryOptions[0]!;
    const automationTools = factoryInput.automationTools as Record<string, { name: string }>;
    assert.equal(factoryInput.customTools, undefined);
    assert.deepEqual(Object.keys(automationTools).sort(), ['browser', 'computer']);
    assert.equal(automationTools.browser?.name, 'browser');
    assert.equal(automationTools.computer?.name, 'computer');
    session.complete();
    await run;
  } finally { await f.close(); }
});
test('the production adapter passes bypass to automation without answering real questions', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gjc-automation-mode-'));
  const socketPath = join(directory, 'bridge.sock');
  const token = 'a'.repeat(64);
  const requests: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const incoming = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      requests.push(incoming);
      const result = incoming.operation === 'authorize'
        ? incoming.surface === 'browser'
          ? { granted: false, origin: 'https://example.com' }
          : { granted: false, application: 'com.apple.TextEdit', label: 'TextEdit' }
        : { success: true };
      socket.end(`${JSON.stringify({ id: incoming.id, ok: incoming.token === token, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const f = await fixture('contract-model', undefined, undefined, undefined, undefined, undefined, {
    automationBridge: { socketPath, token },
  });
  const runId = 'automation-bypass-mode';
  const run = f.host.handle(request('session.start', runId, {
    message: 'hello', options: { ...f.options, permissions: { mode: 'bypass', allowAlways: [] } },
  }, 'automation-app-session'));
  let session: FakeAgentSession | undefined;
  try {
    session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    const tools = f.factoryOptions[0]!.automationTools as AutomationTools;
    await tools.browser!.execute('browser-bypass', { action: 'open', url: 'https://example.com' }, AbortSignal.timeout(5_000));
    await tools.computer!.execute('computer-bypass', { action: 'click', arguments: { pid: 42, x: 1, y: 1 } }, AbortSignal.timeout(5_000));
    assert.equal(methods(f.frames).filter(method => method === 'ask.presented').length, 0);
    assert.deepEqual(requests.map(item => item.operation), ['authorize', 'open', 'authorize', undefined]);
    assert.ok(requests.every(item => item.sessionId === 'automation-app-session'));
    assert.ok(requests.every(item => !(item.payload as Record<string, unknown> | undefined)?.scope));

    const question = session.uiContext!.select('Choose a plan', ['A', 'B']);
    void question.catch(() => {});
    await Promise.resolve();
    const message = (f.frames.at(-1)!.payload as Record<string, unknown>).message as Record<string, unknown>;
    assert.equal(message.kind, 'permission_request');
    assert.equal(message.toolName, 'ask');
    await f.host.handle(request('ask.reply', 'answer-plan', { runId, requestId: message.requestId, decision: { allow: true, message: 'B' } }, 'automation-app-session'));
    assert.equal((response(f.frames, 'answer-plan').payload as Record<string, unknown>).ok, true);
    assert.equal(await question, 'B');
  } finally {
    session?.complete();
    await run;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('abort closes the app automation session before reporting success', async () => {
  const cleanup = deferred<void>();
  const closedSessions: string[] = [];
  const f = await fixture(
    'contract-model',
    undefined,
    { id: 'contract-model', provider: 'contract-provider' },
    undefined,
    undefined,
    undefined,
    {
      closeAutomationSession: async (appSessionId) => {
        closedSessions.push(appSessionId);
        await cleanup.promise;
      },
    },
  );
  try {
    const run = f.host.handle(request('session.start', 'abort-automation', {
      message: 'hello',
      options: f.options,
    }, 'app-session-a'));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    const abort = f.host.handle(request(
      'turn.abort',
      'abort-automation-request',
      { runId: 'abort-automation' },
      'app-session-a',
    ));
    await session.abortStarted.promise;
    await Promise.resolve();
    assert.deepEqual(closedSessions, ['app-session-a']);
    assert.equal(response(f.frames, 'abort-automation-request'), undefined);
    cleanup.resolve();
    await abort;
    await run;
    assert.deepEqual(
      (response(f.frames, 'abort-automation-request').payload as Record<string, unknown>).result,
      { runId: 'abort-automation', aborted: true },
    );
  } finally { await f.close(); }
});
test('failed SDK abort rolls back suppression and allows subsequent terminal events', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'abort-throws', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.abortError = new Error('abort failed');
    await f.host.handle(request('turn.abort', 'abort-throws-request', { runId: 'abort-throws' }));
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'still-live' } });
    session.complete();
    await run;
    assert.deepEqual((response(f.frames, 'abort-throws-request').payload as Record<string, unknown>).result, { runId: 'abort-throws', aborted: false });
    assert.ok(methods(f.frames).includes('message.delta'));
    assert.ok(methods(f.frames).includes('turn.completed'));
    // A rejected abort leaves the run active; its successful completion must
    // settle the start response as ok, not run_failed.
    assert.equal((response(f.frames, 'abort-throws').payload as Record<string, unknown>).ok, true);
  } finally { await f.close(); }
});
test('Stop pressed while the session is still being built ends the run before its prompt', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture();
  const inner = f.adapter['options'].createSessionFactory as GjcAgentSessionFactory;
  f.adapter['options'].createSessionFactory = (async (input: never) => { await gate; return inner(input); }) as GjcAgentSessionFactory;
  try {
    const run = f.host.handle(request('session.start', 'abort-early', { message: 'hello', options: f.options }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.sessions.length, 0, 'the session must still be under construction');
    await f.host.handle(request('turn.abort', 'abort-early-request', { runId: 'abort-early' }));
    assert.deepEqual((response(f.frames, 'abort-early-request').payload as Record<string, unknown>).result, { runId: 'abort-early', aborted: true });

    release();
    await run;
    const session = await firstSession(f.sessions);
    assert.equal(session.promptCalls, 0, 'an aborted run must not prompt');
    assert.equal(session.disposed, true);
    assert.equal((response(f.frames, 'abort-early').payload as Record<string, unknown>).ok, true);
    // No session id was announced: nothing was written that a later turn could resume.
    assert.equal(methods(f.frames).includes('session.created'), false);
    assert.equal(methods(f.frames).includes('turn.completed'), false);
    assert.equal(methods(f.frames).includes('turn.failed'), false);
  } finally { await f.close(); }
});
test('a refused abort does not answer for the next one', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'abort-retry', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.abortError = new Error('abort failed');
    await f.host.handle(request('turn.abort', 'abort-retry-1', { runId: 'abort-retry' }));
    assert.deepEqual((response(f.frames, 'abort-retry-1').payload as Record<string, unknown>).result, { runId: 'abort-retry', aborted: false });

    session.abortError = undefined;
    await f.host.handle(request('turn.abort', 'abort-retry-2', { runId: 'abort-retry' }));
    assert.deepEqual((response(f.frames, 'abort-retry-2').payload as Record<string, unknown>).result, { runId: 'abort-retry', aborted: true });
    await run;
  } finally { await f.close(); }
});
test('failed SDK abort keeps pending and subsequent asks available', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'abort-ask-throws', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.abortError = new Error('abort failed');
    const pending = session.uiContext!.select('First?', ['Yes']);
    await Promise.resolve();
    const firstRequestId = (((f.frames.at(-1)!.payload as Record<string, unknown>).message as Record<string, unknown>).requestId as string);
    await f.host.handle(request('turn.abort', 'abort-ask-throws-request', { runId: 'abort-ask-throws' }));
    await f.host.handle(request('ask.reply', 'first-after-abort', { runId: 'abort-ask-throws', requestId: firstRequestId, decision: { allow: true, message: 'Yes' } }));
    assert.equal(await pending, 'Yes');
    const subsequent = session.uiContext!.select('Second?', ['No']);
    await Promise.resolve();
    const secondRequestId = (((f.frames.at(-1)!.payload as Record<string, unknown>).message as Record<string, unknown>).requestId as string);
    await f.host.handle(request('ask.reply', 'second-after-abort', { runId: 'abort-ask-throws', requestId: secondRequestId, decision: { allow: true, message: 'No' } }));
    assert.equal(await subsequent, 'No');
    session.complete();
    await run;
  } finally { await f.close(); }
});

test('never-settling abort is bounded after the prompt settles', async () => {
  const f = await fixture();
  try {
    const frames: Array<Record<string, unknown>> = [];
    const host = new GjcWorkerHost({ runtime: async () => f.adapter, emit: (frame) => frames.push(frame as Record<string, unknown>), closeDrainMs: 10 });
    await host.handle(request('worker.initialize', 'bounded-init'));
    const run = host.handle(request('session.start', 'bounded-abort', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.neverSettleAbort = true;
    const abort = host.handle(request('turn.abort', 'bounded-abort-request', { runId: 'bounded-abort' }));
    await session.abortStarted.promise;
    session.complete();
    await Promise.all([abort, run]);
    assert.equal((response(frames, 'bounded-abort').payload as Record<string, unknown>).ok, false);
    assert.equal((response(frames, 'bounded-abort-request').payload as Record<string, unknown>).ok, false);
  } finally { await f.close(); }
});
test('late SDK abort resolution after the deadline cannot turn a failed run into an aborted success', async () => {
  const f = await fixture();
  try {
    const frames: Array<Record<string, unknown>> = [];
    const host = new GjcWorkerHost({ runtime: async () => f.adapter, emit: (frame) => frames.push(frame as Record<string, unknown>), closeDrainMs: 10 });
    await host.handle(request('worker.initialize', 'late-abort-init'));
    const run = host.handle(request('session.start', 'late-abort', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.abortDeferred = deferred<void>();
    const abort = host.handle(request('turn.abort', 'late-abort-request', { runId: 'late-abort' }));
    await session.abortStarted.promise;
    session.complete();
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.abortDeferred.resolve();
    await Promise.all([abort, run]);
    assert.equal((response(frames, 'late-abort').payload as Record<string, unknown>).ok, false);
    assert.equal((response(frames, 'late-abort-request').payload as Record<string, unknown>).ok, false);
    assert.equal(JSON.stringify(frames).includes('"aborted":true'), false);
  } finally { await f.close(); }
});
test('rejecting session disposal emits the fixed diagnostic and fails the run', async () => {
  const f = await fixture();
  const originalError = console.error;
  const diagnostics: unknown[][] = [];
  console.error = (...args: unknown[]) => { diagnostics.push(args); };
  try {
    const run = f.host.handle(request('session.start', 'dispose-rejects', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.disposeError = new Error('dispose failed');
    session.complete();
    await run;
    assert.equal((response(f.frames, 'dispose-rejects').payload as Record<string, unknown>).ok, false);
    assert.deepEqual(diagnostics, [['GJC SDK session disposal failed.']]);
    const terminals = f.frames.flatMap(frame => {
      const message = (frame.payload as { message?: Record<string, unknown> })?.message;
      return message?.kind === 'complete' ? [message.exitCode] : [];
    });
    assert.deepEqual(terminals, [], 'Node must emit the failure terminal only after verified worker reaping');
    assert.equal(((response(f.frames, 'dispose-rejects').payload as Record<string, unknown>).error as { code: string }).code,
      GJC_CLEANUP_UNCONFIRMED_CODE);
  } finally {
    console.error = originalError;
    await f.close();
  }
});

test('successful chat completion waits for SDK session cleanup', async () => {
  const f = await fixture();
  const release = deferred<void>();
  let closing = false;
  try {
    const run = f.host.handle(request('session.start', 'dispose-before-complete', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    const originalDispose = session.dispose.bind(session);
    session.dispose = async () => { closing = true; await release.promise; await originalDispose(); };
    session.complete();
    await waitFor(() => closing || undefined);
    assert.equal(methods(f.frames).includes('turn.completed'), false);
    release.resolve();
    await run;
    assert.equal(methods(f.frames).filter(method => method === 'turn.completed').length, 1);
    assert.equal(session.disposed, true);
  } finally { release.resolve(); await f.close(); }
});

test('explicit SDK configuration rejects missing fields, unresolvable credentials, and model mismatches without invoking the factory', async () => {
  const f = await fixture();
  try {
    const invalid = [
      (() => { const { spawns: _spawns, ...missing } = f.options; return missing; })(),
      { ...f.options, credential: { kind: 'stored', providerId: 'wrong-provider' } },
      { ...f.options, credential: { kind: 'stored', credentialId: 999 } },
      { ...f.options, modelId: 'unregistered-model' },
    ];
    f.authStorage.credentials = [
      { id: 2, provider: 'contract-provider' },
      { id: 7, provider: 'contract-provider' },
    ];
    for (const [index, options] of invalid.entries()) {
      await f.host.handle(request('session.start', `invalid-${index}`, { message: 'x', options }));
      assert.equal((response(f.frames, `invalid-${index}`).payload as Record<string, unknown>).ok, false);
    }
    assert.equal(f.sessions.length, 0);
    // Zero stored rows for the model provider stays fail-closed.
    f.authStorage.credentials = [];
    await f.host.handle(request('session.start', 'invalid-zero-rows', { message: 'x', options: { ...f.options, credential: { kind: 'stored' } } }));
    assert.equal((response(f.frames, 'invalid-zero-rows').payload as Record<string, unknown>).ok, false);
    assert.equal(f.sessions.length, 0);
    // Multiple stored rows resolve deterministically to the lowest row id.
    f.authStorage.credentials = [
      { id: 7, provider: 'contract-provider' },
      { id: 2, provider: 'contract-provider' },
    ];
    const run = f.host.handle(request('session.start', 'stored-deterministic', { message: 'x', options: { ...f.options, credential: { kind: 'stored' } } }));
    const session = await firstSession(f.sessions);
    session.complete();
    await run;
    const factoryInput = f.factoryOptions.at(-1) as { credentialSelector?: { selector: { value: string } } };
    assert.equal(factoryInput.credentialSelector?.selector.value, '2');
    assert.deepEqual(((response(f.frames, 'stored-deterministic').payload as Record<string, unknown>).result as Record<string, unknown>).credential, {
      kind: 'stored',
      providerId: 'contract-provider',
      credentialId: 2,
    });
  } finally { await f.close(); }
});

test('a run without a permissions block leaves the SDK gate on its own default', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'no-policy', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    assert.equal(session.sdkPermissionMode, 'allow');
    assert.equal(session.sdkPermissionProvider, undefined);
    session.complete();
    await run;
  } finally { await f.close(); }
});

test('a permissions block switches the SDK gate to prompt and answers it from the project policy', async () => {
  const f = await fixture();
  try {
    const options = { ...f.options, permissions: { mode: 'ask', allowAlways: ['bash'] } };
    const run = f.host.handle(request('session.start', 'policy', { message: 'hello', options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    assert.equal(session.sdkPermissionMode, 'prompt');
    assert.ok(session.sdkPermissionProvider);

    const runtimeOptions = [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ];
    // Covered by the allow-list: approved in the worker, noted once in the transcript.
    const approved = await session.sdkPermissionProvider!({ toolCallId: 'c1', toolName: 'bash', title: 'ls', rawInput: { command: 'ls' } }, runtimeOptions);
    assert.deepEqual(approved, { outcome: 'selected', optionId: 'allow_once', kind: 'allow_once' });
    const notice = f.frames.find((frame) => frame.kind === 'event' && ((frame.payload as Record<string, unknown>).message as Record<string, unknown> | undefined)?.kind === 'system_notice');
    assert.equal(((notice!.payload as Record<string, unknown>).message as Record<string, unknown>).content, 'Auto-approved bash (always allow)');

    // Not covered: a permission card crosses the protocol as ask.presented and waits for ask.reply.
    const pending = session.sdkPermissionProvider!({ toolCallId: 'c2', toolName: 'eval', title: 'eval', rawInput: { cells: [] } }, runtimeOptions);
    await Promise.resolve();
    const card = f.frames.at(-1)!;
    assert.equal(card.method, 'ask.presented');
    const message = (card.payload as Record<string, unknown>).message as Record<string, unknown>;
    assert.equal(message.kind, 'permission_request');
    assert.equal(message.toolName, 'eval');
    assert.match(message.requestId as string, /^sdk-permission:/);
    await f.host.handle(request('ask.reply', 'always-reply', { runId: 'policy', requestId: message.requestId, decision: { allow: true, always: true } }));
    assert.deepEqual((response(f.frames, 'always-reply').payload as Record<string, unknown>).result, { runId: 'policy', accepted: true });
    assert.deepEqual(await pending, { outcome: 'selected', optionId: 'allow_always', kind: 'allow_always' });

    session.complete();
    await run;
  } finally { await f.close(); }
});

test('a malformed permissions block fails the run before the factory is invoked', async () => {
  const f = await fixture();
  try {
    await f.host.handle(request('session.start', 'bad-policy', { message: 'x', options: { ...f.options, permissions: { mode: 'yolo' } } }));
    const payload = response(f.frames, 'bad-policy').payload as Record<string, unknown>;
    assert.equal(payload.ok, false);
    // The app sent the block, so the app is told which part of the run was
    // refused rather than the sanitized "GJC run failed.".
    assert.deepEqual(payload.error, { code: 'invalid_permissions', message: 'Invalid GJC run permissions.' });
    assert.equal(f.sessions.length, 0);
  } finally { await f.close(); }
});

test('ask bridge rejects duplicate and stale replies and cancels pending permission on dispose', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'ask-contract', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    const pending = session.uiContext!.select('Choose', ['One']);
    await Promise.resolve();
    const askFrame = f.frames.at(-1)!;
    const requestId = (((askFrame.payload as Record<string, unknown>).message as Record<string, unknown>).requestId as string);
    await f.host.handle(request('ask.reply', 'answerless-reply', { runId: 'ask-contract', requestId, decision: { allow: true } }));
    assert.deepEqual((response(f.frames, 'answerless-reply').payload as Record<string, unknown>).result, { runId: 'ask-contract', accepted: false });
    await f.host.handle(request('ask.reply', 'first-reply', { runId: 'ask-contract', requestId, decision: { allow: true, message: 'One' } }));
    await pending;
    await f.host.handle(request('ask.reply', 'duplicate-reply', { runId: 'ask-contract', requestId, decision: { allow: true } }));
    assert.deepEqual((response(f.frames, 'duplicate-reply').payload as Record<string, unknown>).result, { runId: 'ask-contract', accepted: false });
    const stale = session.uiContext!.select('Stale', ['No']);
    await Promise.resolve();
    await f.host.handle(request('turn.abort', 'abort-ask', { runId: 'ask-contract' }));
    await assert.rejects(stale, /GJC ask request cancelled/);
    await run;
    assert.equal(methods(f.frames).filter((method) => method === 'ask.presented').length, 3);
  } finally { await f.close(); }
});
test('ask dialogs cancel on AbortSignal and timeout after invoking onTimeout', async () => {
  const messages: Array<Record<string, unknown>> = [];
  const controller = new GjcBunAskController({ send: (message) => messages.push(message as Record<string, unknown>) });
  const signal = new AbortController();
  const aborted = controller.uiContext.select('Abort', ['No'], { signal: signal.signal });
  signal.abort();
  await assert.rejects(aborted, /GJC ask request cancelled/);
  let timedOut = false;
  const timeout = controller.uiContext.select('Timeout', ['No'], {
    timeout: 1,
    onTimeout: () => { timedOut = true; },
  });
  await assert.rejects(timeout, /GJC ask request cancelled/);
  assert.equal(timedOut, true);
  assert.equal(messages.filter((message) => message.kind === 'permission_cancelled').length, 2);
});

test('the SDK bootstrap initializes the global theme the ask tool renders every question through', async () => {
  await ensureSdkThemeInitialized();
  const { theme } = await import('@gajae-code/coding-agent/modes/theme/theme');

  // `ask` builds its selector labels from these symbols for every question
  // (`${theme.status.success} Done selecting`, `theme.checkbox.*`). Only the GJC
  // CLI entrypoints call `initTheme`, so before the bootstrap existed the first
  // option-bearing question threw "undefined is not an object (evaluating
  // 'theme.status')" and took the whole worker down.
  assert.equal(typeof theme.status.success, 'string');
  assert.ok(theme.status.success.length > 0);
  assert.equal(typeof theme.checkbox.checked, 'string');
  assert.equal(typeof theme.checkbox.unchecked, 'string');

  // Idempotent: a second bootstrap must not reload or swap the live instance.
  await ensureSdkThemeInitialized();
  assert.equal((await import('@gajae-code/coding-agent/modes/theme/theme')).theme, theme);
});

test('the pinned SDK ask tool still renders through the global theme instance', async () => {
  const askSource = await readFile(
    join(process.cwd(), 'node_modules', '@gajae-code', 'coding-agent', 'src', 'tools', 'ask.ts'),
    'utf8',
  );
  // Drift guard: if upstream stops dereferencing the process-global theme, this
  // fails and `ensureSdkThemeInitialized` can be dropped instead of lingering.
  assert.match(askSource, /theme\??\.status\??\./u);
  assert.match(askSource, /theme\??\.checkbox\??\./u);
});

test('the SDK runtime bootstrap initializes the theme before any session can ask', async () => {
  const adapterSource = await readFile(join(process.cwd(), 'server', 'gjc-bun-sdk-adapter.ts'), 'utf8');
  const bootstrap = adapterSource.slice(adapterSource.indexOf('export async function createGjcBunSdkAdapter'));
  // The worker builds its runtime here and nowhere else, so dropping this call
  // would leave every option-bearing ask crashing again with a passing suite.
  assert.match(bootstrap, /ensureSdkThemeInitialized\(\)/u);
});
test('production Bun worker verifies the manifest before accepting initialize and shuts down over stdio', async () => {
  const agentDirectory = await mkdtemp(join(tmpdir(), 'gjc-agent-'));
  try {
    const result = await runProductionWorker({
      GJC_ALLOW_RUNTIME_MANIFEST_OVERRIDE: undefined,
      GJC_RUNTIME_MANIFEST_PATH: undefined,
      GJC_WORKER_AGENT_DIR: agentDirectory,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual((response(result.frames, 'entry-init').payload as Record<string, unknown>).ok, true);
    assert.deepEqual((response(result.frames, 'entry-shutdown').payload as Record<string, unknown>).ok, true);
  } finally {
    await rm(agentDirectory, { recursive: true, force: true });
  }
});

test('production Bun worker rejects a tampered test-only manifest override', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gjc-manifest-'));
  const manifestPath = join(directory, 'gjc-runtime-manifest.json');
  try {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'server', 'gjc-runtime-manifest.json'), 'utf8')) as {
      platforms: Record<string, { files: Array<{ sha256: string }> }>;
    };
    manifest.platforms[`${process.platform}-${process.arch}`]!.files[0]!.sha256 = '0'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const agentDirectory = await mkdtemp(join(directory, 'agent-'));
    const result = await runProductionWorker({
      GJC_ALLOW_RUNTIME_MANIFEST_OVERRIDE: '1',
      GJC_RUNTIME_MANIFEST_PATH: manifestPath,
      GJC_WORKER_AGENT_DIR: agentDirectory,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /GJC runtime manifest override enabled/);
    const payload = response(result.frames, 'entry-init').payload as Record<string, unknown>;
    assert.equal(payload.ok, false);
    assert.deepEqual((payload.error as Record<string, unknown>).code, 'initialization_failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('live pinned SDK smoke (set GJC_CONTRACT_LIVE=1)', {
  skip: process.env.GJC_CONTRACT_LIVE === '1' ? false : 'requires GJC_CONTRACT_LIVE=1',
  timeout: 180_000, // Real provider initialization and reasoning exceed Bun's default 5s.
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-contract-live-'));
  try {
    const modelId = process.env.GJC_CONTRACT_LIVE_MODEL_ID;
    assert.ok(modelId, 'GJC_CONTRACT_LIVE_MODEL_ID is required for the live smoke');
    // Credential ref: "stored:<providerId>" uses the machine's real AuthStorage
    // row (the production shape); default stays runtime-env for CI safety.
    const credentialSpec = process.env.GJC_CONTRACT_LIVE_CREDENTIAL ?? 'runtime-env:GJC_RUNTIME_API_KEY';
    const credential = credentialSpec.startsWith('stored:')
      ? { kind: 'stored', providerId: credentialSpec.slice('stored:'.length) }
      : { kind: 'runtime-env', envVar: credentialSpec.slice('runtime-env:'.length) };
    const adapter = await createGjcBunSdkAdapter();
    const frames: Array<Record<string, unknown>> = [];
    const host = new GjcWorkerHost({ runtime: async () => adapter, emit: (frame) => frames.push(frame as Record<string, unknown>) });
    await host.handle(request('worker.initialize', 'live-init'));
    const options = {
      cwd: process.cwd(),
      sessionRoot: root,
      credential,
      modelId,
      toolNames: [],
      spawns: 'deny',
      bashPolicy: { allowedPrefixes: [] },
    };
    await host.handle(request('session.start', 'live-prompt', { message: 'Reply with the single word: ready', options }));
    assert.ok(methods(frames).includes('session.created'));
    assert.ok(methods(frames).includes('usage.updated'));
    assert.ok(methods(frames).includes('turn.completed'));

    const abortRun = host.handle(request('session.start', 'live-abort', { message: 'Think carefully for a long time before replying.', options }));
    for (let attempt = 0; attempt < 100 && methods(frames).filter((method) => method === 'session.created').length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await host.handle(request('turn.abort', 'live-abort-request', { runId: 'live-abort' }));
    await abortRun;
    assert.deepEqual((response(frames, 'live-abort-request').payload as Record<string, unknown>).result, { runId: 'live-abort', aborted: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a message sent during a run is steered into the turn already in flight', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'steer-live', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    assert.equal(session.promptCalls, 1);

    await f.host.handle(request('turn.steer', 'steer-live-request', { runId: 'steer-live', message: 'actually, use TypeScript' }));

    // Steering rides the session's own prompt(), which the SDK routes into its
    // steering queue while streaming — no second run is started for it.
    assert.deepEqual(
      response(f.frames, 'steer-live-request').payload,
      { ok: true, result: { runId: 'steer-live', steered: true } },
    );
    assert.equal(session.promptCalls, 2);
    assert.deepEqual(session.steeredMessages, ['actually, use TypeScript']);
    assert.deepEqual(session.steerBehaviors, ['steer']);
    assert.equal(f.sessions.length, 1);

    session.complete();
    await run;
  } finally { await f.close(); }
});

test('a settled turn refuses steering rather than silently starting another one', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'steer-settled', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.isStreaming = false;

    await f.host.handle(request('turn.steer', 'steer-settled-request', { runId: 'steer-settled', message: 'too late' }));

    assert.deepEqual(
      response(f.frames, 'steer-settled-request').payload,
      { ok: true, result: { runId: 'steer-settled', steered: false } },
    );
    assert.equal(session.promptCalls, 1);

    session.complete();
    await run;
  } finally { await f.close(); }
});

test('an aborting run refuses steering, because its turn is already ending', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'steer-aborting', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    // Hold the abort in flight so the run is observably mid-abort.
    session.abortDeferred = deferred<void>();
    const abort = f.host.handle(request('turn.abort', 'steer-aborting-abort', { runId: 'steer-aborting' }));
    await session.abortStarted.promise;

    await f.host.handle(request('turn.steer', 'steer-aborting-request', { runId: 'steer-aborting', message: 'wait' }));

    assert.deepEqual(
      response(f.frames, 'steer-aborting-request').payload,
      { ok: true, result: { runId: 'steer-aborting', steered: false } },
    );
    assert.equal(session.promptCalls, 1);
    assert.deepEqual(session.steeredMessages, []);

    session.abortDeferred.resolve();
    await abort;
    await run;
  } finally { await f.close(); }
});

test('steering an unknown run is refused instead of reaching the runtime', async () => {
  const f = await fixture();
  try {
    await f.host.handle(request('turn.steer', 'steer-missing', { runId: 'no-such-run', message: 'hello' }));

    const payload = response(f.frames, 'steer-missing').payload as Record<string, unknown>;
    assert.equal(payload.ok, false);
    assert.equal((payload.error as Record<string, unknown>).code, 'run_not_found');
  } finally { await f.close(); }
});

test('steering rejects a payload with nothing to say', async () => {
  const f = await fixture();
  try {
    const run = f.host.handle(request('session.start', 'steer-blank', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;

    await f.host.handle(request('turn.steer', 'steer-blank-request', { runId: 'steer-blank', message: '   ' }));

    const payload = response(f.frames, 'steer-blank-request').payload as Record<string, unknown>;
    assert.equal(payload.ok, false);
    assert.equal((payload.error as Record<string, unknown>).code, 'invalid_payload');
    assert.equal(session.promptCalls, 1);

    session.complete();
    await run;
  } finally { await f.close(); }
});

/*
 * The app's tool policy has to survive the real session-creation path, not just
 * be correct in isolation.
 *
 * `server/gjc-agent-tools.ts` reads as a closed allowlist, but the runtime
 * treats `toolNames` as a seed and appends to it from settings that default to
 * true - which is how goal mode ran in every browser session while the file
 * said it was withheld. The adapter now forces those settings on the per-run
 * clone, and this pins that it actually happens where a session is built.
 */
test('the first turn of a new session titles it from the first message and tells the app', async () => {
  const titleCalls: Array<{ firstMessage: string; model: unknown }> = [];
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, undefined, {
    generateSessionTitle: async (firstMessage, _registry, _settings, model) => {
      titleCalls.push({ firstMessage, model });
      return 'Fix the boot race';
    },
  });
  try {
    const run = f.host.handle(request('session.start', 'title-first', { message: 'why does boot hang on the second launch?', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.complete();
    await run;

    assert.deepEqual(titleCalls.map((call) => call.firstMessage), ['why does boot hang on the second launch?']);
    assert.deepEqual(titleCalls[0]?.model, { id: 'contract-model', provider: 'contract-provider' });
    const titled = f.frames.find((frame) => frame.kind === 'event' && (frame.payload as { message?: { kind?: string } })?.message?.kind === 'session_title');
    assert.ok(titled, 'the app never received the session_title message');
    const message = (titled.payload as { message: Record<string, unknown> }).message;
    // The title in the message is read back from the session manager after
    // `setSessionName` accepted it, so this also proves the runtime holds it
    // (the fake session writes no transcript, so the header lands on disk
    // only once a real turn creates the file).
    assert.equal(message.title, 'Fix the boot race');
    assert.equal(message.source, 'auto');
    assert.equal(typeof message.sessionId, 'string');
    // The title precedes the terminal frame: the turn waits for it.
    const order = f.frames.filter((frame) => frame.kind === 'event').map((frame) => (frame.payload as { message?: { kind?: string } })?.message?.kind);
    assert.ok(order.indexOf('session_title') < order.indexOf('complete'), `expected title before complete in ${order.join(',')}`);
  } finally { await f.close(); }
});

test('SDK activity retains late title generation and persistence after the UI grace expires', async () => {
  const generated = deferred<string | null>();
  const persisted = deferred<void>();
  const writing = deferred<void>();
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, undefined, {
    sessionTitleGraceMs: 0,
    generateSessionTitle: () => generated.promise,
  });
  try {
    const run = f.host.handle(request('session.start', 'late-title', { message: 'title-canary', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    const manager = f.factoryOptions[0]!.sessionManager as SessionManager;
    const setName = manager.setSessionName.bind(manager);
    manager.setSessionName = async (name, source) => {
      writing.resolve();
      await persisted.promise;
      return setName(name, source);
    };
    assert.equal(f.adapter.snapshotActivity().background, 1);
    session.complete();
    await run;
    assert.ok(f.frames.some((frame) => (frame.payload as { message?: { kind?: string } })?.message?.kind === 'complete'),
      'the title request must not hold UI completion past its grace period');
    const terminal = f.adapter.snapshotActivity();
    assert.equal(terminal.running + terminal.starting + terminal.settling, 0);
    assert.equal(terminal.background, 1, 'UI complete is not background task completion');
    assert.equal(JSON.stringify(terminal).includes('title-canary'), false);
    generated.resolve('Delayed title');
    await writing.promise;
    assert.equal(f.adapter.snapshotActivity().background, 1, 'title persistence is part of the owned task');
    persisted.resolve();
    await waitFor(() => f.adapter.snapshotActivity().background === 0 ? true : undefined);
    assert.ok(f.adapter.snapshotActivity().revision > terminal.revision);
    assert.notEqual(f.adapter.getGeneration(), terminal.generation);
    assert.equal(terminal.background, 1, 'earlier snapshots must remain detached');
  } finally {
    generated.resolve(null); persisted.resolve();
    for (const session of f.sessions) session.complete();
    await waitFor(() => f.adapter.snapshotActivity().background === 0 ? true : undefined);
    await f.close();
  }
});

for (const outcome of ['resolve', 'reject'] as const) {
  test(`SDK activity retains a title after user cancellation until its actual ${outcome}`, async () => {
    const generated = deferred<string | null>();
    const f = await fixture(undefined, undefined, undefined, undefined, undefined, undefined, {
      sessionTitleGraceMs: 0,
      generateSessionTitle: () => generated.promise,
    });
    try {
      const run = f.adapter.spawnGjc('cancel title', { ...f.options, runHandle: 'cancel-title' }, { send() {} });
      const session = await firstSession(f.sessions);
      await session.promptStarted.promise;
      const before = f.adapter.getGeneration();
      assert.equal(await f.adapter.abortGjcSession('cancel-title'), true);
      await run;
      const cancelled = f.adapter.snapshotActivity();
      assert.equal(cancelled.background, 1);
      assert.equal(cancelled.running + cancelled.starting + cancelled.settling + cancelled.operations, 0);
      assert.notEqual(cancelled.generation, before);
      if (outcome === 'resolve') generated.resolve(null);
      else generated.reject(new Error('late-title-credential-canary'));
      await waitFor(() => f.adapter.snapshotActivity().background === 0 ? true : undefined);
      assert.ok(f.adapter.snapshotActivity().revision > cancelled.revision);
      assert.equal(JSON.stringify(f.adapter.snapshotActivity()).includes('late-title-credential-canary'), false);
    } finally {
      generated.resolve(null);
      for (const session of f.sessions) session.complete();
      await waitFor(() => f.adapter.snapshotActivity().background === 0 ? true : undefined);
      await f.close();
    }
  });
}

test('SDK activity releases overlapping title tasks independently and absorbs synchronous generator failure', async () => {
  const first = deferred<string | null>();
  const second = deferred<string | null>();
  let titles = 0;
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, undefined, {
    sessionTitleGraceMs: 0,
    generateSessionTitle: () => {
      titles += 1;
      if (titles === 1) return first.promise;
      if (titles === 2) return second.promise;
      throw new Error('synchronous title failure');
    },
  });
  try {
    for (let index = 0; index < 3; index += 1) {
      const run = f.adapter.spawnGjc('title', { ...f.options, runHandle: `overlap-${index}` }, { send() {} });
      const session = await waitFor(() => f.sessions[index]);
      await session.promptStarted.promise;
      session.complete();
      await run;
    }
    assert.equal(f.adapter.snapshotActivity().background, 2);
    const before = f.adapter.getGeneration();
    second.reject(new Error('second title failure'));
    await waitFor(() => f.adapter.snapshotActivity().background === 1 ? true : undefined);
    assert.notEqual(f.adapter.getGeneration(), before);
    first.resolve(null);
    await waitFor(() => f.adapter.snapshotActivity().background === 0 ? true : undefined);
  } finally {
    first.resolve(null); second.resolve(null);
    for (const session of f.sessions) session.complete();
    await waitFor(() => f.adapter.snapshotActivity().background === 0 ? true : undefined);
    await f.close();
  }
});

test('SDK activity revisions cover reservation, SDK events and actual cleanup settlement', async () => {
  const disposed = deferred<void>();
  const f = await fixture();
  try {
    const initial = f.adapter.snapshotActivity();
    assert.equal(initial.complete, true);
    assert.equal(initial.revision, 0);
    const run = f.adapter.spawnGjc('hello', { ...f.options, runHandle: 'activity-root' }, { send() {} });
    const starting = f.adapter.snapshotActivity();
    assert.equal(starting.starting, 1, 'reserve before the first await');
    assert.ok(starting.revision > initial.revision);
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.disposeDeferred = disposed;
    const active = f.adapter.snapshotActivity();
    assert.equal(active.starting, 0);
    assert.equal(active.running, 1);
    assert.deepEqual(f.adapter.snapshotActivity(), active);
    assert.equal(f.adapter.getGeneration(), active.generation);
    session.emit({ type: 'tool_execution_start', toolCallId: 'canary', toolName: 'bash', args: { command: 'secret-command-canary' } });
    assert.notEqual(f.adapter.getGeneration(), active.generation);
    session.complete();
    await waitFor(() => session.disposed ? true : undefined);
    const settling = f.adapter.snapshotActivity();
    assert.equal(settling.settling, 1);
    assert.equal(settling.running + settling.starting, 0);
    assert.equal(JSON.stringify(settling).includes('secret-command-canary'), false);
    disposed.resolve();
    await run;
    const completed = f.adapter.snapshotActivity();
    assert.equal(completed.running + completed.starting + completed.settling + completed.background, 0);
    assert.ok(completed.revision > settling.revision);
    assert.equal(completed.complete, false, 'adapter counts alone do not prove SDK background containment');
    assert.deepEqual(completed.unknown, ['sdk_background_ownership_unproven']);
  } finally {
    disposed.resolve();
    for (const session of f.sessions) session.complete();
    await f.close();
  }
});

test('SDK activity keeps a user-abort operation owned after the run has completed', async () => {
  const automationClosed = deferred<void>();
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, undefined, {
    closeAutomationSession: async () => automationClosed.promise,
  });
  try {
    const run = f.adapter.spawnGjc('hello', { ...f.options, appSessionId: 'owned-app', runHandle: 'owned-abort' }, { send() {} });
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    const abort = f.adapter.abortGjcSession('owned-abort');
    assert.equal(f.adapter.snapshotActivity().operations, 1);
    await run;
    const waiting = f.adapter.snapshotActivity();
    assert.equal(waiting.running + waiting.starting + waiting.settling, 0);
    assert.equal(waiting.operations, 1);
    assert.deepEqual(f.adapter.snapshotActivity(), waiting, 'snapshot must never dispose work to become idle');
    automationClosed.resolve();
    assert.equal(await abort, true);
    assert.equal(f.adapter.snapshotActivity().operations, 0);
    assert.ok(f.adapter.snapshotActivity().revision > waiting.revision);
  } finally {
    automationClosed.resolve();
    for (const session of f.sessions) session.complete();
    await f.close();
  }
});

test('SDK activity composes OAuth cancellation settlement and revisions without inspecting credentials', async () => {
  const loginDone = deferred<void>();
  const loginStarted = deferred<void>();
  const f = await fixture(undefined, undefined, undefined, undefined, async () => {
    loginStarted.resolve();
    await loginDone.promise;
  });
  try {
    const initial = f.adapter.snapshotActivity();
    const attempt = f.adapter.oauth.start('openai-codex');
    assert.equal(typeof attempt.attemptId, 'string');
    assert.equal(f.adapter.snapshotActivity().oauth.starting, 1);
    assert.notEqual(f.adapter.getGeneration(), initial.generation);
    await loginStarted.promise;
    f.adapter.oauth.cancel(attempt.attemptId as string);
    const cancelled = f.adapter.snapshotActivity();
    assert.equal(cancelled.oauth.settling, 1);
    assert.ok(cancelled.revision > initial.revision);
    assert.deepEqual(f.adapter.snapshotActivity(), cancelled);
    const exportSnapshot = f.authStorage.exportSnapshot;
    f.authStorage.exportSnapshot = () => { throw new Error('activity must not access credentials'); };
    try { assert.deepEqual(f.adapter.snapshotActivity(), cancelled); }
    finally { f.authStorage.exportSnapshot = exportSnapshot; }
    loginDone.resolve();
    await waitFor(() => f.adapter.snapshotActivity().oauth.settling === 0 ? true : undefined);
    assert.ok(f.adapter.snapshotActivity().revision > cancelled.revision);
    assert.equal(f.adapter.snapshotActivity().complete, true, 'no SDK session was created');
  } finally {
    f.adapter.oauth.close(); loginDone.resolve();
    await waitFor(() => f.adapter.snapshotActivity().oauth.settling === 0 ? true : undefined);
    await f.close();
  }
});

test('adapter admission fences new roots but preserves accepted session startup and late title ownership', async () => {
  const settingsReady = deferred<Settings>();
  const titleDone = deferred<string | null>();
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, undefined, {
    loadSettings: () => settingsReady.promise,
    sessionTitleGraceMs: 0,
    generateSessionTitle: () => titleDone.promise,
  });
  try {
    const run = f.adapter.spawnGjc('accepted', { ...f.options, runHandle: 'accepted-before-fence' }, { send() {} });
    assert.equal(f.adapter.snapshotActivity().starting, 1);
    f.adapter.setAdmissionFence(true);
    assert.throws(() => f.adapter.spawnGjc('blocked', { ...f.options, runHandle: 'blocked' }, { send() {} }), { code: 'worker_admission_fenced' });
    assert.throws(() => f.adapter.oauth.start('openai-codex'), { code: 'worker_admission_fenced' });
    await assert.rejects(f.adapter.modelCatalog(), { code: 'worker_admission_fenced' });
    settingsReady.resolve(f.settings as unknown as Settings);
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    assert.equal(session.aborted, false, 'fencing does not abort an accepted root during startup');
    assert.equal(await f.adapter.steerGjcSession('accepted-before-fence', 'continue owned work'), true);
    session.complete();
    await run;
    assert.equal(f.adapter.observeActivity().settling, 1, 'the accepted title remains owned after terminal UI completion');
    titleDone.resolve(null);
    await waitFor(() => f.adapter.observeActivity().settling === 0 ? true : undefined);
    assert.deepEqual(f.adapter.observeActivity().unknown, ['sdk_background_ownership_unproven']);
    f.adapter.setAdmissionFence(false);
    assert.ok(Array.isArray((await f.adapter.modelCatalog()).models));
  } finally {
    titleDone.resolve(null);
    for (const session of f.sessions) session.complete();
    await f.close();
  }
});

test('worker observation certifies an unused SDK adapter and preserves OAuth unwind behind the fence', async () => {
  const loginDone = deferred<void>();
  const loginStarted = deferred<void>();
  const f = await fixture(undefined, undefined, undefined, undefined, async () => {
    loginStarted.resolve(); await loginDone.promise;
  });
  const observe = async (id: string) => {
    await f.host.handle(request('worker.activity', id));
    return (response(f.frames, id).payload as { result: { complete: boolean; settling: number; generation: string; unknown: string[] } }).result;
  };
  try {
    await f.host.handle(request('worker.admission', 'first-fence', { fenceId: 'f1', closed: true }));
    const first = await observe('first-idle');
    assert.equal(first.complete, true);
    assert.equal(first.settling, 0);
    assert.deepEqual(await observe('second-idle'), first);
    await f.host.handle(request('worker.admission', 'release', { fenceId: 'f1', closed: false }));
    const attempt = f.adapter.oauth.start('openai-codex');
    await loginStarted.promise;
    await f.host.handle(request('worker.admission', 'second-fence', { fenceId: 'f2', closed: true }));
    f.adapter.oauth.cancel(attempt.attemptId as string);
    assert.equal((await observe('unwind')).settling, 1);
    assert.equal(f.sessions.length, 0);
    loginDone.resolve();
    await waitFor(() => f.adapter.snapshotActivity().oauth.settling === 0 ? true : undefined);
    const settled = await observe('oauth-settled');
    assert.equal(settled.complete, true);
    assert.equal(settled.settling, 0);
    assert.deepEqual(settled.unknown, []);
  } finally {
    loginDone.resolve();
    await waitFor(() => f.adapter.snapshotActivity().oauth.settling === 0 ? true : undefined);
    await f.close();
  }
});

test('real SDK disposal completion is not broadened into an escaped-background ownership proof', async () => {
  const f = await identityFixture();
  try {
    await f.run('actual-sdk-disposal', async (session) => {
      assert.equal(typeof session.awaitDisposeCompletion, 'function');
      assert.equal(f.adapter.observeActivity().complete, false);
    });
    await f.sessions[0]!.awaitDisposeCompletion();
    // Stop future maintenance admission, not accepted work; an open registry
    // deliberately represents its next scheduled refresh as pending startup.
    f.adapter.setAdmissionFence(true);
    const actual = f.adapter.observeActivity();
    assert.equal(actual.starting + actual.running + actual.settling, 0);
    assert.deepEqual(actual.unknown, ['sdk_background_ownership_unproven']);
    assert.equal(actual.complete, false);
  } finally { await f.close(); }
});

test('missing constructor leaf owners remain unknown and real leaf revisions affect the worker proof', async () => {
  const f = await fixture();
  try {
    for (const [owner, reason] of [[f.authStorage, 'sdk_auth_ownership_unproven'],
      [f.modelRegistry, 'sdk_registry_ownership_unproven'], [f.settings, 'sdk_settings_ownership_unproven']] as const) {
      const read = owner.getAppLifecycleActivity;
      const state = { ...read(), generation: 'leaf:idle' };
      owner.getAppLifecycleActivity = () => ({ ...state, unknown: [...state.unknown] });
      const before = f.adapter.getGeneration();
      state.running = 1; state.generation = 'leaf:running';
      assert.ok(f.adapter.observeActivity().running > 0);
      assert.notEqual(f.adapter.getGeneration(), before);
      state.running = 0; state.generation = 'leaf:finished';
      assert.notEqual(f.adapter.getGeneration(), before, 'an idle/busy/idle cycle cannot reuse the proof');
      Object.defineProperty(owner, 'getAppLifecycleActivity', { configurable: true, writable: true, value: undefined });
      assert.ok(f.adapter.observeActivity().unknown.includes(reason));
      assert.equal(f.adapter.observeActivity().complete, false);
      owner.getAppLifecycleActivity = read;
    }
    assert.equal(f.adapter.observeActivity().complete, true);
  } finally { await f.close(); }
});

test('normal adapter cleanup joins real SDK retained cleanup past its public deadline', async () => {
  const held = deferred<void>();
  const cleaning = deferred<void>();
  const f = await identityFixture({ realPrompts: true, onCreated(session) {
    session.setDisposeTimeoutForTests(30);
    session.registerToolSessionCleanup(async () => { cleaning.resolve(); await held.promise; });
  } });
  registerCustomApi('identity-contract', () => {
    const stream = new AssistantMessageEventStream();
    const message = identityAnswer('Normal cleanup contract.');
    stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
  }, f.root);
  let completed = false;
  const run = f.host.handle(request('session.start', 'actual-sdk-timeout', { message: 'offline held cleanup', options: f.options }))
    .then(() => { completed = true; });
  try {
    await cleaning.promise;
    await assert.rejects(f.sessions[0]!.dispose(), (error) => error instanceof SessionDisposalIncompleteError);
    assert.equal(completed, false);
    assert.equal(f.adapter.observeActivity().settling, 1);
    assert.equal(f.adapter.observeActivity().unknown.includes('sdk_cleanup_unconfirmed'), false,
      'a public deadline is not a teardown failure while the exact retained owner remains joinable');
    held.resolve();
    await run;
    assert.equal((response(f.frames, 'actual-sdk-timeout').payload as { ok: boolean }).ok, true);
    assert.equal(f.adapter.observeActivity().settling, 0);
    assert.equal(f.adapter.observeActivity().unknown.includes('sdk_cleanup_unconfirmed'), false);
  } finally {
    held.resolve();
    await run;
    unregisterCustomApis(f.root);
    await f.close();
  }
});

test('real SDK post-prompt continuation remains owned across the adapter admission fence', async () => {
  const held = deferred<void>();
  const entered = deferred<void>();
  const f = await identityFixture({ realPrompts: true, onCreated(session) {
    let registered = false;
    session.subscribe((event: { type: string }) => {
      if (event.type !== 'agent_end' || registered) return;
      registered = true;
      // Public SDK test seam reserves the same owner used by its retry,
      // compaction and delivery continuations. No timers or commands replaced.
      session.trackPostPromptTaskForTests(held.promise);
      entered.resolve();
    });
  } });
  registerCustomApi('identity-contract', () => {
    const stream = new AssistantMessageEventStream();
    const message = identityAnswer('Post-prompt lifecycle.');
    stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
  }, f.root);
  let completed = false;
  const run = f.host.handle(request('session.start', 'owned-post-prompt', { message: 'offline continuation', options: f.options }))
    .then(() => { completed = true; });
  try {
    await entered.promise;
    f.adapter.setAdmissionFence(true);
    const pending = f.adapter.observeActivity();
    assert.equal(completed, false);
    assert.ok(pending.running + pending.starting + pending.settling > 0);
    held.resolve();
    await run;
    assert.equal((response(f.frames, 'owned-post-prompt').payload as { ok: boolean }).ok, true);
    const settled = f.adapter.observeActivity();
    assert.equal(settled.running + settled.starting + settled.settling, 0);
    assert.equal(settled.unknown.includes('sdk_cleanup_unconfirmed'), false);
  } finally {
    held.resolve(); await run;
    unregisterCustomApis(f.root);
    await f.close();
  }
});

test('SDK activity never treats empty diagnostics after background cleanup as proof of idle', async () => {
  const runnerDone = deferred<string>();
  const runnerStarted = deferred<void>();
  let runnerSettled = false;
  let retainedSettled = false;
  const manager = new AsyncJobManager({ onJobComplete: async () => {} });
  const f = await fixture();
  try {
    const run = f.adapter.spawnGjc('background work', { ...f.options, toolNames: ['bash'], runHandle: 'background-bash' }, { send() {} });
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    manager.register('bash', 'background-command-canary', async () => {
      runnerStarted.resolve();
      try { return await runnerDone.promise; }
      finally { runnerSettled = true; }
    });
    await runnerStarted.promise;
    let diagnosticsRead = false;
    Object.assign(session, {
      getAsyncJobSnapshot: () => { diagnosticsRead = true; return { running: [], recent: [] }; },
      pendingMessageCounts: { steering: 0, followUp: 0, nextTurn: 0 },
      hasPostPromptWork: false,
    });
    // Reproduce the SDK's lossy public diagnostic surface with its REAL job
    // manager: cancellation clears diagnostic rows while an ignoring runner
    // is still retained. This is a cleanup fixture, not updater-driven drain.
    session.dispose = async () => {
      assert.equal(await manager.dispose({ timeoutMs: 0 }), false);
      session.disposed = true;
    };
    session.complete();
    await run;
    const retained = manager.awaitRetainedDisposalCompletion().then(() => { retainedSettled = true; });
    assert.equal(manager.getRunningJobs().length, 0);
    assert.equal(runnerSettled, false);
    assert.equal(retainedSettled, false);
    const snapshot = f.adapter.snapshotActivity();
    assert.equal(snapshot.running + snapshot.starting + snapshot.settling + snapshot.background, 0);
    assert.equal(snapshot.complete, false);
    assert.deepEqual(snapshot.unknown, ['sdk_background_ownership_unproven']);
    assert.equal(diagnosticsRead, false, 'a read must not replace ownership proof with diagnostics');
    assert.equal(JSON.stringify(snapshot).includes('background-command-canary'), false);
    runnerDone.resolve('finished');
    await retained;
    assert.equal(runnerSettled, true);
    assert.equal(f.adapter.snapshotActivity().complete, false, 'the adapter has no complete SDK proof to clear the unknown');
  } finally {
    runnerDone.resolve('finished');
    for (const session of f.sessions) session.complete();
    await manager.dispose();
    await manager.awaitRetainedDisposalCompletion();
    await f.close();
  }
});

test('normal adapter cleanup retains the real SDK owner while an async-job runner ignores cancellation', { timeout: 10_000 }, async () => {
  const runnerDone = deferred<string>();
  const cancelled = deferred<void>();
  const managerDisposed = deferred<void>();
  let manager!: AsyncJobManager;
  let runnerSettled = false;
  const f = await identityFixture({ realPrompts: true, onCreated(session) {
    manager = AsyncJobManager.forEndpoint(session.sessionManager.getSessionId())!;
    assert.ok(manager, 'use this actual SDK session owner, never the process-global fallback');
    manager.register('bash', 'owned-cleanup-contract', async ({ signal }) => {
      signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      try { return await runnerDone.promise; }
      finally { runnerSettled = true; }
    }, { ownerId: session.getAgentId() });
    manager.onChange(() => { if (manager.getAllJobs().length === 0) managerDisposed.resolve(); });
    session.setDisposeTimeoutForTests(30);
  } });
  registerCustomApi('identity-contract', () => {
    const stream = new AssistantMessageEventStream();
    const message = identityAnswer('Normal async-job cleanup.');
    stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
  }, f.root);
  let completed = false;
  const run = f.host.handle(request('session.start', 'actual-owned-job', { message: 'offline owned job', options: f.options }))
    .then(() => { completed = true; });
  try {
    await cancelled.promise;
    await assert.rejects(f.sessions[0]!.dispose(), (error) => error instanceof SessionDisposalIncompleteError);
    // Wait for the SDK's REAL 3-second manager deadline. Its visible rows are
    // now gone, but awaitRetainedDisposalCompletion still owns the runner.
    await managerDisposed.promise;
    assert.deepEqual(manager.getAllJobs(), []);
    let retainedJoined = false;
    const retained = manager.awaitRetainedDisposalCompletion().then(() => { retainedJoined = true; });
    await Promise.resolve();
    assert.equal(retainedJoined, false);
    assert.equal(completed, false);
    assert.equal(runnerSettled, false);
    assert.equal(f.adapter.observeActivity().settling, 1);
    // No manager.dispose() call from the app/updater: the SDK's existing
    // normal session cleanup owns cancellation, disposal and retained joins.
    runnerDone.resolve('normal runner settled');
    await retained;
    await run;
    assert.equal(runnerSettled, true);
    assert.equal((response(f.frames, 'actual-owned-job').payload as { ok: boolean }).ok, true);
    assert.equal(f.adapter.observeActivity().settling, 0);
    assert.throws(() => manager.register('bash', 'after-close', async () => 'not admitted'), /disposed|shutting down/);
  } finally {
    runnerDone.resolve('finished');
    await run;
    unregisterCustomApis(f.root);
    await f.close();
  }
});

test('patched SDK retains Codex prewarm until physical completion while public disposal stays bounded', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gjc-sdk-prewarm-lifetime-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  const authStorage = await discoverAuthStorage(agentDir);
  const settings = await Settings.loadForScope({ cwd, agentDir });
  settings.override('memory.enabled', false);
  settings.override('skills.enabled', false);
  settings.override('startup.networkPrewarm', false);
  settings.override('providers.openaiWebsockets', 'on');
  const entered = deferred<void>();
  const release = deferred<void>();
  const settled = deferred<void>();
  let credentialPending = false;
  // Public injected dependency, not patched SDK commands/lifecycle or timers.
  // No token is returned, so this fixture cannot start a real WebSocket.
  class HeldCredentialRegistry extends ModelRegistry {
    override async getApiKey(..._args: Parameters<ModelRegistry['getApiKey']>): Promise<string | undefined> {
      credentialPending = true; entered.resolve();
      try { await release.promise; return undefined; }
      finally { credentialPending = false; settled.resolve(); }
    }
  }
  const registry = new HeldCredentialRegistry(authStorage, join(agentDir, 'models.yml'), settings, { agentDir });
  registry.registerProvider('prewarm-contract', {
    api: 'openai-codex-responses', apiKey: 'offline-unusable-key', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'astra', name: 'Offline lifecycle contract', reasoning: false,
      input: ['text'], contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    ({ session } = await createAgentSession({
      cwd, agentDir, settings, authStorage, modelRegistry: registry,
      model: registry.find('prewarm-contract', 'astra'),
      sessionManager: SessionManager.create(cwd, join(root, 'sessions')),
      toolNames: [], spawns: 'deny', enableMcpAutoload: false, enableLsp: false,
      skipPythonPreflight: true, disableExtensionDiscovery: true,
      skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
    }));
    await entered.promise;
    await session.waitForIdle();
    await session.awaitSessionSettlement();
    session.setDisposeTimeoutForTests(25);
    await assert.rejects(session.dispose(), (error) => error instanceof SessionDisposalIncompleteError);
    let joined = false;
    const completion = session.awaitDisposeCompletion().then(() => { joined = true; });
    await Promise.resolve();
    assert.equal(credentialPending, true);
    assert.equal(joined, false, 'caller timeout cannot release the retained prewarm owner');
    release.resolve();
    await settled.promise;
    await completion;
    assert.equal(session.isDisposed, true);
    assert.equal(joined, true);
    assert.equal(credentialPending, false);
  } finally {
    release.resolve();
    if (credentialPending) await settled.promise;
    await session?.dispose();
    await registry.dispose(); authStorage.close(); await settings.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the real patched runtime bootstrap mints only a nonserializable source-integrity receipt', async () => {
  const proof = await verifyRuntimeManifest();
  assert.equal(isVerifiedSdkPatch(proof), true);
  assert.equal(isVerifiedSdkPatch({ ...proof }), false);
  assert.equal(isVerifiedSdkPatch(JSON.parse(JSON.stringify(proof))), false);
  // This receipt is deliberately not used to clear unknown streaming/extension
  // ownership. The actual component observations still decide runtime safety.
});

test('SDK activity retains cleanup failure as unknown and never clears it on a read', async () => {
  const f = await fixture();
  try {
    const run = f.adapter.spawnGjc('hello', { ...f.options, runHandle: 'failed-cleanup' }, { send() {} });
    const failed = assert.rejects(run, { name: 'GjcCleanupUnconfirmedError' });
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.disposeError = new Error('cleanup-secret-canary');
    session.complete();
    await failed;
    const snapshot = f.adapter.snapshotActivity();
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.settling, 1);
    assert.deepEqual(snapshot.unknown, ['sdk_background_ownership_unproven', 'sdk_cleanup_unconfirmed']);
    assert.deepEqual(f.adapter.snapshotActivity(), snapshot);
    assert.equal(f.adapter.getGeneration(), snapshot.generation);
    assert.equal(JSON.stringify(snapshot).includes('cleanup-secret-canary'), false);
  } finally { await f.close(); }
});

test('a generator that declines leaves the session untitled, and a resumed session is never retitled', async () => {
  let calls = 0;
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, undefined, {
    generateSessionTitle: async () => { calls += 1; return null; },
  });
  try {
    const first = f.host.handle(request('session.start', 'title-none', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);
    await session.promptStarted.promise;
    session.complete();
    await first;
    assert.equal(calls, 1);
    assert.equal(f.frames.some((frame) => (frame.payload as { message?: { kind?: string } })?.message?.kind === 'session_title'), false);

    // A later turn resumes an existing transcript: titling is the first turn's job only.
    const providerSessionId = 'already-running';
    await writeFile(join(f.root, 'running.jsonl'), `${JSON.stringify({
      type: 'session', version: 3, id: providerSessionId, timestamp: new Date().toISOString(), cwd: f.root,
    })}\n`);
    const second = f.host.handle(request('session.resume', 'title-resume', { message: 'and again', options: f.options, providerSessionId }));
    for (let attempt = 0; attempt < 100 && !f.sessions[1]; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    const resumed = f.sessions[1]!;
    await resumed.promptStarted.promise;
    resumed.complete();
    await second;

    assert.equal(calls, 1, 'a resumed session must not be retitled');
  } finally { await f.close(); }
});

test('starting a session forces the tool settings the app policy declares', async () => {
  const f = await fixture();
  try {
    // Not awaited: `session.start` settles only when the turn completes, and
    // the policy is applied while the session is being built.
    const run = f.host.handle(request('session.start', 'tool-policy', { message: 'hello', options: f.options }));
    const session = await firstSession(f.sessions);

    assert.equal(f.toolPolicyOverrides.get('goal.enabled'), false);
    assert.equal(f.toolPolicyOverrides.get('astEdit.enabled'), false);

    session.complete();
    await run;
  } finally {
    await f.close();
  }
});
