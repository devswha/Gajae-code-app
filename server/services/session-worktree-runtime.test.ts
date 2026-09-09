import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import express from 'express';
import type { WebSocket } from 'ws';

import type { GjcWorkerOutcome, GjcWorkerSpawnRun } from '../gjc-worker-client.js';
import { closeConnection, initializeDatabase, projectPermissionsDb, projectsDb, sessionsDb, sessionWorktreesDb } from '../modules/database/index.js';
import { configureSessionWorktrees, createWorktreeSession } from '../modules/providers/services/session-worktrees.service.js';
import providerRoutes from '../modules/providers/provider.routes.js';
import { createProviderCommandsService, providerCommandsService } from '../modules/providers/services/provider-commands.service.js';
import { exportSessionTranscript } from '../modules/providers/services/session-export.service.js';
import { sessionsService } from '../modules/providers/services/sessions.service.js';
import gitRoutes from '../routes/git.js';
import { handleChatConnection } from '../modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '../modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '../modules/websocket/services/websocket-state.service.js';

import { GjcGitClient } from './gjc-git-client.js';
import { DesktopRestartAuthority } from './desktop-restart-authority.js';
import { createGjcJobOrchestratorDesktopRestartReader, JobOrchestrator, type GitWorktrees, type JobSupervisor } from './gjc-job-orchestrator.js';
import { GjcJobsClient } from './gjc-jobs-client.js';
import { readSessionLocation, resolveSessionWorkspacePath, validateSessionRepository } from './session-worktree-paths.js';
import { abortSessionWorktreeRun, configureSessionWorktreeDesktopAdmission, createSessionWorktreeDesktopRestartReader, prepareSessionWorktreeRun, sessionWorktreeWorkerHandle } from './session-worktree-runtime.js';

const execFile = promisify(execFileCallback);
const runOptions = { model: 'openai-codex/gpt-6-astra', effort: 'xhigh' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Fixture did not reach the expected state.');
}

