import assert from 'node:assert/strict';
import test from 'node:test';

import type { GjcWorkerOutcome } from '../gjc-worker-client.js';

import { DesktopRestartAuthority } from './desktop-restart-authority.js';
import { createGjcJobOrchestratorDesktopRestartReader, GjcCapacityExhaustedError, JobOrchestrator, withOwnedJobDesktopContinuation, type JobAuthority, type GitWorktrees, type JobSupervisor } from './gjc-job-orchestrator.js';

type Snap = { jobId: string; state: string; lease: { owner: string; generation: number }; worktreeId?: string; repositoryRoot?: string; branch?: string; currentRun?: { runId: string; appSessionId: string }; dispatchCheckpoint?: { runId: string }; lastSequence?: number };
class Jobs implements JobAuthority {
  calls: Array<[string, Record<string, unknown>]> = []; events: Array<{ eventId: string; sequence: number; payload: unknown }> = []; state: Snap = { jobId: '', state: 'reserved', lease: { owner: 'owner', generation: 1 }, lastSequence: 0 };
  private call(name: string, params: Record<string, unknown>): Promise<unknown> { this.calls.push([name, params]); return Promise.resolve(this.state); }
  private event(name: string, params: Record<string, unknown>): Promise<unknown> { this.calls.push([name, params]); const existing = this.events.find((event) => event.eventId === params.eventId); if (existing) return Promise.resolve(existing); const event = { eventId: String(params.eventId), sequence: (this.state.lastSequence ?? 0) + 1, payload: params.payload }; this.events.push(event); this.state = { ...this.state, lastSequence: event.sequence }; return Promise.resolve(event); }
  reserve(p: Record<string, unknown>) { this.state = { ...this.state, jobId: String(p.jobId), state: 'reserved', lease: { owner: String(p.owner), generation: 1 } }; return this.call('reserve', p); }
  prepare(p: Record<string, unknown>) { this.state = { ...this.state, worktreeId: String(p.worktreeId), repositoryRoot: String(p.repositoryRoot), branch: String(p.branch) }; return this.call('prepare', p); }
  admit(p: Record<string, unknown>) { this.state = { ...this.state, state: 'queued', currentRun: { runId: String(p.runId), appSessionId: String(p.appSessionId) } }; return this.call('admit', p); }
  readmit(p: Record<string, unknown>) { this.state = { ...this.state, state: 'queued', lease: { owner: String(p.owner), generation: 2 }, currentRun: { runId: String(p.runId), appSessionId: String(p.appSessionId) } }; return this.call('readmit', p); }
  transition(p: Record<string, unknown>) { if (['succeeded', 'failed', 'aborted', 'interrupted'].includes(String(p.state))) return Promise.reject(new Error('invalid_transition')); this.state = { ...this.state, state: String(p.state) }; return this.call('transition', p); }
  markDispatching(p: Record<string, unknown>) { this.state = { ...this.state, state: 'queued', dispatchCheckpoint: { runId: String(p.runId) } }; return this.call('markDispatching', p); }
  finalize(p: Record<string, unknown>) { this.state = { ...this.state, state: String(p.state), lease: { owner: '', generation: 0 } }; return this.call('finalize', p); }
  cancelAdmission(p: Record<string, unknown>) {
    this.state = { ...this.state, state: 'failed', lease: { owner: '', generation: 0 } };
    this.calls.push(['cancelAdmission', p]);
    const terminal = p.terminalEvent;
    if (terminal && typeof terminal === 'object' && !Array.isArray(terminal)) {
      const eventId = (terminal as { eventId?: unknown }).eventId;
      if (typeof eventId !== 'string') return Promise.reject(new Error('invalid terminal event'));
      const existing = this.events.find((event) => event.eventId === eventId);
      const event = existing ?? { eventId, sequence: (this.state.lastSequence ?? 0) + 1, payload: (terminal as { payload?: unknown }).payload };
      if (!existing) {
        this.events.push(event);
        this.state = { ...this.state, lastSequence: event.sequence };
      }
      return Promise.resolve({ ...this.state, terminalEvent: event });
    }
    return Promise.resolve(this.state);
  }
  appendEvent(p: Record<string, unknown>) { return this.event('appendEvent', p); }
  appendAdminEvent(p: Record<string, unknown>) { return this.state.state === 'ready' ? this.event('appendAdminEvent', p) : Promise.reject(new Error('invalid_transition')); }
  replayEvents(p: Record<string, unknown>) { this.calls.push(['replayEvents', p]); return Promise.resolve({ events: this.events.filter((event) => event.sequence > Number(p.after ?? 0)) }); }
  get(p: Record<string, unknown>) { return this.call('get', p); }
  reconcile(p: Record<string, unknown> = {}) { return this.call('reconcile', p); }
  bindProviderSession(p: Record<string, unknown>) { return this.call('bindProviderSession', p); }
  reserveStart(p: Record<string, unknown>) { return this.reserve(p); }
  turnAdmit(p: Record<string, unknown>) { return this.admit(p); }
  runFinalize(p: Record<string, unknown>) { const event = this.event('runFinalize', p); this.state = { ...this.state, state: String(p.terminalRunState), lease: { owner: '', generation: 0 } }; return event.then(() => this.state); }
  bindingResolve(p: Record<string, unknown>) { return Promise.resolve({ jobId: this.state.jobId, state: this.state.state, providerSessionId: 'provider-1', ...p }); }
  bindingRelease(p: Record<string, unknown>) { return this.call('bindingRelease', p); }
  interruptForShutdown() { this.state = { ...this.state, state: 'interrupted' }; return this.call('interruptForShutdown', {}); }
}
class Git implements GitWorktrees { calls: string[] = []; async create() { this.calls.push('create'); return { worktree: { worktreeId: '/project/.gjc-worktrees/job-abc', jobId: 'job-abc', path: '/project/.gjc-worktrees/job-abc', branch: 'job/job-abc', head: 'abc' } }; } async list() { this.calls.push('list'); return { items: [{ worktreeId: '/project/.gjc-worktrees/job-abc', path: '/project/.gjc-worktrees/job-abc' }] }; } async status() { this.calls.push('status'); return { branch: 'job/abc' }; } }
class Supervisor implements JobSupervisor { input?: Parameters<JobSupervisor['spawnRun']>[0]; aborted?: string; spawnRun(input: Parameters<JobSupervisor['spawnRun']>[0]) { this.input = input; return { started: Promise.resolve(), completion: new Promise<void>(() => {}), abortHandle: input.runId }; } async abort(id: string) { this.aborted = id; return 'aborted' as const; } }
const options = { appSessionId: 'app-1', writer: { send() {} } };
const stopCompletionTimeoutMs = 5;
test('start reserves a trimmed initial prompt capped at 2000 characters and omits blank prompts', async () => {
  const prompt = 'x'.repeat(2_001);
  const jobs = new Jobs(); const git = new Git(); const supervisor = new Supervisor();
  await new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' }).start('gjc', 'app-1', '/project', ` \n${prompt}\t `, options);
  const reserve = jobs.calls.find(([name]) => name === 'reserve')?.[1];
  assert.equal(reserve?.prompt, 'x'.repeat(2_000));

  const blankJobs = new Jobs();
  await new JobOrchestrator({ jobs: blankJobs, git: new Git(), supervisor: new Supervisor(), owner: 'owner', createId: () => 'def' }).start('gjc', 'app-1', '/project', ' \n\t ', options);
  const blankReserve = blankJobs.calls.find(([name]) => name === 'reserve')?.[1];
  assert.equal('prompt' in (blankReserve ?? {}), false);
});

