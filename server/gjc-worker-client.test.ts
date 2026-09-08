import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';

import type { DesktopOwnerActivity } from '../shared/desktopUpdateProtocol.js';

import { DesktopRestartAuthority, type DesktopRestartAuthorityOptions } from './services/desktop-restart-authority.js';
import { createDesktopRestartRuntime, DESKTOP_RESTART_REQUIRED_OWNERS } from './services/desktop-restart-runtime.js';
import { GjcWorkerHost, type GjcWorkerRuntime } from './gjc-worker.js';
import {
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  GjcWorkerSupervisor,
  createGjcWorkerDesktopRestartReader,
  getGjcWorkerSupervisor,
  killWorkerTree,
  resolveGjcResumeSessionRoot,
} from './gjc-worker-client.js';
import { GJC_MODEL_UNRESOLVED_CODE, GJC_MODEL_UNRESOLVED_MESSAGE } from './gjc-model-resolution.js';
import { GJC_CLEANUP_UNCONFIRMED_CODE } from './gjc-engine.js';
import {
  GJC_WINDOWS_JOB_GUARD_ACK,
  GJC_WINDOWS_JOB_GUARD_READY,
} from './gjc-windows-job.js';
import {
  GJC_WORKER_PROTOCOL_VERSION,
  GjcWorkerNdjsonDecoder,
  serializeGjcWorkerFrame,
  GJC_WORKER_MAX_FRAME_BYTES,
  type GjcWorkerEventFrame,
  type GjcWorkerRequestFrame,
  type GjcWorkerResponseFrame,
  type JsonObject,
} from './gjc-worker-protocol.js';
let runSequence = 0;
function spawn(
  supervisor: GjcWorkerSupervisor,
  message: string,
  options: Parameters<GjcWorkerSupervisor['spawnRun']>[0]['options'] = {},
  writer: Parameters<GjcWorkerSupervisor['spawnRun']>[0]['writer'],
): Promise<void> & { abortHandle: string } {
  const appSessionId = writer.getAppSessionId?.()
    ?? (supervisor as unknown as { runtime: { createScope?: () => string } }).runtime.createScope?.()
    ?? 'app-session-1';
  const run = supervisor.spawnRun({
    runId: `test-run-${++runSequence}`,
    appSessionId,
    message,
    options,
    writer,
  });
  const completion = run.completion as Promise<void> & { abortHandle: string };
  completion.abortHandle = run.abortHandle;
  return completion;
}

test('resume root resolution selects either allowlisted store from indexed session metadata', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'gjc-resume-enrichment-'));
  const liveRoot = join(tempDirectory, 'live-sessions');
  const savedRoot = join(homedir(), '.gjc', 'agent', 'sessions');
  const savedDirectory = join(savedRoot, `gjc-worker-client-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await Promise.all([mkdir(liveRoot, { recursive: true }), mkdir(savedDirectory, { recursive: true })]);
    const paths = {
      live: join(liveRoot, 'live.jsonl'),
      saved: join(savedDirectory, 'saved.jsonl'),
    };
    await Promise.all([writeFile(paths.live, '{}\n'), writeFile(paths.saved, '{}\n')]);
    const lookup = async (sessionId: string) => paths[sessionId as keyof typeof paths];

    // The resolver returns the directory SessionManager must scan. macOS
    // resolves the temp store under /var to /private/var, so normalize
    // expectations too.
    assert.equal(await resolveGjcResumeSessionRoot('live', liveRoot, lookup), await realpath(liveRoot));
    assert.equal(await resolveGjcResumeSessionRoot('saved', liveRoot, lookup), await realpath(savedDirectory));
  } finally {
    await Promise.all([
      rm(tempDirectory, { recursive: true, force: true }),
      rm(savedDirectory, { recursive: true, force: true }),
    ]);
  }
});
// The supervisor intentionally unrefs its internal timers so a shutting-down
// application is never kept alive. Tests that await only those timers would let
// the event loop drain before they fire (observed on macOS), so hold one
// referenced handle for the lifetime of this file.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0);
    this.emit('close', 0);
    return true;
  }
}
class ReapFakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 12_345;
  killCount = 0;

  kill(): boolean {
    this.killCount += 1;
    return true;
  }
}

class FakePeer {
  readonly requests: GjcWorkerRequestFrame[] = [];
  readonly #decoder = new GjcWorkerNdjsonDecoder();
  #handler: (request: GjcWorkerRequestFrame) => void = () => {};

  constructor(readonly child: FakeChild, guarded = false) {
    let guardInput = Buffer.alloc(0);
    child.stdin.on('data', (chunk: Buffer) => {
      let protocolChunk = chunk;
      if (guarded) {
        guardInput = Buffer.concat([guardInput, chunk]);
        const newline = guardInput.indexOf(0x0a);
        if (newline < 0) return;
        assert.equal(
          guardInput.subarray(0, newline).toString('utf8'),
          GJC_WINDOWS_JOB_GUARD_ACK,
        );
        protocolChunk = guardInput.subarray(newline + 1);
        guardInput = Buffer.alloc(0);
        guarded = false;
      }
      if (protocolChunk.length === 0) return;
      for (const frame of this.#decoder.push(protocolChunk)) {
        assert.equal(frame.kind, 'request');
        const request = frame as GjcWorkerRequestFrame;
        this.requests.push(request);
        this.#handler(request);
      }
    });
  }

  handle(handler: (request: GjcWorkerRequestFrame) => void): void {
    this.#handler = handler;
  }

  respond(
    request: GjcWorkerRequestFrame,
    payload: GjcWorkerResponseFrame['payload'] = { ok: true },
  ): void {
    const frame = {
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'response',
      id: request.id,
      method: request.method,
      ...('sessionId' in request ? { sessionId: request.sessionId } : {}),
      payload,
    } as GjcWorkerResponseFrame;
    this.child.stdout.write(serializeGjcWorkerFrame(frame));
  }

  event(
    sessionId: string,
    runId: string,
    method: Exclude<GjcWorkerEventFrame['method'], 'worker.status'>,
    payload: JsonObject = {},
  ): void {
    const frame: GjcWorkerEventFrame = {
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      id: `event-${this.requests.length}-${Math.random()}`,
      method,
      sessionId,
      payload: { runId, ...payload },
    };
    this.child.stdout.write(serializeGjcWorkerFrame(frame));
  }

  status(sessionId: string, runId: string, processId: number | null): void {
    const frame: GjcWorkerEventFrame = {
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      id: `status-${this.requests.length}-${Math.random()}`,
      method: 'worker.status',
      sessionId,
      payload: { runId, processId },
    };
    this.child.stdout.write(serializeGjcWorkerFrame(frame));
  }

  async waitFor(
    method: GjcWorkerRequestFrame['method'],
    count = 1,
  ): Promise<GjcWorkerRequestFrame> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const matches = this.requests.filter((request) => request.method === method);
      if (matches.length >= count) return matches[count - 1];
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${method}.`);
  }
}

function runtime(child: FakeChild, scope = 'app-session-1') {
  return {
    spawn: () => child,
    corePath: '/test/gajae-core',
    workerPath: '/test/gjc-bun-worker.js',
    bunPath: '/test/bun',
    compiled: true,
    createScope: () => scope,
    notifyRunStopped: () => {},
    notifyRunFailed: () => {},
  };
}
test('killWorkerTree reaps a process group that forms after the initial kill', async () => {
  const child = new ReapFakeChild();
  let groupKillCount = 0;
  let closeScheduled = false;
  const esrch = (): Error & { code: string } => Object.assign(new Error('No such process.'), { code: 'ESRCH' });
  const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
    assert.equal(pid, -child.pid);
    if (signal === 0) throw esrch();

    groupKillCount += 1;
    if (groupKillCount < 3) throw esrch();
    if (!closeScheduled) {
      closeScheduled = true;
      queueMicrotask(() => child.emit('close', 0));
    }
  };

  await killWorkerTree(child, 'darwin', kill);

  assert.equal(groupKillCount >= 3, true);
  assert.equal(child.killCount >= 2, true);
});

test('killWorkerTree rejects when a process group cannot be verified as terminated', { timeout: 6_000 }, async () => {
  const child = new ReapFakeChild();
  const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
    assert.equal(pid, -child.pid);
    if (signal === 0) return;
  };

  await assert.rejects(
    killWorkerTree(child, 'darwin', kill),
    /GJC worker tree termination timed out/,
  );
});
test('killWorkerTree waits through an EPERM process-group verification window', { timeout: 1_000 }, async () => {
  const child = new ReapFakeChild();
  let probeCount = 0;
  let closeScheduled = false;
  const eperm = (): Error & { code: string } => Object.assign(new Error('Operation not permitted.'), { code: 'EPERM' });
  const esrch = (): Error & { code: string } => Object.assign(new Error('No such process.'), { code: 'ESRCH' });
  const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
    assert.equal(pid, -child.pid);
    if (signal === 'SIGKILL') throw eperm();

    probeCount += 1;
    if (probeCount <= 10) throw eperm();
    if (!closeScheduled) {
      closeScheduled = true;
      queueMicrotask(() => child.emit('close', 0));
    }
    throw esrch();
  };

  await killWorkerTree(child, 'darwin', kill);

  assert.equal(probeCount, 12);
  assert.equal(child.killCount >= 11, true);
});

test('killWorkerTree fails closed when process-group verification remains EPERM', { timeout: 6_000 }, async () => {
  const child = new ReapFakeChild();
  const eperm = (): Error & { code: string } => Object.assign(new Error('Operation not permitted.'), { code: 'EPERM' });
  const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
    assert.equal(pid, -child.pid);
    throw eperm();
  };

  await assert.rejects(
    killWorkerTree(child, 'darwin', kill),
    /GJC worker tree termination timed out/,
  );
});

function replyToHandshake(peer: FakePeer): void {
  peer.handle((request) => {
    if (request.method === 'worker.initialize') peer.respond(request);
  });
}

test('launches the Windows worker behind an atomic kill-on-close job guard', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child, true);
  peer.handle((request) => peer.respond(request));
  let command = '';
  let args: string[] = [];
  let spawnOptions: {
    detached?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {};
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    platform: 'win32',
    environment: {
      SystemRoot: 'C:\\Windows',
      KEEP_ME: 'yes',
    },
    spawn: (workerCommand, workerArgs, options) => {
      command = workerCommand;
      args = workerArgs;
      spawnOptions = options;
      return child;
    },
  });

  const run = spawn(supervisor, 'hello', {}, { send() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peer.requests.length, 0);
  child.stdout.write(`${GJC_WINDOWS_JOB_GUARD_READY}\n`);
  await run;

  assert.equal(
    command,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(args.at(-2), '-EncodedCommand');
  assert.equal(spawnOptions.detached, false);
  assert.equal(spawnOptions.env?.KEEP_ME, 'yes');
  assert.equal(
    spawnOptions.env?.GAJAE_INTERNAL_JOB_APPLICATION,
    '/test/gajae-core',
  );
  assert.equal(
    peer.requests.filter((request) => request.method === 'worker.initialize').length,
    1,
  );
  assert.match(
    spawnOptions.env?.GAJAE_INTERNAL_JOB_COMMAND_LINE ?? '',
    /gjc-bun-worker\.js/,
  );
});

test('fails closed when the Windows job guard never proves app ownership', async () => {
  const child = new FakeChild();
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    initializeTimeoutMs: 5,
  });

  await assert.rejects(
    spawn(supervisor, 'hello', {}, { send() {} }),
    /GJC worker failed/,
  );

  assert.equal(child.killed, false);
});

