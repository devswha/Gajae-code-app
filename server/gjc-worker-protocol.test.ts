import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import {
  GJC_WORKER_EVENT_METHODS,
  GJC_WORKER_MAX_FRAME_BYTES,
  GJC_WORKER_PROTOCOL_VERSION,
  GJC_WORKER_REQUEST_METHODS,
  GjcWorkerNdjsonDecoder,
  GjcWorkerProtocolError,
  GjcWorkerRequestTracker,
  parseGjcWorkerFrame,
  redactGjcWorkerSecrets,
  serializeGjcWorkerFrame,
  type GjcWorkerRequestFrame,
} from './gjc-worker-protocol.js';

const scopedMethods = new Set(['session.start', 'session.resume', 'turn.start', 'turn.abort', 'turn.steer', 'goal.inspect', 'goal.control', 'ask.reply']);
const globalEventMethods = new Set(['oauth.phase', 'oauth.providers.updated', 'provider.auth.updated']);

function request(method: typeof GJC_WORKER_REQUEST_METHODS[number], id = 'request-1'): GjcWorkerRequestFrame {
  const base = {
    protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
    kind: 'request' as const,
    id,
    method,
    payload: method === 'worker.activity' ? {} : method === 'worker.admission' ? { fenceId: 'fence-1', closed: true } : { input: 'hello' },
  };
  if (scopedMethods.has(method)) {
    return {
      ...base,
      method: method as Exclude<typeof method, 'worker.initialize' | 'worker.shutdown'>,
      sessionId: 'session-1',
    } as GjcWorkerRequestFrame;
  }
  return base as GjcWorkerRequestFrame;
}

function protocolError(action: () => unknown, code?: string): void {
  assert.throws(action, (error: unknown) => error instanceof GjcWorkerProtocolError && (!code || error.code === code));
}

test('declares the independent worker protocol v1 surface', () => {
  assert.equal(GJC_WORKER_PROTOCOL_VERSION, 1);
  assert.equal(GJC_WORKER_MAX_FRAME_BYTES, 64 * 1024 * 1024);
  assert.deepEqual(GJC_WORKER_REQUEST_METHODS, ['worker.initialize', 'worker.activity', 'worker.admission', 'session.start', 'session.resume', 'turn.start', 'turn.abort', 'turn.steer', 'goal.inspect', 'goal.control', 'ask.reply', 'models.catalog', 'oauth.providers', 'oauth.status', 'oauth.start', 'oauth.submit', 'oauth.cancel', 'worker.shutdown']);
  assert.deepEqual(GJC_WORKER_EVENT_METHODS, ['session.created', 'message.delta', 'message.completed', 'tool.started', 'tool.completed', 'ask.presented', 'usage.updated', 'turn.completed', 'turn.failed', 'worker.status', 'oauth.phase', 'oauth.providers.updated', 'provider.auth.updated']);
});

test('parses every request method and enforces scope, fields, and protocolVersion', () => {
  for (const method of GJC_WORKER_REQUEST_METHODS) assert.equal(parseGjcWorkerFrame(JSON.stringify(request(method))).method, method);
  protocolError(() => parseGjcWorkerFrame(JSON.stringify({ ...request('worker.initialize'), sessionId: 'session-1' })), 'invalid_session_scope');
  protocolError(() => parseGjcWorkerFrame(JSON.stringify({ ...request('turn.start'), sessionId: '' })), 'invalid_session_id');
  protocolError(() => parseGjcWorkerFrame(JSON.stringify({ ...request('turn.start'), protocolVersion: 3 })), 'unsupported_protocol_version');
  protocolError(() => parseGjcWorkerFrame(JSON.stringify({ ...request('turn.start'), version: 1 })), 'unknown_field');
  protocolError(() => parseGjcWorkerFrame(JSON.stringify({ ...request('turn.start'), kind: 'request', extra: true })), 'unknown_field');
});

test('parses every event method with required IDs and correct session scope', () => {
  for (const method of GJC_WORKER_EVENT_METHODS) {
    const frame = { protocolVersion: 1, kind: 'event', id: `event-${method}`, method, payload: { value: 1 }, ...(method === 'worker.status' || globalEventMethods.has(method) ? {} : { sessionId: 'session-1' }) };
    assert.equal(parseGjcWorkerFrame(JSON.stringify(frame)).method, method);
  }
  assert.equal(parseGjcWorkerFrame(JSON.stringify({ protocolVersion: 1, kind: 'event', id: 'event-1', method: 'worker.status', sessionId: 'session-1', payload: {} })).method, 'worker.status');
  protocolError(() => parseGjcWorkerFrame(JSON.stringify({ protocolVersion: 1, kind: 'event', id: 'event-2', method: 'turn.completed', payload: {} })), 'invalid_session_id');
  protocolError(() => parseGjcWorkerFrame(JSON.stringify({ protocolVersion: 1, kind: 'event', method: 'worker.status', payload: {} })), 'invalid_id');
});