test('start never splits a surrogate pair at the 2000-character prompt cap', async () => {
  // 1999 units then an emoji (2 units): the cap boundary lands between the
  // surrogate halves; the lone high surrogate must be dropped, not sent.
  const message = `${'x'.repeat(1_999)}\u{1F600}`;
  const jobs = new Jobs();
  await new JobOrchestrator({ jobs, git: new Git(), supervisor: new Supervisor(), owner: 'owner', createId: () => 'ghi' }).start('gjc', 'app-1', '/project', message, options);
  const reserve = jobs.calls.find(([name]) => name === 'reserve')?.[1];
  assert.equal(reserve?.prompt, 'x'.repeat(1_999));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify({ prompt: reserve?.prompt })));
});

test('start reserves before creating a worktree, admits caller-owned run id, then runs it', async () => {
  const jobs = new Jobs(); const git = new Git(); const supervisor = new Supervisor();
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' });
  const result = await orchestrator.start('gjc', 'app-1', '/project', 'hello', options);
  assert.equal(result.jobId, 'job-abc');
  assert.deepEqual(jobs.calls.map(([name]) => name), ['reserve', 'prepare', 'admit', 'markDispatching', 'transition']);
  assert.deepEqual(git.calls, ['create']);
  assert.equal(supervisor.input?.runId, 'run-abc');
  assert.equal(supervisor.input?.appSessionId, 'app-1');
  let completed = false;
  void result.completion.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
});
test('completion resolves only after durable finalization succeeds', async () => {
  const jobs = new Jobs(); const git = new Git();
  let settle!: () => void; const workerCompletion = new Promise<void>((resolve) => { settle = resolve; });
  let finalize!: () => void; const finalizeGate = new Promise<void>((resolve) => { finalize = resolve; });
  jobs.runFinalize = async (p) => { jobs.calls.push(['runFinalize', p]); await finalizeGate; await Jobs.prototype.runFinalize.call(jobs, p); return jobs.state; };
  const supervisor: JobSupervisor = { spawnRun: (input) => ({ started: Promise.resolve(), completion: workerCompletion, abortHandle: input.runId }), abort: async () => 'aborted' };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' });
  const run = await orchestrator.start('gjc', 'app-1', '/project', 'hello', options);
  let completed = false; void run.completion.then(() => { completed = true; });
  settle(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false); assert.equal(jobs.calls.at(-1)?.[0], 'runFinalize');
  finalize(); await run.completion; assert.equal(jobs.state.state, 'succeeded');
});
test('completion read-back accepts a committed success when the finalize response is lost', async () => {
  const jobs = new Jobs(); const git = new Git();
  let settle!: () => void; const workerCompletion = new Promise<void>((resolve) => { settle = resolve; });
  jobs.runFinalize = async (p) => {
    jobs.calls.push(['runFinalize', p]);
    await Jobs.prototype.runFinalize.call(jobs, p);
    throw new Error('finalize response lost');
  };
  const supervisor: JobSupervisor = { spawnRun: (input) => ({ started: Promise.resolve(), completion: workerCompletion, abortHandle: input.runId }), abort: async () => 'aborted' };
  const run = await new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' }).start('gjc', 'app-1', '/project', 'hello', options);
  settle();
  await run.completion;
  assert.equal(jobs.state.state, 'succeeded');
  assert.deepEqual(jobs.calls.slice(-3).map(([name]) => name), ['runFinalize', 'get', 'replayEvents']);
});
test('pre-run admission failure uses cancelAdmission instead of forbidden terminal transition', async () => {
  const jobs = new Jobs(); const git = new Git(); git.create = async () => { throw new Error('worktree failed'); };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor: new Supervisor(), owner: 'owner', createId: () => 'abc' });
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), /worktree failed/);
  assert.equal(jobs.state.state, 'failed');
  assert.equal(jobs.calls.at(-1)?.[0], 'cancelAdmission');
  assert.equal(jobs.calls.some(([name, params]) => name === 'transition' && params.state === 'failed'), false);
});
test('surfaces an unconfirmed cancelAdmission failure instead of hiding a fenced lease', async () => {
  const jobs = new Jobs(); const git = new Git();
  git.create = async () => { throw new Error('worktree failed'); };
  jobs.cancelAdmission = async (p) => {
    jobs.calls.push(['cancelAdmission', p]);
    throw new Error('cancel storage failed');
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor: new Supervisor(), owner: 'owner', createId: () => 'abc' });
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), /cancel storage failed/);
  assert.equal(jobs.state.state, 'reserved');
});