test('shares one handshake and sends one start request per concurrent run', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  peer.handle((request) => peer.respond(request));
  let command = '';
  let args: string[] = [];
  let detached: boolean | undefined;
  let launchEnvironment: NodeJS.ProcessEnv | undefined;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    spawn: (workerCommand, workerArgs, options) => {
      command = workerCommand;
      args = workerArgs;
      detached = options.detached;
      launchEnvironment = options.env;
      return child;
    },
  });

  await Promise.all([
    spawn(supervisor, 'first', { sessionId: null, model: 'x' }, { send() {} }),
    spawn(supervisor, 'second', {}, { send() {} }),
  ]);

  assert.equal(peer.requests.filter((request) => request.method === 'worker.initialize').length, 1);
  const starts = peer.requests.filter((request) => request.method === 'session.start');
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0]?.payload, { message: 'first', options: { model: 'x' } });
  assert.equal(peer.requests.some((request) => request.method === 'turn.start'), false);
  assert.equal(detached, process.platform !== 'win32');
  assert.equal(environmentExtendsProcessEnvWithAgentDir(launchEnvironment), true);
  assert.equal(command, '/test/gajae-core');
  assert.deepEqual(args, ['--', '/test/bun', '/test/gjc-bun-worker.js']);
});
test('spawnRun preserves caller-owned identifiers and resolves started when its request is written', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  const supervisor = new GjcWorkerSupervisor(runtime(child));
  const run = supervisor.spawnRun({
    runId: 'run-caller-owned',
    appSessionId: 'app-caller-owned',
    message: 'hello',
    options: {},
    writer: { send() {} },
  });
  peer.respond(await peer.waitFor('worker.initialize'));
  const request = await peer.waitFor('session.start');
  await run.started;
  assert.equal(request.id, 'run-caller-owned');
  assert.equal('sessionId' in request ? request.sessionId : undefined, 'app-caller-owned');
  peer.respond(request);
  await run.completion;
  assert.equal(await run.outcome, 'completed');
});
test('rejects an oversized start frame as not_started without terminating its worker generation', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  const supervisor = new GjcWorkerSupervisor(runtime(child));
  const oversized = supervisor.spawnRun({
    runId: 'oversized-start',
    appSessionId: 'app-oversized',
    message: 'x'.repeat(GJC_WORKER_MAX_FRAME_BYTES),
    options: {},
    writer: { send() {} },
  });
  peer.respond(await peer.waitFor('worker.initialize'));
  await assert.rejects(oversized.started);
  assert.equal(await oversized.outcome, 'not_started');
  assert.equal(child.killed, false);

  const next = spawn(supervisor, 'hello', {}, { send() {} });
  peer.respond(await peer.waitFor('session.start'));
  await next;
});

/**
 * The launch env is process.env extended by exactly one injected key:
 * GJC_WORKER_AGENT_DIR (explicit app-owned auth/config injection, F12).
 */
function environmentExtendsProcessEnvWithAgentDir(environment: NodeJS.ProcessEnv | undefined): boolean {
  if (!environment) return false;
  const keys = new Set(Object.keys(environment));
  if (typeof environment.GJC_WORKER_AGENT_DIR !== 'string' || environment.GJC_WORKER_AGENT_DIR.length === 0) return false;
  for (const key of Object.keys(process.env)) {
    if (key === 'GJC_WORKER_AGENT_DIR') continue;
    if (environment[key] !== process.env[key]) return false;
    keys.delete(key);
  }
  keys.delete('GJC_WORKER_AGENT_DIR');
  return keys.size === 0;
}

test('wraps the source worker with Bun while only adding the injected agent directory', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  peer.handle((request) => peer.respond(request));
  let args: string[] = [];
  let environment: NodeJS.ProcessEnv | undefined;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    compiled: false,
    workerPath: '/test/gjc-bun-worker.ts',
    spawn: (_command, workerArgs, options) => {
      args = workerArgs;
      environment = options.env;
      return child;
    },
  });

  await spawn(supervisor, 'source', {}, { send() {} });

  assert.deepEqual(args, ['--', '/test/bun', '/test/gjc-bun-worker.ts']);
  assert.equal(environmentExtendsProcessEnvWithAgentDir(environment), true);
});

test('fails safely when the native core cannot launch without a Node fallback', async () => {
  const commands: string[] = [];
  const supervisor = new GjcWorkerSupervisor({
    corePath: '/missing/gajae-core',
    workerPath: '/test/gjc-worker.js',
    compiled: true,
    bunPath: '/test/bun',
    spawn: (command) => {
      commands.push(command);
      throw new Error('missing');
    },
    notifyRunStopped: () => {},
    notifyRunFailed: () => {},
  });

  await assert.rejects(
    spawn(supervisor, 'hello', {}, { send() {} }),
    /GJC worker failed/,
  );
  assert.deepEqual(commands, ['/missing/gajae-core']);
});

test('resumes by provider session and forwards events using immutable run identity', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const messages: unknown[] = [];
  let providerSessionId = '';
  const supervisor = new GjcWorkerSupervisor(runtime(child, 'app-2'));
  const run = spawn(supervisor, 'hello', { sessionId: 'provider-old' }, {
    send: (value) => messages.push(value),
    setSessionId: (id) => { providerSessionId = id; },
  });
  const request = await peer.waitFor('session.resume');

  assert.deepEqual(request.payload, {
    message: 'hello',
    options: {},
    providerSessionId: 'provider-old',
  });
  peer.event('app-2', request.id, 'session.created', { providerSessionId: 'provider-new' });
  peer.event('app-2', request.id, 'message.delta', {
    message: { kind: 'stream_delta', content: 'kept' },
  });
  peer.respond(request);
  await run;

  assert.equal(providerSessionId, 'provider-new');
  assert.deepEqual(
    messages.filter((message) => (message as { kind?: string }).kind === 'stream_delta'),
    [{ kind: 'stream_delta', content: 'kept' }],
  );
});

test('aborting before the start request prevents the run from reaching the worker', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  const supervisor = new GjcWorkerSupervisor(runtime(child, 'app-prestart'));
  const run = spawn(supervisor, 'hello', {}, { send() {} });

  assert.equal(await supervisor.abort(run.abortHandle), 'not_started');
  peer.respond(await peer.waitFor('worker.initialize'));
  await run;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(peer.requests.some((request) => request.method === 'session.start'), false);
  assert.equal(peer.requests.some((request) => request.method === 'turn.abort'), false);
});

test('aborts an issued run by runId and waits for its terminal start response', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const supervisor = new GjcWorkerSupervisor(runtime(child, 'app-abort'));
  const sent: unknown[] = [];
  const run = spawn(supervisor, 'hello', {}, { send: value => sent.push(value) });
  const start = await peer.waitFor('session.start');
  let settled = false;
  void run.then(() => { settled = true; });

  const abortResult = supervisor.abort(run.abortHandle);
  const abort = await peer.waitFor('turn.abort');
  assert.deepEqual(abort.payload, { runId: start.id });
  peer.respond(abort, { ok: true, result: { runId: start.id, aborted: true } });
  assert.equal(await abortResult, 'aborted');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  peer.respond(start, { ok: true, result: { runId: start.id, aborted: true } });
  await run;
  assert.equal(settled, true);
  assert.equal(sent.length, 0, 'the explicit abort caller retains terminal ownership');
});

test('keeps a run active when the worker cannot confirm abort', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const supervisor = new GjcWorkerSupervisor(runtime(child, 'app-abort-failed'));
  const run = spawn(supervisor, 'hello', {}, { send() {} });
  const start = await peer.waitFor('session.start');

  const abortResult = supervisor.abort(run.abortHandle);
  const abort = await peer.waitFor('turn.abort');
  peer.respond(abort, {
    ok: true,
    result: { runId: start.id, aborted: false },
  });

  assert.equal(await abortResult, 'unconfirmed');
  assert.equal(supervisor.isActive(run.abortHandle), true);
  peer.respond(start);
  await run;
});
test('joins concurrent alias termination requests to one worker generation reap', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  let releaseReap!: () => void;
  const reapGate = new Promise<void>((resolve) => { releaseReap = resolve; });
  const supervisor = new GjcWorkerSupervisor({ ...runtime(child), killTree: () => reapGate });
  const first = spawn(supervisor, 'one', {}, { send() {} });
  const second = spawn(supervisor, 'two', {}, { send() {} });
  const firstStart = await peer.waitFor('session.start');
  const secondStart = await peer.waitFor('session.start', 2);
  peer.event('app-session-1', firstStart.id, 'session.created', { providerSessionId: 'provider-one' });
  peer.event('app-session-1', secondStart.id, 'session.created', { providerSessionId: 'provider-two' });

  const firstTermination = supervisor.terminate('provider-one');
  const secondTermination = supervisor.terminate('provider-two');
  releaseReap();

  assert.deepEqual(await Promise.all([firstTermination, secondTermination]), ['reaped', 'reaped']);
  await assert.rejects(first, /GJC worker failed/);
  await assert.rejects(second, /GJC worker failed/);
});

test('mirrors approval replay, reply, and cancellation in app-owned state', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const messages: unknown[] = [];
  const supervisor = new GjcWorkerSupervisor(runtime(child, 'app-approval'));
  const run = spawn(supervisor, 'hello', {}, { send: (value) => messages.push(value) });
  const start = await peer.waitFor('session.start');
  const approval = { kind: 'permission_request', requestId: 'request-1', toolName: 'Bash' };

  peer.event('app-approval', start.id, 'ask.presented', { message: approval });
  assert.deepEqual(supervisor.pendingApprovals('app-approval'), [approval]);
  assert.equal(supervisor.resolveApproval('request-1', { allow: true }), true);
  const reply = await peer.waitFor('ask.reply');
  assert.deepEqual(reply.payload, {
    runId: start.id,
    requestId: 'request-1',
    decision: { allow: true },
  });
  peer.respond(reply, { ok: true, result: { runId: start.id, accepted: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.pendingApprovals('app-approval').length, 0);

  const retryableApproval = { kind: 'permission_request', requestId: 'request-2' };
  peer.event('app-approval', start.id, 'ask.presented', {
    message: retryableApproval,
  });
  assert.equal(supervisor.resolveApproval('request-2', { allow: false }), true);
  const rejectedReply = await peer.waitFor('ask.reply', 2);
  peer.respond(rejectedReply, {
    ok: true,
    result: { runId: start.id, accepted: false },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(supervisor.pendingApprovals('app-approval'), [retryableApproval]);
  assert.equal(
    messages.filter((message) => (
      message as { requestId?: string }
    ).requestId === 'request-2').length,
    2,
  );

  peer.event('app-approval', start.id, 'ask.presented', {
    message: { kind: 'permission_cancelled', requestId: 'request-2' },
  });
  assert.equal(supervisor.pendingApprovals('app-approval').length, 0);
  peer.respond(start);
  await run;
});

test('malformed worker output fails active work once and starts a fresh generation later', async () => {
  const first = new FakeChild();
  const second = new FakeChild();
  const firstPeer = new FakePeer(first);
  const secondPeer = new FakePeer(second);
  replyToHandshake(firstPeer);
  secondPeer.handle((request) => secondPeer.respond(request));
  const children = [first, second];
  let spawnCalls = 0;
  const sent: unknown[] = [];
  const ownedProcessKills: number[] = [];
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(first),
    spawn: () => children[spawnCalls++]!,
    killProcessTree: (processId) => { ownedProcessKills.push(processId); },
    notifyRunFailed: () => {
      throw new Error('notification unavailable');
    },
    diagnostic: () => {
      throw new Error('diagnostic unavailable');
    },
  });
  const run = spawn(supervisor, 'hello', {}, { send: (value) => sent.push(value) });
  const firstStart = await firstPeer.waitFor('session.start');
  firstPeer.status('app-session-1', firstStart.id, 4_242);

  first.stdout.write('not-json\n');
  await assert.rejects(run, /GJC worker failed/);
  assert.equal(first.killed, true);
  assert.equal(sent.filter((value) => (value as { kind?: string }).kind === 'complete').length, 1);
  assert.deepEqual(ownedProcessKills, [4_242]);

  await spawn(supervisor, 'again', {}, { send() {} });
  assert.equal(spawnCalls, 2);
});

test('worker exit waits for tree termination before starting a fresh generation', async () => {
  const first = new FakeChild();
  const second = new FakeChild();
  const firstPeer = new FakePeer(first);
  const secondPeer = new FakePeer(second);
  secondPeer.handle((request) => secondPeer.respond(request));
  const children = [first, second];
  let spawnCalls = 0;
  let releaseTermination!: () => void;
  const termination = new Promise<void>((resolve) => {
    releaseTermination = resolve;
  });
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(first),
    spawn: () => children[spawnCalls++]!,
    killTree: () => termination,
  });
  const failedRun = spawn(supervisor, 'first', {}, { send() {} });
  const failure = failedRun.then(() => assert.fail('worker exit must reject the active run'), () => {});
  await firstPeer.waitFor('worker.initialize');

  first.emit('exit', 1);
  const replacement = spawn(supervisor, 'second', {}, { send() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCalls, 1);
  releaseTermination();

  await Promise.all([failure, replacement]);
  assert.equal(spawnCalls, 2);
});

test('failed tree cleanup permanently blocks a replacement worker generation', async () => {
  const first = new FakeChild();
  const firstPeer = new FakePeer(first);
  replyToHandshake(firstPeer);
  let spawnCalls = 0;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(first),
    spawn: () => {
      spawnCalls += 1;
      return first;
    },
    killTree: () => Promise.reject(new Error('tree still alive')),
  });
  const failedRun = supervisor.spawnRun({
    runId: 'failed-reap-run',
    appSessionId: 'app-session-1',
    message: 'first',
    writer: { send() {} },
  });
  await firstPeer.waitFor('session.start');

  first.stdout.write('not-json\n');
  assert.equal(await failedRun.outcome, 'unconfirmed');
  await assert.rejects(
    spawn(supervisor, 'replacement', {}, { send() {} }),
    /GJC worker failed/,
  );

  assert.equal(spawnCalls, 1);
});

