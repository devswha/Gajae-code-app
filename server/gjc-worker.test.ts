import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  GJC_WORKER_PROTOCOL_VERSION,
  GJC_WORKER_REQUEST_METHODS,
  GjcWorkerNdjsonDecoder,
  parseGjcWorkerFrame,
  serializeGjcWorkerFrame,
  type GjcWorkerEventFrame,
  type GjcWorkerRequestFrame,
} from './gjc-worker-protocol.js';
import { GjcRunPermissionsError } from './gjc-permission-policy.js';
import { GJC_CLEANUP_UNCONFIRMED_CODE, GJC_CLEANUP_UNCONFIRMED_MESSAGE, GjcCleanupUnconfirmedError, isGjcCleanupUnconfirmedError } from './gjc-cleanup-error.js';
import { GJC_MODEL_UNRESOLVED_CODE, GJC_MODEL_UNRESOLVED_MESSAGE, GjcModelResolutionError } from './gjc-model-resolution.js';
import { claimProtocolStdout, GjcWorkerHost, runGjcWorkerEntrypoint, type GjcWorkerRuntime, type GjcWorkerWriter } from './gjc-worker.js';

const request = (method: string, id: string, payload: Record<string, unknown> = {}, sessionId = 'scope-1') => ({ protocolVersion: GJC_WORKER_PROTOCOL_VERSION, kind: 'request' as const, id, method, payload, ...(['worker.initialize', 'worker.shutdown', 'worker.activity', 'worker.admission', 'models.catalog', 'oauth.providers', 'oauth.status', 'oauth.start', 'oauth.submit', 'oauth.cancel'].includes(method) ? {} : { sessionId }) }) as GjcWorkerRequestFrame;
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fakeRuntime() {
  const runs: Array<{ run: ReturnType<typeof deferred<void>>; writer?: GjcWorkerWriter }> = []; const calls: string[] = [];
  const runtime: GjcWorkerRuntime = {
    spawnGjc: (_message, _options, writer) => {
      const run = deferred<void>();
      runs.push({ run, writer });
      const result = run.promise as Promise<void> & {
        abortHandle?: string;
        processId?: number;
      };
      result.abortHandle = `abort-${runs.length}`;
      result.processId = 4_200 + runs.length;
      return result;
    },
    abortGjcSession: async (id) => { calls.push(id); return true; },
    resolveGjcToolApproval: (id) => { calls.push(id); return true; },
  };
  return { runtime, runs, calls };
}
async function initialized(fake = fakeRuntime()) {
  const frames: unknown[] = []; const host = new GjcWorkerHost({ runtime: async () => fake.runtime, emit: (frame) => frames.push(frame) });
  await host.handle(request('worker.initialize', 'init'));
  return { fake, frames, host };
}

