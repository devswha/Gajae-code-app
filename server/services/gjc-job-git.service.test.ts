import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { execFile as execFileCallback } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

import { configureInternalDesktopAdmission, enterInternalActivity, getInternalActivityGeneration, snapshotInternalActivity, withInternalActivity } from '../shared/desktop-internal-activity.js';

import { DesktopRestartAuthority } from './desktop-restart-authority.js';
import { GjcJobGitService } from './gjc-job-git.service.js';

const execFile = promisify(execFileCallback);
let desktopAuthority: DesktopRestartAuthority | undefined;
const sources: string[] = [];
configureInternalDesktopAdmission({
  enter(source) { sources.push(source); return desktopAuthority?.enter(source) ?? (() => {}); },
  enterCompletion(source) { sources.push(source); return desktopAuthority?.enterCompletion(source) ?? (() => {}); },
});

test('job git status resolves only the stored managed worktree', async () => {
  const calls: Record<string, unknown>[] = [];
  const service = new GjcJobGitService(
    { get: async () => ({ jobId: 'job-a', repositoryRoot: '/repo', worktreeId: '/repo/.gjc-worktrees/job-a', branch: 'job/job-a', baseCommit: 'abc1234' }), appendAdminEvent: async () => ({}) },
    () => ({
      list: async () => ({ items: [{ worktreeId: '/repo/.gjc-worktrees/job-a', path: '/repo/.gjc-worktrees/job-a', branch: 'job/job-a' }] }),
      status: async params => { calls.push(params); return { clean: true, count: 0 }; },
      diff: async () => ({ patch: Buffer.alloc(0) }),
    }),
  );

  assert.deepEqual(await service.status('job-a'), { clean: true, count: 0 });
  assert.deepEqual(calls, [
    { jobId: 'job-a', branch: 'job/job-a', path: '/repo/.gjc-worktrees/job-a' },
    { jobId: 'job-a', branch: 'job/job-a', path: '/repo/.gjc-worktrees/job-a' },
  ]);
});

test('job git resolution rejects a worktree moved off its stored branch', async () => {
  const service = new GjcJobGitService(
    { get: async () => ({ jobId: 'job-a', repositoryRoot: '/repo', worktreeId: '/repo/.gjc-worktrees/job-a', branch: 'job/job-a', baseCommit: 'abc1234' }), appendAdminEvent: async () => ({}) },
    () => ({ list: async () => ({ items: [{ worktreeId: '/repo/.gjc-worktrees/job-a', path: '/repo/.gjc-worktrees/job-a', branch: 'other' }] }), status: async () => ({ clean: true, count: 0 }), diff: async () => ({}) }),
  );

  await assert.rejects(service.status('job-a'), /no longer on the job branch/);
});
test('job git diff uses the bounded native base diff including untracked files', async () => {
  const calls: Record<string, unknown>[] = [];
  const service = new GjcJobGitService(
    { get: async () => ({ jobId: 'job-a', repositoryRoot: '/repo', worktreeId: 'worktree-a', branch: 'job/job-a', baseCommit: 'abc1234' }), appendAdminEvent: async () => ({}) },
    () => ({
      list: async () => ({ items: [{ worktreeId: 'worktree-a', path: '/repo/.gjc-worktrees/job-a', branch: 'job/job-a' }] }),
      status: async () => ({ clean: false }),
      diff: async params => { calls.push(params); return { patch: Buffer.from('diff') }; },
    }),
  );

  assert.deepEqual(await service.diff('job-a'), { text: 'diff', paths: [] });
  assert.deepEqual(calls, [{ jobId: 'job-a', branch: 'job/job-a', path: '/repo/.gjc-worktrees/job-a', mode: 'base', baseCommit: 'abc1234', includeUntracked: true }]);
});