test('fatal cleanup fences every scope and same-batch terminal until the shared worker is reaped', async () => {
  const first = new FakeChild(); const replacement = new FakeChild();
  const peer = new FakePeer(first); const nextPeer = new FakePeer(replacement);
  replyToHandshake(peer); nextPeer.handle((request) => nextPeer.respond(request));
  let releaseReap!: () => void;
  const reap = new Promise<void>((resolve) => { releaseReap = resolve; });
  let spawnCalls = 0; let killCalls = 0;
  const processKills: number[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(first), spawn: () => ++spawnCalls === 1 ? first : replacement,
    killTree: async (child) => { killCalls += 1; await reap; child.kill(); },
    killProcessTree: (id) => { processKills.push(id); },
  });
  const a = supervisor.spawnRun({ runId: 'fatal-a', appSessionId: 'scope-a', message: 'a', writer: { send: (value) => messages.push(value as Record<string, unknown>) } });
  const b = supervisor.spawnRun({ runId: 'fatal-b', appSessionId: 'scope-b', message: 'b', writer: { send: (value) => messages.push(value as Record<string, unknown>) } });
  let completionsSettled = false; let outcomesSettled = false;
  const completions = Promise.allSettled([a.completion, b.completion]).then((value) => { completionsSettled = true; return value; });
  const outcomes = Promise.all([a.outcome!, b.outcome!]).then((value) => { outcomesSettled = true; return value; });
  const startA = await peer.waitFor('session.start');
  const startB = await peer.waitFor('session.start', 2);
  peer.status('scope-a', startA.id, 4101); peer.status('scope-b', startB.id, 4102);
  peer.event('scope-b', startB.id, 'ask.presented', { message: { kind: 'permission_request', requestId: 'held-approval' } });
  // Even a preceding abort acknowledgement cannot prove final cleanup once
  // this generation subsequently reports the fatal cleanup condition.
  const abort = supervisor.abort(a.abortHandle);
  peer.respond(await peer.waitFor('turn.abort'), { ok: true, result: { runId: a.abortHandle, aborted: true } });
  assert.equal(await abort, 'aborted');
  const fatal: GjcWorkerResponseFrame = {
    protocolVersion: GJC_WORKER_PROTOCOL_VERSION, kind: 'response', id: startA.id, method: 'session.start', sessionId: 'scope-a',
    payload: { ok: false, error: { code: GJC_CLEANUP_UNCONFIRMED_CODE, message: 'Cleanup is unconfirmed.' } },
  };
  const late: GjcWorkerEventFrame = {
    protocolVersion: GJC_WORKER_PROTOCOL_VERSION, kind: 'event', id: 'late-terminal', method: 'turn.completed', sessionId: 'scope-b',
    payload: { runId: startB.id, message: { kind: 'complete', exitCode: 0 } },
  };
  first.stdout.write(serializeGjcWorkerFrame(fatal) + serializeGjcWorkerFrame(late));
  const c = supervisor.spawnRun({ runId: 'after-reap', appSessionId: 'scope-c', message: 'c', writer: { send() {} } });
  let catalogSettled = false;
  const catalog = supervisor.modelCatalog().then((value) => { catalogSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(killCalls, 1); assert.equal(spawnCalls, 1);
  assert.deepEqual(processKills.sort(), [4101, 4102]);
  assert.equal(completionsSettled, false); assert.equal(outcomesSettled, false); assert.equal(catalogSettled, false);
  assert.equal(supervisor.isActive(a.abortHandle), true); assert.equal(supervisor.isActive(b.abortHandle), true);
  assert.equal(messages.some((message) => message.kind === 'complete'), false);
  assert.equal(supervisor.resolveApproval('held-approval', { allow: true }), false);
  assert.deepEqual(supervisor.pendingApprovals('scope-b'), []);
  peer.event('scope-b', startB.id, 'turn.completed', { message: { kind: 'complete', exitCode: 0 } });
  releaseReap();
  assert.deepEqual(await outcomes, ['reaped', 'reaped']);
  assert.deepEqual((await completions).map((value) => value.status), ['rejected', 'rejected']);
  assert.deepEqual(messages.filter((message) => message.kind === 'complete').map((message) => message.exitCode), [1, 1]);
  assert.equal(messages.some((message) => message.aborted === true), false);
  await c.completion; assert.equal((await catalog).ok, true);
  assert.equal(spawnCalls, 2); assert.equal(killCalls, 1);
  await supervisor.shutdown();
});

test('unconfirmed fatal reap retains uncertain runs and blocks new work across scopes', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
  let spawnCalls = 0;
  const messages: unknown[] = [];
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child), spawn: () => { spawnCalls += 1; return child; },
    killTree: async () => { throw new Error('process group remains alive'); },
  });
  const run = supervisor.spawnRun({ runId: 'uncertain', appSessionId: 'scope-a', message: 'a', writer: { send: (value) => messages.push(value) } });
  let settled = false;
  void run.completion.then(() => { settled = true; }, () => { settled = true; });
  const start = await peer.waitFor('session.start');
  peer.respond(start, { ok: false, error: { code: GJC_CLEANUP_UNCONFIRMED_CODE, message: 'Cleanup is unconfirmed.' } });
  assert.equal(await run.outcome, 'unconfirmed');
  assert.equal(await supervisor.terminate(run.abortHandle), 'unconfirmed');
  assert.equal(run.phase!(), 'request_issued');
  assert.equal(supervisor.isActive(run.abortHandle), true);
  assert.equal(settled, false);
  assert.deepEqual(messages, []);
  const next = supervisor.spawnRun({ runId: 'blocked-next', appSessionId: 'scope-b', message: 'b', writer: { send() {} } });
  await assert.rejects(next.completion, /GJC worker failed/);
  assert.equal(await next.outcome, 'not_started');
  await assert.rejects(supervisor.modelCatalog(), /GJC worker failed/);
  assert.equal(spawnCalls, 1);
  assert.equal(supervisor.isActive(run.abortHandle), true);
  assert.equal(settled, false);
  await assert.rejects(supervisor.shutdown(), /GJC worker failed/);
});

test('an ordinary failed run cannot poison a healthy worker by imitating cleanup text', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
  let kills = 0;
  const supervisor = new GjcWorkerSupervisor({ ...runtime(child), killTree: () => { kills += 1; child.kill(); } });
  const failed = spawn(supervisor, 'first', {}, { send() {} });
  const rejected = assert.rejects(failed, /GJC worker failed/);
  peer.respond(await peer.waitFor('session.start'), { ok: false, error: {
    code: 'run_failed', message: `${GJC_CLEANUP_UNCONFIRMED_CODE}: GjcCleanupUnconfirmedError`,
  } });
  await rejected;
  assert.equal(kills, 0);
  const healthy = spawn(supervisor, 'second', {}, { send() {} });
  peer.respond(await peer.waitFor('session.start', 2));
  await healthy;
  assert.equal(kills, 0);
  peer.handle((request) => peer.respond(request));
  await supervisor.shutdown();
});

test('a timed-out auxiliary request does not corrupt other request correlation', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    requestTimeoutMs: 5,
  });
  const run = spawn(supervisor, 'hello', {}, { send() {} });
  const start = await peer.waitFor('session.start');

  peer.event('app-session-1', start.id, 'ask.presented', {
    message: { kind: 'permission_request', requestId: 'request-timeout' },
  });
  assert.equal(supervisor.resolveApproval('request-timeout', { allow: true }), true);
  const timedOutReply = await peer.waitFor('ask.reply');
  await new Promise((resolve) => setTimeout(resolve, 15));
  peer.respond(timedOutReply);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.killed, false);

  peer.event('app-session-1', start.id, 'ask.presented', {
    message: { kind: 'permission_request', requestId: 'request-success' },
  });
  assert.equal(supervisor.resolveApproval('request-success', { allow: true }), true);
  const successfulReply = await peer.waitFor('ask.reply', 2);
  peer.respond(successfulReply);
  peer.respond(start);
  await run;
  assert.equal(child.killed, false);
});

test('ignores stale events when a later run reuses the same app scope', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const messages: unknown[] = [];
  const supervisor = new GjcWorkerSupervisor(runtime(child, 'shared-app'));
  const writer = { send: (value: unknown) => messages.push(value) };

  const oldRun = spawn(supervisor, 'old', {}, writer);
  const oldStart = await peer.waitFor('session.start');
  peer.respond(oldStart);
  await oldRun;

  const newRun = spawn(supervisor, 'new', {}, writer);
  const newStart = await peer.waitFor('session.start', 2);
  peer.event('shared-app', oldStart.id, 'message.delta', {
    message: { kind: 'stream_delta', content: 'stale' },
  });
  peer.event('shared-app', newStart.id, 'message.delta', {
    message: { kind: 'stream_delta', content: 'current' },
  });
  peer.respond(newStart);
  await newRun;

  assert.deepEqual(
    messages.filter((message) => (message as { kind?: string }).kind === 'stream_delta'),
    [{ kind: 'stream_delta', content: 'current' }],
  );
});

test('forwards one worker terminal event without synthesizing a duplicate', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const sent: unknown[] = [];
  let failures = 0;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child, 'app-terminal'),
    notifyRunFailed: () => { failures += 1; },
  });
  const run = spawn(supervisor, 'hello', {}, { send: (value) => sent.push(value) });
  const start = await peer.waitFor('session.start');
  const terminal = { kind: 'complete', provider: 'gjc', exitCode: 1 };

  peer.event('app-terminal', start.id, 'turn.failed', { message: terminal });
  peer.respond(start, { ok: false, error: { code: 'run_failed', message: 'safe' } });
  await assert.rejects(run, /GJC worker failed/);

  assert.deepEqual(sent, [terminal]);
  assert.equal(failures, 1);
});

test('runtime-owned goal stops preserve aborted outcomes and emit one truthful chat terminal', async () => {
  for (const aborted of [true, 'true'] as const) {
    const child = new FakeChild();
    const peer = new FakePeer(child);
    replyToHandshake(peer);
    const sent: Array<Record<string, unknown>> = [];
    const reasons: string[] = [];
    const supervisor = new GjcWorkerSupervisor({
      ...runtime(child, 'app-goal-stop'),
      notifyRunStopped: event => reasons.push(event.stopReason),
    });
    const run = supervisor.spawnRun({ runId: 'goal-stop', appSessionId: 'app-goal-stop', message: 'work', options: {}, writer: { send: value => sent.push(value as Record<string, unknown>) } });
    const start = await peer.waitFor('session.start');
    peer.respond(start, { ok: true, result: { runId: start.id, aborted } });
    await run.completion;
    assert.equal(await run.outcome, aborted === true ? 'aborted' : 'completed');
    assert.equal(sent.length, 1);
    const terminal = sent[0];
    assert.ok(terminal);
    assert.equal(terminal.kind, 'complete');
    assert.equal(terminal.aborted, aborted === true);
    assert.equal(terminal.exitCode, 0);
    assert.deepEqual(reasons, [aborted === true ? 'aborted' : 'completed']);
  }
});
test('durable-job notification ownership suppresses direct GJC terminal sends', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  let failures = 0;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child, 'app-terminal-owned'),
    notifyRunFailed: () => { failures += 1; },
  });
  const run = spawn(
    supervisor,
    'hello',
    { notificationOwner: 'terminal-adapter' },
    { send() {} },
  );
  const start = await peer.waitFor('session.start');
  peer.respond(start, { ok: false, error: { code: 'run_failed', message: 'safe' } });
  await assert.rejects(run, /GJC worker failed/);
  assert.equal(failures, 0);
});

test('completed terminal event remains authoritative if the worker exits before its response', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const sent: unknown[] = [];
  let stopped = 0;
  let failed = 0;
  const ownedProcessKills: number[] = [];
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child, 'app-terminal-exit'),
    notifyRunStopped: () => { stopped += 1; },
    notifyRunFailed: () => { failed += 1; },
    killProcessTree: (processId) => { ownedProcessKills.push(processId); },
  });
  const run = spawn(supervisor, 'hello', {}, { send: (value) => sent.push(value) });
  const start = await peer.waitFor('session.start');
  const terminal = { kind: 'complete', provider: 'gjc', exitCode: 0 };

  peer.event('app-terminal-exit', start.id, 'turn.completed', { message: terminal });
  peer.status('app-terminal-exit', start.id, 4_242);
  peer.status('app-terminal-exit', start.id, null);
  child.emit('exit', 1);
  await run;

  assert.deepEqual(sent, [terminal]);
  assert.equal(stopped, 1);
  assert.equal(failed, 0);
  assert.deepEqual(ownedProcessKills, []);
});