async function fixture(t: test.TestContext, options: { delayPreparation?: boolean; delayStartup?: boolean; failStartupOnce?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'session-worktree-runtime-')));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'app.db');
  await initializeDatabase();
  const repository = path.join(root, 'repository');
  await mkdir(repository);
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const gitCommand = (...args: string[]) => execFile('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, '-c', 'user.name=Session Test', '-c', 'user.email=session@example.test', ...args], { cwd: repository, env: environment });
  await gitCommand('init');
  await writeFile(path.join(repository, 'README.md'), 'project file\n');
  await gitCommand('add', 'README.md');
  await gitCommand('commit', '-m', 'fixture');
  const project = projectsDb.createProjectPath(repository).project!;
  projectPermissionsDb.setMode(repository, 'bypass', { acknowledgeBypass: true });
  const alias = path.join(root, 'alias');
  await symlink(repository, alias, process.platform === 'win32' ? 'junction' : 'dir');
  configureSessionWorktrees({ validateRepository: validateSessionRepository, readLocation: readSessionLocation, resolveWorkspace: resolveSessionWorkspacePath });
  const created = await createWorktreeSession(alias);
  const jobs = new GjcJobsClient({ database: path.join(root, 'jobs.db') });
  const git = new GjcGitClient({ workdir: repository });
  const preparation = deferred<void>();
  let preparing = false;
  const gitBoundary: GitWorktrees = {
    create: async (params) => {
      const value = await git.create(params);
      preparing = true;
      if (options.delayPreparation) await preparation.promise;
      return value;
    },
    list: (params) => git.list(params), status: (params) => git.status(params),
  };
  const workers: Array<{ input: GjcWorkerSpawnRun; finish: (outcome?: GjcWorkerOutcome) => void }> = [];
  const supervisor: JobSupervisor = {
    spawnRun(input) {
      const started = deferred<void>();
      const completed = deferred<void>();
      const outcome = deferred<GjcWorkerOutcome>();
      const finish = (value: GjcWorkerOutcome = 'completed') => {
        if (options.delayStartup && value !== 'completed') started.reject(new Error('Stopped before startup'));
        else started.resolve();
        outcome.resolve(value);
        completed.resolve();
      };
      workers.push({ input, finish });
      if (options.failStartupOnce && workers.length === 1) {
        started.reject(new Error('Fixture startup failure'));
        outcome.resolve('not_started');
        completed.resolve();
      } else if (!options.delayStartup) started.resolve();
      return { started: started.promise, completion: completed.promise, outcome: outcome.promise, abortHandle: input.runId };
    },
    async abort(handle) {
      workers.find(({ input }) => input.runId === handle)?.finish(options.delayStartup ? 'not_started' : 'aborted');
      return options.delayStartup ? 'not_started' : 'aborted';
    },
  };
  let sequence = 0;
  const orchestrator = new JobOrchestrator({ jobs, git: gitBoundary, supervisor, owner: 'session-test', createId: () => `session-${++sequence}` });
  const messages: unknown[] = [];
  const writer = {
    send(value: unknown) { messages.push(value); },
    setSessionId(providerId: string) { sessionsDb.assignProviderSessionId(created.sessionId, 'gjc', providerId); },
    getAppSessionId() { return created.sessionId; },
  };
  const makeTicket = (owner = orchestrator) => {
    const ticket = prepareSessionWorktreeRun(created.sessionId, () => owner)!;
    t.after(() => ticket.dispose());
    return ticket;
  };
  t.after(async () => {
    chatRunRegistry.clearAll(); connectedClients.clear();
    jobs.close(); git.close(); closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, repository, project, created, jobs, git, supervisor, orchestrator, messages, writer, workers, makeTicket, preparation, isPreparing: () => preparing };
}

function worktreeDesktopAuthority(t: test.TestContext, orchestrator: JobOrchestrator) {
  const reader = createSessionWorktreeDesktopRestartReader();
  const authority = new DesktopRestartAuthority({
    requiredOwners: ['worktrees', 'orchestrator'],
    ownerReaders: { worktrees: reader, orchestrator: createGjcJobOrchestratorDesktopRestartReader(orchestrator) },
  });
  configureSessionWorktreeDesktopAdmission(authority);
  orchestrator.configureDesktopAdmission(authority);
  t.after(() => configureSessionWorktreeDesktopAdmission());
  return { authority, reader };
}
const worktreeDesktopTick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('desktop worktree reader is pure and unused ticket disposal closes its single-use admission', async (t) => {
  const f = await fixture(t);
  const { authority, reader } = worktreeDesktopAuthority(t, f.orchestrator);
  const before = reader.read();
  assert.equal(before.owner, 'worktrees');
  assert.deepEqual(reader.read(), before);
  assert.equal(reader.getGeneration(), before.generation);
  assert.equal(f.workers.length, 0);
  const ticket = f.makeTicket();
  assert.equal(reader.read().starting, before.starting + 1);
  assert.notEqual(reader.getGeneration(), before.generation);
  assert.equal((await authority.prepare({ attemptId: 'unused-ticket', epoch: 'desktop-1' })).ok, false);
  ticket.dispose();
  const after = reader.read();
  ticket.dispose();
  assert.deepEqual(reader.read(), after);
  assert.deepEqual({ ...after, generation: before.generation }, before);
  await assert.rejects(ticket.run('disposed', runOptions, f.writer), /disposed/);
  assert.equal((await authority.snapshot()).idle, true);
  const prepared = await authority.prepare({ attemptId: 'new-ticket-fenced', epoch: 'desktop-1' });
  assert.equal(prepared.ok, true);
  assert.throws(() => prepareSessionWorktreeRun(f.created.sessionId, () => f.orchestrator), { code: 'DESKTOP_RESTART_FENCED' });
  assert.equal(f.workers.length, 0);
  if (prepared.ok) authority.cancel(prepared.token);
});

test('disposal and chat registry clearing during paused preparation cannot hide the worktree lifetime', async (t) => {
  const f = await fixture(t, { delayPreparation: true });
  const { authority, reader } = worktreeDesktopAuthority(t, f.orchestrator);
  const ticket = f.makeTicket();
  const running = ticket.run('paused preparation', runOptions, f.writer);
  await until(f.isPreparing);
  ticket.dispose();
  chatRunRegistry.clearAll();
  assert.ok(reader.read().running > 0 && reader.read().settling > 0);
  assert.equal((await authority.prepare({ attemptId: 'disposed-preparation', epoch: 'desktop-1' })).ok, false);
  assert.equal(ticket.aborted, false);
  f.preparation.resolve();
  await until(() => f.workers.length === 1);
  assert.equal(sessionWorktreeWorkerHandle(ticket.abortHandle), f.workers[0].input.runId);
  f.workers[0].input.writer.send({ kind: 'complete', exitCode: 0 });
  assert.equal((await authority.snapshot()).idle, false);
  assert.equal(f.messages.some((message) => (message as { kind?: string }).kind === 'complete'), false);
  f.workers[0].finish();
  await running;
  await worktreeDesktopTick();
  assert.equal(sessionWorktreeWorkerHandle(ticket.abortHandle), undefined);
  assert.equal((await authority.snapshot()).idle, true);
});

test('a live ticket may continue during a paused prepare while new roots remain fenced', async (t) => {
  const f = await fixture(t);
  // This accepted owner predates authority injection, so the reader (rather
  // than a retained ingress lease) must protect the entire transfer.
  const ticket = f.makeTicket();
  const { authority } = worktreeDesktopAuthority(t, f.orchestrator);
  const preparing = authority.prepare({ attemptId: 'owned-continuation', epoch: 'desktop-1' });
  assert.equal(authority.state, 'preparing');
  const running = ticket.run('owned continuation', runOptions, f.writer);
  const rejected = assert.rejects(f.orchestrator.start('gjc', 'other-session', f.repository, 'new root', { writer: f.writer }), { code: 'DESKTOP_RESTART_FENCED' });
  assert.throws(() => prepareSessionWorktreeRun(f.created.sessionId, () => f.orchestrator), { code: 'DESKTOP_RESTART_FENCED' });
  assert.equal((await preparing).ok, false);
  await rejected;
  await until(() => f.workers.length === 1);
  assert.equal(ticket.aborted, false);
  f.workers[0].finish();
  await running;
  ticket.dispose();
  await worktreeDesktopTick();
  assert.equal((await authority.snapshot()).idle, true);
});

test('a disposed failed-start ticket stays owned until the actual worker promise settles', async (t) => {
  const f = await fixture(t);
  const completed = deferred<void>(); const outcome = deferred<GjcWorkerOutcome>();
  const supervisor: JobSupervisor = {
    spawnRun: (input) => ({ started: Promise.reject(new Error('paused worker startup failure')), completion: completed.promise, outcome: outcome.promise, phase: () => 'request_issued', abortHandle: input.runId }),
    abort: async () => 'unconfirmed', terminate: async () => 'reaped',
  };
  const orchestrator = new JobOrchestrator({ jobs: f.jobs, git: f.git, supervisor, stopCompletionTimeoutMs: 1 });
  const { authority, reader } = worktreeDesktopAuthority(t, orchestrator);
  const ticket = f.makeTicket(orchestrator);
  const running = ticket.run('startup failure', runOptions, f.writer);
  await assert.rejects(running, /paused worker startup failure/);
  ticket.dispose();
  assert.ok(reader.read().retained > 0 && reader.read().settling > 0);
  assert.ok(sessionWorktreeWorkerHandle(ticket.abortHandle));
  assert.equal((await authority.snapshot()).idle, false);
  outcome.resolve('reaped');
  completed.resolve();
  await worktreeDesktopTick();
  assert.equal(sessionWorktreeWorkerHandle(ticket.abortHandle), undefined);
  assert.equal((await authority.snapshot()).idle, true);
});

test('worktree abort timeout does not release cancellation or preparation ownership', async (t) => {
  const f = await fixture(t, { delayPreparation: true });
  const { authority, reader } = worktreeDesktopAuthority(t, f.orchestrator);
  const ticket = f.makeTicket();
  const running = ticket.run('cancel paused preparation', runOptions, f.writer);
  await until(f.isPreparing);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const aborting = abortSessionWorktreeRun(ticket.abortHandle);
  t.mock.timers.tick(5000);
  assert.equal(await aborting, false);
  t.mock.timers.reset();
  ticket.dispose();
  assert.ok(reader.read().running > 0 && reader.read().settling > 0);
  assert.equal((await authority.prepare({ attemptId: 'abort-timeout', epoch: 'desktop-1' })).ok, false);
  f.preparation.resolve();
  await running;
  await worktreeDesktopTick();
  assert.equal(ticket.aborted, true);
  assert.equal(f.workers.length, 0);
  assert.equal((await authority.snapshot()).idle, true);
});

test('worktree session keeps canonical project policy, actual cwd, and provider identity across turns and reload', async (t) => {
  const f = await fixture(t);
  assert.equal(f.created.projectPath, f.repository);
  assert.equal(readSessionLocation(f.created.sessionId).cwd, null);
  const first = f.makeTicket().run('first fixture turn', { ...runOptions, cwd: '/untrusted', permissions: { mode: 'ask' } }, f.writer);
  await until(() => f.workers.length === 1);
  const input = f.workers[0].input;
  const location = readSessionLocation(f.created.sessionId);
  assert.equal(input.options?.cwd, location.cwd);
  assert.equal(input.options?.projectPath, f.repository);
  assert.equal((input.options?.permissions as { mode: string }).mode, 'bypass');
  assert.notEqual(location.cwd, f.repository);
  input.writer.setSessionId?.('provider-session');
  await writeFile(path.join(location.cwd!, 'README.md'), 'isolated edits\n');
  input.writer.send({ kind: 'complete', provider: 'gjc', exitCode: 0 });
  f.workers[0].finish();
  await first;
  assert.equal((await f.orchestrator.resolveBinding('gjc', f.created.sessionId))?.state, 'ready');
  assert.equal((f.messages.at(-1) as { kind: string }).kind, 'complete');
  assert.equal(await readFile(path.join(f.repository, 'README.md'), 'utf8'), 'project file\n');
  sessionsDb.createSession('provider-session', 'gjc', location.cwd!, 'Synced transcript');
  assert.equal(sessionsDb.getSessionById(f.created.sessionId)?.project_path, f.repository);
  assert.equal(sessionsDb.countSessionsByProjectPath(f.repository), 1);
  assert.equal(projectsDb.getProjectPaths().length, 1);
  assert.equal(await resolveSessionWorkspacePath(f.project.project_id, f.created.sessionId), location.cwd);
  closeConnection();
  assert.deepEqual(readSessionLocation(f.created.sessionId), location);
  const restarted = new JobOrchestrator({ jobs: f.jobs, git: f.git, supervisor: f.supervisor, owner: 'restarted-session-test' });
  const second = f.makeTicket(restarted).run('second fixture turn', runOptions, f.writer);
  await until(() => f.workers.length === 2);
  assert.equal(f.workers[1].input.options?.cwd, location.cwd);
  assert.equal(f.workers[1].input.options?.sessionId, 'provider-session');
  f.workers[1].finish();
  await second;
});

test('REST worktree-session allocation persists a canonical parent and exposes pending location', async (t) => {
  const f = await fixture(t);
  const server = express().use(express.json()).use('/api/providers', providerRoutes).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const { port } = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}/api/providers/worktree-sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'gjc', projectPath: path.join(f.root, 'alias'), cwd: '/untrusted' }),
  });
  assert.equal(response.status, 201);
  const { data } = await response.json() as { data: { sessionId: string; projectPath: string } };
  assert.equal(data.projectPath, f.repository);
  const locationResponse = await fetch(`http://127.0.0.1:${port}/api/providers/sessions/${data.sessionId}/location`);
  const { data: location } = await locationResponse.json() as { data: { mode: string; cwd: string | null; projectPath: string } };
  assert.deepEqual({ mode: location.mode, cwd: location.cwd, projectPath: location.projectPath }, { mode: 'worktree', cwd: null, projectPath: f.repository });
  assert.equal(f.workers.length, 0);
  assert.equal(await f.orchestrator.resolveBinding('gjc', data.sessionId), null);
});

class ChatSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
}

test('chat dispatch uses the bound runtime and emits complete only after native readiness', async (t) => {
  const f = await fixture(t);
  const socket = new ChatSocket();
  t.after(() => socket.emit('close'));
  handleChatConnection(socket as unknown as WebSocket, { user: { id: 'fixture-user' } } as never, {
    spawnFns: { gjc: async () => assert.fail('Worktree session cannot use the root runner') } as never,
    abortFns: {} as never, resolveToolApproval() {}, getPendingApprovalsForSession: () => [],
    resolveSessionModel: async () => runOptions.model,
    sessionWorktrees: { prepare: (id) => prepareSessionWorktreeRun(id, () => f.orchestrator), abort: abortSessionWorktreeRun, workerHandle: sessionWorktreeWorkerHandle },
  });
  socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: f.created.sessionId, content: 'fixture turn', options: { ...runOptions, cwd: '/untrusted', permissions: { mode: 'ask' } } }));
  await until(() => f.workers.length === 1);
  assert.equal(f.workers[0].input.options?.cwd, readSessionLocation(f.created.sessionId).cwd);
  assert.equal((f.workers[0].input.options?.permissions as { mode: string }).mode, 'bypass');
  f.workers[0].input.writer.setSessionId?.('wire-provider-session');
  f.workers[0].input.writer.send({ kind: 'complete', provider: 'gjc', exitCode: 0 });
  assert.equal(socket.sent.some(({ kind }) => kind === 'complete'), false);
  f.workers[0].finish();
  await until(() => socket.sent.some(({ kind }) => kind === 'complete'));
  assert.equal((await f.orchestrator.resolveBinding('gjc', f.created.sessionId))?.state, 'ready');
  assert.equal(socket.sent.filter(({ kind }) => kind === 'complete').length, 1);
  assert.equal(sessionsDb.getSessionById(f.created.sessionId)?.project_path, f.repository);
});

