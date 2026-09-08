import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

class SocketCapture {
  readyState = 1;
  readonly messages: Array<Record<string, unknown>> = [];

  send(serialized: string): void {
    this.messages.push(JSON.parse(serialized) as Record<string, unknown>);
  }
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function openDatabase(body: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'registry-spec-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'database.sqlite');
  await initializeDatabase();
  cleanup = async () => {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  };
  await body();
}

function createRun(sessionId: string, socket = new SocketCapture()) {
  sessionsDb.createAppSession(sessionId, 'gjc', '/workspace/demo');
  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: 'gjc',
    providerSessionId: null,
    connection: socket,
    userId: null,
  });
  assert.ok(run);
  return { run, socket };
}

function framesOf(socket: SocketCapture, kind: string): Array<Record<string, unknown>> {
  return socket.messages.filter((message) => message.kind === kind);
}

describe('chat run event protocol', () => {
  test('restart snapshot retains approvals and publication work beyond visible run completion', async () => {
    await openDatabase(async () => {
      const initial = chatRunRegistry.getGeneration();
      const { run } = createRun('restart-activity');
      assert.notEqual(chatRunRegistry.getGeneration(), initial);
      assert.equal(chatRunRegistry.snapshotActivity().running, 1);
      run.writer.send({ kind: 'permission_request', requestId: 'approval-1', toolName: 'bash' });
      const pendingRevision = chatRunRegistry.getGeneration();
      assert.equal(chatRunRegistry.snapshotActivity().approvals, 1);
      assert.deepEqual(chatRunRegistry.getPendingApproval('approval-1'), { appSessionId: 'restart-activity', toolName: 'bash' });
      assert.equal(chatRunRegistry.getGeneration(), pendingRevision, 'read-only lookup must not mutate ownership');
      chatRunRegistry.resolvePendingApproval('approval-1');
      assert.equal(chatRunRegistry.snapshotActivity().approvals, 0);
      assert.notEqual(chatRunRegistry.getGeneration(), pendingRevision);
      run.writer.send({ kind: 'session_created', provider: 'gjc', sessionId: 'native-activity', newSessionId: 'native-activity' });
      run.writer.send({ kind: 'complete', provider: 'gjc', exitCode: 0 });
      assert.equal(chatRunRegistry.snapshotActivity().running, 0);
      assert.equal(chatRunRegistry.snapshotActivity().settling, 1, 'async publication remains owned after terminal UI state');
      chatRunRegistry.clearAll();
      assert.equal(chatRunRegistry.snapshotActivity().settling, 1, 'clearing the run registry cannot erase an unsettled publication');
      await new Promise((resolve) => setImmediate(resolve));
      const settled = chatRunRegistry.snapshotActivity();
      assert.equal(settled.settling, 0);
      assert.equal(settled.generation, chatRunRegistry.getGeneration());
    });
  });

  test('uses the application session and increasing event positions', async () => {
    await openDatabase(() => {
      const { run, socket } = createRun('sequence');
      assert.equal(run.writer.getAppSessionId(), 'sequence');
      run.writer.send({ kind: 'stream_delta', provider: 'gjc', sessionId: 'native', content: 'first' });
      run.writer.send({ kind: 'text', provider: 'gjc', sessionId: 'native', content: 'second' });
      assert.deepEqual(socket.messages.map(({ sessionId, seq }) => ({ sessionId, seq })), [
        { sessionId: 'sequence', seq: 1 }, { sessionId: 'sequence', seq: 2 },
      ]);
    });
  });

  test('supplies missing envelope fields without replacing supplied values', async () => {
    await openDatabase(() => {
      const { run, socket } = createRun('envelopes');
      run.writer.send({ kind: 'tool_use', provider: 'gjc', toolId: 'tool', toolName: 'bash' });
      run.writer.send({ kind: 'system_notice', provider: 'gjc', level: 'warning', content: 'fallback' });
      for (const message of socket.messages) {
        assert.match(String(message.id), /.+/);
        assert.ok(!Number.isNaN(Date.parse(String(message.timestamp))));
      }
      assert.notEqual(socket.messages[0]?.id, socket.messages[1]?.id);
      run.writer.send({ kind: 'text', provider: 'gjc', id: 'fixed', timestamp: '2026-01-01T00:00:00.000Z', content: 'kept' });
      assert.deepEqual(socket.messages[2]?.id, 'fixed');
      assert.deepEqual(socket.messages[2]?.timestamp, '2026-01-01T00:00:00.000Z');
    });
  });

  test('records provider identity while hiding its creation event', async () => {
    await openDatabase(async () => {
      const { run, socket } = createRun('mapping');
      connectedClients.add(socket as never);
      run.writer.send({ kind: 'session_created', provider: 'gjc', sessionId: 'native-7', newSessionId: 'native-7' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(run.providerSessionId, 'native-7');
      assert.equal(sessionsDb.getSessionById('mapping')?.provider_session_id, 'native-7');
      assert.deepEqual(framesOf(socket, 'session_upserted').map(({ sessionId, providerSessionId }) => ({ sessionId, providerSessionId })), [
        { sessionId: 'mapping', providerSessionId: 'native-7' },
      ]);
    });
  });

  test('accepts one terminal event and exposes only later buffered events', async () => {
    await openDatabase(() => {
      const { run, socket } = createRun('terminal');
      for (const content of ['a', 'b', 'c']) run.writer.send({ kind: 'stream_delta', provider: 'gjc', sessionId: 'native', content });
      assert.deepEqual(chatRunRegistry.replayEvents('terminal', 1, run.replayGeneration).map(({ content, seq }) => ({ content, seq })), [
        { content: 'b', seq: 2 }, { content: 'c', seq: 3 },
      ]);
      run.writer.send({ kind: 'complete', provider: 'gjc', sessionId: 'native', exitCode: 0 });
      run.writer.send({ kind: 'complete', provider: 'gjc', sessionId: 'native', exitCode: 1 });
      chatRunRegistry.completeRun('terminal', { exitCode: 1 });
      assert.equal(chatRunRegistry.isProcessing('terminal'), false);
      assert.deepEqual(framesOf(socket, 'complete').map(({ actualSessionId }) => actualSessionId), ['terminal']);
    });
  });
});

describe('chat run lifecycle', () => {
  test('obsolete writers cannot publish into a replacement run', async () => {
    await openDatabase(() => {
      const { run: oldRun, socket } = createRun('obsolete');
      oldRun.writer.send({ kind: 'complete', exitCode: 0 });
      const nextRun = chatRunRegistry.startRun({ appSessionId: 'obsolete', provider: 'gjc', providerSessionId: null, connection: socket, userId: null });
      assert.ok(nextRun);
      assert.notEqual(nextRun.replayGeneration, oldRun.replayGeneration);
      oldRun.writer.send({ kind: 'stream_delta', content: 'obsolete' });
      oldRun.writer.send({ kind: 'permission_request', requestId: 'obsolete-approval' });
      nextRun.writer.send({ kind: 'stream_delta', content: 'current' });
      assert.deepEqual(socket.messages.map(frame => [frame.kind, frame.seq, frame.replayGeneration]), [
        ['complete', 1, oldRun.replayGeneration], ['stream_delta', 1, nextRun.replayGeneration],
      ]);
      assert.equal(nextRun.pendingApprovals.size, 0);
    });
  });

  test('an old expiry timer cannot remove a newer completed generation', async (context) => {
    await openDatabase(() => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const { socket } = createRun('expiry');
      chatRunRegistry.completeRun('expiry', { exitCode: 0 });
      context.mock.timers.tick(299_999);
      const nextRun = chatRunRegistry.startRun({ appSessionId: 'expiry', provider: 'gjc', providerSessionId: null, connection: socket, userId: null });
      assert.ok(nextRun);
      chatRunRegistry.completeRun('expiry', { exitCode: 0 });
      context.mock.timers.tick(1);
      assert.equal(chatRunRegistry.getRun('expiry'), nextRun);
      context.mock.timers.tick(299_999);
      assert.equal(chatRunRegistry.getRun('expiry'), undefined);
    });
  });

  test('does not let an old completion fallback terminate its replacement', async () => {
    await openDatabase(() => {
      const { run: oldRun, socket } = createRun('replacement');
      oldRun.writer.send({ kind: 'complete', provider: 'gjc', sessionId: 'native', exitCode: 0 });
      const nextRun = chatRunRegistry.startRun({ appSessionId: 'replacement', provider: 'gjc', providerSessionId: null, connection: socket, userId: null });
      assert.ok(nextRun);
      chatRunRegistry.completeRunIfCurrent(oldRun, { exitCode: 1 });
      assert.equal(chatRunRegistry.isProcessing('replacement'), true);
      chatRunRegistry.completeRunIfCurrent(nextRun, { exitCode: 1 });
      assert.equal(chatRunRegistry.isProcessing('replacement'), false);
      assert.equal(framesOf(socket, 'complete').length, 2);
    });
  });

  test('reports active runs and rejects concurrent starts until completion', async () => {
    await openDatabase(() => {
      const first = createRun('one');
      const second = createRun('two');
      assert.equal(chatRunRegistry.startRun({ appSessionId: 'one', provider: 'gjc', providerSessionId: null, connection: first.socket, userId: null }), null);
      chatRunRegistry.completeRun('one', { exitCode: 0 });
      assert.deepEqual(chatRunRegistry.listRunningRuns().map(({ sessionId, provider }) => ({ sessionId, provider })), [{ sessionId: 'two', provider: 'gjc' }]);
      assert.ok(chatRunRegistry.startRun({ appSessionId: 'one', provider: 'gjc', providerSessionId: null, connection: first.socket, userId: null }));
      second.run.writer.send({ kind: 'stream_delta', provider: 'gjc', sessionId: 'native', content: 'still active' });
    });
  });

  test('reports a run as awaiting input while an approval it raised is unanswered', async () => {
    await openDatabase(() => {
      const { run } = createRun('approval');
      const awaiting = () => chatRunRegistry.listRunningRuns().find((entry) => entry.sessionId === 'approval')?.awaitingInput;
      assert.equal(awaiting(), false);

      run.writer.send({ kind: 'permission_request', provider: 'gjc', sessionId: 'native', requestId: 'ask-1', toolName: 'bash' });
      run.writer.send({ kind: 'permission_request', provider: 'gjc', sessionId: 'native', requestId: 'ask-2', toolName: 'edit' });
      assert.equal(awaiting(), true);

      // The worker re-presents a restored approval under the same id; that is not a second question.
      run.writer.send({ kind: 'permission_request', provider: 'gjc', sessionId: 'native', requestId: 'ask-1', toolName: 'bash' });
      // Answering hands back what the provider said the request was for, so
      // "Always allow" can be stored against the real tool name.
      assert.deepEqual(chatRunRegistry.resolvePendingApproval('ask-1'), { appSessionId: 'approval', toolName: 'bash' });
      assert.equal(chatRunRegistry.resolvePendingApproval('ask-1'), null, 'an answered request is gone');
      assert.equal(awaiting(), true, 'a second question is still open');

      run.writer.send({ kind: 'permission_cancelled', provider: 'gjc', sessionId: 'native', requestId: 'ask-2' });
      assert.equal(awaiting(), false);

      run.writer.send({ kind: 'permission_request', provider: 'gjc', sessionId: 'native', requestId: 'ask-3', toolName: 'bash' });
      chatRunRegistry.completeRun('approval', { exitCode: 0 });
      assert.equal(awaiting(), undefined, 'a finished run is no longer listed at all');
    });
  });

  test('a second viewer joins the live stream without taking it from the first', async () => {
    // Two tabs on one session (a desktop and a phone on the LAN) re-subscribe
    // on every session_upserted. The sender must keep every frame, and the
    // newcomer gets everything from then on; the same seq reaches both.
    await openDatabase(() => {
      const { run, socket: sender } = createRun('fanout');
      run.writer.send({ kind: 'stream_delta', provider: 'gjc', sessionId: 'native', content: 'old' });
      const viewer = new SocketCapture();
      assert.equal(chatRunRegistry.attachConnection('fanout', viewer), true);
      assert.equal(chatRunRegistry.attachConnection('fanout', sender), true, 'the sender re-subscribing is a no-op');
      run.writer.send({ kind: 'stream_delta', provider: 'gjc', sessionId: 'native', content: 'new' });
      chatRunRegistry.completeRun('fanout', { exitCode: 0 });
      assert.deepEqual(sender.messages.map(({ kind, content }) => `${kind}:${content ?? ''}`), ['stream_delta:old', 'stream_delta:new', 'complete:']);
      assert.deepEqual(viewer.messages.map(({ kind, content }) => `${kind}:${content ?? ''}`), ['stream_delta:new', 'complete:']);
      assert.equal(sender.messages[1].seq, viewer.messages[0].seq);
    });
  });

  test('a closed or detached socket stops receiving frames; the others keep them', async () => {
    await openDatabase(() => {
      const { run, socket: sender } = createRun('leave');
      const closing = new SocketCapture();
      const leaving = new SocketCapture();
      chatRunRegistry.attachConnection('leave', closing);
      chatRunRegistry.attachConnection('leave', leaving);
      assert.equal(run.writer.connectionCount(), 3);

      closing.readyState = 3;
      chatRunRegistry.detachConnection(leaving);
      run.writer.send({ kind: 'stream_delta', provider: 'gjc', sessionId: 'native', content: 'after' });

      assert.deepEqual(sender.messages.map(({ content }) => content), ['after']);
      assert.deepEqual(closing.messages, []);
      assert.deepEqual(leaving.messages, []);
      assert.equal(run.writer.connectionCount(), 1);
    });
  });
});