test('worker failure finalizes durable state and rejects completion', async () => {
  const jobs = new Jobs(); const git = new Git();
  const workerError = new Error('worker exploded');
  const supervisor: JobSupervisor = { spawnRun: (input) => ({ started: Promise.resolve(), completion: Promise.reject(workerError), abortHandle: input.runId }), abort: async () => 'aborted' };
  const run = await new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' }).start('gjc', 'app-1', '/project', 'hello', options);
  await assert.rejects(run.completion, /worker exploded/);
  assert.equal(jobs.state.state, 'failed');
});
test('a dropped run handle does not raise unhandledRejection when the worker fails', async () => {
  // POST /api/gjc/jobs responds 202 and never consumes `handle.completion`;
  // a later worker failure must finalize durably without crashing the process.
  const jobs = new Jobs(); const git = new Git();
  const supervisor: JobSupervisor = { spawnRun: (input) => ({ started: Promise.resolve(), completion: Promise.reject(new Error('worker exploded')), abortHandle: input.runId }), abort: async () => 'aborted' };
  const unhandled: unknown[] = [];
  const capture = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', capture);
  try {
    await new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' }).start('gjc', 'app-1', '/project', 'hello', options);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
    assert.equal(jobs.state.state, 'failed');
  } finally {
    process.off('unhandledRejection', capture);
  }
});

test('durability failure latches before completion and cannot be reported as success', async () => {
  const jobs = new Jobs(); const git = new Git();
  let complete!: () => void;
  const workerCompletion = new Promise<void>((resolve) => { complete = resolve; });
  const supervisor: JobSupervisor = {
    spawnRun: (input) => {
      input.writer.send({ kind: 'delta' });
      return { started: Promise.resolve(), completion: workerCompletion, abortHandle: input.runId };
    },
    abort: async () => 'aborted',
  };
  jobs.appendEvent = async (p) => { jobs.calls.push(['appendEvent', p]); throw new Error('event disk failed'); };
  const run = await new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' }).start('gjc', 'app-1', '/project', 'hello', options);
  complete();
  await assert.rejects(run.completion, /event disk failed/);
  assert.equal(jobs.state.state, 'failed');
});