test('chat Stop during model lookup prevents a later worktree dispatch', async (t) => {
  const f = await fixture(t);
  const socket = new ChatSocket();
  const model = deferred<string>();
  let modelLookup = false;
  t.after(() => socket.emit('close'));
  handleChatConnection(socket as unknown as WebSocket, { user: { id: 'fixture-user' } } as never, {
    spawnFns: { gjc: async () => assert.fail('Must not dispatch') } as never,
    abortFns: {} as never, resolveToolApproval() {}, getPendingApprovalsForSession: () => [],
    resolveSessionModel: async () => { modelLookup = true; return model.promise; },
    sessionWorktrees: { prepare: (id) => prepareSessionWorktreeRun(id, () => f.orchestrator), abort: abortSessionWorktreeRun, workerHandle: sessionWorktreeWorkerHandle },
  });
  socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: f.created.sessionId, content: 'must not start', options: runOptions }));
  await until(() => modelLookup);
  socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: f.created.sessionId }));
  await until(() => socket.sent.some(({ kind }) => kind === 'complete'));
  model.resolve(runOptions.model);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.workers.length, 0);
  assert.equal(await f.orchestrator.resolveBinding('gjc', f.created.sessionId), null);
});

test('Stop before model lookup prevents native admission', async (t) => {
  const f = await fixture(t);
  const ticket = f.makeTicket();
  assert.equal(await abortSessionWorktreeRun(ticket.abortHandle), true);
  await ticket.run('must not start', runOptions, f.writer);
  assert.equal(f.workers.length, 0);
  assert.equal(await f.orchestrator.resolveBinding('gjc', f.created.sessionId), null);
  assert.equal(readSessionLocation(f.created.sessionId).cwd, null);
});