test('job git commit resolves its managed worktree, commits changed relative paths, and records an admin event', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gjc-job-commit-'));
  const events: Record<string, unknown>[] = [];
  const commands = async (...args: string[]) => execFile('git', args, { cwd: directory });
  try {
    await commands('init');
    await commands('config', 'user.email', 'test@example.com');
    await commands('config', 'user.name', 'GJC test');
    await writeFile(path.join(directory, 'changed.txt'), 'changed\n');
    await writeFile(path.join(directory, 'unrelated.txt'), 'unrelated\n');
    await commands('add', 'unrelated.txt');
    const service = new GjcJobGitService(
      {
        get: async () => ({ jobId: 'job-a', repositoryRoot: '/repository-root', worktreeId: 'worktree-a', branch: 'job/job-a', baseCommit: 'base' }),
        appendAdminEvent: async params => { events.push(params); return {}; },
      },
      () => ({
        list: async () => ({ items: [{ worktreeId: 'worktree-a', path: directory, branch: 'job/job-a' }] }),
        status: async () => ({ clean: false }),
        diff: async () => ({}),
      }),
    );

    const result = await service.commit('job-a', '  Commit changed file  ', ['changed.txt']);
    assert.match(result.commit, /^[0-9a-f]{40}$/u);
    assert.match(result.eventId, /^commit\./u);
    assert.deepEqual((await commands('show', '--format=%s', '--no-patch')).stdout.trim(), 'Commit changed file');
    assert.deepEqual((await commands('show', '--format=', '--name-only', 'HEAD')).stdout.trim(), 'changed.txt');
    assert.deepEqual((await commands('diff', '--cached', '--name-only')).stdout.trim(), 'unrelated.txt');
    assert.deepEqual(events, [{ jobId: 'job-a', eventId: result.eventId, payload: { kind: 'git_commit', commit: result.commit, paths: ['changed.txt'] } }]);

    for (const [message, paths] of [
      ['', ['changed.txt']],
      ['message', ['/absolute.txt']],
      ['message', ['../traversal.txt']],
      ['message', ['unchanged.txt']],
      ['message', Array.from({ length: 101 }, (_, index) => `file-${index}`)],
    ] as const) await assert.rejects(service.commit('job-a', message, paths), { code: 'invalid_request' });
    await assert.rejects(service.commit('job-a', 'a'.repeat(4097), ['changed.txt']), { code: 'invalid_request' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('job git summaries isolate failures, parse patches, and cache by lifecycle state', async () => {
  const snapshots = new Map<string, Record<string, unknown>>([
    ['active', { jobId: 'active', state: 'running', lastSequence: 1, repositoryRoot: '/repo', worktreeId: 'active', branch: 'job/active', baseCommit: 'base' }],
    ['terminal', { jobId: 'terminal', state: 'ready', lastSequence: 1, repositoryRoot: '/repo', worktreeId: 'terminal', branch: 'job/terminal', baseCommit: 'base' }],
    ['broken', { jobId: 'broken', state: 'ready', lastSequence: 1, repositoryRoot: '/repo', worktreeId: 'broken', branch: 'job/broken', baseCommit: 'base' }],
  ]);
  const calls = { get: 0, list: 0, status: 0, diff: 0 };
  const service = new GjcJobGitService(
    {
      get: async ({ jobId }) => { calls.get++; return snapshots.get(String(jobId)); },
      appendAdminEvent: async () => ({}),
    },
    () => ({
      list: async () => { calls.list++; return { items: ['active', 'terminal', 'broken'].map(worktreeId => ({ worktreeId, path: `/worktrees/${worktreeId}`, branch: `job/${worktreeId}` })) }; },
      status: async () => { calls.status++; return {}; },
      diff: async ({ jobId }) => {
        calls.diff++;
        if (jobId === 'broken') throw new Error('diff unavailable');
        return { patch: [
          'diff --git a/a.txt b/a.txt',
          '--- a/a.txt',
          '+++ b/a.txt',
          '+added',
          '-removed',
          'diff --git a/b.txt b/b.txt',
          '+second addition',
          '\\ No newline at end of file',
        ].join('\n') };
      },
    }),
  );

  assert.deepEqual(await service.summaries(['active', 'broken']), {
    active: { status: 'available', files: 2, additions: 2, deletions: 1, stale: true },
    broken: { status: 'unavailable' },
  });
  assert.equal(calls.diff, 2);
  assert.deepEqual(await service.summaries(['active']), { active: { status: 'available', files: 2, additions: 2, deletions: 1, stale: true } });
  assert.equal(calls.diff, 2);

  assert.deepEqual(await service.summaries(['terminal']), { terminal: { status: 'available', files: 2, additions: 2, deletions: 1, stale: false } });
  assert.equal(calls.diff, 3);
  assert.deepEqual(await service.summaries(['terminal']), { terminal: { status: 'available', files: 2, additions: 2, deletions: 1, stale: false } });
  assert.equal(calls.diff, 3);
  snapshots.set('active', { ...snapshots.get('active')!, state: 'ready', lastSequence: 2 });
  assert.deepEqual(await service.summaries(['active']), { active: { status: 'available', files: 2, additions: 2, deletions: 1, stale: false } });
  assert.equal(calls.diff, 4);
  assert.deepEqual(await service.summaries(['active'], { forceRefresh: true }), { active: { status: 'available', files: 2, additions: 2, deletions: 1, stale: false } });
  assert.equal(calls.diff, 5);
  assert.equal(calls.get, 7);
  assert.equal(calls.list, 5);
  assert.equal(calls.status, 5);
});

test('job git summaries allow 50 unique job IDs and reject larger batches', async () => {
  const service = new GjcJobGitService(
    { get: async ({ jobId }) => ({ jobId, state: 'ready', lastSequence: 1, repositoryRoot: '/repo', worktreeId: jobId, branch: `job/${jobId}`, baseCommit: 'base' }), appendAdminEvent: async () => ({}) },
    () => ({ list: async () => ({ items: [] }), status: async () => ({}), diff: async () => ({}) }),
  );
  assert.equal(Object.keys(await service.summaries(Array.from({ length: 50 }, (_, index) => `job-${index}`))).length, 50);
  await assert.rejects(service.summaries(Array.from({ length: 51 }, (_, index) => `job-${index}`)), { code: 'invalid_request' });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
class GitProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills = 0;
  kill() { this.kills++; return true; }
}
function mockGit(t: test.TestContext, respond?: (child: GitProcess, args: string[]) => void) {
  const children: GitProcess[] = [];
  const commands: string[][] = [];
  const spawned = deferred<void>();
  const mocked = t.mock.method(childProcess, 'spawn', (command: string, args: string[]) => {
    assert.equal(command, 'git');
    const child = new GitProcess();
    children.push(child); commands.push(args); spawned.resolve();
    if (respond) queueMicrotask(() => respond(child, args));
    return child as never;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return { children, commands, spawned: spawned.promise };
}
function activityFixture(t: test.TestContext) {
  sources.length = 0;
  const authority = new DesktopRestartAuthority({ requiredOwners: ['internal-producers'], ownerReaders: {
    'internal-producers': { getGeneration: getInternalActivityGeneration, read: snapshotInternalActivity },
  } });
  desktopAuthority = authority;
  t.after(() => { desktopAuthority = undefined; });
  return authority;
}
const storedJob = { jobId: 'job-a', repositoryRoot: '/fixture/repo', worktreeId: 'worktree-a', branch: 'job/job-a', baseCommit: 'base' };
function serviceFixture(overrides: Partial<ConstructorParameters<typeof GjcJobGitService>[0]> = {}) {
  const events: Record<string, unknown>[] = [];
  let reads = 0;
  const service = new GjcJobGitService({
    get: async () => { reads++; return storedJob; },
    appendAdminEvent: async (event) => { events.push(event); return {}; },
    ...overrides,
  }, () => ({
    list: async () => ({ items: [{ worktreeId: 'worktree-a', path: '/fixture/worktree', branch: 'job/job-a' }] }),
    status: async () => ({ clean: false }), diff: async () => ({ patch: '' }),
  }));
  return { service, events, reads: () => reads };
}

test('internal activity is pure, monotonic, source-labelled and retained across callback settlement', async (t) => {
  const authority = activityFixture(t);
  const before = snapshotInternalActivity();
  assert.equal(before.owner, 'internal-producers');
  assert.deepEqual(snapshotInternalActivity(), before);
  assert.equal(getInternalActivityGeneration(), before.generation);
  const finish = deferred<void>();
  const pending = withInternalActivity('git-service:test', () => {
    assert.equal(snapshotInternalActivity().running, 1);
    return finish.promise;
  });
  const busy = snapshotInternalActivity();
  assert.deepEqual(sources, ['git-service:test']);
  assert.equal((await authority.prepare({ attemptId: 'internal-test', epoch: 'epoch-1' })).ok, false);
  finish.resolve();
  await pending;
  const after = snapshotInternalActivity();
  assert.deepEqual({ ...after, generation: before.generation }, before);
  assert.ok(BigInt(after.generation.split(':').at(-1)!) > BigInt(busy.generation.split(':').at(-1)!));
  const release = enterInternalActivity('git-service:idempotent');
  release(); const generation = getInternalActivityGeneration(); release();
  assert.equal(getInternalActivityGeneration(), generation);
  await assert.rejects(withInternalActivity('git-service:failure', () => { throw new Error('sync failed'); }), /sync failed/);
  assert.equal((await authority.snapshot()).idle, true);
});

test('all public Git roots are fenced before authority reads, lifecycle writes, or subprocesses', async (t) => {
  const authority = activityFixture(t); const f = serviceFixture(); const git = mockGit(t);
  const prepared = await authority.prepare({ attemptId: 'git-roots', epoch: 'epoch-1' });
  assert.equal(prepared.ok, true);
  for (const action of [
    () => f.service.resolve('job-a'), () => f.service.status('job-a'), () => f.service.diff('job-a'),
    () => f.service.summaries(['job-a']), () => f.service.publish('job-a'), () => f.service.hasCommits('job-a'),
    () => f.service.commit('job-a', 'commit', ['changed.txt']),
    () => f.service.createPullRequest('job-a', async () => assert.fail('PR callback must not run')), () => f.service.prContext('job-a'),
  ]) await assert.rejects(action(), { code: 'DESKTOP_RESTART_FENCED' });
  assert.equal(f.reads(), 0); assert.deepEqual(f.events, []); assert.deepEqual(git.commands, []);
  if (prepared.ok) assert.equal((await authority.commit(prepared.token, 'epoch-1')).ok, true);
});

test('a Git root counts binding preparation before its first await', async (t) => {
  const authority = activityFixture(t); const binding = deferred<typeof storedJob>();
  const f = serviceFixture({ get: () => binding.promise });
  const status = f.service.status('job-a');
  assert.equal(snapshotInternalActivity().running, 1);
  assert.equal((await authority.snapshot()).ingress, 1);
  assert.equal((await authority.prepare({ attemptId: 'git-binding', epoch: 'epoch-1' })).ok, false);
  binding.resolve(storedJob); await status;
  assert.deepEqual(sources, ['git-service:status']);
  assert.equal((await authority.snapshot()).idle, true);
});

test('a mocked publish error waits for child close and failed-event persistence without an updater kill', async (t) => {
  const authority = activityFixture(t); const git = mockGit(t);
  const persistence = deferred<void>(); const persisting = deferred<void>();
  const events: string[] = [];
  const f = serviceFixture({ appendAdminEvent: async ({ eventId }) => {
    events.push(String(eventId));
    if (String(eventId).endsWith('.failed')) { persisting.resolve(); await persistence.promise; }
    return {};
  } });
  const pending = f.service.publish('job-a');
  const rejected = assert.rejects(pending, /child error before close/);
  await git.spawned;
  assert.equal(git.commands[0][0], 'push'); // Intercepted above; no real push is executed.
  const child = git.children[0];
  let settled = false; void pending.catch(() => {}).then(() => { settled = true; });
  child.emit('error', new Error('child error before close'));
  child.emit('exit', 1);
  await tick();
  assert.equal(settled, false); assert.equal(events.length, 1);
  assert.equal((await authority.prepare({ attemptId: 'git-close', epoch: 'epoch-1' })).ok, false);
  assert.equal(child.kills, 0);
  child.emit('close', 0);
  await persisting.promise;
  assert.equal(settled, false); assert.equal(snapshotInternalActivity().running, 1);
  persistence.resolve(); await rejected; await tick();
  assert.equal((await authority.snapshot()).idle, true);
  assert.equal(child.kills, 0);
});

test('commit private continuations retain one root through every mocked child and its admin event', async (t) => {
  const authority = activityFixture(t);
  const git = mockGit(t, (child, args) => {
    if (args[0] === 'status') child.stdout.write(' M changed.txt\n');
    if (args[0] === 'rev-parse') child.stdout.write('fixture-commit\n');
    child.emit('close', 0);
  });
  const persisting = deferred<void>(); const persisted = deferred<void>();
  const f = serviceFixture({ appendAdminEvent: async () => { persisting.resolve(); await persisted.promise; return {}; } });
  const pending = f.service.commit('job-a', 'message', ['changed.txt']);
  await persisting.promise;
  assert.deepEqual(git.commands.map((args) => args[0]), ['status', 'add', 'commit', 'rev-parse']);
  assert.deepEqual(sources, ['git-service:commit']);
  assert.equal(snapshotInternalActivity().running, 1);
  assert.equal((await authority.prepare({ attemptId: 'git-persistence', epoch: 'epoch-1' })).ok, false);
  persisted.resolve();
  assert.equal((await pending).commit, 'fixture-commit');
  assert.equal((await authority.snapshot()).idle, true);
});

test('a PR facade promise and its final admin event stay inside the accepted Git root', async (t) => {
  const authority = activityFixture(t);
  const git = mockGit(t, (child, args) => {
    child.stdout.write(args[0] === 'rev-list' ? 'commit\n' : args[0] === 'symbolic-ref' ? 'refs/remotes/origin/main\n' : 'https://example.invalid/repo.git\n');
    child.emit('close', 0);
  });
  const created = deferred<string>(); const creating = deferred<void>();
  const recorded = deferred<void>(); const recording = deferred<void>();
  const f = serviceFixture({ appendAdminEvent: async ({ eventId }) => {
    if (String(eventId).endsWith('.completed')) { recording.resolve(); await recorded.promise; }
    return {};
  } });
  const pending = f.service.createPullRequest('job-a', async (context) => {
    assert.deepEqual(context, { branch: 'job/job-a', baseBranch: 'main', remoteUrl: 'https://example.invalid/repo.git' });
    creating.resolve(); return created.promise;
  });
  await creating.promise;
  assert.equal(snapshotInternalActivity().running, 1);
  assert.equal((await authority.prepare({ attemptId: 'pr-facade', epoch: 'epoch-1' })).ok, false);
  assert.deepEqual(git.commands.map((args) => args[0]), ['rev-list', 'symbolic-ref', 'remote']);
  created.resolve('fixture-pr'); await recording.promise;
  assert.equal(snapshotInternalActivity().running, 1);
  recorded.resolve(); assert.equal(await pending, 'fixture-pr');
  assert.deepEqual(sources, ['git-service:pull-request']);
  assert.equal((await authority.snapshot()).idle, true);
});