test('a never-dispatched start failure atomically records and broadcasts one canonical terminal event', async () => {
  const jobs = new Jobs(); const git = new Git(); const events: unknown[] = [];
  const supervisor: JobSupervisor = { spawnRun: (input) => ({ started: Promise.reject(new Error('start failed')), completion: new Promise<void>(() => {}), outcome: Promise.resolve('not_started'), abortHandle: input.runId }), abort: async () => 'unconfirmed' };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', broadcast: (_jobId, event) => events.push(event) });
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), /start failed/);
  assert.equal(jobs.state.state, 'failed');
  const cancelled = jobs.calls.find(([name]) => name === 'cancelAdmission')?.[1];
  assert.deepEqual(cancelled?.terminalEvent, {
    eventId: 'run-terminal:run-abc',
    payload: { schemaVersion: 1, kind: 'job_terminal', runId: 'run-abc', appSessionId: 'app-1', outcome: 'failed', jobState: 'failed', reason: 'start failed' },
  });
  assert.equal(jobs.calls.some(([name]) => name === 'appendAdminEvent'), false);
  assert.deepEqual(events, [{
    eventId: 'run-terminal:run-abc',
    sequence: 1,
    payload: { schemaVersion: 1, kind: 'job_terminal', runId: 'run-abc', appSessionId: 'app-1', outcome: 'failed', jobState: 'failed', reason: 'start failed' },
  }]);
  assert.deepEqual((await jobs.replayEvents({ jobId: 'job-abc', after: 0 }) as { events: unknown[] }).events, events);
});
test('a lost cancelAdmission reply replays and publishes the committed canonical terminal event', async () => {
  const jobs = new Jobs(); const git = new Git(); const events: unknown[] = [];
  const supervisor: JobSupervisor = { spawnRun: (input) => ({ started: Promise.reject(new Error('start failed')), completion: new Promise<void>(() => {}), outcome: Promise.resolve('not_started'), abortHandle: input.runId }), abort: async () => 'unconfirmed' };
  jobs.cancelAdmission = async (params) => {
    await Jobs.prototype.cancelAdmission.call(jobs, params);
    throw new Error('cancel response lost');
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', broadcast: (_jobId, event) => events.push(event) });

  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), /start failed/);

  assert.equal(jobs.state.state, 'failed');
  assert.deepEqual(jobs.calls.slice(-3).map(([name]) => name), ['cancelAdmission', 'get', 'replayEvents']);
  assert.deepEqual(events, [{
    eventId: 'run-terminal:run-abc',
    sequence: 1,
    payload: { schemaVersion: 1, kind: 'job_terminal', runId: 'run-abc', appSessionId: 'app-1', outcome: 'failed', jobState: 'failed', reason: 'start failed' },
  }]);
  assert.equal((await jobs.replayEvents({ jobId: 'job-abc', after: 0 }) as { events: unknown[] }).events.length, 1);
});
test('forced worker generation termination permits failed finalization after abort refusal', async () => {
  const jobs = new Jobs(); const git = new Git();
  let terminated = false;
  const supervisor: JobSupervisor = {
    spawnRun: (input) => ({ started: Promise.reject(new Error('start failed')), completion: new Promise<void>(() => {}), abortHandle: input.runId }),
    abort: async () => 'unconfirmed',
    terminate: async () => (terminated = true, 'reaped' as const),
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', stopCompletionTimeoutMs });
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), /start failed/);
  assert.equal(terminated, true);
  assert.equal(jobs.state.state, 'failed');
});

test('capacity admission rejects while leaving the durable waiting job for a future dispatcher', async () => {
  const jobs = new Jobs(); jobs.reserve = async (p) => { jobs.calls.push(['reserve', p]); jobs.state = { ...jobs.state, jobId: String(p.jobId), state: 'Waiting' }; return jobs.state; };
  const git = new Git(); const supervisor = new Supervisor(); const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc' });
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), (error: unknown) => error instanceof GjcCapacityExhaustedError && error.jobId === 'job-abc');
  assert.equal(jobs.state.state, 'Waiting'); assert.deepEqual(git.calls, []); assert.equal(supervisor.input, undefined);
});

test('resume derives the repository root from its stored worktree and never creates one', async () => {
  const jobs = new Jobs(); jobs.state = { jobId: 'job-abc', state: 'Interrupted', lease: { owner: 'old', generation: 1 }, worktreeId: '/project/.gjc-worktrees/job-abc', repositoryRoot: '/project', branch: 'job/job-abc' };
  const git = new Git(); const supervisor = new Supervisor(); let requestedRoot: string | undefined;
  const orchestrator = new JobOrchestrator({ jobs, gitForProject: (root) => (requestedRoot = root, git), supervisor, owner: 'owner', createId: () => 'next' });
  await orchestrator.resume('job-abc', 'app-1', 'resume', options);
  assert.equal(requestedRoot, '/project'); assert.deepEqual(git.calls, ['list', 'status']); assert.equal(supervisor.input?.options?.sessionId, 'provider-1'); assert.equal(supervisor.input?.options?.cwd, '/project/.gjc-worktrees/job-abc');
});