test('confirmed startup failure retains the worktree for the next attempt', async (t) => {
  const f = await fixture(t, { failStartupOnce: true });
  await assert.rejects(f.makeTicket().run('fixture turn', runOptions, f.writer), /Fixture startup failure/);
  const location = readSessionLocation(f.created.sessionId);
  assert.ok(location.cwd);
  assert.equal((await f.orchestrator.resolveBinding('gjc', f.created.sessionId))?.state, 'ready');
  const next = f.makeTicket().run('retry fixture turn', runOptions, f.writer);
  await until(() => f.workers.length === 2);
  assert.equal(f.workers[1].input.options?.cwd, location.cwd);
  f.workers[1].finish();
  await next;
});

test('Stop during worktree preparation leaves a reusable bound workspace without spawning', async (t) => {
  const f = await fixture(t, { delayPreparation: true });
  const ticket = f.makeTicket();
  const first = ticket.run('fixture turn', runOptions, f.writer);
  await until(f.isPreparing);
  const aborted = abortSessionWorktreeRun(ticket.abortHandle);
  f.preparation.resolve();
  assert.equal(await aborted, true);
  await first;
  assert.equal(f.workers.length, 0);
  assert.equal((await f.orchestrator.resolveBinding('gjc', f.created.sessionId))?.state, 'ready');
  const cwd = readSessionLocation(f.created.sessionId).cwd;
  const second = f.makeTicket().run('continue after stop', runOptions, f.writer);
  await until(() => f.workers.length === 1);
  assert.equal(f.workers[0].input.options?.cwd, cwd);
  f.workers[0].finish();
  await second;
});