test('graceful shutdown waits for the worker response then terminates its process tree', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  let stopped = 0;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child, 'app-shutdown'),
    notifyRunStopped: () => { stopped += 1; },
  });
  const run = spawn(supervisor, 'hello', {}, { send() {} });
  const start = await peer.waitFor('session.start');
  const shutdownPromise = supervisor.shutdown();
  const shutdown = await peer.waitFor('worker.shutdown');

  assert.equal(child.killed, false);
  peer.respond(start);
  peer.respond(shutdown);
  await Promise.all([run, shutdownPromise]);

  assert.equal(stopped, 1);
  assert.equal(child.killed, true);
  await assert.rejects(
    spawn(supervisor, 'too-late', {}, { send() {} }),
    /GJC worker failed/,
  );
});

test('shutdown waits for in-flight exit cleanup and propagates its failure', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  let rejectTermination!: (error: Error) => void;
  const termination = new Promise<void>((_resolve, reject) => {
    rejectTermination = reject;
  });
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    killTree: () => termination,
  });
  const run = spawn(supervisor, 'hello', {}, { send() {} });
  const start = await peer.waitFor('session.start');
  peer.respond(start);
  await run;

  const shutdownPromise = supervisor.shutdown();
  await peer.waitFor('worker.shutdown');
  child.emit('exit', 1);
  let settled = false;
  void shutdownPromise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  rejectTermination(new Error('tree still alive'));
  await assert.rejects(shutdownPromise, /GJC worker failed/);
});
test('rejecting option enrichment settles a pre-request run as not_started', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    enrichOptions: async () => { throw new Error('configuration unavailable'); },
  });
  const run = supervisor.spawnRun({
    runId: 'enrichment-failure',
    appSessionId: 'app-enrichment',
    message: 'hello',
    writer: { send() {} },
  });
  await assert.rejects(run.started, /GJC worker failed/);
  assert.equal(await run.outcome, 'not_started');
  assert.equal(supervisor.isActive('enrichment-failure'), false);
});
test('production POSIX terminator waits for direct-child close and process-group absence', async () => {
  const child = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const processId = child.pid!;
  await killWorkerTree(child);
  assert.throws(
    () => process.kill(-processId, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
  );
});
test('Windows tree reaping is explicitly fail-closed while the v2 runtime is frozen', async () => {
  await assert.rejects(
    killWorkerTree(new FakeChild(), 'win32'),
    /unconfirmed on Windows/,
  );
});
test('OAuth requests and chat runs share one supervised worker process', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  let spawnCount = 0;
  peer.handle((request) => {
    if (request.method === 'worker.initialize') {
      peer.respond(request);
      return;
    }
    if (request.method === 'oauth.providers') {
      peer.respond(request, { ok: true, result: { providers: [] } });
      return;
    }
    if (request.method === 'session.start') {
      peer.respond(request, { ok: true });
      const payload = request.payload as Record<string, unknown>;
      peer.event(
        request.sessionId!,
        String(payload.runId),
        'turn.completed',
        { exitCode: 0 },
      );
    }
  });
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child, 'shared-oauth-chat'),
    spawn: () => {
      spawnCount += 1;
      return child;
    },
  });

  assert.deepEqual(await supervisor.oauthProviders(), { ok: true, result: { providers: [] } });
  const run = supervisor.spawnRun({
    runId: 'shared-oauth-chat-run',
    appSessionId: 'shared-oauth-chat',
    message: 'shared worker',
    options: {},
    writer: { send() {} },
  });
  await run.started;
  await run.completion;

  assert.equal(spawnCount, 1);
  assert.deepEqual(peer.requests.map((request) => request.method), [
    'worker.initialize',
    'oauth.providers',
    'session.start',
  ]);
});

// Regression: three browser tabs reconnecting after a server restart each send
// `oauth.status`, which starts the worker. Its SDK bootstrap (model registry +
// online discovery) takes 4-8 s on a loaded machine, and a 5 s initialize bound
// killed the healthy worker, so every tab logged only "GJC worker failed.".
test('worker initialization survives a bootstrap slower than the former 5 s bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new FakeChild();
  const peer = new FakePeer(child);
  const diagnostics: string[] = [];
  peer.handle((request) => {
    if (request.method === 'oauth.status') peer.respond(request, { ok: true, result: { providers: [] } });
  });
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    diagnostic: (message) => diagnostics.push(message),
  });

  const reconnectingTabs = [supervisor.oauthStatus(), supervisor.oauthStatus(), supervisor.oauthStatus()];
  const initialize = await peer.waitFor('worker.initialize');
  t.mock.timers.tick(8_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.killed, false, 'a worker still bootstrapping must not be reaped');
  assert.deepEqual(diagnostics, []);

  peer.respond(initialize);
  await peer.waitFor('oauth.status', 3);
  assert.deepEqual(await Promise.all(reconnectingTabs), Array(3).fill({ ok: true, result: { providers: [] } }));
  assert.equal(DEFAULT_INITIALIZE_TIMEOUT_MS >= 30_000, true);
});

test('a worker that never initializes fails every waiter once and says why in the diagnostics', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new FakeChild();
  const peer = new FakePeer(child);
  const diagnostics: string[] = [];
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    diagnostic: (message) => diagnostics.push(message),
  });

  const waiters = [supervisor.oauthStatus(), supervisor.oauthStatus()];
  const settled = waiters.map((waiter) => waiter.then(() => 'fulfilled', (error: Error) => error.message));
  await peer.waitFor('worker.initialize');
  t.mock.timers.tick(DEFAULT_INITIALIZE_TIMEOUT_MS);
  assert.deepEqual(await Promise.all(settled), ['GJC worker failed.', 'GJC worker failed.']);
  assert.equal(child.killed, true);
  assert.deepEqual(diagnostics, [
    `GJC worker initialization failed after ${DEFAULT_INITIALIZE_TIMEOUT_MS}ms bound: GJC worker request timed out.`,
  ]);
});

test('a rejected initialize response records the worker\'s code', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  const diagnostics: string[] = [];
  peer.handle((request) => peer.respond(request, { ok: false, error: { code: 'initialization_failed', message: 'Worker initialization failed.' } }));
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    diagnostic: (message) => diagnostics.push(message),
  });

  await assert.rejects(supervisor.oauthStatus(), /GJC worker failed/);
  assert.deepEqual(diagnostics, [
    `GJC worker initialization failed after ${DEFAULT_INITIALIZE_TIMEOUT_MS}ms bound: worker.initialize was rejected (initialization_failed)`,
  ]);
});

test('shutdown of an unresponsive worker is bounded separately from initialization', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new FakeChild();
  const peer = new FakePeer(child);
  peer.handle((request) => {
    if (request.method !== 'worker.shutdown') peer.respond(request);
  });
  const supervisor = new GjcWorkerSupervisor(runtime(child));
  assert.deepEqual(await supervisor.oauthStatus(), { ok: true });

  const shutdown = supervisor.shutdown();
  await peer.waitFor('worker.shutdown');
  t.mock.timers.tick(DEFAULT_SHUTDOWN_TIMEOUT_MS);
  await shutdown;
  assert.equal(child.killed, true);
  assert.equal(DEFAULT_SHUTDOWN_TIMEOUT_MS < DEFAULT_INITIALIZE_TIMEOUT_MS, true);
});

test('a start refused for a malformed permissions block tells the client why', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  peer.handle((request) => {
    if (request.method === 'worker.initialize') peer.respond(request);
    else if (request.method === 'session.start') {
      const options = (request.payload as { options: Record<string, unknown> }).options;
      peer.respond(request, options.permissions
        ? { ok: false, error: { code: 'invalid_permissions', message: 'Invalid GJC run permissions.' } }
        : { ok: false, error: { code: 'run_failed', message: 'GJC run failed.' } });
    }
  });
  const failures: string[] = [];
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    notifyRunFailed: ({ error }) => { failures.push(error); },
  });

  const sent: Array<Record<string, unknown>> = [];
  await assert.rejects(
    spawn(supervisor, 'hello', { permissions: { mode: 'yolo' } }, { send(value) { sent.push(value as Record<string, unknown>); } }),
    /Invalid GJC run permissions\./,
  );
  assert.deepEqual(sent.map((message) => [message.kind, message.content ?? message.exitCode]), [
    ['error', 'Invalid GJC run permissions.'],
    ['complete', 1],
  ]);

  // Every other worker-side failure stays behind the sanitized text.
  await assert.rejects(spawn(supervisor, 'hello', {}, { send(value) { sent.push(value as Record<string, unknown>); } }), /^Error: GJC worker failed\.$/);
  assert.deepEqual(sent.at(-2)?.content, 'GJC worker failed.');
  assert.deepEqual(failures, ['Invalid GJC run permissions.', 'GJC worker failed.']);
});
test('a start refused for an unresolvable model tells the client why', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  peer.handle((request) => {
    if (request.method === 'worker.initialize') peer.respond(request);
    else if (request.method === 'session.start') {
      peer.respond(request, { ok: false, error: { code: GJC_MODEL_UNRESOLVED_CODE, message: GJC_MODEL_UNRESOLVED_MESSAGE } });
    }
  });
  const failures: string[] = [];
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    notifyRunFailed: ({ error }) => { failures.push(error); },
  });

  const sent: Array<Record<string, unknown>> = [];
  await assert.rejects(
    spawn(supervisor, 'hello', {}, { send(value) { sent.push(value as Record<string, unknown>); } }),
    (error: unknown) => error instanceof Error && error.message === GJC_MODEL_UNRESOLVED_MESSAGE,
  );
  assert.deepEqual(sent.map((message) => [message.kind, message.content ?? message.exitCode]), [
    ['error', GJC_MODEL_UNRESOLVED_MESSAGE],
    ['complete', 1],
  ]);
  assert.deepEqual(failures, [GJC_MODEL_UNRESOLVED_MESSAGE]);
});

function assertDesktopIdle(activity: DesktopOwnerActivity): void {
  assert.equal(activity.owner, 'gjc-worker');
  assert.equal(activity.complete, true);
  assert.deepEqual(activity.unknown, []);
  for (const count of ['starting', 'queued', 'running', 'settling', 'approvals', 'retained'] as const) {
    assert.equal(activity[count], 0, count);
  }
}

async function restartObservationFixture() {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  let spawns = 0;
  let reaps = 0;
  let fenceId: string | null = null;
  const remote = { generation: 'sdk-1', complete: true, starting: 0, queued: 0, running: 0,
    settling: 0, approvals: 0, retained: 0, unknown: [] as string[] };
  let delayed = false;
  peer.handle((request) => {
    if (request.method === 'worker.admission') {
      fenceId = request.payload.closed ? request.payload.fenceId : null;
      peer.respond(request, { ok: true, result: { fenceId } });
    } else if (request.method === 'worker.activity') {
      if (!delayed) peer.respond(request, { ok: true, result: { ...remote, unknown: [...remote.unknown], fenceId } });
    } else if (request.method === 'worker.initialize' || request.method === 'models.catalog') peer.respond(request);
  });
  const supervisor = new GjcWorkerSupervisor({ ...runtime(child),
    spawn: () => { spawns++; return child; }, killTree: () => { reaps++; } });
  await supervisor.modelCatalog();
  return { child, peer, supervisor, remote,
    delay() { delayed = true; }, counts: () => ({ spawns, reaps }),
    reply(request: GjcWorkerRequestFrame, observedFence = fenceId) {
      peer.respond(request, { ok: true, result: { ...remote, unknown: [...remote.unknown], fenceId: observedFence } });
    },
  };
}