test('an abort acknowledgement without terminal completion does not finalize the durable lease', async () => {
  const jobs = new Jobs(); const git = new Git();
  let settle!: () => void; const workerCompletion = new Promise<void>((resolve) => { settle = resolve; });
  const supervisor: JobSupervisor = {
    spawnRun: (input) => ({ started: Promise.resolve(), completion: workerCompletion, abortHandle: input.runId }),
    abort: async () => 'aborted',
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', stopCompletionTimeoutMs });
  const run = await orchestrator.start('gjc', 'app-1', '/project', 'hello', options);
  assert.equal(await orchestrator.abort(run.jobId), false); assert.equal(jobs.state.state, 'aborting'); assert.equal(jobs.calls.at(-1)?.[0], 'transition');
  settle();
  await run.completion;
  assert.equal(jobs.state.state, 'succeeded');
});
test('a completion after an unacknowledged abort finalizes Aborting as succeeded', async () => {
  const jobs = new Jobs(); const git = new Git();
  let settle!: () => void; const workerCompletion = new Promise<void>((resolve) => { settle = resolve; });
  const supervisor: JobSupervisor = {
    spawnRun: (input) => ({ started: Promise.resolve(), completion: workerCompletion, abortHandle: input.runId }),
    abort: async () => 'unconfirmed',
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', stopCompletionTimeoutMs });
  const run = await orchestrator.start('gjc', 'app-1', '/project', 'hello', options);
  assert.equal(await orchestrator.abort(run.jobId), false);
  assert.equal(jobs.state.state, 'aborting');
  settle();
  await run.completion;
  assert.equal(jobs.state.state, 'succeeded');
  assert.equal(jobs.calls.at(-2)?.[0], 'runFinalize');
});
test('resolveBinding reads the durable app-session binding', async () => {
  const jobs = new Jobs();
  jobs.state = { jobId: 'job-abc', state: 'Interrupted', lease: { owner: 'owner', generation: 1 } };
  const orchestrator = new JobOrchestrator({ jobs, git: new Git(), supervisor: new Supervisor() });

  const binding = await orchestrator.resolveBinding('gjc', 'app-1');
  assert.equal(binding?.jobId, 'job-abc');
  assert.equal(binding?.state, 'Interrupted');
  assert.equal(binding?.providerSessionId, 'provider-1');
});
test('a running transition failure compensates before the worker outcome settles', async () => {
  const jobs = new Jobs(); const git = new Git();
  let settleCompletion!: () => void; const workerCompletion = new Promise<void>((resolve) => { settleCompletion = resolve; });
  let settleOutcome!: (outcome: GjcWorkerOutcome) => void; const workerOutcome = new Promise<GjcWorkerOutcome>((resolve) => { settleOutcome = resolve; });
  let aborted = false;
  const supervisor: JobSupervisor = {
    spawnRun: (input) => ({
      started: Promise.resolve(),
      completion: workerCompletion,
      outcome: workerOutcome,
      phase: () => 'request_issued',
      abortHandle: input.runId,
    }),
    abort: async () => (aborted = true, 'aborted'),
    terminate: async () => 'reaped',
  };
  jobs.transition = async () => { throw new Error('running transition failed'); };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', stopCompletionTimeoutMs });
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'hello', options), /running transition failed/);
  assert.equal(aborted, true);
  assert.equal(jobs.state.state, 'failed');
  settleOutcome('reaped');
  settleCompletion();
  await Promise.all([workerOutcome, workerCompletion]);
});
test('two non-settling runs are reaped before an early healthy authority notification admits work', async () => {
  const jobs = new Jobs(); const git = new Git();
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
  const completions: Array<() => void> = [];
  let aborts = 0;
  const supervisor: JobSupervisor = {
    spawnRun: (input) => {
      let settle!: () => void;
      const completion = new Promise<void>((resolve) => { settle = resolve; });
      completions.push(settle);
      return { started: Promise.resolve(), completion, abortHandle: input.runId };
    },
    abort: async () => { aborts += 1; await abortGate; return 'aborted'; },
    terminate: async () => 'reaped',
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', stopCompletionTimeoutMs });
  const firstRun = await orchestrator.start('gjc', 'app-1', '/project', 'hello', options);
  const secondRun = await orchestrator.start('gjc', 'app-2', '/project', 'hello', { ...options, jobId: 'job-second' });
  const down = orchestrator.authorityHealth(false);
  const up = orchestrator.authorityHealth(true);
  releaseAbort();
  await Promise.all([down, up]);
  assert.equal(aborts, 2);
  assert.equal(jobs.calls.filter(([name]) => name === 'reconcile').length, 1);
  const thirdRun = await orchestrator.start('gjc', 'app-3', '/project', 'hello', { ...options, jobId: 'job-third' });
  completions.forEach((settle) => settle());
  await Promise.all([firstRun.completion, secondRun.completion, thirdRun.completion]);
  assert.equal(jobs.state.state, 'succeeded');
});
test('broadcast receives the committed event identity and sequence', async () => {
  const jobs = new Jobs(); const git = new Git(); const events: Array<{ eventId: string; sequence: number; payload: unknown }> = [];
  let complete!: () => void; const completion = new Promise<void>((resolve) => { complete = resolve; });
  const supervisor: JobSupervisor = { spawnRun: (input) => { input.writer.send({ kind: 'delta' }); return { started: Promise.resolve(), completion, abortHandle: input.runId }; }, abort: async () => 'aborted' };
  const run = await new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', broadcast: (_jobId, event) => events.push(event) }).start('gjc', 'app-1', '/project', 'hello', options);
  await new Promise<void>((resolve) => setImmediate(resolve)); complete(); await run.completion;
  assert.equal(events.length, 2);
  assert.equal(events[0]?.sequence, 1);
  assert.equal(events[1]?.eventId, 'run-terminal:run-abc');
  assert.deepEqual(events[1]?.payload, { schemaVersion: 1, kind: 'job_terminal', runId: 'run-abc', appSessionId: 'app-1', outcome: 'succeeded', jobState: 'succeeded', reason: 'completed' });
});
test('a throwing broadcast cannot undo a committed event or terminal state', async () => {
  const jobs = new Jobs(); const git = new Git(); let complete!: () => void; const completion = new Promise<void>((resolve) => { complete = resolve; });
  const supervisor: JobSupervisor = { spawnRun: (input) => ({ started: Promise.resolve(), completion, abortHandle: input.runId }), abort: async () => 'aborted' };
  const run = await new JobOrchestrator({ jobs, git, supervisor, owner: 'owner', createId: () => 'abc', broadcast: () => { throw new Error('subscriber failed'); } }).start('gjc', 'app-1', '/project', 'hello', options);
  complete(); await run.completion;
  assert.equal(jobs.state.state, 'succeeded');
  assert.equal(jobs.events.at(-1)?.eventId, 'run-terminal:run-abc');
});
test('admin events broadcast only after a committed authority event is returned', async () => {
  const jobs = new Jobs(); jobs.state = { ...jobs.state, state: 'ready' }; const events: Array<{ eventId: string; sequence: number }> = [];
  const orchestrator = new JobOrchestrator({ jobs, git: new Git(), supervisor: new Supervisor(), broadcast: (_jobId, event) => events.push(event) });
  await orchestrator.appendAdminEvent('job-admin', 'publish.started', { branch: 'job-admin' });
  assert.deepEqual(events.map(({ eventId, sequence }) => ({ eventId, sequence })), [{ eventId: 'publish.started', sequence: 1 }]);
});

function desktopDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { resolve, promise };
}
const desktopTick = () => new Promise<void>((resolve) => setImmediate(resolve));
function desktopFixture() {
  const jobs = new Jobs(); const git = new Git(); const supervisor = new Supervisor();
  const completed = desktopDeferred<void>();
  supervisor.spawnRun = (input) => {
    supervisor.input = input;
    return { started: Promise.resolve(), completion: completed.promise, abortHandle: input.runId };
  };
  const orchestrator = new JobOrchestrator({ jobs, git, supervisor, owner: 'desktop-test', createId: () => 'abc' });
  const reader = createGjcJobOrchestratorDesktopRestartReader(orchestrator);
  const authority = new DesktopRestartAuthority({ requiredOwners: ['orchestrator'], ownerReaders: { orchestrator: reader } });
  orchestrator.configureDesktopAdmission(authority);
  return { jobs, git, supervisor, completed, orchestrator, reader, authority };
}

