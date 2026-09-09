import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ModelRegistry } from '@gajae-code/coding-agent/config/model-registry';
import type { AuthStorage } from '@gajae-code/coding-agent/session/auth-storage';

import { GjcBunOAuthController, type GjcOAuthActivitySnapshot, type GjcOAuthEvent } from './gjc-bun-oauth-controller.js';

// The installed AuthStorage declaration accepts unknown callbacks. Keep the
// test seam at the same narrow callback contract the controller supplies.
type Callbacks = {
  onAuth(info: { url: string; instructions?: string }): void;
  onPrompt(prompt: { message: string; placeholder?: string }): Promise<string>;
  signal?: AbortSignal;
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('Expected OAuth lifetime transition did not occur.');
}

function total(snapshot: GjcOAuthActivitySnapshot): number {
  return snapshot.starting + snapshot.running + snapshot.settling;
}

function fixture(login: (callbacks: Callbacks) => Promise<void>, refresh = async () => {}, timeoutMs?: number) {
  let credentialReads = 0;
  let loginCalls = 0;
  let refreshCalls = 0;
  const events: GjcOAuthEvent[] = [];
  const storage = {
    exportSnapshot() {
      credentialReads += 1;
      return { credentials: [{ provider: 'openai-codex', accessToken: 'stored-credential-canary' }] };
    },
    login: async (_provider: string, callbacks: Callbacks) => { loginCalls += 1; await login(callbacks); },
  };
  const controller = new GjcBunOAuthController(storage as unknown as AuthStorage, {
    refresh: async () => { refreshCalls += 1; await refresh(); },
  } as unknown as ModelRegistry, { timeoutMs });
  controller.subscribe((event) => events.push(event));
  return { controller, events, reads: () => credentialReads, logins: () => loginCalls, refreshes: () => refreshCalls };
}

test('OAuth activity is synchronously reserved, read-only, detached and credential-free', async () => {
  const finish = deferred();
  const entered = deferred();
  const f = fixture(async (callbacks) => {
    callbacks.onAuth({ url: 'https://example.invalid/authorization-url-canary', instructions: 'instruction-canary' });
    entered.resolve();
    await finish.promise;
  });
  const initial = f.controller.snapshotActivity();
  assert.equal(total(initial), 0);
  assert.equal(f.reads(), 0);
  assert.equal(f.controller.getGeneration(), initial.generation);
  assert.notEqual(f.controller.getGeneration(), fixture(async () => {}).controller.getGeneration());
  const attempt = f.controller.start('openai-codex');
  try {
    const starting = f.controller.snapshotActivity();
    assert.equal(starting.starting, 1);
    assert.ok(starting.revision > initial.revision);
    await entered.promise;
    const running = f.controller.snapshotActivity();
    assert.equal(running.running, 1);
    assert.ok(running.revision > starting.revision);
    const reads = f.reads();
    assert.deepEqual(f.controller.snapshotActivity(), running);
    assert.equal(f.controller.getGeneration(), running.generation);
    assert.equal(f.reads(), reads, 'activity reads must not inspect auth storage');
    const serialized = JSON.stringify(running);
    for (const secret of ['stored-credential-canary', 'authorization-url-canary', 'instruction-canary', attempt.attemptId, 'openai-codex']) {
      assert.equal(serialized.includes(secret), false);
    }
    (running as { running: number }).running = 987;
    assert.equal(f.controller.snapshotActivity().running, 1);
    assert.equal(total(initial), 0, 'past snapshots must not mutate');
  } finally {
    f.controller.close();
    finish.resolve();
    await until(() => total(f.controller.snapshotActivity()) === 0);
  }
});

