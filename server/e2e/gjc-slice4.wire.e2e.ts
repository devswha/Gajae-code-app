import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { WebSocket } from 'ws';

import { isJobProjectionOutboundFrame } from '../../shared/gjc-job-projection-protocol.js';
import type { GjcWorkerSpawnRun } from '../gjc-worker-client.js';
import { createGjcAppFactory } from '../app-factory.js';
import { validateApiKey } from '../middleware/auth.js';
import { GjcJobProjectionService } from '../modules/websocket/services/gjc-job-projection.service.js';
import { GjcGitClient } from '../services/gjc-git-client.js';
import { GjcJobGitService } from '../services/gjc-job-git.service.js';
import { GjcJobsClient } from '../services/gjc-jobs-client.js';
import { JobOrchestrator, type JobSupervisor } from '../services/gjc-job-orchestrator.js';

const execFile = promisify(execFileCallback);
const corePath = join(process.cwd(), 'dist-native', 'gajae-core');
const git = (cwd: string, args: string[]) => execFile('git', args, { cwd });
const sleep = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

class Supervisor implements JobSupervisor {
  readonly runs: Array<{ input: GjcWorkerSpawnRun; resolve(): void }> = [];
  spawnRun(input: GjcWorkerSpawnRun) {
    let resolve!: () => void;
    const completion = new Promise<void>(done => { resolve = done; });
    this.runs.push({ input, resolve });
    return { started: Promise.resolve(), completion, abortHandle: input.runId, phase: () => 'request_issued' as const };
  }
  async abort(alias: string) { this.runs.find(run => run.input.runId === alias)?.resolve(); return 'aborted' as const; }
  async terminate() { return 'reaped' as const; }
  emit(index: number, payload: unknown) { this.runs[index]?.input.writer.send(payload); }
}