test('desktop reader is pure and its revision advances through an idle/busy/idle cycle', async () => {
  const f = desktopFixture();
  const before = f.reader.read();
  assert.deepEqual(f.reader.read(), before);
  assert.equal(f.reader.getGeneration(), before.generation);
  assert.equal(before.owner, 'orchestrator');
  assert.deepEqual(f.jobs.calls, []);
  assert.deepEqual(f.git.calls, []);
  const write = desktopDeferred<void>();
  f.jobs.state.state = 'ready';
  f.jobs.appendAdminEvent = async (params) => { await write.promise; return Jobs.prototype.appendAdminEvent.call(f.jobs, params); };
  const pending = f.orchestrator.appendAdminEvent('job-abc', 'admin', {});
  const busy = f.reader.read();
  assert.ok(busy.queued > 0 && busy.settling > 0);
  assert.equal(f.reader.getGeneration(), busy.generation);
  write.resolve();
  await pending;
  await desktopTick();
  const after = f.reader.read();
  assert.deepEqual({ ...after, generation: before.generation }, before);
  assert.ok(BigInt(after.generation.split(':').at(-1)!) > BigInt(busy.generation.split(':').at(-1)!));
  assert.ok(BigInt(busy.generation.split(':').at(-1)!) > BigInt(before.generation.split(':').at(-1)!));
});