test('OAuth cancellation retains the old login while a replacement owns the dialog', async () => {
  const firstDone = deferred();
  const secondDone = deferred();
  const callbacks: Callbacks[] = [];
  const f = fixture(async (current) => {
    callbacks.push(current);
    await (callbacks.length === 1 ? firstDone.promise : secondDone.promise);
  });
  try {
    const first = f.controller.start('openai-codex');
    await until(() => callbacks.length === 1);
    const before = f.controller.snapshotActivity();
    assert.equal(f.controller.cancel(first.attemptId).phase, 'cancelled');
    const cancelled = f.controller.snapshotActivity();
    assert.equal(cancelled.settling, 1);
    assert.equal(cancelled.running, 0);
    assert.ok(cancelled.revision > before.revision);
    assert.equal(callbacks[0]!.signal?.aborted, true);
    const replacement = f.controller.start('openai-codex');
    assert.equal(f.controller.snapshotActivity().starting, 1);
    assert.equal(f.controller.snapshotActivity().settling, 1);
    await until(() => callbacks.length === 2);
    const overlapping = f.controller.snapshotActivity();
    assert.equal(overlapping.running, 1);
    assert.equal(overlapping.settling, 1);
    firstDone.resolve();
    await until(() => f.controller.snapshotActivity().settling === 0);
    assert.equal(f.controller.snapshotActivity().running, 1);
    assert.ok(f.controller.snapshotActivity().revision > overlapping.revision);
    assert.equal(f.controller.status().attempt?.attemptId, replacement.attemptId);
    assert.equal(f.refreshes(), 0);
    f.controller.cancel(replacement.attemptId);
    secondDone.reject(new Error('late-login-secret-canary'));
    await until(() => total(f.controller.snapshotActivity()) === 0);
    assert.equal(f.controller.status().attempt?.phase, 'cancelled');
    assert.equal(JSON.stringify(f.events).includes('late-login-secret-canary'), false);
  } finally {
    f.controller.close(); firstDone.resolve(); secondDone.resolve();
    await until(() => total(f.controller.snapshotActivity()) === 0);
  }
});

test('OAuth timeout keeps ownership until an abort-ignoring login actually rejects', async () => {
  const finish = deferred();
  const f = fixture(async () => finish.promise, undefined, 10);
  try {
    f.controller.start('openai-codex');
    await until(() => f.controller.status().attempt?.phase === 'timed_out');
    const timedOut = f.controller.snapshotActivity();
    assert.equal(timedOut.settling, 1);
    f.controller.close();
    assert.equal(f.controller.snapshotActivity().settling, 1);
    finish.reject(new Error('late timeout failure'));
    await until(() => total(f.controller.snapshotActivity()) === 0);
    assert.ok(f.controller.snapshotActivity().revision > timedOut.revision);
    assert.equal(f.refreshes(), 0);
  } finally {
    f.controller.close(); finish.resolve();
    await until(() => total(f.controller.snapshotActivity()) === 0);
  }
});

for (const outcome of ['resolve', 'reject'] as const) {
  test(`OAuth close retains an in-flight refresh until its actual ${outcome}`, async () => {
    const refreshDone = deferred();
    const f = fixture(async () => {}, () => refreshDone.promise);
    try {
      f.controller.start('openai-codex');
      await until(() => f.refreshes() === 1);
      assert.equal(f.controller.status().attempt?.phase, 'refreshing');
      const before = f.controller.snapshotActivity();
      f.controller.close();
      const closing = f.controller.snapshotActivity();
      assert.ok(closing.revision > before.revision);
      assert.equal(closing.settling, 1);
      assert.equal(f.controller.status().attempt?.phase, 'cancelled');
      const eventCount = f.events.length;
      if (outcome === 'resolve') refreshDone.resolve();
      else refreshDone.reject(new Error('refresh-credential-canary'));
      await until(() => total(f.controller.snapshotActivity()) === 0);
      assert.ok(f.controller.snapshotActivity().revision > closing.revision);
      assert.equal(f.events.length, eventCount, 'close must not resurrect UI listeners');
      assert.equal(f.controller.status().attempt?.phase, 'cancelled');
    } finally {
      f.controller.close(); refreshDone.resolve();
      await until(() => total(f.controller.snapshotActivity()) === 0);
    }
  });
}