/** Real authority + production reader + protocol host; only the SDK/process are fake. */
async function composedRestartWorkerFixture(options: {
  holdClose?: boolean;
  holdRelease?: boolean;
  clock?: Pick<DesktopRestartAuthorityOptions, 'now' | 'schedule' | 'tokenTtlMs'>;
} = {}) {
  const child = new FakeChild(); const peer = new FakePeer(child);
  const trace: string[] = [];
  const roots = new Map<string, ReturnType<typeof deferredEnrichment<void>>>();
  const errors: unknown[] = [];
  const replies: GjcWorkerResponseFrame[] = [];
  let sdkRevision = 0;
  let aborted = 0;
  let spawned = 0;
  let reaped = 0;
  let holdClose = options.holdClose ?? false;
  let holdRelease = options.holdRelease ?? false;
  const sdk: GjcWorkerRuntime = {
    observeActivity: () => ({ generation: `sdk-${sdkRevision}`, complete: true,
      starting: 0, queued: 0, running: roots.size, settling: 0, approvals: 0, retained: 0, unknown: [] }),
    setAdmissionFence: (closed) => {
      trace.push(closed ? 'sdk:close' : 'sdk:release');
      if (closed) assert.equal(authority.state, 'preparing', 'top-level admission closes before the worker');
      sdkRevision++;
    },
    modelCatalog: async () => ({}),
    spawnGjc: (_message, input) => {
      const runId = String(input.runHandle);
      const done = deferredEnrichment<void>(); roots.set(runId, done); sdkRevision++;
      return Object.assign(done.promise.finally(() => { roots.delete(runId); sdkRevision++; }), { abortHandle: runId });
    },
    abortGjcSession: async () => { aborted++; return false; },
    resolveGjcToolApproval: () => false,
  };
  const host = new GjcWorkerHost({ runtime: async () => sdk, emit(frame) {
    if (frame.kind === 'response' && frame.method === 'worker.admission' && frame.payload.ok) {
      const closing = frame.payload.result.fenceId !== null;
      if (closing ? holdClose : holdRelease) { replies.push(frame); return; }
    }
    child.stdout.write(serializeGjcWorkerFrame(frame));
  } });
  peer.handle((request) => {
    trace.push(request.method === 'worker.admission'
      ? `wire:${request.payload.closed ? 'close' : 'release'}` : `wire:${request.method}`);
    void host.handle(request).catch((error) => { errors.push(error); });
  });
  const supervisor = new GjcWorkerSupervisor({ ...runtime(child),
    spawn: () => { spawned++; return child; }, killTree: () => { reaped++; } });
  const reader = createGjcWorkerDesktopRestartReader(supervisor);
  const ownerReaders = Object.fromEntries(DESKTOP_RESTART_REQUIRED_OWNERS.map((owner) => [owner, {
    getGeneration: () => 'fixture-idle',
    read: () => ({ owner, generation: 'fixture-idle', complete: true,
      starting: 0, queued: 0, running: 0, settling: 0, approvals: 0, retained: 0, unknown: [] }),
  }]));
  const readers = { ...ownerReaders, 'gjc-worker': {
    getGeneration: reader.getGeneration,
    read: () => { trace.push('owner:read'); return reader.read(); },
  } };
  const preparationFence = { owner: 'gjc-worker',
    close: (id: string) => supervisor.fenceForDesktopRestart(id),
    release: (id: string) => supervisor.releaseDesktopRestartFence(id),
  };
  // Exercise the exact production factory by default. Expiry/deadline tests
  // inject only authority time; worker transport and its timers remain real.
  const authority: DesktopRestartAuthority = options.clock
    ? new DesktopRestartAuthority({ requiredOwners: DESKTOP_RESTART_REQUIRED_OWNERS,
        ownerReaders: readers, preparationFence, ...options.clock })
    : createDesktopRestartRuntime(readers, preparationFence);
  supervisor.configureDesktopRestartAdmission({ acquire: (source) => ({ release: authority.enter(source) }) });
  await supervisor.modelCatalog();
  trace.length = 0;
  const acknowledge = (closed: boolean) => {
    const index = replies.findIndex((frame) => frame.method === 'worker.admission' && frame.payload.ok
      && (frame.payload.result.fenceId !== null) === closed);
    assert.notEqual(index, -1, 'the delayed acknowledgement must exist');
    child.stdout.write(serializeGjcWorkerFrame(replies.splice(index, 1)[0]!));
  };
  return { authority, supervisor, peer, reader, trace, errors, roots,
    counts: () => ({ spawned, reaped, aborted }),
    acknowledgeClose: () => acknowledge(true), acknowledgeRelease: () => acknowledge(false),
    releaseAcknowledgements() { holdClose = false; holdRelease = false; },
    async close() { for (const root of roots.values()) root.resolve(); await host.close(); },
  };
}

function restartCompositionClock() {
  let now = 0;
  const timers = new Set<{ at: number; callback: () => void }>();
  return {
    options: { now: () => now, tokenTtlMs: 20,
      schedule(callback: () => void, delay: number) {
        const timer = { at: now + delay, callback }; timers.add(timer); return () => { timers.delete(timer); };
      },
    },
    advance(milliseconds: number) {
      now += milliseconds;
      for (const timer of [...timers]) if (timer.at <= now && timers.delete(timer)) timer.callback();
    },
  };
}

test('production restart composition closes before its first observation and owns cancellation release', async () => {
  const f = await composedRestartWorkerFixture({ holdClose: true, holdRelease: true });
  try {
    const preparedTask = f.authority.prepare({ attemptId: 'composed-1', epoch: 'desktop-1' });
    assert.equal(f.authority.state, 'preparing');
    await assert.rejects(f.supervisor.modelCatalog(), { code: 'DESKTOP_RESTART_FENCED' });
    const close = await f.peer.waitFor('worker.admission');
    assert.equal(close.payload.closed, true);
    assert.equal(f.trace.includes('owner:read'), false, 'owner generation is captured only after close settles');
    f.acknowledgeClose();
    const prepared = await preparedTask;
    assert.ok(prepared.ok, JSON.stringify(prepared));
    const owner = prepared.snapshot.owners.find((value) => value.owner === 'gjc-worker')!;
    assertDesktopIdle(owner);
    assert.equal(owner.generation, f.reader.getGeneration(), 'close/observation did not invalidate the first snapshot');
    assert.ok(f.trace.indexOf('sdk:close') < f.trace.indexOf('owner:read'));
    const stable = f.reader.getGeneration();
    assertDesktopIdle(await f.reader.read());
    assert.equal(f.reader.getGeneration(), stable);
    f.authority.cancel(prepared.token);
    await flushEnrichment();
    const release = f.peer.requests.filter((r) => r.method === 'worker.admission').at(-1)!;
    assert.equal(release.payload.closed, false);
    assert.equal(release.payload.fenceId, close.payload.fenceId);
    const releasing = await f.authority.snapshot();
    assert.equal(releasing.ingress, 1, 'release acknowledgement retains cleanup ownership');
    assert.equal((await f.authority.prepare({ attemptId: 'cannot-overtake', epoch: 'desktop-1' })).ok, false);
    await assert.rejects(f.supervisor.modelCatalog(), { code: 'DESKTOP_RESTART_FENCED' });
    f.acknowledgeRelease();
    await flushEnrichment();
    assert.equal((await f.authority.snapshot()).ingress, 0);
    await f.supervisor.modelCatalog();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.counts(), { spawned: 1, reaped: 0, aborted: 0 });
  } finally { await f.close(); }
});

test('composed restart expiry releases the same fake-worker fence while cleanup blocks another prepare', async () => {
  const clock = restartCompositionClock();
  const f = await composedRestartWorkerFixture({ holdRelease: true, clock: clock.options });
  try {
    const prepared = await f.authority.prepare({ attemptId: 'expires', epoch: 'desktop-1' });
    assert.ok(prepared.ok, JSON.stringify(prepared));
    clock.advance(20);
    await flushEnrichment();
    assert.equal(f.authority.state, 'open');
    const admissions = f.peer.requests.filter((r) => r.method === 'worker.admission');
    assert.equal(admissions.length, 2);
    assert.equal(admissions[0]!.payload.fenceId, admissions[1]!.payload.fenceId);
    assert.equal(admissions[1]!.payload.closed, false);
    assert.equal((await f.authority.snapshot()).ingress, 1);
    const blocked = await f.authority.prepare({ attemptId: 'too-early', epoch: 'desktop-1' });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, 'busy');
    f.acknowledgeRelease(); await flushEnrichment();
    assert.equal((await f.authority.snapshot()).ingress, 0);
    f.releaseAcknowledgements();
    const next = await f.authority.prepare({ attemptId: 'after-expiry', epoch: 'desktop-1' });
    assert.ok(next.ok, JSON.stringify(next));
    f.authority.cancel(next.token); await flushEnrichment();
    await f.supervisor.modelCatalog();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.counts(), { spawned: 1, reaped: 0, aborted: 0 });
  } finally { await f.close(); }
});

for (const reason of ['controller-loss', 'prepare-deadline'] as const) {
  test(`composed restart ${reason} joins a delayed close before exact release without observing`, async () => {
    const clock = restartCompositionClock();
    const f = await composedRestartWorkerFixture({ holdClose: true, holdRelease: true, clock: clock.options });
    try {
      const preparedTask = f.authority.prepare({ attemptId: 'interrupted', epoch: 'desktop-1' });
      const close = await f.peer.waitFor('worker.admission');
      if (reason === 'controller-loss') f.authority.controllerLost('desktop-1');
      else clock.advance(5_000);
      const prepared = await preparedTask;
      assert.equal(prepared.ok, false);
      assert.equal(f.trace.includes('owner:read'), false);
      assert.equal(f.peer.requests.filter((r) => r.method === 'worker.admission').length, 1,
        'release cannot overtake the unsettled close');
      const blocked = await f.authority.prepare({ attemptId: 'cannot-overtake', epoch: 'desktop-2' });
      assert.equal(blocked.ok, false);
      if (!blocked.ok) assert.equal(blocked.code, 'busy');
      f.acknowledgeClose(); await flushEnrichment();
      const release = f.peer.requests.filter((r) => r.method === 'worker.admission').at(-1)!;
      assert.equal(release.payload.closed, false);
      assert.equal(release.payload.fenceId, close.payload.fenceId);
      f.acknowledgeRelease(); await flushEnrichment();
      assert.equal((await f.authority.snapshot()).ingress, 0);
      await f.supervisor.modelCatalog();
      assert.deepEqual(f.errors, []);
      assert.deepEqual(f.counts(), { spawned: 1, reaped: 0, aborted: 0 });
    } finally { await f.close(); }
  });
}

test('production restart composition refuses an accepted root without sending abort or a remote fence', async () => {
  const f = await composedRestartWorkerFixture();
  try {
    const root = f.supervisor.spawnRun({ runId: 'accepted-root', appSessionId: 'scope', message: 'owned work', writer: { send() {} } });
    await root.started;
    const prepared = await f.authority.prepare({ attemptId: 'while-busy', epoch: 'desktop-1' });
    assert.equal(prepared.ok, false);
    if (!prepared.ok) assert.equal(prepared.code, 'busy');
    assert.equal(f.peer.requests.some((r) => r.method === 'worker.admission' || r.method === 'turn.abort'), false);
    assert.equal(f.supervisor.isActive('accepted-root'), true);
    f.roots.get('accepted-root')!.resolve(); await root.completion; await flushEnrichment();
    const next = await f.authority.prepare({ attemptId: 'after-root', epoch: 'desktop-1' });
    assert.ok(next.ok, JSON.stringify(next));
    f.authority.cancel(next.token); await flushEnrichment();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.counts(), { spawned: 1, reaped: 0, aborted: 0 });
  } finally { await f.close(); }
});

test('fenced healthy worker certifies idle through the production reader without self-invalidating', async () => {
  const f = await restartObservationFixture();
  const reader = createGjcWorkerDesktopRestartReader(f.supervisor);
  assert.equal((await reader.read()).complete, false, 'an unfenced remote snapshot cannot certify idle');
  assert.equal(f.peer.requests.filter((r) => r.method === 'worker.activity').length, 1);
  await f.supervisor.fenceForDesktopRestart('update-1');
  const generation = reader.getGeneration();
  assertDesktopIdle(await reader.read());
  assertDesktopIdle(await reader.read());
  assert.equal(reader.getGeneration(), generation);
  assert.equal(f.supervisor.snapshotActivity().retained, 1, 'observation never discards OS ownership');
  const authority = new DesktopRestartAuthority({ requiredOwners: ['gjc-worker'], ownerReaders: { 'gjc-worker': reader } });
  const prepared = await authority.prepare({ attemptId: 'update-1', epoch: 'desktop-1' });
  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    const committed = await authority.commit(prepared.token, prepared.epoch);
    assert.equal(committed.ok, true);
  }
  await assert.rejects(f.supervisor.modelCatalog(), { code: 'DESKTOP_RESTART_FENCED' });
  await f.supervisor.releaseDesktopRestartFence('update-1');
  await f.supervisor.modelCatalog();
  assert.deepEqual(f.counts(), { spawns: 1, reaps: 0 });
});

test('SDK-only idle-busy-idle invalidates the prepared owner even without host events', async () => {
  const f = await restartObservationFixture();
  const reader = createGjcWorkerDesktopRestartReader(f.supervisor);
  await f.supervisor.fenceForDesktopRestart('update-1');
  const authority = new DesktopRestartAuthority({ requiredOwners: ['gjc-worker'], ownerReaders: { 'gjc-worker': reader } });
  const prepared = await authority.prepare({ attemptId: 'update-1', epoch: 'desktop-1' });
  assert.equal(prepared.ok, true);
  assert.ok(prepared.ok);
  const generation = reader.getGeneration();
  // The SDK accepts and settles internal work without emitting a run/OAuth
  // frame. Zero endpoint counts do not erase the intervening mutations.
  f.remote.generation = 'sdk-3';
  assert.equal(reader.getGeneration(), generation, 'no host event announced this remote change');
  const committed = await authority.commit(prepared.token, prepared.epoch);
  assert.equal(committed.ok, false, 'a different remote revision must not reuse the prepared proof');
  assert.notEqual(reader.getGeneration(), generation);
  const invalidated = reader.getGeneration();
  assert.ok((await reader.read()).unknown.includes('worker_observation_stale'));
  assert.equal(reader.getGeneration(), invalidated, 'unchanged observation does not create another mutation');
  // Do not silently adopt a new baseline (or accept a reverted one) under
  // the same lease after it was invalidated.
  f.remote.generation = 'sdk-1';
  assert.equal((await reader.read()).complete, false);
  await f.supervisor.releaseDesktopRestartFence('update-1');
  await f.supervisor.fenceForDesktopRestart('update-2');
  assertDesktopIdle(await reader.read());
  assert.deepEqual(f.counts(), { spawns: 1, reaps: 0 });
  await f.supervisor.releaseDesktopRestartFence('update-2');
});