test('Stop during worker startup retains the binding and records an aborted turn', async (t) => {
  const f = await fixture(t, { delayStartup: true });
  const ticket = f.makeTicket();
  const run = ticket.run('fixture turn', runOptions, f.writer);
  await until(() => f.workers.length === 1);
  assert.equal(await abortSessionWorktreeRun(ticket.abortHandle), true);
  await run;
  assert.equal((await f.orchestrator.resolveBinding('gjc', f.created.sessionId))?.state, 'ready');
  assert.equal((f.messages.at(-1) as { aborted: boolean }).aborted, true);
  const binding = sessionWorktreesDb.get(f.created.sessionId)!;
  const events = await f.jobs.replayEvents({ jobId: binding.job_id }) as { events: Array<{ payload: { outcome?: string } }> };
  assert.ok(events.events.some(({ payload }) => payload.outcome === 'aborted'));
});

test('tampered worktree and cross-project reads fail without dispatch or project-policy fallback', async (t) => {
  const f = await fixture(t);
  const first = f.makeTicket().run('fixture turn', runOptions, f.writer);
  await until(() => f.workers.length === 1);
  f.workers[0].finish();
  await first;
  const location = readSessionLocation(f.created.sessionId);
  const foreign = path.join(f.root, 'foreign');
  await mkdir(foreign);
  const other = projectsDb.createProjectPath(foreign).project!;
  await assert.rejects(resolveSessionWorkspacePath(other.project_id, f.created.sessionId), { code: 'SESSION_PROJECT_MISMATCH' });
  await rename(location.cwd!, path.join(f.root, 'saved-worktree'));
  await symlink(foreign, location.cwd!, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.makeTicket().run('must refuse', runOptions, f.writer), { code: 'SESSION_WORKTREE_UNAVAILABLE' });
  await assert.rejects(resolveSessionWorkspacePath(f.project.project_id, f.created.sessionId), { code: 'SESSION_WORKTREE_UNAVAILABLE' });
  assert.equal(f.workers.length, 1);
  assert.equal((await f.orchestrator.resolveBinding('gjc', f.created.sessionId))?.state, 'ready');
});

test('session command discovery uses the validated worktree and refuses malformed scope', async (t) => {
  const f = await fixture(t);
  const run = f.makeTicket().run('fixture turn', runOptions, f.writer);
  await until(() => f.workers.length === 1);
  f.workers[0].finish();
  await run;
  const cwd = readSessionLocation(f.created.sessionId).cwd!;
  for (const [directory, name] of [[f.repository, 'root-only'], [cwd, 'worktree-only']]) {
    await mkdir(path.join(directory, '.gjc', 'commands'), { recursive: true });
    await writeFile(path.join(directory, '.gjc', 'commands', `${name}.md`), `---\ndescription: ${name}\n---\nFixture command\n`);
  }
  const original = providerCommandsService.listProviderCommands;
  providerCommandsService.listProviderCommands = createProviderCommandsService({ homeDir: f.root }).listProviderCommands;
  t.after(() => { providerCommandsService.listProviderCommands = original; });
  const server = express().use('/api/providers', providerRoutes).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const { port } = server.address() as { port: number };
  const endpoint = `http://127.0.0.1:${port}/api/providers/gjc/commands?projectId=${f.project.project_id}`;
  const response = await fetch(`${endpoint}&sessionId=${f.created.sessionId}`);
  assert.equal(response.status, 200);
  const { data } = await response.json() as { data: { commands: Array<{ name: string; path?: string }> } };
  assert.ok(data.commands.some((command) => command.name === '/worktree-only' && command.path?.startsWith(cwd)));
  assert.equal(data.commands.some((command) => command.name === '/root-only'), false);
  assert.equal((await fetch(`${endpoint}&sessionId[]=${f.created.sessionId}`)).status, 400);
});

