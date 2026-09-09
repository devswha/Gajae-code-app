import { strict as assert } from 'node:assert';
import { EventEmitter as CloneProcessEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename as directoryName, dirname, join } from 'node:path';
import { PassThrough as CloneOutputStream } from 'node:stream';
import { test } from 'node:test';

import { createCloneWorkspace, startCloneProject as beginProjectClone } from '@/modules/projects/services/project-clone.service.js';
import { AppError as ProjectCloneError } from '@/shared/utils.js';
import { configureInternalDesktopAdmission, getInternalActivityGeneration, snapshotInternalActivity } from '@/shared/desktop-internal-activity.js';

type CloneDependencies = NonNullable<Parameters<typeof beginProjectClone>[2]>;
let fenced = false;
let ingress = 0;
const sources: string[] = [];
const acquire = () => {
  ingress++;
  let released = false;
  return () => { assert.equal(released, false); released = true; ingress--; };
};
configureInternalDesktopAdmission({
  enter(source) {
    sources.push(source);
    if (fenced) throw Object.assign(new Error('Desktop restart fenced.'), { code: 'DESKTOP_RESTART_FENCED' });
    return acquire();
  },
  enterCompletion(source) { sources.push(source); return acquire(); },
});

function cloneInput(overrides: Partial<Parameters<typeof beginProjectClone>[0]> = {}) {
  return {
    workspacePath: '/workspaces/gajae/imports',
    githubUrl: 'https://github.com/gajae-app/example-project',
    userId: 42,
    ...overrides,
  };
}

function cloneDependencies(overrides: Partial<CloneDependencies> = {}): CloneDependencies {
  return {
    validatePath: async () => ({ valid: true, resolvedPath: '/workspaces/gajae/imports' }),
    ensureDirectory: async () => undefined,
    pathExists: async () => false,
    createCloneWorkspace: async (destination) => ({ path: `${destination}.partial`, publish: async () => undefined, cleanup: async () => undefined }),
    getGithubTokenById: async () => ({ github_token: 'gajae-token' }),
    spawnGitClone: () => {
      throw new Error('This scenario must provide a clone process');
    },
    registerProject: async () => ({ project: { projectId: 'gajae-imported-project' } }),
    logError: () => undefined,
    ...overrides,
  };
}

function createCloneProcess() {
  const process = new CloneProcessEmitter() as CloneProcessEmitter & {
    stdout: CloneOutputStream;
    stderr: CloneOutputStream;
    kill: () => void;
  };
  process.stdout = new CloneOutputStream();
  process.stderr = new CloneOutputStream();
  process.kill = () => process.emit('close', null);
  return process;
}

function createCloneEvents() {
  const progressMessages: string[] = [];
  let completion: { project: Record<string, unknown>; message: string } | undefined;
  return {
    handlers: {
      onProgress: (message: string) => progressMessages.push(message),
      onComplete: (payload: { project: Record<string, unknown>; message: string }) => {
        completion = payload;
      },
    },
    progressMessages,
    getCompletion: () => completion,
  };
}

async function assertCloneRejection(
  input: Partial<Parameters<typeof beginProjectClone>[0]>,
  code: string,
): Promise<void> {
  const events = createCloneEvents();
  await assert.rejects(
    () => beginProjectClone(cloneInput(input), events.handlers, cloneDependencies()),
    (error: unknown) => error instanceof ProjectCloneError && error.code === code,
  );
}

test('clone requests require a workspace and a repository URL that cannot be interpreted as git flags', async () => {
  const invalidRequests = [
    [{ workspacePath: '' }, 'WORKSPACE_PATH_REQUIRED'],
    [{ githubUrl: '' }, 'GITHUB_URL_REQUIRED'],
    [{ githubUrl: '--upload-pack=malicious' }, 'INVALID_GITHUB_URL'],
  ] as const;

  for (const [input, code] of invalidRequests) {
    await assertCloneRejection(input, code);
  }
});

test('a user-selected token must still belong to that user when cloning starts', async () => {
  const events = createCloneEvents();
  await assert.rejects(
    () => beginProjectClone(cloneInput({ githubTokenId: 42 }),
    events.handlers,
    cloneDependencies({ getGithubTokenById: async () => null }),),
    (error: unknown) => error instanceof ProjectCloneError && error.code === 'GITHUB_TOKEN_NOT_FOUND',
  );
});