test('validates response success and failure payloads with exact scope', () => {
  const success = parseGjcWorkerFrame(JSON.stringify({ protocolVersion: 1, kind: 'response', id: 'request-1', method: 'turn.start', sessionId: 'session-1', payload: { ok: true, result: { answer: 'yes' } } }));
  assert.equal(success.kind, 'response');
  const failure = parseGjcWorkerFrame(JSON.stringify({ protocolVersion: 1, kind: 'response', id: 'request-2', method: 'worker.shutdown', payload: { ok: false, error: { code: 'stopped', message: 'Stopped', details: { retry: false } } } }));
  assert.equal(failure.kind, 'response');
  protocolError(() => parseGjcWorkerFrame(JSON.stringify({ protocolVersion: 1, kind: 'response', id: 'request-3', method: 'worker.shutdown', sessionId: 'session-1', payload: { ok: true } })), 'invalid_session_scope');
  protocolError(() => parseGjcWorkerFrame(JSON.stringify({ protocolVersion: 1, kind: 'response', id: 'request-4', method: 'turn.start', sessionId: 'session-1', payload: { ok: false, error: { code: 1, message: 'bad' } } })), 'invalid_response_payload');
});

test('ownership RPCs reject loose payloads, unsafe counters and unbounded evidence', () => {
  for (const payload of [{ fenceId: 'f1' }, { fenceId: '', closed: true }, { fenceId: 'f1', closed: 1 },
    { fenceId: 'f1', closed: true, ignored: true }]) {
    protocolError(() => parseGjcWorkerFrame(JSON.stringify({ ...request('worker.admission'), payload })), 'invalid_payload');
  }
  protocolError(() => parseGjcWorkerFrame(JSON.stringify({ ...request('worker.activity'), payload: { spawn: true } })), 'invalid_payload');
  const activity = { fenceId: 'f1', generation: 'generation-1', complete: true,
    starting: 0, queued: 0, running: 0, settling: 0, approvals: 0, retained: 0, unknown: [] };
  const response = (result: unknown) => JSON.stringify({ protocolVersion: 1, kind: 'response', id: 'observation',
    method: 'worker.activity', payload: { ok: true, result } });
  assert.equal(parseGjcWorkerFrame(response(activity)).method, 'worker.activity');
  for (const result of [undefined, {}, { ...activity, ignored: true }, { ...activity, starting: -1 },
    { ...activity, running: 0.1 }, { ...activity, retained: Number.MAX_SAFE_INTEGER + 1 },
    { ...activity, generation: 'x'.repeat(129) }, { ...activity, unknown: Array(33).fill('unknown') },
    { ...activity, unknown: ['secret with spaces'] }]) {
    protocolError(() => parseGjcWorkerFrame(response(result)), 'invalid_response_payload');
  }
});

test('fails closed on malformed JSON, methods, invalid JSON values, and direct byte bounds', () => {
  protocolError(() => parseGjcWorkerFrame('{'), 'malformed_frame');
  protocolError(() => parseGjcWorkerFrame(JSON.stringify({ ...request('turn.start'), method: 'provider.run' })), 'unknown_method');
  protocolError(() => serializeGjcWorkerFrame({ ...request('turn.start'), payload: { bad: undefined } } as unknown as GjcWorkerRequestFrame), 'invalid_json_value');
  protocolError(() => serializeGjcWorkerFrame({ ...request('turn.start'), payload: { bad: Number.NaN } } as unknown as GjcWorkerRequestFrame), 'invalid_json_value');
  protocolError(() => serializeGjcWorkerFrame({ ...request('turn.start'), payload: { bad: new Date() } } as unknown as GjcWorkerRequestFrame), 'invalid_json_value');
  protocolError(() => serializeGjcWorkerFrame({ ...request('turn.start'), payload: { bad: () => undefined } } as unknown as GjcWorkerRequestFrame), 'invalid_json_value');
  protocolError(() => serializeGjcWorkerFrame({ ...request('turn.start'), payload: { bad: 1n } } as unknown as GjcWorkerRequestFrame), 'invalid_json_value');
  protocolError(() => serializeGjcWorkerFrame({ ...request('turn.start'), payload: { bad: Symbol('bad') } } as unknown as GjcWorkerRequestFrame), 'invalid_json_value');
  const oversized = Buffer.alloc(GJC_WORKER_MAX_FRAME_BYTES + 1, 0x61);
  protocolError(() => parseGjcWorkerFrame(oversized), 'frame_too_large');
  protocolError(() => new GjcWorkerNdjsonDecoder().push(oversized), 'frame_too_large');
});