test('worker observation is noninitializing, self-excluding and requires reversible runtime admission', async () => {
  const fake = fakeRuntime();
  let loads = 0;
  const changes: boolean[] = [];
  const activity = { generation: 'sdk-1', complete: true, starting: 0, queued: 0,
    running: 0, settling: 0, approvals: 0, retained: 0, unknown: [] as string[] };
  fake.runtime.observeActivity = () => ({ ...activity, unknown: [...activity.unknown] });
  fake.runtime.setAdmissionFence = (closed) => { changes.push(closed); };
  const frames: any[] = [];
  const host = new GjcWorkerHost({ runtime: async () => { loads++; return fake.runtime; }, emit: (frame) => frames.push(frame) });
  const call = async (method: string, id: string, payload = {}) => {
    await host.handle(request(method, id, payload));
    return frames.find((frame) => frame.id === id)!.payload;
  };
  assert.equal((await call('worker.activity', 'cold')).result.complete, false);
  assert.equal(loads, 0);
  await call('worker.initialize', 'initialize');
  assert.ok((await call('worker.activity', 'open')).result.unknown.includes('worker_admission_open'));
  await call('worker.admission', 'close', { fenceId: 'f1', closed: true });
  const first = (await call('worker.activity', 'first')).result;
  const second = (await call('worker.activity', 'second')).result;
  assert.deepEqual(second, first, 'observation does not revise or count itself');
  assert.equal(first.complete, true);
  assert.equal(first.settling + first.running + first.starting + first.queued, 0);
  assert.equal((await call('session.start', 'blocked', { message: 'new', options: {} })).error.code, 'worker_admission_fenced');
  assert.equal(fake.runs.length, 0);
  assert.equal((await call('worker.admission', 'wrong', { fenceId: 'f2', closed: false })).error.code, 'worker_admission_conflict');
  await call('worker.admission', 'release', { fenceId: 'f1', closed: false });
  assert.deepEqual(changes, [true, false]);
  const accepted = host.handle(request('session.start', 'accepted', { message: 'existing', options: {} }));
  assert.equal(fake.runs.length, 1);
  await call('worker.admission', 'reclose', { fenceId: 'f2', closed: true });
  assert.equal(fake.calls.length, 0, 'closing admission does not abort accepted roots');
  assert.ok((await call('worker.activity', 'busy')).result.settling > 0);
  fake.runs[0]!.run.resolve();
  await accepted;
  assert.equal((await call('worker.activity', 'settled')).result.complete, true);
  await host.close();
});

test('runtime unknowns and missing observations remain blockers behind a worker fence', async () => {
  const fake = fakeRuntime();
  fake.runtime.setAdmissionFence = () => {};
  const { host, frames } = await initialized(fake);
  await host.handle(request('worker.admission', 'fence', { fenceId: 'f1', closed: true }));
  await host.handle(request('worker.activity', 'missing'));
  const missing = (frames.find((frame: any) => frame.id === 'missing') as any).payload.result;
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.unknown, ['worker_runtime_unaccounted']);
  fake.runtime.observeActivity = () => ({ generation: 'sdk-2', complete: false, starting: 0, queued: 0,
    running: 0, settling: 1, approvals: 0, retained: 0, unknown: ['sdk_background_ownership_unproven'] });
  await host.handle(request('worker.activity', 'unproven'));
  const unproven = (frames.find((frame: any) => frame.id === 'unproven') as any).payload.result;
  assert.deepEqual(unproven.unknown, ['sdk_background_ownership_unproven']);
  assert.equal(unproven.settling, 1);
  assert.equal(unproven.complete, false);
  await host.close();
});