test('an SDK revision change while the commit observation is pending cannot certify an idle reply', async () => {
  const f = await restartObservationFixture();
  const reader = createGjcWorkerDesktopRestartReader(f.supervisor);
  await f.supervisor.fenceForDesktopRestart('update-1');
  const authority = new DesktopRestartAuthority({ requiredOwners: ['gjc-worker'], ownerReaders: { 'gjc-worker': reader } });
  const prepared = await authority.prepare({ attemptId: 'update-1', epoch: 'desktop-1' });
  assert.ok(prepared.ok);
  f.delay();
  const committed = authority.commit(prepared.token, prepared.epoch);
  const request = f.peer.requests.filter((r) => r.method === 'worker.activity').at(-1)!;
  f.remote.generation = 'sdk-3';
  f.reply(request);
  assert.equal((await committed).ok, false);
  assert.deepEqual(f.counts(), { spawns: 1, reaps: 0 });
  await f.supervisor.releaseDesktopRestartFence('update-1');
});

test('observation timeouts coalesce into one bounded slot and never poison or reap a healthy worker', async () => {
  const f = await restartObservationFixture();
  await f.supervisor.fenceForDesktopRestart('update-1');
  f.delay();
  const reader = createGjcWorkerDesktopRestartReader(f.supervisor);
  const generation = reader.getGeneration();
  const results = await Promise.all(Array.from({ length: 20 }, () => reader.read()));
  assert.equal(f.peer.requests.filter((r) => r.method === 'worker.activity').length, 1);
  assert.equal(f.supervisor.snapshotActivity().queued, 0);
  assert.equal(reader.getGeneration(), generation);
  for (const result of results) {
    assert.equal(result.complete, false);
    assert.ok(result.unknown.includes('worker_observation_unavailable'));
    assert.equal(result.unknown.includes('worker_request_timeout_unconfirmed'), false);
  }
  await reader.read();
  assert.equal(f.peer.requests.filter((r) => r.method === 'worker.activity').length, 1, 'unanswered reads cannot grow a late-ID cache');
  f.reply(f.peer.requests.find((r) => r.method === 'worker.activity')!);
  const fresh = reader.read();
  f.reply(f.peer.requests.filter((r) => r.method === 'worker.activity')[1]!);
  assertDesktopIdle(await fresh);
  assert.equal(reader.getGeneration(), generation);
  assert.deepEqual(f.counts(), { spawns: 1, reaps: 0 });
  await f.supervisor.releaseDesktopRestartFence('update-1');
});

test('timed-out admission stays fenced until ordered release without permanently poisoning SDK activity', async () => {
  const f = await restartObservationFixture();
  let closeRequest: GjcWorkerRequestFrame | undefined;
  f.peer.handle((request) => {
    if (request.method !== 'worker.admission') return;
    if (request.payload.closed) closeRequest = request;
    else f.peer.respond(request, { ok: true, result: { fenceId: null } });
  });
  await assert.rejects(f.supervisor.fenceForDesktopRestart('update-1'));
  assert.ok(closeRequest);
  await assert.rejects(f.supervisor.modelCatalog(), { code: 'DESKTOP_RESTART_FENCED' });
  assert.equal((await createGjcWorkerDesktopRestartReader(f.supervisor).read()).complete, false);
  assert.equal(f.supervisor.snapshotActivity().unknown.includes('worker_request_timeout_unconfirmed'), false);
  await f.supervisor.releaseDesktopRestartFence('update-1');
  f.peer.respond(closeRequest, { ok: true, result: { fenceId: 'update-1' } });
  f.peer.handle((request) => f.peer.respond(request));
  await f.supervisor.modelCatalog();
  assert.equal(f.supervisor.snapshotActivity().unknown.includes('worker_request_timeout_unconfirmed'), false);
  assert.deepEqual(f.counts(), { spawns: 1, reaps: 0 });
});

test('worker-side titles, OAuth unwind and SDK unknowns are not replaced by empty parent maps', async () => {
  const f = await restartObservationFixture();
  await f.supervisor.fenceForDesktopRestart('update-1');
  f.remote.settling = 2;
  f.remote.complete = false;
  f.remote.unknown = ['sdk_background_ownership_unproven'];
  const result = await createGjcWorkerDesktopRestartReader(f.supervisor).read();
  assert.equal(result.complete, false);
  assert.equal(result.settling, 2);
  assert.deepEqual(result.unknown, ['sdk_background_ownership_unproven']);
  assert.deepEqual(f.counts(), { spawns: 1, reaps: 0 });
  await f.supervisor.releaseDesktopRestartFence('update-1');
});

test('a released or mismatched fence cannot reuse an in-flight worker idle snapshot', async () => {
  const f = await restartObservationFixture();
  await f.supervisor.fenceForDesktopRestart('update-1');
  f.delay();
  const reader = createGjcWorkerDesktopRestartReader(f.supervisor);
  const pending = reader.read();
  const observation = f.peer.requests.find((r) => r.method === 'worker.activity')!;
  await assert.rejects(f.supervisor.releaseDesktopRestartFence('other-update'));
  await f.supervisor.releaseDesktopRestartFence('update-1');
  f.reply(observation, 'update-1');
  const result = await pending;
  assert.equal(result.complete, false);
  assert.ok(result.unknown.includes('worker_observation_stale'));
  assert.notEqual(result.generation, reader.getGeneration());
  assert.deepEqual(f.counts(), { spawns: 1, reaps: 0 });
});

test('cold worker fencing and observation never spawn and optional root admission is releasable', async () => {
  let spawns = 0;
  const child = new FakeChild();
  const peer = new FakePeer(child);
  peer.handle((request) => peer.respond(request));
  const supervisor = new GjcWorkerSupervisor({ ...runtime(child), spawn: () => { spawns++; return child; } });
  const reader = createGjcWorkerDesktopRestartReader(supervisor);
  await supervisor.fenceForDesktopRestart('cold-fence');
  assertDesktopIdle(await reader.read());
  await assert.rejects(supervisor.oauthStart('openai-codex'), { code: 'DESKTOP_RESTART_FENCED' });
  await assert.rejects(supervisor.oauthSubmit('not-owned', 'input'));
  assert.equal(spawns, 0);
  assert.equal(peer.requests.length, 0);
  await supervisor.releaseDesktopRestartFence('cold-fence');
  let leases = 0;
  let open = false;
  supervisor.configureDesktopRestartAdmission({ acquire(source) {
    assert.equal(source, 'gjc-worker:models.catalog');
    if (!open) throw Object.assign(new Error('fenced'), { code: 'DESKTOP_RESTART_FENCED' });
    leases++;
    return { release() { leases--; } };
  } });
  await assert.rejects(supervisor.modelCatalog(), { code: 'DESKTOP_RESTART_FENCED' });
  assert.equal(spawns, 0);
  open = true;
  await supervisor.modelCatalog();
  assert.equal(spawns, 1);
  assert.equal(leases, 0);
});

test('fencing during accepted enrichment leaves that root owned and rejects new roots without abort', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child);
  const enriched = deferredEnrichment<Record<string, unknown>>();
  let entered = false;
  const supervisor = new GjcWorkerSupervisor({ ...runtime(child), enrichOptions: async () => { entered = true; return enriched.promise; } });
  const accepted = supervisor.spawnRun({ runId: 'accepted', appSessionId: 'scope', message: 'existing', writer: { send() {} } });
  peer.respond(await peer.waitFor('worker.initialize'));
  await flushEnrichment();
  assert.equal(entered, true);
  await assert.rejects(supervisor.fenceForDesktopRestart('update-1'), /accepted work/);
  const blocked = supervisor.spawnRun({ runId: 'blocked', appSessionId: 'scope', message: 'new', writer: { send() {} } });
  await assert.rejects(blocked.started, { code: 'DESKTOP_RESTART_FENCED' });
  assert.equal(await blocked.outcome, 'not_started');
  assert.equal(peer.requests.some((r) => r.method === 'worker.admission' || r.method === 'turn.abort'), false);
  enriched.resolve({});
  const start = await peer.waitFor('session.start');
  assert.equal(start.id, 'accepted');
  peer.respond(start);
  await accepted.completion;
  await supervisor.releaseDesktopRestartFence('update-1');
  assert.equal(child.killed, false);
});

test('desktop reader is inert, detached from returned snapshots, and bound to the production singleton by default', async () => {
  let spawns = 0;
  let reaps = 0;
  const child = new FakeChild();
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    spawn: () => { spawns += 1; return child; },
    killTree: () => { reaps += 1; },
  });
  const reader = createGjcWorkerDesktopRestartReader(supervisor);
  const generation = reader.getGeneration();
  const first = await reader.read();
  assertDesktopIdle(first);
  assert.equal(first.generation, generation);
  (first.unknown as string[]).push('caller_mutation');
  first.queued = 100;
  assertDesktopIdle(await reader.read());
  assert.equal(reader.getGeneration(), generation);
  assert.notEqual(new GjcWorkerSupervisor().getGeneration(), generation);
  assert.deepEqual(await createGjcWorkerDesktopRestartReader().read(), getGjcWorkerSupervisor().snapshotActivity());
  assert.equal(spawns, 0);
  assert.equal(reaps, 0);
  assert.equal(child.killed, false);
});

test('desktop startup is owned inside spawn and request settlement retains its awaiting continuation', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child);
  let insideSpawn!: DesktopOwnerActivity;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    spawn: () => { insideSpawn = supervisor.snapshotActivity(); return child; },
  });
  const reader = createGjcWorkerDesktopRestartReader(supervisor);
  const cold = reader.getGeneration();
  const catalog = supervisor.modelCatalog();
  assert.ok(insideSpawn.starting > 0);
  assert.ok(insideSpawn.settling > 0);
  assert.notEqual(insideSpawn.generation, cold);
  const initializing = supervisor.snapshotActivity();
  assert.equal(initializing.complete, false);
  assert.deepEqual(initializing.unknown, ['worker_runtime_unaccounted']);
  peer.respond(await peer.waitFor('worker.initialize'));
  const request = await peer.waitFor('models.catalog');
  const pending = supervisor.snapshotActivity();
  assert.equal(pending.queued, 1);
  assert.equal(pending.starting, 0);
  assert.notEqual(pending.generation, initializing.generation);
  peer.respond(request);
  const acknowledged = supervisor.snapshotActivity();
  assert.equal(acknowledged.queued, 0);
  assert.ok(acknowledged.settling > 0, 'response acknowledgement cannot drop its continuation');
  assert.notEqual(acknowledged.generation, pending.generation);
  await catalog;
  const retained = supervisor.snapshotActivity();
  assert.equal(retained.settling, 0);
  assert.equal(retained.retained, 1);
  assert.equal(retained.complete, false, 'an empty parent request map is not SDK idle proof');
  assert.equal(child.killed, false, 'reading never drains a retained worker');
});

test('desktop generation records failed startup even when both endpoint snapshots are idle', async () => {
  let observed!: DesktopOwnerActivity;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(new FakeChild()),
    spawn: () => { observed = supervisor.snapshotActivity(); throw new Error('spawn failed'); },
  });
  const before = supervisor.snapshotActivity();
  assertDesktopIdle(before);
  await assert.rejects(supervisor.modelCatalog(), /spawn failed/);
  assert.ok(observed.starting > 0);
  assert.ok(observed.settling > 0);
  const after = supervisor.snapshotActivity();
  assertDesktopIdle(after);
  assert.notEqual(before.generation, after.generation, 'idle -> failed startup -> idle must invalidate a prepared proof');
});