test('serializes compact LF NDJSON and recursively redacts supplied secrets', () => {
  const secret = 'correct-horse-battery-staple';
  const serialized = serializeGjcWorkerFrame({
    ...request('turn.start'),
    payload: {
      token: secret,
      nested: [secret, { [`prefix-${secret}`]: `x${secret}y` }],
    },
  } as GjcWorkerRequestFrame, [secret]);
  assert.ok(serialized.endsWith('\n'));
  assert.equal(serialized.slice(0, -1).includes('\n'), false);
  assert.equal(serialized.includes(secret), false);
  assert.deepEqual(redactGjcWorkerSecrets({ secret, [`${secret}-key`]: secret }, [secret]), { secret: '[redacted]', '[redacted]-key': '[redacted]' });
});

test('decodes multiple, CRLF, split UTF-8 frames and remains failed after protocol errors', () => {
  const decoder = new GjcWorkerNdjsonDecoder();
  const first = JSON.stringify(request('turn.start', 'request-1'));
  const second = JSON.stringify({ protocolVersion: 1, kind: 'event', id: 'event-1', method: 'message.delta', sessionId: 'session-1', payload: { text: '한' } });
  const bytes = Buffer.from(`${first}\r\n${second}\n`);
  const split = bytes.indexOf(Buffer.from('한')) + 1;
  assert.deepEqual(decoder.push(bytes.subarray(0, split)), [parseGjcWorkerFrame(first)]);
  assert.equal(decoder.push(bytes.subarray(split)).length, 1);
  decoder.finish();

  const bad = new GjcWorkerNdjsonDecoder();
  protocolError(() => bad.push(Buffer.from('\n')), 'invalid_ndjson');
  protocolError(() => bad.push(Buffer.from(`${first}\n`)), 'decoder_failed');
  const unfinished = new GjcWorkerNdjsonDecoder();
  unfinished.push(Buffer.from(first));
  protocolError(() => unfinished.finish(), 'unterminated_frame');
  const invalidUtf8 = new GjcWorkerNdjsonDecoder();
  protocolError(() => invalidUtf8.push(Buffer.from([0xc3, 0x28, 0x0a])), 'malformed_frame');
});


test('tracker protects duplicates, correlates exact responses, and resolves successes and failures', async () => {
  const tracker = new GjcWorkerRequestTracker();
  const pending = tracker.track(request('turn.start', 'request-1'));
  protocolError(() => tracker.track(request('turn.start', 'request-1')), 'duplicate_request_id');
  protocolError(() => tracker.settle({ protocolVersion: 1, kind: 'response', id: 'missing', method: 'turn.start', sessionId: 'session-1', payload: { ok: true } }), 'unknown_response_id');
  protocolError(() => tracker.settle({ protocolVersion: 1, kind: 'response', id: 'request-1', method: 'turn.abort', sessionId: 'session-1', payload: { ok: true } }), 'mismatched_response');
  tracker.settle({ protocolVersion: 1, kind: 'response', id: 'request-1', method: 'turn.start', sessionId: 'session-1', payload: { ok: true, result: 'done' } });
  await assert.doesNotReject(pending);
  const failed = tracker.track(request('worker.shutdown', 'request-2'));
  tracker.settle({ protocolVersion: 1, kind: 'response', id: 'request-2', method: 'worker.shutdown', payload: { ok: false, error: { code: 'stopped', message: 'Stopped' } } });
  assert.deepEqual(await failed, { ok: false, error: { code: 'stopped', message: 'Stopped' } });
  const timedOut = tracker.track(request('turn.start', 'request-timeout'));
  assert.equal(tracker.reject('request-timeout', new Error('request timed out')), true);
  await assert.rejects(timedOut, /request timed out/);
  assert.equal(tracker.reject('request-timeout', new Error('late timeout')), false);
});

test('tracker rejects all pending requests when the worker exits', async () => {
  const tracker = new GjcWorkerRequestTracker();
  const first = tracker.track(request('turn.start', 'request-1'));
  const second = tracker.track(request('ask.reply', 'request-2'));
  tracker.failAll();
  await assert.rejects(first, (error: unknown) => error instanceof GjcWorkerProtocolError && error.code === 'worker_exited');
  await assert.rejects(second, (error: unknown) => error instanceof GjcWorkerProtocolError && error.code === 'worker_exited');
  assert.equal(tracker.size, 0);
});

test('protocol errors never echo secret input', () => {
  const secret = 'never disclose token';
  try {
    parseGjcWorkerFrame(`{"protocolVersion":1,"kind":"request","id":"${secret}","method":"turn.start","sessionId":"session-1","payload":{}}`);
    assert.fail('Expected invalid id');
  } catch (error) {
    assert.ok(error instanceof GjcWorkerProtocolError);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.stack?.includes(secret) ?? false, false);
  }
});