test('unconfirmed worker termination retains native ownership and cannot report success or start another turn', async (t) => {
  const f = await fixture(t);
  const ticket = f.makeTicket();
  const run = ticket.run('fixture turn', runOptions, f.writer);
  const rejected = assert.rejects(run, /termination is unconfirmed/);
  await until(() => f.workers.length === 1);
  f.workers[0].finish('unconfirmed');
  await rejected;
  assert.equal(ticket.aborted, false);
  assert.equal(f.messages.some((message) => (message as { kind: string }).kind === 'complete'), false);
  assert.equal((await f.orchestrator.resolveBinding('gjc', f.created.sessionId))?.state, 'running');
  assert.equal(await abortSessionWorktreeRun(ticket.abortHandle), false);
  assert.equal(ticket.aborted, false);
  await assert.rejects(f.makeTicket().run('must not start', runOptions, f.writer), { code: 'RUN_IN_PROGRESS' });
  assert.equal(f.workers.length, 1);
  ticket.dispose();
  const reader = createSessionWorktreeDesktopRestartReader();
  assert.equal(reader.read().complete, false);
  assert.ok(reader.read().unknown.includes('worktree_stop_unconfirmed'));
  assert.ok(reader.read().retained > 0);
  assert.equal(sessionWorktreeWorkerHandle(ticket.abortHandle), f.workers[0].input.runId);
});

test('an unsuccessful worker completion never becomes a successful native turn', async (t) => {
  const f = await fixture(t);
  const run = f.makeTicket().run('fixture turn', runOptions, f.writer);
  const rejected = assert.rejects(run, /unsuccessful turn/);
  await until(() => f.workers.length === 1);
  f.workers[0].input.writer.send({ kind: 'complete', provider: 'gjc', exitCode: 1 });
  f.workers[0].finish();
  await rejected;
  const binding = sessionWorktreesDb.get(f.created.sessionId)!;
  const events = await f.jobs.replayEvents({ jobId: binding.job_id }) as { events: Array<{ payload: { outcome?: string } }> };
  assert.ok(events.events.some(({ payload }) => payload.outcome === 'failed'));
  assert.equal(events.events.some(({ payload }) => payload.outcome === 'succeeded'), false);
  assert.equal(f.messages.some((message) => (message as { kind: string }).kind === 'complete'), false);
});

test('concurrent claims dispatch only once and separate sessions receive separate worktrees', async (t) => {
  const f = await fixture(t);
  const first = f.makeTicket().run('first fixture turn', runOptions, f.writer);
  await until(() => f.workers.length === 1);
  await assert.rejects(f.makeTicket().run('duplicate fixture turn', runOptions, f.writer), { code: 'RUN_IN_PROGRESS' });
  const secondSession = await createWorktreeSession(f.repository);
  const ticket = prepareSessionWorktreeRun(secondSession.sessionId, () => f.orchestrator)!;
  t.after(() => ticket.dispose());
  const second = ticket.run('separate session', runOptions, { send() {}, getAppSessionId: () => secondSession.sessionId });
  await until(() => f.workers.length === 2);
  assert.notEqual(f.workers[0].input.options?.cwd, f.workers[1].input.options?.cwd);
  assert.notEqual(readSessionLocation(f.created.sessionId).jobId, readSessionLocation(secondSession.sessionId).jobId);
  f.workers.forEach((worker) => worker.finish());
  await Promise.all([first, second]);
});