test('desktop reader tracks registered, issued and terminal run mutations without exposing payloads', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child);
  const supervisor = new GjcWorkerSupervisor(runtime(child));
  const reader = createGjcWorkerDesktopRestartReader(supervisor);
  const cold = reader.getGeneration();
  const run = spawn(supervisor, 'private-prompt-never-in-snapshot', {}, { send() {} });
  const registered = supervisor.snapshotActivity();
  assert.ok(registered.starting >= 2, 'registered run plus worker startup');
  assert.notEqual(registered.generation, cold);
  peer.respond(await peer.waitFor('worker.initialize'));
  const start = await peer.waitFor('session.start');
  const issued = supervisor.snapshotActivity();
  assert.equal(issued.starting, 0);
  assert.equal(issued.running, 1);
  assert.equal(issued.queued, 1);
  assert.notEqual(issued.generation, registered.generation);
  peer.event('app-session-1', start.id, 'turn.completed', { message: { kind: 'complete' } });
  const terminalEvent = supervisor.snapshotActivity();
  assert.equal(terminalEvent.running, 1, 'UI terminal does not retire the request/run owner');
  assert.notEqual(terminalEvent.generation, issued.generation);
  peer.respond(start);
  assert.equal(supervisor.snapshotActivity().queued, 0);
  assert.equal(supervisor.snapshotActivity().running, 1, 'run finalization is still queued after acknowledgement');
  await run;
  await new Promise((resolve) => setImmediate(resolve));
  const finished = supervisor.snapshotActivity();
  assert.equal(finished.running, 0);
  assert.equal(finished.settling, 0);
  assert.deepEqual(finished.unknown, ['worker_runtime_unaccounted']);
  assert.notEqual(finished.generation, terminalEvent.generation);
  assert.equal(JSON.stringify(finished).includes('private-prompt'), false);
  assert.equal(JSON.stringify(finished).includes(start.id), false);
});

test('desktop approvals include hidden in-flight replies, restoration and cancellation', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
  const supervisor = new GjcWorkerSupervisor(runtime(child));
  const run = spawn(supervisor, 'hello', {}, { send() {} });
  const start = await peer.waitFor('session.start');
  const initial = supervisor.snapshotActivity();
  peer.event('app-session-1', start.id, 'ask.presented', {
    message: { kind: 'permission_request', requestId: 'private-approval', content: 'secret-input' },
  });
  const presented = supervisor.snapshotActivity();
  assert.equal(presented.approvals, 1);
  assert.notEqual(presented.generation, initial.generation);
  assert.equal(supervisor.resolveApproval('private-approval', { allow: true }), true);
  const replying = supervisor.snapshotActivity();
  assert.deepEqual(supervisor.pendingApprovals('app-session-1'), []);
  assert.equal(replying.approvals, 1);
  assert.ok(replying.settling > presented.settling);
  assert.notEqual(replying.generation, presented.generation);
  assert.equal(JSON.stringify(replying).includes('private-approval'), false);
  const reply = await peer.waitFor('ask.reply');
  peer.respond(reply, { ok: true, result: { accepted: false } });
  await new Promise((resolve) => setImmediate(resolve));
  const restored = supervisor.snapshotActivity();
  assert.equal(restored.approvals, 1);
  assert.equal(supervisor.pendingApprovals('app-session-1').length, 1);
  assert.equal(restored.settling, presented.settling);
  assert.notEqual(restored.generation, replying.generation);
  supervisor.resolveApproval('private-approval', { allow: false });
  peer.respond(await peer.waitFor('ask.reply', 2), { ok: true, result: { accepted: true } });
  await new Promise((resolve) => setImmediate(resolve));
  const accepted = supervisor.snapshotActivity();
  assert.equal(accepted.approvals, 1, 'accepted reply alone does not erase the mirrored approval');
  peer.event('app-session-1', start.id, 'ask.presented', {
    message: { kind: 'permission_cancelled', requestId: 'private-approval' },
  });
  assert.equal(supervisor.snapshotActivity().approvals, 0);
  assert.notEqual(supervisor.getGeneration(), accepted.generation);
  peer.respond(start); await run;
});

test('desktop timeout uncertainty survives 257-request eviction, late replies and failAll until tree proof', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
  let releaseReap!: () => void;
  const verifiedTree = new Promise<void>((resolve) => { releaseReap = resolve; });
  let insideReap!: DesktopOwnerActivity;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child), requestTimeoutMs: 5,
    killTree: () => { insideReap = supervisor.snapshotActivity(); return verifiedTree; },
  });
  const warm = supervisor.modelCatalog();
  peer.respond(await peer.waitFor('models.catalog')); await warm;
  const waiters = Array.from({ length: 257 }, () => supervisor.modelCatalog());
  const failures = Promise.all(waiters.map((waiter) => assert.rejects(waiter, /request timed out/)));
  await peer.waitFor('models.catalog', 258);
  const before = supervisor.snapshotActivity();
  assert.equal(before.queued, 257);
  t.mock.timers.tick(5); await failures;
  const timedOut = supervisor.snapshotActivity();
  assert.equal(timedOut.queued, 0);
  assert.equal(timedOut.settling, 0);
  assert.ok(timedOut.unknown.includes('worker_request_timeout_unconfirmed'));
  assert.notEqual(timedOut.generation, before.generation);
  const expired = (supervisor as unknown as { expiredRequests: ReadonlyMap<string, unknown> }).expiredRequests;
  assert.equal(expired.size, 256, 'exercise actual bounded-cache eviction, not just one timeout');
  const requests = peer.requests.filter((request) => request.method === 'models.catalog').slice(1);
  for (const request of requests.slice(1)) peer.respond(request);
  assert.equal(expired.size, 0);
  const late = supervisor.snapshotActivity();
  assert.ok(late.unknown.includes('worker_request_timeout_unconfirmed'));
  assert.notEqual(late.generation, timedOut.generation);
  assert.equal(child.killed, false);

  child.emit('exit', 1);
  assert.ok(insideReap.unknown.includes('worker_reap_pending'));
  assert.equal(insideReap.retained, 1, 'the child field is cleared before killTree but ownership must survive');
  const pendingReap = supervisor.snapshotActivity();
  assert.ok(pendingReap.unknown.includes('worker_request_timeout_unconfirmed'));
  assert.equal(expired.size, 0, 'failAll/cache clearing is not reap proof');
  assert.notEqual(pendingReap.generation, late.generation);
  releaseReap();
  await new Promise((resolve) => setImmediate(resolve));
  assertDesktopIdle(supervisor.snapshotActivity());
  assert.notEqual(supervisor.getGeneration(), pendingReap.generation);
});

test('desktop failed reap retains runtime and timeout uncertainty without active parent requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child), requestTimeoutMs: 5,
    killTree: () => Promise.reject(new Error('tree remains alive')),
  });
  const request = assert.rejects(supervisor.oauthStatus(), /request timed out/);
  await peer.waitFor('oauth.status');
  t.mock.timers.tick(5); await request;
  child.emit('exit', 1);
  await new Promise((resolve) => setImmediate(resolve));
  const failed = supervisor.snapshotActivity();
  assert.equal(failed.queued, 0);
  assert.equal(failed.running, 0);
  assert.equal(failed.settling, 0);
  assert.equal(failed.retained, 1);
  assert.equal(failed.complete, false);
  assert.deepEqual(failed.unknown, [
    'worker_runtime_unaccounted', 'worker_request_timeout_unconfirmed', 'worker_reap_unconfirmed',
  ]);
  assert.equal(supervisor.getGeneration(), failed.generation);
  assert.deepEqual(supervisor.snapshotActivity(), failed);
});

test('desktop reader retains option enrichment after registered-run abort and verified worker reap', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
  let rejectEnrichment!: (error: Error) => void;
  const enrichment = new Promise<never>((_resolve, reject) => { rejectEnrichment = reject; });
  let enriching = false;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child), enrichOptions: () => { enriching = true; return enrichment; },
  });
  const run = spawn(supervisor, 'hello', {}, { send() {} });
  await peer.waitFor('worker.initialize');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(enriching, true);
  assert.equal(await supervisor.abort(run.abortHandle), 'not_started');
  await run;
  child.emit('exit', 1);
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = supervisor.snapshotActivity();
  assert.equal(waiting.running, 0);
  assert.equal(waiting.starting, 0);
  assert.equal(waiting.retained, 0);
  assert.equal(waiting.complete, true);
  assert.ok(waiting.settling > 0, 'the removed run still has an accepted enrichment continuation');
  rejectEnrichment(new Error('late enrichment failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assertDesktopIdle(supervisor.snapshotActivity());
  assert.notEqual(supervisor.getGeneration(), waiting.generation);
  assert.equal(peer.requests.some((request) => request.method === 'session.start'), false);
});

function deferredEnrichment<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const flushEnrichment = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const method of ['session.start', 'session.resume'] as const) {
  test(`successful option enrichment cannot dispatch a cancelled ${method}`, async () => {
    const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
    const entered = deferredEnrichment<void>();
    const enriched = deferredEnrichment<Record<string, unknown>>();
    const messages: unknown[] = [];
    let stopped = 0;
    const supervisor = new GjcWorkerSupervisor({
      ...runtime(child),
      enrichOptions: () => { entered.resolve(); return enriched.promise; },
      notifyRunStopped: () => { stopped += 1; },
    });
    const run = supervisor.spawnRun({
      runId: 'cancel-during-enrichment', appSessionId: 'app-session-1', message: 'never send this',
      options: method === 'session.resume' ? { sessionId: 'existing-provider-session' } : {},
      writer: { send: (message) => messages.push(message) },
    });
    try {
      await entered.promise;
      const alias = method === 'session.resume' ? 'existing-provider-session' : run.abortHandle;
      assert.equal(await supervisor.abort(alias), 'not_started');
      await run.completion;
      await assert.rejects(run.started, /GJC worker failed/);
      assert.equal(await run.outcome, 'not_started');
      assert.equal(run.phase?.(), 'run_terminal');
      const cancelled = supervisor.snapshotActivity();
      assert.ok(cancelled.settling > 0, 'cancellation still owns the unfinished enrichment');
      enriched.resolve({ cwd: '/test/project', modelId: 'resolved-model' });
      await flushEnrichment();
      assert.equal(peer.requests.some((request) => request.method === method), false);
      assert.equal(run.phase?.(), 'run_terminal');
      assert.equal(supervisor.isActive(alias), false);
      assert.equal(supervisor.snapshotActivity().settling, 0);
      assert.notEqual(supervisor.getGeneration(), cancelled.generation);
      assert.equal(child.killed, false, 'cancelling an unissued run must not kill the shared worker');
      assert.deepEqual(messages, [], 'no synthetic completion or late stream after the accepted abort');
      assert.equal(stopped, 1);
    } finally {
      enriched.resolve({});
      await flushEnrichment();
      for (const request of peer.requests.filter((entry) => entry.method === method)) peer.respond(request);
      await flushEnrichment();
    }
  });
}

test('successful option enrichment from a cancelled run cannot seize its reused run ID', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
  const oldEntered = deferredEnrichment<void>(); const nextEntered = deferredEnrichment<void>();
  const oldOptions = deferredEnrichment<Record<string, unknown>>();
  const nextOptions = deferredEnrichment<Record<string, unknown>>();
  let enrichments = 0;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    enrichOptions: () => {
      if (++enrichments === 1) { oldEntered.resolve(); return oldOptions.promise; }
      nextEntered.resolve(); return nextOptions.promise;
    },
  });
  const input = { runId: 'reused-run-id', appSessionId: 'app-session-1', writer: { send() {} } };
  const oldRun = supervisor.spawnRun({ ...input, message: 'cancelled message' });
  try {
    await oldEntered.promise;
    assert.equal(await supervisor.abort(oldRun.abortHandle), 'not_started');
    await oldRun.completion;
    const replacement = supervisor.spawnRun({ ...input, message: 'replacement message' });
    await nextEntered.promise;
    oldOptions.resolve({ modelId: 'stale-model' });
    await flushEnrichment();
    assert.equal(peer.requests.some((request) => request.method === 'session.start'), false);
    assert.equal(oldRun.phase?.(), 'run_terminal');
    assert.equal(replacement.phase?.(), 'registered');
    assert.equal(supervisor.isActive(replacement.abortHandle), true);
    nextOptions.resolve({ modelId: 'current-model' });
    const start = await peer.waitFor('session.start');
    assert.equal((start.payload as JsonObject).message, 'replacement message');
    assert.equal(((start.payload as JsonObject).options as Record<string, unknown>).modelId, 'current-model');
    await replacement.started;
    peer.respond(start);
    await replacement.completion;
    assert.equal(await replacement.outcome, 'completed');
    assert.equal(await oldRun.outcome, 'not_started');
    assert.equal(peer.requests.filter((request) => request.method === 'session.start').length, 1);
  } finally {
    oldOptions.resolve({}); nextOptions.resolve({});
    await flushEnrichment();
    for (const request of peer.requests.filter((entry) => entry.method === 'session.start')) peer.respond(request);
    await flushEnrichment();
  }
});

