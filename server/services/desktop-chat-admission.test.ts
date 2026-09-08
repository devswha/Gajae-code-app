import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { handleChatConnection } from '../modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '../modules/websocket/services/chat-run-registry.service.js';
import type { GjcJobProjectionService } from '../modules/websocket/services/gjc-job-projection.service.js';
import type { AuthenticatedWebSocketRequest } from '../shared/types.js';

import { DesktopRestartAuthority } from './desktop-restart-authority.js';

class Socket extends EventEmitter {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  dispatch(value: unknown) { this.emit('message', JSON.stringify(value)); }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const attempt = { attemptId: 'test', epoch: 'test-native' };
function createAuthority() {
  return new DesktopRestartAuthority({ requiredOwners: ['test'], ownerReaders: { test: {
    getGeneration: () => 'g1',
    read: () => ({ owner: 'test', generation: 'g1', complete: true, starting: 0, queued: 0, running: 0, settling: 0, approvals: 0, retained: 0, unknown: [] }),
  } } });
}
function connect(admission: DesktopRestartAuthority, overrides: Partial<Parameters<typeof handleChatConnection>[2]> = {}) {
  const socket = new Socket();
  handleChatConnection(socket as unknown as WebSocket, { user: { id: 1 } } as AuthenticatedWebSocketRequest, {
    desktopRestartAdmission: admission, spawnFns: { gjc: async () => {} }, abortFns: { gjc: () => false },
    resolveToolApproval() {}, getPendingApprovalsForSession: () => [], ...overrides,
  });
  return socket;
}

test('a previously connected socket cannot dispatch new work while preparation is fenced', async (t) => {
  const admission = createAuthority();
  let projections = 0;
  const socket = connect(admission, { gjcProjection: { async handle() { projections++; return true; } } as unknown as GjcJobProjectionService });
  t.after(() => socket.emit('close'));
  assert.equal((await admission.prepare(attempt)).ok, true);
  for (const type of ['chat.send', 'chat.steer', 'chat.goal', 'oauth.start', 'oauth.providers', 'gjc.job.subscribe']) socket.dispatch({ type });
  await tick();
  assert.equal(projections, 0, 'denial happens before the first projection await');
  assert.equal(socket.sent.length, 6);
  assert.ok(socket.sent.every((frame) => frame.code === 'DESKTOP_RESTART_FENCED'));
});

test('projection dispatch keeps the same lease after a websocket disconnect', async () => {
  const admission = createAuthority();
  let finish!: (handled: boolean) => void;
  const pending = new Promise<boolean>((resolve) => { finish = resolve; });
  const socket = connect(admission, { gjcProjection: { handle() { return pending; } } as unknown as GjcJobProjectionService });
  socket.dispatch({ type: 'gjc.job.subscribe' });
  assert.equal((await admission.snapshot()).ingress, 1);
  socket.emit('close');
  assert.equal((await admission.prepare(attempt)).ok, false);
  finish(true); await tick();
  assert.equal((await admission.snapshot()).ingress, 0);
  assert.equal((await admission.prepare(attempt)).ok, true);
});

test('cached chat subscription remains available while new work is fenced', async (t) => {
  const admission = createAuthority(); const socket = connect(admission);
  t.after(() => socket.emit('close'));
  assert.equal((await admission.prepare(attempt)).ok, true);
  socket.dispatch({ type: 'chat.subscribe', sessions: [{ sessionId: 'no-active-run' }] });
  await tick();
  assert.equal(socket.sent[0]?.kind, 'chat_subscribed');
  assert.equal((await admission.snapshot()).ingress, 0);
});

test('an already recorded approval may complete during preparation and invalidates its token', async (t) => {
  const admission = createAuthority(); let resolved = 0;
  const socket = connect(admission, { resolveToolApproval() { resolved++; } });
  t.after(() => { socket.emit('close'); chatRunRegistry.clearAll(); });
  const run = chatRunRegistry.startRun({ appSessionId: 'approval-session', provider: 'gjc', providerSessionId: null, connection: socket, userId: null });
  assert.ok(run);
  run.writer.send({ kind: 'permission_request', requestId: 'owned-approval', toolName: 'bash' });
  const prepared = await admission.prepare(attempt); assert.equal(prepared.ok, true);
  socket.dispatch({ type: 'chat.permission-response', requestId: 'owned-approval', allow: false });
  await tick();
  assert.equal(resolved, 1);
  assert.equal(chatRunRegistry.getPendingApproval('owned-approval'), null);
  if (prepared.ok) assert.equal((await admission.commit(prepared.token, attempt.epoch)).ok, false);
});

test('a forged completion is not allowed to use the owned-completion admission path', async (t) => {
  const admission = createAuthority(); let resolved = 0;
  const socket = connect(admission, { resolveToolApproval() { resolved++; } });
  t.after(() => socket.emit('close'));
  assert.equal((await admission.prepare(attempt)).ok, true);
  socket.dispatch({ type: 'chat.permission-response', requestId: 'not-owned', allow: true });
  await tick();
  assert.equal(resolved, 0);
  assert.equal(socket.sent[0]?.code, 'DESKTOP_RESTART_FENCED');
});

test('a remembered OAuth UI owner cannot bypass the fence through lazy-spawning submit or cancel', async (t) => {
  const admission = createAuthority(); let completions = 0;
  const socket = connect(admission, { oauthSupervisor: {
    oauthProviders: async () => ({}), oauthStatus: async () => ({}),
    oauthStart: async () => ({ ok: true, result: { attemptId: 'old-attempt' } }),
    oauthSubmit: async () => { completions++; return {}; },
    oauthCancel: async () => { completions++; return {}; },
    subscribeOAuth: () => () => {},
  } });
  t.after(() => socket.emit('close'));
  socket.dispatch({ type: 'oauth.start', providerId: 'test' }); await tick();
  assert.equal(socket.sent[0]?.kind, 'oauth.start');
  const prepared = await admission.prepare(attempt); assert.equal(prepared.ok, true);
  // This UI ownership cache is deliberately unchanged, as it would be after a
  // terminal event or worker replacement. It is not live process ownership.
  socket.dispatch({ type: 'oauth.submit', attemptId: 'old-attempt', value: 'fixture' });
  socket.dispatch({ type: 'oauth.cancel', attemptId: 'old-attempt' }); await tick();
  assert.equal(completions, 0);
  assert.equal(socket.sent.filter((frame) => frame.code === 'DESKTOP_RESTART_FENCED').length, 2);
});