test('worker observation generation binds SDK-only revisions without revising on the observation itself', async () => {
  const fake = fakeRuntime();
  let generation = 'sdk-1';
  fake.runtime.setAdmissionFence = () => {};
  fake.runtime.observeActivity = () => ({ generation, complete: true, starting: 0, queued: 0,
    running: 0, settling: 0, approvals: 0, retained: 0, unknown: [] });
  const { host, frames } = await initialized(fake);
  await host.handle(request('worker.admission', 'fence', { fenceId: 'f1', closed: true }));
  const observe = async (id: string): Promise<string> => {
    await host.handle(request('worker.activity', id));
    const frame = frames.find((frame: any) => frame.id === id) as { payload: { result: { generation: string } } };
    return frame.payload.result.generation;
  };
  const before = await observe('before');
  assert.equal(await observe('unchanged'), before);
  generation = 'sdk-3';
  const after = await observe('after');
  assert.notEqual(after, before, 'idle endpoint counts cannot conceal SDK mutations');
  assert.equal(await observe('still-unchanged'), after);
  assert.match(after, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  await host.close();
});

test('cleanup failure requires the app-owned brand, not a provider name, code, message or prototype', () => {
  const genuine = new GjcCleanupUnconfirmedError();
  assert.equal(isGjcCleanupUnconfirmedError(genuine), true);
  assert.equal(genuine.message, GJC_CLEANUP_UNCONFIRMED_MESSAGE);
  for (const spoof of [
    GJC_CLEANUP_UNCONFIRMED_MESSAGE, null, undefined,
    Object.assign(new Error(GJC_CLEANUP_UNCONFIRMED_MESSAGE), { name: genuine.name, code: GJC_CLEANUP_UNCONFIRMED_CODE }),
    Object.create(GjcCleanupUnconfirmedError.prototype),
    { name: genuine.name, code: GJC_CLEANUP_UNCONFIRMED_CODE, message: genuine.message },
  ]) assert.equal(isGjcCleanupUnconfirmedError(spoof), false);
});

test('fatal cleanup fences all worker requests and sibling events without retiring uncertain runs', async () => {
  const fake = fakeRuntime();
  const frames: Array<{ kind?: string; id?: string; method?: string; payload?: any }> = [];
  const host = new GjcWorkerHost({ runtime: async () => fake.runtime, emit: (frame) => frames.push(frame), closeDrainMs: 1 });
  await host.handle(request('worker.initialize', 'init'));
  const first = host.handle(request('session.start', 'fatal-run', { message: 'first', options: {} }, 'scope-a'));
  const second = host.handle(request('session.start', 'sibling-run', { message: 'second', options: {} }, 'scope-b'));
  fake.runs[0]!.run.reject(new GjcCleanupUnconfirmedError());
  await first;
  const fatal = frames.find((frame) => frame.id === 'fatal-run')!;
  assert.deepEqual(fatal.payload, { ok: false, error: { code: GJC_CLEANUP_UNCONFIRMED_CODE, message: GJC_CLEANUP_UNCONFIRMED_MESSAGE } });
  const before = frames.length;
  fake.runs[1]!.writer!.send({ kind: 'complete', exitCode: 0 });
  fake.runs[1]!.writer!.send({ kind: 'permission_request', requestId: 'late-ask' });
  fake.runs[1]!.writer!.setSessionId!('late-provider-id');
  assert.equal(frames.length, before);
  for (const method of GJC_WORKER_REQUEST_METHODS) {
    const id = `blocked-${method}`;
    await host.handle(request(method, id, {}, 'scope-c'));
    assert.equal(frames.find((frame) => frame.id === id)!.payload.error.code, GJC_CLEANUP_UNCONFIRMED_CODE);
  }
  assert.equal(fake.runs.length, 2, 'no request reached the runtime after poisoning');
  fake.runs[1]!.run.resolve();
  await second;
  assert.equal(frames.find((frame) => frame.id === 'sibling-run')!.payload.error.code, GJC_CLEANUP_UNCONFIRMED_CODE);
  assert.equal(frames.some((frame) => frame.kind === 'event' && ['turn.completed', 'turn.failed'].includes(frame.method!)), false);
  assert.equal(frames.some((frame) => frame.method === 'worker.status' && frame.payload.processId === null), false,
    'unconfirmed cleanup must not erase process ownership before reaping');
  assert.equal(JSON.stringify(frames).includes('"aborted":true'), false);
  await host.close();
});

test('ordinary provider failures that imitate fatal cleanup remain nonfatal', async () => {
  const { fake, host, frames } = await initialized();
  const first = host.handle(request('session.start', 'benign-failure', { message: 'first', options: {} }));
  fake.runs[0]!.run.reject(Object.assign(new Error(GJC_CLEANUP_UNCONFIRMED_MESSAGE), {
    name: 'GjcCleanupUnconfirmedError', code: GJC_CLEANUP_UNCONFIRMED_CODE,
  }));
  await first;
  assert.equal((frames.find((frame: any) => frame.id === 'benign-failure') as any).payload.error.code, 'run_failed');
  const second = host.handle(request('session.start', 'healthy-reuse', { message: 'second', options: {} }));
  assert.equal(fake.runs.length, 2);
  fake.runs[1]!.run.resolve();
  await second;
  assert.equal((frames.find((frame: any) => frame.id === 'healthy-reuse') as any).payload.ok, true);
  await host.close();
});

test('requires initialization exactly once and completes the handshake', async () => {
  const fake = fakeRuntime(); const frames: unknown[] = []; const host = new GjcWorkerHost({ runtime: async () => fake.runtime, emit: (frame) => frames.push(frame) });
  await host.handle(request('turn.start', 'early', { message: 'x', options: {} }));
  await host.handle(request('worker.initialize', 'init')); await host.handle(request('worker.initialize', 'again'));
  assert.equal((frames[0] as { payload: { error: { code: string } } }).payload.error.code, 'not_initialized');
  assert.equal((frames[1] as { payload: { ok: boolean } }).payload.ok, true);
  assert.equal((frames[2] as { payload: { error: { code: string } } }).payload.error.code, 'already_initialized');
});

test('validates start and resume payloads before invoking GJC', async () => {
  const { host, frames, fake } = await initialized();
  await host.handle(request('session.start', 'bad-start', { message: 1, options: {} }));
  await host.handle(request('session.resume', 'bad-resume', { message: 'x', options: {} }));
  assert.equal(fake.runs.length, 0);
  assert.equal((frames[1] as { payload: { error: { code: string } } }).payload.error.code, 'invalid_payload');
  assert.equal((frames[2] as { payload: { error: { code: string } } }).payload.error.code, 'invalid_payload');
});

test('maps events with immutable run identity and captures provider sessions', async () => {
  const { fake, host, frames } = await initialized();
  const pending = host.handle(request('session.start', 'run-1', { message: 'hello', options: {} })); await Promise.resolve();
  const writer = fake.runs[0].writer!;
  writer.setSessionId!('provider-1'); writer.send({ kind: 'stream_delta', content: 'hi' }); writer.send({ kind: 'tool_use' }); writer.send({ kind: 'tool_result' }); writer.send({ kind: 'permission_request' }); writer.send({ kind: 'status', text: 'token_budget' }); writer.send({ kind: 'complete', exitCode: 0 });
  const events = frames.slice(1) as Array<{ method: string; payload: { runId: string } }>;
  assert.deepEqual(events.map((frame) => frame.method), ['worker.status', 'session.created', 'message.delta', 'tool.started', 'tool.completed', 'ask.presented', 'usage.updated', 'turn.completed']);
  assert.ok(events.every((frame) => frame.payload.runId === 'run-1'));
  fake.runs[0].run.resolve();
  await pending;
  const tail = frames.slice(-2) as Array<{
    kind: string;
    method: string;
    payload: { processId?: number | null };
  }>;
  assert.equal(tail[0]?.method, 'worker.status');
  assert.equal(tail[0]?.payload.processId, null);
  assert.equal(tail[1]?.kind, 'response');
});

test('allows overlapping app scopes while routing abort and approval by exact runId', async () => {
  const { fake, host, frames } = await initialized();
  const first = host.handle(request('turn.start', 'run-old', { message: 'old', options: {} }));
  const second = host.handle(request('turn.start', 'run-new', { message: 'new', options: {} })); await Promise.resolve();
  await host.handle(request('turn.abort', 'abort', { runId: 'run-old' }));
  await host.handle(request('ask.reply', 'reply', { runId: 'run-new', requestId: 'ask-2', decision: { allow: true } }));
  assert.deepEqual(fake.calls, ['abort-1', 'ask-2']);
  assert.equal((frames.at(-2) as { payload: { result: { runId: string } } }).payload.result.runId, 'run-old');
  fake.runs[0].run.resolve(); fake.runs[1].run.resolve(); await Promise.all([first, second]);
});

test('isolates late old-run events and rejects duplicate run IDs', async () => {
  const { fake, host, frames } = await initialized();
  const first = host.handle(request('turn.start', 'run-same', { message: 'old', options: {} })); await Promise.resolve();
  const oldWriter = fake.runs[0].writer!;
  await host.handle(request('turn.start', 'run-same', { message: 'duplicate', options: {} }));
  assert.equal((frames.at(-1) as { payload: { error: { code: string } } }).payload.error.code, 'duplicate_run_id');
  fake.runs[0].run.resolve(); await first;
  const count = frames.length; oldWriter.send({ kind: 'stream_delta', content: 'late' });
  assert.equal(frames.length, count);
});

test('close drains active runs, shutdown responds only after abort drain, and post-shutdown work fails safely', async () => {
  const { fake, host, frames } = await initialized();
  const pending = host.handle(request('turn.start', 'run-close', { message: 'hello', options: {} })); await Promise.resolve();
  const shutdown = host.handle(request('worker.shutdown', 'shutdown'));
  await Promise.resolve();
  assert.deepEqual(fake.calls, ['abort-1']);
  assert.equal(frames.some((frame) => (frame as { id: string }).id === 'shutdown'), false);
  fake.runs[0].run.resolve(); await Promise.all([pending, shutdown]);
  assert.equal((frames.find((frame) => (frame as { id: string }).id === 'shutdown') as { payload: { ok: boolean } }).payload.ok, true);
  await host.handle(request('ask.reply', 'after', { runId: 'run-close', requestId: 'ask', decision: true }));
  assert.equal((frames.at(-1) as { payload: { error: { code: string } } }).payload.error.code, 'worker_closed');
});

test('close bounds the abort phase when a runtime abort never settles', async () => {
  const fake = fakeRuntime();
  fake.runtime.abortGjcSession = async () => new Promise<boolean>(() => {});
  const frames: unknown[] = [];
  const host = new GjcWorkerHost({
    runtime: async () => fake.runtime,
    emit: (frame) => frames.push(frame),
    closeDrainMs: 5,
  });
  await host.handle(request('worker.initialize', 'init'));
  const pending = host.handle(request('turn.start', 'run-hung-abort', {
    message: 'hello',
    options: {},
  }));
  await Promise.resolve();

  const result = await Promise.race([
    host.close().then(() => 'closed'),
    new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ]);
  assert.equal(result, 'closed');

  fake.runs[0].run.resolve();
  await pending;
});

test('returns safe run failures without raw runtime text', async () => {
  const { fake, host, frames } = await initialized();
  const pending = host.handle(request('turn.start', 'run-fail', { message: 'hello', options: {} })); await Promise.resolve();
  fake.runs[0].run.reject(new Error('super-secret stderr /cwd argv')); await pending;
  const text = JSON.stringify(frames);
  assert.ok(text.includes('GJC run failed.') && !text.includes('super-secret'));
});

test('a malformed permissions block is answered with its own code instead of the generic failure', async () => {
  const fake = fakeRuntime();
  const diagnostics: string[] = [];
  fake.runtime.spawnGjc = () => { throw new GjcRunPermissionsError(); };
  const frames: unknown[] = [];
  const host = new GjcWorkerHost({ runtime: async () => fake.runtime, emit: (frame) => frames.push(frame), diagnostic: (message) => diagnostics.push(message) });
  await host.handle(request('worker.initialize', 'init'));
  await host.handle(request('session.start', 'bad-policy', { message: 'hello', options: { permissions: { mode: 'yolo' } } }));
  const response = frames.at(-1) as { payload: { ok: boolean; error: { code: string; message: string } } };
  assert.equal(response.payload.ok, false);
  assert.deepEqual(response.payload.error, { code: 'invalid_permissions', message: 'Invalid GJC run permissions.' });
  assert.ok(diagnostics.some((line) => line.startsWith('run bad-policy failed')));
});
test('an unresolvable model is answered with its own code instead of the generic failure', async () => {
  const fake = fakeRuntime();
  const diagnostics: string[] = [];
  fake.runtime.spawnGjc = () => { throw new GjcModelResolutionError(); };
  const frames: unknown[] = [];
  const host = new GjcWorkerHost({ runtime: async () => fake.runtime, emit: (frame) => frames.push(frame), diagnostic: (message) => diagnostics.push(message) });
  await host.handle(request('worker.initialize', 'init'));
  await host.handle(request('session.start', 'no-model', { message: 'hello', options: {} }));
  const response = frames.at(-1) as { payload: { ok: boolean; error: { code: string; message: string } } };
  assert.equal(response.payload.ok, false);
  assert.deepEqual(response.payload.error, { code: GJC_MODEL_UNRESOLVED_CODE, message: GJC_MODEL_UNRESOLVED_MESSAGE });
  assert.ok(diagnostics.some((line) => line.startsWith('run no-model failed')));
});

test('entrypoint fails closed on malformed input and emits protocol-only stdout', async () => {
  const previousExitCode = process.exitCode;
  try {
    const input = new PassThrough(); const output = new PassThrough(); const errors = new PassThrough(); let stdout = ''; let stderr = '';
    output.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); }); errors.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    runGjcWorkerEntrypoint(input, output, errors);
    input.end('{not json}\n'); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stdout, ''); assert.equal(stderr.includes('GJC worker protocol failure.'), true);
    assert.doesNotThrow(() => stdout.split('\n').filter(Boolean).forEach((line) => parseGjcWorkerFrame(line)));
  } finally { process.exitCode = previousExitCode; }
});