test('a fresh native client resumes an interrupted admission with the same worktree and provider identity', async (t) => {
  const f = await fixture(t);
  const first = f.makeTicket().run('first fixture turn', runOptions, f.writer);
  await until(() => f.workers.length === 1);
  f.workers[0].input.writer.setSessionId?.('restart-provider');
  f.workers[0].finish();
  await first;
  const location = readSessionLocation(f.created.sessionId);
  await f.jobs.turnAdmit({ jobId: location.jobId, appSessionId: f.created.sessionId, owner: 'crashed-owner', runId: 'crashed-run', cap: 4 });
  f.jobs.close();
  f.git.close();
  closeConnection();
  await initializeDatabase();
  const jobs = new GjcJobsClient({ database: path.join(f.root, 'jobs.db') });
  const git = new GjcGitClient({ workdir: f.repository });
  t.after(() => { jobs.close(); git.close(); });
  const restarted = new JobOrchestrator({ jobs, git, supervisor: f.supervisor, owner: 'restarted-owner' });
  await restarted.reconcile();
  assert.equal((await restarted.resolveBinding('gjc', f.created.sessionId))?.state, 'interrupted');
  const resumed = f.makeTicket(restarted).run('resumed turn', runOptions, f.writer);
  await until(() => f.workers.length === 2);
  assert.equal(f.workers[1].input.options?.cwd, location.cwd);
  assert.equal(f.workers[1].input.options?.sessionId, 'restart-provider');
  f.workers[1].finish();
  await resumed;
  assert.deepEqual(readSessionLocation(f.created.sessionId), location);
  assert.equal((await restarted.resolveBinding('gjc', f.created.sessionId))?.state, 'ready');
});

test('Git reads, transcript exports, and archive retain the execution directory without modifying the parent', async (t) => {
  const f = await fixture(t);
  const run = f.makeTicket().run('fixture turn', runOptions, f.writer);
  await until(() => f.workers.length === 1);
  f.workers[0].input.writer.setSessionId?.('export-provider');
  f.workers[0].finish();
  await run;
  const cwd = readSessionLocation(f.created.sessionId).cwd!;
  await writeFile(path.join(cwd, 'README.md'), 'worktree change\n');
  await writeFile(path.join(cwd, 'untracked.txt'), 'preserve me\n');
  const transcript = path.join(f.root, 'transcript.jsonl');
  await writeFile(transcript, [
    { type: 'session', version: 3, id: 'export-provider', cwd },
    { type: 'message', id: 'msg-one', timestamp: '2026-09-05T01:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Isolated transcript' }] } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');
  sessionsDb.createSession('export-provider', 'gjc', cwd, 'Worktree conversation', undefined, undefined, transcript);
  const exported = await exportSessionTranscript(f.created.sessionId);
  assert.ok(exported.body.includes(`- Project: ${f.repository}`));
  assert.ok(exported.body.includes(`- Working directory: ${cwd}`));
  assert.ok(exported.body.includes('Isolated transcript'));

  const server = express().use('/api/git', gitRoutes).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const { port } = server.address() as { port: number };
  const endpoint = `http://127.0.0.1:${port}/api/git`;
  const status = await (await fetch(`${endpoint}/status?project=${f.project.project_id}&sessionId=${f.created.sessionId}`)).json() as { branch: string; modified: string[]; untracked: string[] };
  assert.equal(status.branch, `job/${readSessionLocation(f.created.sessionId).jobId}`);
  assert.ok(status.modified.includes('README.md'));
  assert.ok(status.untracked.includes('untracked.txt'));
  const diff = await (await fetch(`${endpoint}/diff?project=${f.project.project_id}&sessionId=${f.created.sessionId}`)).json() as { files: Array<{ path: string; patch?: string }> };
  assert.ok(diff.files.some((file) => file.path === 'README.md' && file.patch?.includes('+worktree change')));
  await sessionsService.deleteOrArchiveSessionById(f.created.sessionId);
  assert.equal(await readFile(path.join(cwd, 'untracked.txt'), 'utf8'), 'preserve me\n');
  assert.equal(await readFile(path.join(f.repository, 'README.md'), 'utf8'), 'project file\n');
  await assert.rejects(f.makeTicket().run('archived turn', runOptions, f.writer), { code: 'SESSION_PROJECT_MISMATCH' });
  sessionsService.restoreSessionById(f.created.sessionId);
  assert.equal(await resolveSessionWorkspacePath(f.project.project_id, f.created.sessionId), cwd);
});