function observe(ws: WebSocket) {
  const frames: any[] = [];
  ws.on('message', raw => frames.push(JSON.parse(String(raw))));
  return {
    frames,
    async wait(predicate: (frame: any) => boolean, label: string) {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const frame = frames.find(predicate);
        if (frame) return frame;
        await sleep();
      }
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(frames)}`);
    },
  };
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await check()) return;
    await sleep();
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function subscribe(ws: WebSocket, inbox: ReturnType<typeof observe>, jobId: string, after: number): Promise<{ subscriptionId: string; watermark: number }> {
  ws.send(JSON.stringify({ protocolVersion: 1, type: 'gjc.job.subscribe', jobId, after }));
  const frame = await inbox.wait(frame => frame.kind === 'gjc_job_subscribed' && frame.jobId === jobId, 'subscription');
  assert.ok(isJobProjectionOutboundFrame(frame));
  assert.equal(frame.kind, 'gjc_job_subscribed');
  return frame;
}

async function replay(ws: WebSocket, inbox: ReturnType<typeof observe>, jobId: string, subscriptionId: string, after: number) {
  ws.send(JSON.stringify({ protocolVersion: 1, type: 'gjc.job.replay', jobId, subscriptionId, after, byteBudget: 4096 }));
  return inbox.wait(frame => frame.kind === 'gjc_job_replay_chunk' && frame.subscriptionId === subscriptionId, 'replay');
}

test('wire e2e: HTTP jobs endpoints and full websocket projection matrix', { timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gjc-wire-')));
  const database = join(root, '..', `${basename(root)}.jobs.sqlite3`);
  await git(root, ['init']); await git(root, ['config', 'user.email', 'e2e@test']); await git(root, ['config', 'user.name', 'E2E']);
  await writeFile(join(root, 'README.md'), 'base\n'); await git(root, ['add', 'README.md']); await git(root, ['commit', '-m', 'base']);
  const jobs = new GjcJobsClient({ database, corePath });
  const client = new GjcGitClient({ workdir: root, corePath });
  const supervisor = new Supervisor();
  let authorityCalls = 0;
  let authorityDown = false;
  const authority = {
    get: async (params: { jobId: string }) => {
      authorityCalls += 1;
      if (authorityDown) throw Object.assign(new Error('down'), { code: 'authority_unavailable' });
      return jobs.get(params);
    },
    list: (params: any) => jobs.list(params),
    replayEvents: async (params: any) => {
      if (authorityDown) throw Object.assign(new Error('down'), { code: 'authority_unavailable' });
      return jobs.replayEvents(params);
    },
  };
  let projection = new GjcJobProjectionService(authority as any);
  let id = 0;
  let orchestrator = new JobOrchestrator({
    jobs, supervisor, owner: 'wire-e2e', createId: () => `wire-${++id}`, gitForProject: () => client,
    broadcast: () => {},
  });
  const gitService = new GjcJobGitService(jobs, () => client, async (jobId, eventId, payload) => orchestrator.appendAdminEvent(jobId, eventId, payload));
  const originalApiKey = process.env.API_KEY;
  process.env.API_KEY = 'wire-e2e-api-key';
  const createRuntime = () => createGjcAppFactory({
    authority,
    orchestrator,
    gitService,
    projection,
    terminalNotificationAdapter: { onCommittedEvent() {}, async startupCatchUp() {} },
    authenticateWebSocket: () => ({ id: 'wire-user', username: 'wire-user' }),
    authenticateGjcRoute: (_req: unknown, _res: unknown, next: () => void) => next(),
    validateApiKey,
    chat: {
      spawnFns: { claude: async () => undefined, cursor: async () => undefined, codex: async () => undefined, opencode: async () => undefined, gjc: async () => undefined },
      abortFns: { claude: async () => false, cursor: async () => false, codex: async () => false, opencode: async () => false, gjc: async () => false },
      resolveToolApproval() {},
      getPendingApprovalsForSession: () => [],
      gjcProjection: projection,
    },
    shell: {},
  });
  let { server, wss } = createRuntime();
  const listen = async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as any).port as number; };
  let port = await listen();
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); jobs.close(); client.close(); await waitFor(async () => jobs.activity().settling === 0 && client.activity().settling === 0, 'native client close'); await rm(database, { force: true }); await rm(root, { recursive: true, force: true }); if (originalApiKey === undefined) delete process.env.API_KEY; else process.env.API_KEY = originalApiKey; });
  const request = (path: string, method = 'GET', body?: unknown, apiKey: string | null = 'wire-e2e-api-key') => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...(apiKey === null ? {} : { 'x-api-key': apiKey }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const connect = (apiKey: string | null = 'wire-e2e-api-key', origin?: string) => new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { ...(apiKey === null ? {} : { 'x-api-key': apiKey }), ...(origin ? { origin } : {}) },
  });
  const beforeUnauthorized = authorityCalls;
  assert.equal((await request('/api/gjc/jobs/not-a-job', 'GET', undefined, null)).status, 401);
  assert.equal((await request('/api/gjc/jobs/not-a-job', 'GET', undefined, 'wrong-api-key')).status, 401);
  assert.equal(authorityCalls, beforeUnauthorized);

  await t.test('websocket upgrades reject absent or incorrect API keys and foreign origins before authority access', async () => {
    for (const [apiKey, origin] of [[null, undefined], ['wrong-api-key', undefined], ['wire-e2e-api-key', 'https://attacker.invalid']] as const) {
      const socket = connect(apiKey, origin);
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      await assert.rejects(once(socket, 'open'), /Unexpected server response: 401/u);
      await closed;
    }
    assert.equal(wss.clients.size, 0);
    assert.equal(authorityCalls, beforeUnauthorized);
  });

  const created = await request('/api/gjc/jobs', 'POST', { appSessionId: 'app-wire', projectPath: root, message: 'run' });
  assert.equal(created.status, 202); const { jobId: responseJobId } = await created.json() as any; assert.equal(typeof responseJobId, 'string'); const jobId = responseJobId;
  const ws = connect(); await once(ws, 'open'); const inbox = observe(ws);
  const firstSubscription = await subscribe(ws, inbox, jobId, 0);
  const firstReplay = await replay(ws, inbox, jobId, firstSubscription.subscriptionId, 0); assert.equal(firstReplay.done, true);
  supervisor.emit(0, { kind: 'wire_live' });
  const firstLive = await inbox.wait(frame => frame.kind === 'gjc_job_event' && frame.event.payload.kind === 'wire_live', 'initial live event');
  assert.equal(firstLive.event.sequence, 1);
  ws.send(JSON.stringify({ protocolVersion: 1, type: 'gjc.job.unsubscribe', jobId, subscriptionId: firstSubscription.subscriptionId }));
  await inbox.wait(frame => frame.kind === 'gjc_job_unsubscribed', 'unsubscribe');
  ws.terminate(); await once(ws, 'close');
  await orchestrator.interruptForShutdown();
  // An irreversibly retired owner cannot be reused to fake a restart. Rebuild
  // the HTTP/projection/orchestrator composition over the same durable jobs.
  // This is a wire-resume fixture, not proof of installed-app process handoff.
  await supervisor.abort(supervisor.runs[0]!.input.runId);
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  projection = new GjcJobProjectionService(authority as any);
  orchestrator = new JobOrchestrator({
    jobs, supervisor, owner: 'wire-e2e-resumed', createId: () => `wire-${++id}`, gitForProject: () => client,
    broadcast: () => {},
  });
  ({ server, wss } = createRuntime());
  port = await listen();
  const resumed = await request(`/api/gjc/jobs/${jobId}/resume`, 'POST', { appSessionId: 'app-wire', message: 'resume' });
  assert.equal(resumed.status, 202);
  const resumedDto = await resumed.json() as any;
  assert.equal(typeof resumedDto.runId, 'string');
  assert.equal((await jobs.get({ jobId }) as any).state, 'running');
  assert.equal((await jobs.get({ jobId }) as any).currentRun.runId, resumedDto.runId);
  assert.equal(supervisor.runs.length, 2);
  assert.equal(supervisor.runs[1]!.input.runId, resumedDto.runId);

  await t.test('reconnect orders durable replay before buffered live with no duplicate or gap', async () => {
    const beforeOffline = (await jobs.get({ jobId }) as any).lastSequence;
    supervisor.emit(1, { kind: 'offline', step: 1 }); supervisor.emit(1, { kind: 'offline', step: 2 });
    await waitFor(async () => (await jobs.get({ jobId }) as any).lastSequence === beforeOffline + 2, 'offline durable events');
    const reconnect = connect(); await once(reconnect, 'open'); const messages = observe(reconnect);
    const sub = await subscribe(reconnect, messages, jobId, beforeOffline);
    assert.equal(sub.watermark, beforeOffline + 2);
    supervisor.emit(1, { kind: 'watermark_after' });
    const chunk = await replay(reconnect, messages, jobId, sub.subscriptionId, beforeOffline);
    assert.deepEqual(chunk.events.map((event: any) => event.sequence), [beforeOffline + 1, beforeOffline + 2]);
    const buffered = await messages.wait(frame => frame.kind === 'gjc_job_event' && frame.event.payload.kind === 'watermark_after', 'buffered live event');
    assert.equal(buffered.event.sequence, beforeOffline + 3);
    supervisor.emit(1, { kind: 'live_after_reconnect' });
    await messages.wait(frame => frame.kind === 'gjc_job_event' && frame.event.payload.kind === 'live_after_reconnect', 'post replay live event');
    const sequences = messages.frames.filter(frame => frame.kind === 'gjc_job_replay_chunk' || frame.kind === 'gjc_job_event').flatMap(frame => frame.kind === 'gjc_job_replay_chunk' ? frame.events.map((event: any) => event.sequence) : [frame.event.sequence]);
    assert.deepEqual(sequences, [beforeOffline + 1, beforeOffline + 2, beforeOffline + 3, beforeOffline + 4]); assert.equal(new Set(sequences).size, sequences.length);
    reconnect.terminate(); await once(reconnect, 'close');
  });

  await t.test('oversized and malformed ids are rejected without authority contact or healthy subscription impact', async () => {
    const isolate = connect(); await once(isolate, 'open'); const messages = observe(isolate);
    const before = authorityCalls;
    isolate.send(JSON.stringify({ protocolVersion: 1, type: 'gjc.job.subscribe', jobId: 'x'.repeat(129), after: 0 }));
    const oversized = await messages.wait(frame => frame.kind === 'gjc_job_error', 'oversized id rejection'); assert.equal(oversized.code, 'invalid_request');
    isolate.send(JSON.stringify({ protocolVersion: 1, type: 'gjc.job.subscribe', jobId: 'bad/id', after: 0 }));
    const malformed = await messages.wait(frame => frame.kind === 'gjc_job_error' && messages.frames.indexOf(frame) > messages.frames.indexOf(oversized), 'malformed id rejection'); assert.equal(malformed.code, 'invalid_request');
    assert.equal(authorityCalls, before);
    const cursor = (await jobs.get({ jobId }) as any).lastSequence;
    const sub = await subscribe(isolate, messages, jobId, cursor); const chunk = await replay(isolate, messages, jobId, sub.subscriptionId, cursor); assert.equal(chunk.done, true);
    supervisor.emit(1, { kind: 'healthy_after_invalid' }); await messages.wait(frame => frame.kind === 'gjc_job_event' && frame.event.payload.kind === 'healthy_after_invalid', 'healthy live event');
    isolate.terminate(); await once(isolate, 'close');
  });

  await t.test('authority outage rejects only GJC while legacy chat remains available', async () => {
    const socket = connect(); await once(socket, 'open'); const messages = observe(socket); authorityDown = true;
    socket.send(JSON.stringify({ protocolVersion: 1, type: 'gjc.job.subscribe', jobId, after: 0 }));
    const error = await messages.wait(frame => frame.kind === 'gjc_job_error', 'authority unavailable'); assert.equal(error.code, 'authority_unavailable'); assert.equal(error.retryable, true);
    socket.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: 'legacy-session', lastSeq: 0 }] }));
    const chat = await messages.wait(frame => frame.kind === 'chat_subscribed', 'chat subscribe'); assert.equal(chat.sessionId, 'legacy-session');
    authorityDown = false; socket.terminate(); await once(socket, 'close');
  });

  await t.test('throwing projection callback preserves durable state and isolates other websocket traffic', async () => {
    const socket = connect(); await once(socket, 'open'); const messages = observe(socket);
    const cursor = (await jobs.get({ jobId }) as any).lastSequence;
    const publish = projection.publish.bind(projection);
    (projection as any).publish = () => { throw new Error('projection callback failed'); };
    supervisor.emit(1, { kind: 'broadcast_throw' });
    await waitFor(async () => (await jobs.get({ jobId }) as any).lastSequence === cursor + 1, 'durable event after throwing callback');
    (projection as any).publish = publish;
    socket.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: 'legacy-session', lastSeq: 0 }] }));
    await messages.wait(frame => frame.kind === 'chat_subscribed', 'legacy traffic');
    const recovery = connect(); await once(recovery, 'open'); const recoveryMessages = observe(recovery);
    const recovered = await subscribe(recovery, recoveryMessages, jobId, cursor); const chunk = await replay(recovery, recoveryMessages, jobId, recovered.subscriptionId, cursor);
    assert.equal(chunk.events.length, 1); assert.equal(chunk.events[0].payload.kind, 'broadcast_throw');
    supervisor.emit(1, { kind: 'other_subscriber_live' }); await recoveryMessages.wait(frame => frame.kind === 'gjc_job_event' && frame.event.payload.kind === 'other_subscriber_live', 'recovered subscriber after throw');
    recovery.terminate(); await once(recovery, 'close'); socket.terminate(); await once(socket, 'close');
  });

  await t.test('HTTP diff and commit use the ready managed worktree and publish the commit event live', async () => {
    supervisor.runs[1]!.resolve();
    await waitFor(async () => (await jobs.get({ jobId }) as any).state === 'ready', 'resumed run completion');
    assert.equal((await jobs.get({ jobId }) as any).state, 'ready');
    const snapshot = await jobs.get({ jobId }) as any;
    await writeFile(join(snapshot.worktreeId, 'selected.txt'), 'selected\n'); await writeFile(join(snapshot.worktreeId, 'unselected.txt'), 'unselected\n');
    const baseHead = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const diff = await request(`/api/gjc/jobs/${jobId}/git/diff`); assert.equal(diff.status, 200); const diffDto = await diff.json() as any; assert.match(diffDto.text, /selected\.txt/u); assert.match(diffDto.text, /unselected\.txt/u); assert.deepEqual(diffDto.paths.sort(), ['selected.txt', 'unselected.txt']);
    const socket = connect(); await once(socket, 'open'); const messages = observe(socket);
    const cursor = (await jobs.get({ jobId }) as any).lastSequence; const sub = await subscribe(socket, messages, jobId, cursor); await replay(socket, messages, jobId, sub.subscriptionId, cursor);
    const committed = await request(`/api/gjc/jobs/${jobId}/git/commit`, 'POST', { message: 'selected only', paths: ['selected.txt'] }); assert.equal(committed.status, 201); const dto = await committed.json() as any;
    assert.notEqual(dto.commit, baseHead); assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), baseHead);
    assert.deepEqual((await git(snapshot.worktreeId, ['status', '--porcelain'])).stdout.trim().split('\n').filter(Boolean), ['?? unselected.txt']);
    const event = await messages.wait(frame => frame.kind === 'gjc_job_event' && frame.event.eventId === dto.eventId, 'live commit event'); assert.equal(event.event.payload.kind, 'git_commit'); assert.deepEqual(event.event.payload.paths, ['selected.txt']);
    socket.terminate(); await once(socket, 'close');
  });
});