test('OAuth submission invalidates activity even when its visible phase does not change', async () => {
  const finish = deferred();
  let submitted: string | undefined;
  const f = fixture(async (callbacks) => {
    submitted = await callbacks.onPrompt({ message: 'Enter password' });
    await finish.promise;
  });
  try {
    const attempt = f.controller.start('openai-codex');
    await until(() => f.controller.snapshotActivity().approvals === 1);
    const waiting = f.controller.snapshotActivity();
    assert.equal(f.controller.submit(attempt.attemptId, 'submitted-password-canary').phase, 'awaiting_input');
    const accepted = f.controller.snapshotActivity();
    assert.equal(accepted.approvals, 0);
    assert.equal(accepted.running, 1);
    assert.ok(accepted.revision > waiting.revision);
    assert.notEqual(accepted.generation, waiting.generation);
    await until(() => submitted !== undefined);
    assert.equal(submitted, 'submitted-password-canary');
    assert.equal(JSON.stringify(accepted).includes(submitted), false);
    const beforeInvalid = f.controller.getGeneration();
    assert.throws(() => f.controller.submit(attempt.attemptId, 'duplicate'), /OAuth request failed/);
    assert.equal(f.controller.getGeneration(), beforeInvalid);
  } finally {
    f.controller.close(); finish.resolve();
    await until(() => total(f.controller.snapshotActivity()) === 0);
  }
});

test('OAuth completion observers still see the task until the outer login chain settles', async () => {
  const f = fixture(async () => {});
  let terminal: GjcOAuthActivitySnapshot | undefined;
  f.controller.subscribe((event) => {
    if (event.method === 'oauth.phase' && event.payload.phase === 'completed') terminal = f.controller.snapshotActivity();
  });
  f.controller.start('openai-codex');
  await until(() => terminal !== undefined && total(f.controller.snapshotActivity()) === 0);
  assert.equal(terminal?.settling, 1);
  assert.ok(f.controller.snapshotActivity().revision > terminal!.revision);
  f.controller.close();
});

test('OAuth same-stack cancellation does not start the deferred login', async () => {
  const f = fixture(async () => {});
  const attempt = f.controller.start('openai-codex');
  f.controller.cancel(attempt.attemptId);
  assert.equal(f.controller.snapshotActivity().settling, 1);
  await until(() => total(f.controller.snapshotActivity()) === 0);
  assert.equal(f.logins(), 0);
  assert.equal(f.refreshes(), 0);
  f.controller.close();
});

test('OAuth reentrant input cancellation owns the registered input and its delayed unwind', async () => {
  const unwound = deferred();
  const finish = deferred();
  const f = fixture(async (callbacks) => {
    try { await callbacks.onPrompt({ message: 'Enter code' }); }
    finally { unwound.resolve(); await finish.promise; }
  });
  const approvalCounts: number[] = [];
  f.controller.subscribe((event) => {
    if (event.method === 'oauth.phase' && event.payload.phase === 'awaiting_input') {
      approvalCounts.push(f.controller.snapshotActivity().approvals);
      f.controller.cancel(event.payload.attemptId);
    }
  });
  try {
    f.controller.start('openai-codex');
    await unwound.promise;
    assert.deepEqual(approvalCounts, [1]);
    assert.equal(f.controller.snapshotActivity().approvals, 0);
    assert.equal(f.controller.snapshotActivity().settling, 1);
  } finally {
    f.controller.close(); finish.resolve();
    await until(() => total(f.controller.snapshotActivity()) === 0);
  }
});

test('OAuth observer failures cannot strand a reserved login task', async () => {
  const f = fixture(async () => {});
  f.controller.subscribe(() => { throw new Error('observer failure'); });
  f.controller.start('openai-codex');
  await until(() => f.logins() === 1 && total(f.controller.snapshotActivity()) === 0);
  assert.equal(f.controller.status().attempt?.phase, 'completed');
  f.controller.close();
});