test('protocol stdout claim keeps non-protocol writes out of the frame stream', async () => {
  const stdout = new PassThrough(); const errors = new PassThrough(); let emitted = ''; let stderr = '';
  stdout.on('data', (chunk: Buffer) => { emitted += chunk.toString('utf8'); });
  errors.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const emit = claimProtocolStdout(stdout, errors, stdout);
  // The SDK ask tool notifies the terminal with a bell before waiting for input.
  stdout.write('\u0007');
  let flushed = false;
  stdout.write('stray diagnostic\n', () => { flushed = true; });
  emit(serializeGjcWorkerFrame({ protocolVersion: GJC_WORKER_PROTOCOL_VERSION, kind: 'event', id: 'claim-1', method: 'worker.status', payload: { runId: 'claim' } } as GjcWorkerEventFrame));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flushed, true);
  assert.equal(emitted.includes('\u0007'), false);
  assert.equal(emitted.includes('stray diagnostic'), false);
  assert.equal(stderr, '\u0007stray diagnostic\n');
  assert.doesNotThrow(() => emitted.split('\n').filter(Boolean).forEach((line) => parseGjcWorkerFrame(line)));
});

test('production worker executable performs a protocol-only handshake and shutdown', async (t) => {
  const workerPath = fileURLToPath(new URL('./gjc-worker.ts', import.meta.url));
  const tsconfigPath = fileURLToPath(new URL('./tsconfig.json', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath], {
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: tsconfigPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  const decoder = new GjcWorkerNdjsonDecoder();
  const frames: ReturnType<typeof parseGjcWorkerFrame>[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    frames.push(...decoder.push(chunk));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const initialize = request('worker.initialize', 'process-init');
  child.stdin.write(serializeGjcWorkerFrame(initialize));
  for (let attempt = 0; attempt < 500 && frames.length < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(frames[0]?.kind, 'response');
  assert.equal((frames[0] as { payload?: { ok?: boolean } }).payload?.ok, true);

  const shutdown = request('worker.shutdown', 'process-shutdown');
  child.stdin.write(serializeGjcWorkerFrame(shutdown));
  for (let attempt = 0; attempt < 500 && frames.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((frames[1] as { payload?: { ok?: boolean } }).payload?.ok, true);
  child.stdin.end();

  for (let attempt = 0; attempt < 500 && child.exitCode === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(child.exitCode, 0);
  assert.equal(stderr, '');
});