test('desktop admission fences every public job root before any authority or Git await', async () => {
  const f = desktopFixture();
  const prepared = await f.authority.prepare({ attemptId: 'job-fence', epoch: 'desktop-1' });
  assert.equal(prepared.ok, true);
  for (const action of [
    () => f.orchestrator.start('gjc', 'app-1', '/project', 'start', options),
    () => f.orchestrator.turnStart('gjc', 'app-1', 'turn', options),
    () => f.orchestrator.resume('job-abc', 'app-1', 'resume', options),
    () => f.orchestrator.resolveBinding('gjc', 'app-1'),
    () => f.orchestrator.reconcile(),
    () => f.orchestrator.appendAdminEvent('job-abc', 'event', {}),
  ]) await assert.rejects(action(), { code: 'DESKTOP_RESTART_FENCED' });
  assert.deepEqual(f.jobs.calls, []);
  assert.deepEqual(f.git.calls, []);
  assert.equal(f.supervisor.input, undefined);
  if (prepared.ok) f.authority.cancel(prepared.token);
});

test('paused turn binding lookup owns ingress before there is a queue and transfers without an idle gap', async () => {
  const f = desktopFixture();
  f.jobs.state = { ...f.jobs.state, jobId: 'job-abc', state: 'ready', worktreeId: '/project/.gjc-worktrees/job-abc', repositoryRoot: '/project', branch: 'job/job-abc' };
  const lookup = desktopDeferred<unknown>();
  f.jobs.bindingResolve = () => lookup.promise as ReturnType<Jobs['bindingResolve']>;
  const pending = f.orchestrator.turnStart('gjc', 'app-1', 'continue', options);
  assert.equal(f.reader.read().starting, 1);
  assert.equal(f.reader.read().queued, 0);
  assert.equal((await f.authority.snapshot()).ingress, 1);
  assert.equal((await f.authority.prepare({ attemptId: 'binding-race', epoch: 'desktop-1' })).ok, false);
  assert.equal(f.supervisor.aborted, undefined);
  lookup.resolve({ jobId: 'job-abc', state: 'ready', providerSessionId: 'provider-1' });
  const handle = await pending;
  assert.equal((await f.authority.snapshot()).idle, false);
  assert.equal(f.reader.read().running, 1);
  f.completed.resolve();
  await handle.completion;
  await desktopTick();
  assert.equal((await f.authority.snapshot()).idle, true);
});

test('owned continuation capability is checked at entry and is not inherited by new callback roots', async () => {
  const f = desktopFixture();
  const prepared = await f.authority.prepare({ attemptId: 'continuation-scope', epoch: 'desktop-1' });
  assert.equal(prepared.ok, true);
  assert.throws(() => withOwnedJobDesktopContinuation(() => false, () => assert.fail('expired owner dispatched')), /live owner/);
  let callbackChecked = false;
  const handle = await withOwnedJobDesktopContinuation(() => true, () => f.orchestrator.start('gjc', 'app-1', '/project', 'owned turn', {
    ...options,
    onPrepared: async () => {
      await assert.rejects(f.orchestrator.start('gjc', 'other-app', '/project', 'new callback root', options), { code: 'DESKTOP_RESTART_FENCED' });
      callbackChecked = true;
    },
  }));
  assert.equal(callbackChecked, true);
  f.completed.resolve();
  await handle.completion;
  await desktopTick();
  if (prepared.ok) assert.equal((await f.authority.commit(prepared.token, 'desktop-1')).ok, false);
});

test('paused worktree creation and resume validation retain root ingress until dispatch', async () => {
  for (const mode of ['start', 'resume'] as const) {
    const f = desktopFixture();
    const gate = desktopDeferred<void>();
    const reached = desktopDeferred<void>();
    if (mode === 'start') {
      f.git.create = async () => { reached.resolve(); await gate.promise; return Git.prototype.create.call(f.git); };
    } else {
      f.jobs.state = { ...f.jobs.state, jobId: 'job-abc', state: 'interrupted', worktreeId: '/project/.gjc-worktrees/job-abc', repositoryRoot: '/project', branch: 'job/job-abc' };
      f.git.status = async () => { reached.resolve(); await gate.promise; return Git.prototype.status.call(f.git); };
    }
    const pending = mode === 'start'
      ? f.orchestrator.start('gjc', 'app-1', '/project', 'start', options)
      : f.orchestrator.resume('job-abc', 'app-1', 'resume', options);
    await reached.promise;
    assert.ok(f.reader.read().starting > 0 && f.reader.read().queued > 0);
    assert.equal((await f.authority.snapshot()).ingress, 1);
    assert.equal((await f.authority.prepare({ attemptId: `paused-${mode}`, epoch: 'desktop-1' })).ok, false);
    assert.equal(f.supervisor.aborted, undefined);
    gate.resolve();
    const handle = await pending;
    f.completed.resolve();
    await handle.completion;
    await desktopTick();
    assert.equal((await f.authority.snapshot()).idle, true);
  }
});