test('a completed clone registers its derived destination and reports the completion contract', async () => {
  const cloneProcess = createCloneProcess();
  const events = createCloneEvents();
  const registeredDestinations: Array<{ destination: string; name: string }> = [];
  const lifecycle: string[] = [];
  const clone = await beginProjectClone(cloneInput({ githubUrl: 'https://github.com/gajae-app/dashboard.git' }),
  events.handlers,
  cloneDependencies({
    createCloneWorkspace: async (destination) => ({
      path: `${destination}.partial`,
      publish: async () => { lifecycle.push('publish'); },
      cleanup: async () => { lifecycle.push('cleanup'); },
    }),
    spawnGitClone: (_url, destination) => {
      assert.equal(destination, '/workspaces/gajae/imports/dashboard.partial');
      return cloneProcess;
    },
    registerProject: async (destination, name) => {
      lifecycle.push('register');
      registeredDestinations.push({ destination, name });
      return { project: { projectId: 'gajae-dashboard', path: destination } };
    },
  }),);

  cloneProcess.emit('close', 0);
  await clone.waitForCompletion;
  assert.deepEqual(lifecycle, ['publish', 'register', 'cleanup']);

  assert.deepEqual(
    registeredDestinations.map(({ name, destination }) => ({ name, destination: directoryName(destination) })),
    [{ name: 'dashboard', destination: 'dashboard' }],
  );
  assert.ok(events.progressMessages.includes("Cloning into 'dashboard'..."));
  assert.deepEqual(events.getCompletion(), {
    project: { projectId: 'gajae-dashboard', path: registeredDestinations[0].destination },
    message: 'Repository cloned successfully',
  });
});

test('a synchronous clone spawn failure releases only its staging workspace', async () => {
  let cleaned = 0;
  const failure = new Error('fixture spawn failed');
  await assert.rejects(beginProjectClone(cloneInput(), createCloneEvents().handlers, cloneDependencies({
    createCloneWorkspace: async () => ({ path: '/private/staging/checkout', publish: async () => assert.fail('failed spawn cannot publish'), cleanup: async () => { cleaned += 1; } }),
    spawnGitClone: () => { throw failure; },
  })), (error: unknown) => error === failure);
  assert.equal(cleaned, 1);
});

test('a process error followed by close cannot publish or clean up twice', async () => {
  const cloneProcess = createCloneProcess();
  let cleaned = 0;
  const clone = await beginProjectClone(cloneInput(), createCloneEvents().handlers, cloneDependencies({
    createCloneWorkspace: async () => ({ path: '/private/staging/checkout', publish: async () => assert.fail('failed process cannot publish'), cleanup: async () => { cleaned += 1; } }),
    spawnGitClone: () => cloneProcess,
    registerProject: async () => { assert.fail('failed process cannot register'); },
  }));
  const rejected = assert.rejects(clone.waitForCompletion, (error: unknown) => error instanceof ProjectCloneError && error.code === 'GIT_NOT_FOUND');
  cloneProcess.emit('error', Object.assign(new Error('missing git'), { code: 'ENOENT' }));
  cloneProcess.emit('close', 0);
  await rejected;
  assert.equal(cleaned, 1);
});

test('cancelled clones discard staging without publishing a destination', async () => {
  const cloneProcess = createCloneProcess();
  let cleaned = 0;
  const clone = await beginProjectClone(cloneInput(), createCloneEvents().handlers, cloneDependencies({
    createCloneWorkspace: async () => ({ path: '/private/staging/checkout', publish: async () => assert.fail('cancelled clone cannot publish'), cleanup: async () => { cleaned += 1; } }),
    spawnGitClone: () => cloneProcess,
  }));
  const rejected = assert.rejects(clone.waitForCompletion, (error: unknown) => error instanceof ProjectCloneError && error.code === 'GIT_CLONE_FAILED');
  clone.cancel();
  await rejected;
  assert.equal(cleaned, 1);
});

test('publication conflicts keep their 409 status and never register the losing checkout', async () => {
  const cloneProcess = createCloneProcess();
  let cleaned = 0;
  const conflict = new ProjectCloneError('destination already claimed', { code: 'CLONE_TARGET_ALREADY_EXISTS', statusCode: 409 });
  const clone = await beginProjectClone(cloneInput(), createCloneEvents().handlers, cloneDependencies({
    createCloneWorkspace: async () => ({ path: '/private/staging/checkout', publish: async () => { throw conflict; }, cleanup: async () => { cleaned += 1; } }),
    spawnGitClone: () => cloneProcess,
    registerProject: async () => { assert.fail('losing checkout cannot register'); },
  }));
  cloneProcess.emit('close', 0);
  await assert.rejects(clone.waitForCompletion, (error: unknown) => error === conflict);
  assert.equal(cleaned, 1);
});