test('successful option enrichment during shutdown uses the existing not-started abort outcome', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
  const entered = deferredEnrichment<void>();
  const enriched = deferredEnrichment<Record<string, unknown>>();
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child), enrichOptions: () => { entered.resolve(); return enriched.promise; },
  });
  const run = supervisor.spawnRun({
    runId: 'shutdown-enrichment', appSessionId: 'app-session-1', message: 'never dispatch', writer: { send() {} },
  });
  let shutdown: Promise<void> | undefined;
  try {
    await entered.promise;
    shutdown = supervisor.shutdown();
    await peer.waitFor('worker.shutdown');
    enriched.resolve({ modelId: 'late-model' });
    await flushEnrichment();
    assert.equal(peer.requests.some((request) => request.method === 'session.start'), false);
    await run.completion;
    assert.equal(await run.outcome, 'not_started');
    assert.equal(run.phase?.(), 'run_terminal');
    assert.equal(child.killed, false, 'the existing shutdown response/reap sequence is unchanged');
  } finally {
    enriched.resolve({});
    await flushEnrichment();
    for (const request of peer.requests.filter((entry) => entry.method === 'session.start' || entry.method === 'worker.shutdown')) peer.respond(request);
    if (shutdown) await shutdown;
    await flushEnrichment();
  }
});

test('successful option enrichment from a reaped worker cannot dispatch into its replacement', async () => {
  const first = new FakeChild(); const second = new FakeChild();
  const peer = new FakePeer(first); const nextPeer = new FakePeer(second);
  replyToHandshake(peer); replyToHandshake(nextPeer);
  const entered = deferredEnrichment<void>();
  const enriched = deferredEnrichment<Record<string, unknown>>();
  let spawns = 0;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(first), spawn: () => ++spawns === 1 ? first : second,
    killTree: () => {},
    enrichOptions: () => { entered.resolve(); return enriched.promise; },
  });
  const run = supervisor.spawnRun({
    runId: 'old-worker-enrichment', appSessionId: 'app-session-1', message: 'old worker only', writer: { send() {} },
  });
  try {
    await entered.promise;
    const failure = assert.rejects(run.completion, /GJC worker failed/);
    first.emit('exit', 1);
    await failure;
    assert.equal(await run.outcome, 'reaped');
    const catalog = supervisor.modelCatalog();
    nextPeer.respond(await nextPeer.waitFor('models.catalog'));
    await catalog;
    assert.equal(spawns, 2);
    enriched.resolve({ modelId: 'old-generation-model' });
    await flushEnrichment();
    assert.equal(nextPeer.requests.some((request) => request.method === 'session.start'), false);
    assert.equal(peer.requests.some((request) => request.method === 'session.start'), false);
    assert.equal(run.phase?.(), 'run_terminal');
    assert.equal(supervisor.active().length, 0);
    assert.equal(supervisor.snapshotActivity().settling, 0);
    assert.equal(second.killed, false);
  } finally {
    enriched.resolve({});
    await flushEnrichment();
    for (const request of nextPeer.requests.filter((entry) => entry.method === 'session.start')) nextPeer.respond(request);
    await flushEnrichment();
  }
});

test('desktop reader owns terminal callback settlement after run removal and tree reap', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
  let finishNotification!: () => void;
  const notification = new Promise<void>((resolve) => { finishNotification = resolve; });
  let duringNotification!: DesktopOwnerActivity;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child), notifyRunStopped: () => {
      duringNotification = supervisor.snapshotActivity();
      return notification;
    },
  });
  const run = spawn(supervisor, 'hello', {}, { send() {} });
  peer.respond(await peer.waitFor('session.start')); await run;
  assert.equal(duringNotification.running, 0);
  assert.ok(duringNotification.settling > 0);
  child.emit('exit', 1);
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = supervisor.snapshotActivity();
  assert.equal(waiting.retained, 0);
  assert.equal(waiting.complete, true);
  assert.ok(waiting.settling > 0);
  finishNotification();
  await new Promise((resolve) => setImmediate(resolve));
  assertDesktopIdle(supervisor.snapshotActivity());
  assert.notEqual(supervisor.getGeneration(), waiting.generation);
});

test('desktop reap-to-finalization handoff has no zero-count gap inside a writer callback', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
  const observed: DesktopOwnerActivity[] = [];
  const supervisor = new GjcWorkerSupervisor(runtime(child));
  const run = spawn(supervisor, 'hello', {}, { send() { observed.push(supervisor.snapshotActivity()); } });
  await peer.waitFor('session.start');
  const failure = assert.rejects(run, /GJC worker failed/);
  child.emit('exit', 1);
  await failure;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(observed.length > 0);
  for (const during of observed) {
    assert.equal(during.running, 0);
    assert.equal(during.retained, 0);
    assert.ok(during.settling > 0, 'finish owns synchronous callbacks after releasing the run map entry');
  }
  assertDesktopIdle(supervisor.snapshotActivity());
});

test('desktop replacement waiters remain owned across reap and stale old-child frames cannot mutate the reader', async () => {
  const first = new FakeChild(); const second = new FakeChild();
  const peer = new FakePeer(first); const nextPeer = new FakePeer(second);
  replyToHandshake(peer); replyToHandshake(nextPeer);
  let releaseReap!: () => void;
  const verifiedTree = new Promise<void>((resolve) => { releaseReap = resolve; });
  let spawns = 0;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(first), spawn: () => ++spawns === 1 ? first : second,
    killTree: () => verifiedTree,
  });
  const warm = supervisor.modelCatalog();
  peer.respond(await peer.waitFor('models.catalog')); await warm;
  const oldGeneration = supervisor.getGeneration();
  first.emit('exit', 1);
  const run = spawn(supervisor, 'replacement', {}, { send() {} });
  const catalog = supervisor.modelCatalog();
  const waiting = supervisor.snapshotActivity();
  assert.equal(spawns, 1);
  assert.ok(waiting.starting > 0);
  assert.ok(waiting.settling > 0);
  assert.ok(waiting.unknown.includes('worker_reap_pending'));
  assert.notEqual(waiting.generation, oldGeneration);
  releaseReap();
  const start = await nextPeer.waitFor('session.start');
  const models = await nextPeer.waitFor('models.catalog');
  const replaced = supervisor.snapshotActivity();
  assert.equal(spawns, 2);
  assert.equal(replaced.retained, 1);
  assert.equal(replaced.running, 1);
  assert.deepEqual(replaced.unknown, ['worker_runtime_unaccounted']);
  assert.notEqual(replaced.generation, waiting.generation);
  first.stdout.write('not-json\n');
  first.emit('close', 1);
  assert.equal(supervisor.getGeneration(), replaced.generation);
  nextPeer.respond(start); nextPeer.respond(models);
  await Promise.all([run, catalog]);
});

test('desktop process-tree proof includes a separately reported run process, not just worker leader exit', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
  let proveProcessExit!: () => void;
  const processExit = new Promise<void>((resolve) => { proveProcessExit = resolve; });
  const killed: number[] = [];
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child), killTree: () => {},
    killProcessTree: (pid) => { killed.push(pid); return processExit; },
  });
  const run = spawn(supervisor, 'hello', {}, { send() {} });
  const start = await peer.waitFor('session.start');
  const beforePid = supervisor.getGeneration();
  peer.status('app-session-1', start.id, 4242);
  assert.notEqual(supervisor.getGeneration(), beforePid);
  const failure = assert.rejects(run, /GJC worker failed/);
  child.emit('exit', 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(killed, [4242]);
  const pending = supervisor.snapshotActivity();
  assert.equal(pending.retained, 1);
  assert.equal(pending.running, 1);
  assert.ok(pending.unknown.includes('worker_reap_pending'));
  proveProcessExit(); await failure;
  await new Promise((resolve) => setImmediate(resolve));
  assertDesktopIdle(supervisor.snapshotActivity());
});

test('desktop missing process reaper or discarded PID never becomes an OS tree-termination proof', async () => {
  for (const mode of ['missing-reaper', 'pid-cleared', 'pid-replaced', 'run-finished'] as const) {
    const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
    const supervisor = new GjcWorkerSupervisor({
      ...runtime(child),
      ...(mode !== 'missing-reaper' ? { killProcessTree: () => {} } : {}),
    });
    const run = spawn(supervisor, 'hello', {}, { send() {} });
    const start = await peer.waitFor('session.start');
    peer.status('app-session-1', start.id, 4242);
    if (mode === 'pid-cleared') peer.status('app-session-1', start.id, null);
    if (mode === 'pid-replaced') peer.status('app-session-1', start.id, 4243);
    if (mode === 'run-finished') { peer.respond(start); await run; }
    const settled = mode === 'run-finished' ? run : assert.rejects(run, /GJC worker failed/);
    child.emit('exit', 1); await settled;
    await new Promise((resolve) => setImmediate(resolve));
    const unknown = supervisor.snapshotActivity();
    assert.equal(unknown.retained, 1, mode);
    assert.equal(unknown.complete, false, mode);
    assert.deepEqual(unknown.unknown, ['worker_runtime_unaccounted', 'worker_process_tree_unaccounted'], mode);
  }
});

test('desktop pending approval and abort completions outlive terminal run and approval map removal', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child); replyToHandshake(peer);
  const supervisor = new GjcWorkerSupervisor(runtime(child));
  const run = spawn(supervisor, 'hello', {}, { send() {} });
  const start = await peer.waitFor('session.start');
  peer.event('app-session-1', start.id, 'ask.presented', {
    message: { kind: 'permission_request', requestId: 'outliving-reply' },
  });
  supervisor.resolveApproval('outliving-reply', { allow: true });
  const beforeAbort = supervisor.getGeneration();
  const abort = supervisor.abort(run.abortHandle);
  assert.notEqual(supervisor.getGeneration(), beforeAbort);
  const abortRequest = await peer.waitFor('turn.abort');
  const approvalRequest = await peer.waitFor('ask.reply');
  peer.respond(start); await run;
  const terminal = supervisor.snapshotActivity();
  assert.equal(terminal.running, 0);
  assert.equal(terminal.approvals, 0);
  assert.equal(terminal.queued, 2);
  assert.ok(terminal.settling >= 2, 'both owned completion handlers are still live');
  peer.respond(abortRequest, { ok: true, result: { aborted: true } });
  peer.respond(approvalRequest, { ok: true, result: { accepted: false } });
  const replies = supervisor.snapshotActivity();
  assert.equal(replies.queued, 0);
  assert.ok(replies.settling >= 2, 'acknowledging both requests does not run their continuations inline');
  assert.notEqual(replies.generation, terminal.generation);
  assert.equal(await abort, 'unconfirmed', 'do not change existing late-abort behavior');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.snapshotActivity().settling, 0);
  assert.notEqual(supervisor.getGeneration(), replies.generation);
});

test('desktop old reap cannot erase a reentrant replacement generation or its pending reap', async () => {
  const first = new FakeChild(); const second = new FakeChild();
  const peer = new FakePeer(first); const nextPeer = new FakePeer(second);
  replyToHandshake(peer); replyToHandshake(nextPeer);
  let proveFirstExit!: () => void; let proveSecondExit!: () => void;
  const firstExit = new Promise<void>((resolve) => { proveFirstExit = resolve; });
  const secondExit = new Promise<void>((resolve) => { proveSecondExit = resolve; });
  let replacement!: Promise<unknown>;
  let insideReplacement!: DesktopOwnerActivity;
  let spawns = 0;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(first), spawn: () => ++spawns === 1 ? first : second,
    killTree: (child) => {
      if (child === first) {
        // Existing lifecycle hooks can reenter before terminating is assigned.
        // Observation must remain safe without changing that runtime behavior.
        replacement = supervisor.modelCatalog();
        insideReplacement = supervisor.snapshotActivity();
        return firstExit;
      }
      return secondExit;
    },
  });
  const warm = supervisor.modelCatalog();
  peer.respond(await peer.waitFor('models.catalog')); await warm;
  first.emit('exit', 1);
  assert.equal(insideReplacement.retained, 2);
  nextPeer.respond(await nextPeer.waitFor('models.catalog')); await replacement;
  second.emit('exit', 1);
  const bothRetiring = supervisor.snapshotActivity();
  assert.equal(bothRetiring.retained, 2);
  proveFirstExit();
  await new Promise((resolve) => setImmediate(resolve));
  const secondRetiring = supervisor.snapshotActivity();
  assert.equal(secondRetiring.retained, 1);
  assert.equal(secondRetiring.complete, false);
  assert.ok(secondRetiring.unknown.includes('worker_reap_pending'));
  assert.notEqual(secondRetiring.generation, bothRetiring.generation);
  proveSecondExit();
  await new Promise((resolve) => setImmediate(resolve));
  assertDesktopIdle(supervisor.snapshotActivity());
});

test('desktop frozen Windows tree remains unaccounted even if an injected reaper fulfills', async () => {
  const child = new FakeChild(); const peer = new FakePeer(child, true); replyToHandshake(peer);
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child), platform: 'win32', killTree: () => {},
    environment: { SystemRoot: 'C:\\Windows' },
  });
  const catalog = supervisor.modelCatalog();
  child.stdout.write(`${GJC_WINDOWS_JOB_GUARD_READY}\n`);
  peer.respond(await peer.waitFor('models.catalog')); await catalog;
  child.emit('exit', 1);
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = supervisor.snapshotActivity();
  assert.equal(snapshot.retained, 1);
  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.unknown, ['worker_runtime_unaccounted']);
});