test('UI completion, worker completion, and registry clearing do not hide pending event persistence or finalization', async () => {
  const f = desktopFixture();
  const write = desktopDeferred<void>(); const writing = desktopDeferred<void>();
  const finalize = desktopDeferred<void>(); const finalizing = desktopDeferred<void>();
  f.jobs.appendEvent = async (params) => { writing.resolve(); await write.promise; return Jobs.prototype.appendEvent.call(f.jobs, params); };
  f.jobs.runFinalize = async (params) => { finalizing.resolve(); await finalize.promise; return Jobs.prototype.runFinalize.call(f.jobs, params); };
  const handle = await f.orchestrator.start('gjc', 'app-1', '/project', 'run', options);
  f.supervisor.input!.writer.send({ kind: 'complete', exitCode: 0 });
  await writing.promise;
  f.completed.resolve();
  await f.orchestrator.interruptForShutdown();
  assert.equal(f.reader.read().running, 0);
  assert.ok(f.reader.read().settling > 0 && f.reader.read().queued > 0);
  assert.equal((await f.authority.snapshot()).idle, false);
  write.resolve();
  await finalizing.promise;
  assert.ok(f.reader.read().settling > 0);
  assert.equal((await f.authority.prepare({ attemptId: 'finalize-race', epoch: 'desktop-1' })).ok, false);
  assert.equal(f.supervisor.aborted, undefined);
  finalize.resolve();
  await handle.completion;
  await desktopTick();
  assert.equal(f.reader.read().settling, 0);
  assert.ok(f.reader.read().unknown.includes('orchestrator_closed'));
});

test('registry clearing does not release the actual worker and completion promise lifetime', async () => {
  const f = desktopFixture();
  const handle = await f.orchestrator.start('gjc', 'app-1', '/project', 'run', options);
  await f.orchestrator.interruptForShutdown();
  assert.equal(f.reader.read().running, 0);
  assert.ok(f.reader.read().settling > 0);
  assert.equal((await f.authority.prepare({ attemptId: 'cleared-map', epoch: 'desktop-1' })).ok, false);
  f.completed.resolve();
  await handle.completion;
  await desktopTick();
  assert.equal(f.reader.read().settling, 0);
  assert.ok(f.reader.read().unknown.includes('orchestrator_closed'));
});

test('late unowned writer callbacks cannot persist through a prepared restart fence', async () => {
  const f = desktopFixture();
  const handle = await f.orchestrator.start('gjc', 'app-1', '/project', 'run', options);
  f.completed.resolve();
  await handle.completion;
  await desktopTick();
  const prepared = await f.authority.prepare({ attemptId: 'late-writer', epoch: 'desktop-1' });
  assert.equal(prepared.ok, true);
  const calls = f.jobs.calls.length;
  f.supervisor.input!.writer.send({ kind: 'delta', text: 'late' });
  await desktopTick();
  assert.equal(f.jobs.calls.length, calls);
  if (prepared.ok) f.authority.cancel(prepared.token);
});

test('unconfirmed termination stays unknown even after an abort completion acknowledgement', async () => {
  const f = desktopFixture();
  f.supervisor.spawnRun = (input) => ({ started: Promise.resolve(), completion: f.completed.promise, outcome: Promise.resolve('unconfirmed'), abortHandle: input.runId });
  const handle = await f.orchestrator.start('gjc', 'app-1', '/project', 'run', options);
  f.completed.resolve();
  await assert.rejects(handle.completion, /unconfirmed/);
  assert.equal(await f.orchestrator.abort(handle.jobId), false);
  const activity = f.reader.read();
  assert.equal(activity.running, 1);
  assert.equal(activity.complete, false);
  assert.ok(activity.unknown.includes('orchestrator_settlement_unconfirmed'));
});

test('initialization and health recovery remain owned and update cancellation cannot reset health', async () => {
  const initializing = desktopDeferred<void>();
  const jobs = new Jobs();
  const orchestrator = new JobOrchestrator({ jobs, git: new Git(), supervisor: new Supervisor(), initialize: () => initializing.promise });
  const reader = createGjcJobOrchestratorDesktopRestartReader(orchestrator);
  assert.equal(reader.read().starting, 1);
  initializing.resolve();
  await desktopTick();
  assert.equal(reader.read().starting, 0);
  const authority = new DesktopRestartAuthority({ requiredOwners: ['orchestrator'], ownerReaders: { orchestrator: reader } });
  orchestrator.configureDesktopAdmission(authority);
  await orchestrator.authorityHealth(false);
  const before = reader.read();
  assert.equal(before.complete, false);
  assert.equal((await authority.prepare({ attemptId: 'unhealthy', epoch: 'desktop-1' })).ok, false);
  await assert.rejects(orchestrator.start('gjc', 'app-1', '/project', 'run', options), { code: 'authority_unavailable' });
  const recovery = desktopDeferred<void>();
  jobs.reconcile = async (params) => { await recovery.promise; return Jobs.prototype.reconcile.call(jobs, params); };
  const healthy = orchestrator.authorityHealth(true);
  assert.ok(reader.read().settling > 0);
  recovery.resolve();
  await healthy;
  await desktopTick();
  assert.equal((await authority.snapshot()).idle, true);
  orchestrator.markClosed();
  assert.ok(reader.read().unknown.includes('orchestrator_closed'));
});