test('filesystem publication preserves a concurrently created directory or symlink', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gajae-clone-ownership-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const kind of ['directory', 'symlink'] as const) {
    const destination = join(root, kind);
    const workspace = await createCloneWorkspace(destination);
    await mkdir(workspace.path);
    await writeFile(join(workspace.path, 'clone.txt'), 'staged clone');
    const existing = kind === 'directory' ? destination : join(root, 'user-directory');
    await mkdir(existing);
    await writeFile(join(existing, 'user.txt'), 'preserve user data');
    if (kind === 'symlink') await symlink(existing, destination, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await lstat(destination);
    await assert.rejects(workspace.publish(), (error: unknown) => error instanceof ProjectCloneError && error.statusCode === 409);
    await workspace.cleanup();
    assert.equal((await lstat(destination)).ino, before.ino);
    assert.equal(await readFile(join(existing, 'user.txt'), 'utf8'), 'preserve user data');
    await assert.rejects(lstat(dirname(workspace.path)), { code: 'ENOENT' });
  }
});

test('a failed publication removes its empty reservation and private staging only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gajae-clone-publish-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await createCloneWorkspace(join(root, 'destination'));
  // A missing checkout makes the atomic rename fail after mkdir succeeds.
  await assert.rejects(workspace.publish(), { code: 'ENOENT' });
  await workspace.cleanup();
  assert.deepEqual(await readdir(root), []);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('clone admission is fresh and precedes even its first path-validation await', async (t) => {
  fenced = true;
  t.after(() => { fenced = false; });
  let validated = false;
  await assert.rejects(beginProjectClone(cloneInput(), createCloneEvents().handlers, cloneDependencies({
    validatePath: async () => { validated = true; return { valid: true, resolvedPath: '/fixture' }; },
  })), { code: 'DESKTOP_RESTART_FENCED' });
  assert.equal(validated, false);
  assert.equal(ingress, 0);
  assert.equal(snapshotInternalActivity().running, 0);
});

test('clone preparation transfers its ingress to the returned completion without a zero-count gap', async (t) => {
  const validation = deferred<{ valid: boolean; resolvedPath: string }>();
  const child = createCloneProcess();
  const before = getInternalActivityGeneration();
  const starting = beginProjectClone(cloneInput(), createCloneEvents().handlers, cloneDependencies({
    validatePath: () => validation.promise, spawnGitClone: () => child,
  }));
  assert.equal(ingress, 1); assert.equal(snapshotInternalActivity().running, 1);
  assert.notEqual(getInternalActivityGeneration(), before);
  fenced = true; // Accepted preparation must not attempt another fresh root.
  t.after(() => { fenced = false; });
  validation.resolve({ valid: true, resolvedPath: '/fixture' });
  const clone = await starting;
  assert.equal(ingress, 1); assert.equal(snapshotInternalActivity().running, 1);
  assert.equal(typeof clone.cancel, 'function');
  child.emit('close', 0); await clone.waitForCompletion;
  assert.equal(ingress, 0); assert.equal(snapshotInternalActivity().running, 0);
});

test('clone error and exit do not clean staging before close or release before cleanup settles', async () => {
  const child = createCloneProcess();
  const cleanup = deferred<void>(); const cleaning = deferred<void>();
  let cleaned = 0;
  const clone = await beginProjectClone(cloneInput(), createCloneEvents().handlers, cloneDependencies({
    createCloneWorkspace: async () => ({ path: '/fixture/staging', publish: async () => assert.fail('errored clone cannot publish'), cleanup: async () => { cleaned++; cleaning.resolve(); await cleanup.promise; } }),
    spawnGitClone: () => child,
  }));
  let settled = false;
  const result = clone.waitForCompletion.finally(() => { settled = true; });
  const rejected = assert.rejects(result, { code: 'GIT_NOT_FOUND' });
  child.emit('error', Object.assign(new Error('missing fixture git'), { code: 'ENOENT' }));
  child.emit('exit', 1);
  await tick();
  assert.equal(cleaned, 0); assert.equal(settled, false);
  assert.equal(snapshotInternalActivity().running, 1); assert.equal(ingress, 1);
  child.emit('close', 0); await cleaning.promise;
  child.emit('close', 1); // Duplicate close cannot create a second cleanup.
  assert.equal(cleaned, 1); assert.equal(settled, false);
  assert.equal(snapshotInternalActivity().running, 1);
  cleanup.resolve(); await rejected;
  assert.equal(snapshotInternalActivity().running, 0); assert.equal(ingress, 0);
});

test('clone completion owns publication, project registration, UI callback and cleanup after real close', async () => {
  const child = createCloneProcess(); const events = createCloneEvents();
  const publication = deferred<void>(); const publishing = deferred<void>();
  const registration = deferred<void>(); const registering = deferred<void>();
  const cleanup = deferred<void>(); const cleaning = deferred<void>();
  const clone = await beginProjectClone(cloneInput(), events.handlers, cloneDependencies({
    createCloneWorkspace: async () => ({
      path: '/fixture/staging',
      publish: async () => { publishing.resolve(); await publication.promise; },
      cleanup: async () => { cleaning.resolve(); await cleanup.promise; },
    }),
    spawnGitClone: () => child,
    registerProject: async () => { registering.resolve(); await registration.promise; return { project: { name: 'fixture' } }; },
  }));
  let settled = false; void clone.waitForCompletion.then(() => { settled = true; });
  child.emit('close', 0); await publishing.promise;
  assert.equal(ingress, 1); assert.equal(settled, false);
  publication.resolve(); await registering.promise;
  assert.equal(snapshotInternalActivity().running, 1); assert.equal(settled, false);
  registration.resolve(); await cleaning.promise;
  assert.ok(events.getCompletion());
  assert.equal(snapshotInternalActivity().running, 1); assert.equal(settled, false);
  cleanup.resolve(); await clone.waitForCompletion;
  assert.equal(ingress, 0); assert.equal(snapshotInternalActivity().running, 0);
});

test('cancel stays synchronous under a fence but cannot settle a still-open clone or publish a late successful exit', async (t) => {
  const child = createCloneProcess(); let kills = 0; let cleaned = 0;
  child.kill = () => { kills++; };
  sources.length = 0;
  const clone = await beginProjectClone(cloneInput(), createCloneEvents().handlers, cloneDependencies({
    createCloneWorkspace: async () => ({ path: '/fixture/staging', publish: async () => assert.fail('cancelled clone cannot publish'), cleanup: async () => { cleaned++; } }),
    spawnGitClone: () => child,
  }));
  fenced = true;
  t.after(() => { fenced = false; });
  const rejected = assert.rejects(clone.waitForCompletion, { code: 'GIT_CLONE_FAILED' });
  assert.equal(clone.cancel(), undefined);
  assert.equal(kills, 1); assert.equal(cleaned, 0);
  assert.equal(snapshotInternalActivity().running, 1); assert.equal(ingress, 1);
  assert.deepEqual(sources, ['clone:start', 'clone:cancel']);
  child.emit('close', 0); await rejected;
  assert.equal(cleaned, 1); assert.equal(ingress, 0);
  clone.cancel(); assert.equal(kills, 1);
});

test('a synchronous clone spawn failure stays owned through delayed staging cleanup', async () => {
  const cleanup = deferred<void>(); const cleaning = deferred<void>();
  const pending = beginProjectClone(cloneInput(), createCloneEvents().handlers, cloneDependencies({
    createCloneWorkspace: async () => ({ path: '/fixture/staging', publish: async () => {}, cleanup: async () => { cleaning.resolve(); await cleanup.promise; } }),
    spawnGitClone: () => { throw new Error('synchronous spawn failure'); },
  }));
  const rejected = assert.rejects(pending, /synchronous spawn failure/);
  await cleaning.promise;
  assert.equal(snapshotInternalActivity().running, 1); assert.equal(ingress, 1);
  cleanup.resolve(); await rejected;
  assert.equal(snapshotInternalActivity().running, 0); assert.equal(ingress, 0);
});

test('an abandoned clone waiter handles failure without dropping the actual child lifetime', async (t) => {
  const child = createCloneProcess();
  const unhandled: unknown[] = [];
  const capture = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', capture);
  t.after(() => process.off('unhandledRejection', capture));
  await beginProjectClone(cloneInput(), createCloneEvents().handlers, cloneDependencies({ spawnGitClone: () => child }));
  child.emit('error', new Error('abandoned waiter failure')); await tick();
  assert.equal(snapshotInternalActivity().running, 1);
  assert.deepEqual(unhandled, []);
  child.emit('close', 1); await tick();
  assert.equal(snapshotInternalActivity().running, 0); assert.equal(ingress, 0);
  assert.deepEqual(unhandled, []);
});

test('clone cleanup failure preserves the logged result contract but leaves bounded restart uncertainty', async () => {
  const child = createCloneProcess(); const logged: string[] = [];
  const clone = await beginProjectClone(cloneInput(), createCloneEvents().handlers, cloneDependencies({
    spawnGitClone: () => child,
    createCloneWorkspace: async () => ({ path: '/fixture/staging', publish: async () => {}, cleanup: () => { throw new Error('fixture cleanup failed'); } }),
    logError: (message) => { logged.push(message); },
  }));
  child.emit('close', 0); await clone.waitForCompletion;
  assert.equal(logged.length, 1);
  assert.equal(snapshotInternalActivity().running, 0); assert.equal(ingress, 0);
  assert.equal(snapshotInternalActivity().complete, false);
  assert.deepEqual(snapshotInternalActivity().unknown, ['clone:cleanup_failed']);
});
