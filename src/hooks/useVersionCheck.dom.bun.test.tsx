import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import { version } from '../../package.json';

import { useVersionCheck } from './useVersionCheck';

// Future major fixtures stay newer after beta and stable release bumps.
const currentMajor = Number(version.split('.')[0]);
const nextVersion = `${currentMajor + 1}.0.0`;
const laterVersion = `${currentMajor + 2}.0.0`;
const retiredVersion = `${currentMajor + 3}.0.0`;

const originalFetch = globalThis.fetch;
const originalSetInterval = window.setInterval;
const originalClearInterval = window.clearInterval;
const originalSetTimeout = window.setTimeout;
const originalClearTimeout = window.clearTimeout;
const originalNow = Date.now;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.setInterval = originalSetInterval;
  window.clearInterval = originalClearInterval;
  window.setTimeout = originalSetTimeout;
  window.clearTimeout = originalClearTimeout;
  Date.now = originalNow;
});

function release(tag: string) {
  return { tag_name: tag, draft: false, prerelease: tag.includes('-'), published_at: '2026-09-07T00:00:00Z' };
}
const page = (tag: string) => new Response(JSON.stringify([release(tag)]));
const emptyState = { updateAvailable: false, latestVersion: null, currentVersion: version, releaseInfo: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function timers() {
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  let nextId = 10_000;
  window.setInterval = ((...args: Parameters<typeof window.setInterval>) => {
    const [callback, delay] = args;
    if (delay !== 5 * 60 * 1000) return originalSetInterval.apply(window, args);
    assert.equal(typeof callback, 'function');
    const id = nextId++;
    intervals.set(id, callback as () => void);
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = (id) => {
    if (typeof id === 'number' && intervals.delete(id)) return;
    originalClearInterval.call(window, id);
  };
  window.setTimeout = ((...args: Parameters<typeof window.setTimeout>) => {
    const [callback, delay] = args;
    if (delay !== 30_000) return originalSetTimeout.apply(window, args);
    assert.equal(typeof callback, 'function');
    const id = nextId++;
    timeouts.set(id, callback as () => void);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = (id) => {
    if (typeof id === 'number' && timeouts.delete(id)) return;
    originalClearTimeout.call(window, id);
  };
  return {
    intervals, timeouts,
    poll: async () => { await act(async () => { for (const callback of intervals.values()) await callback(); }); },
  };
}

test('the public hook retains its notification-only shape and displays a complete list result', async () => {
  timers();
  globalThis.fetch = async () => page(`v${nextVersion}`);
  const view = renderHook(() => useVersionCheck('owner', 'repo'));
  await waitFor(() => assert.equal(view.result.current.latestVersion, nextVersion));
  assert.deepEqual(Object.keys(view.result.current).sort(), Object.keys(emptyState).sort());
  assert.equal(view.result.current.currentVersion, version);
  assert.equal(view.result.current.updateAvailable, true);
  assert.equal(view.result.current.releaseInfo?.htmlUrl, `https://github.com/owner/repo/releases/tag/v${nextVersion}`);
});

test('disabled web checks do no I/O and retire an active callback when native ownership arrives', async () => {
  const clock = timers();
  const waiting = deferred<Response>();
  let calls = 0;
  let signal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init) => { calls += 1; signal = init?.signal as AbortSignal; return waiting.promise; };
  const view = renderHook(({ enabled }) => useVersionCheck('owner', 'repo', enabled), { initialProps: { enabled: false } });
  await act(async () => {});
  assert.equal(calls, 0);
  assert.equal(clock.intervals.size, 0);
  view.rerender({ enabled: true });
  assert.equal(calls, 1);
  view.rerender({ enabled: false });
  assert.equal((signal as AbortSignal | null)?.aborted, true);
  assert.equal(clock.intervals.size, 0);
  await act(async () => { waiting.resolve(page(`v${retiredVersion}`)); });
  assert.deepEqual(view.result.current, emptyState);
});

test('a failed refresh clears an earlier result, and a later poll can recover', async () => {
  const clock = timers();
  globalThis.fetch = async () => page(`v${nextVersion}`);
  const view = renderHook(() => useVersionCheck('owner', 'repo'));
  await waitFor(() => assert.equal(view.result.current.updateAvailable, true));
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  await clock.poll();
  assert.deepEqual(view.result.current, emptyState);
  globalThis.fetch = async () => page(`v${laterVersion}`);
  await clock.poll();
  assert.equal(view.result.current.latestVersion, laterVersion);
});

test('HTTP failures and bounded partial results never become a latest-version notification', async () => {
  const clock = timers();
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  const view = renderHook(() => useVersionCheck('owner', 'repo'));
  await act(async () => {});
  assert.deepEqual(view.result.current, emptyState);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify([release(`v${retiredVersion}`)]), { headers: { Link: '<https://api.github.com/next>; rel="next"' } });
  };
  await clock.poll();
  assert.equal(calls, 5);
  assert.deepEqual(view.result.current, emptyState);
});

test('429 honors Retry-After seconds and dates without an immediate retry loop', async () => {
  const clock = timers();
  const start = Date.parse('2026-09-07T00:00:00Z');
  let now = start;
  Date.now = () => now;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('', { status: 429, headers: { 'Retry-After': '900' } });
    if (calls === 2) return new Response('', { status: 429, headers: { 'Retry-After': new Date(start + 1_800_000).toUTCString() } });
    return page(`v${nextVersion}`);
  };
  const view = renderHook(() => useVersionCheck('owner', 'repo'));
  await act(async () => {});
  now += 300_000;
  await clock.poll();
  assert.equal(calls, 1);
  assert.deepEqual(view.result.current, emptyState);
  now = start + 900_000;
  await clock.poll();
  assert.equal(calls, 2);
  now += 300_000;
  await clock.poll();
  assert.equal(calls, 2);
  now = start + 1_800_000;
  await clock.poll();
  assert.equal(calls, 3);
  assert.equal(view.result.current.latestVersion, nextVersion);
});

test('repository changes clear the old result and retire late successes and failures', async () => {
  timers();
  const pending = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
  const signals: AbortSignal[] = [];
  globalThis.fetch = async (_url, init) => {
    signals.push(init?.signal as AbortSignal);
    return pending[signals.length - 1].promise;
  };
  const view = renderHook(({ owner, repo }) => useVersionCheck(owner, repo), { initialProps: { owner: 'old', repo: 'repo' } });
  view.rerender({ owner: 'new', repo: 'repo' });
  assert.equal(signals[0].aborted, true);
  await act(async () => { pending[1].resolve(page(`v${nextVersion}`)); });
  assert.equal(view.result.current.latestVersion, nextVersion);
  await act(async () => { pending[0].resolve(page(`v${retiredVersion}`)); });
  assert.equal(view.result.current.latestVersion, nextVersion, 'retired success cannot overwrite the new repository');

  view.rerender({ owner: 'new', repo: 'other' });
  assert.deepEqual(view.result.current, emptyState);
  const lateFailure = pending[2];
  globalThis.fetch = async () => page(`v${laterVersion}`);
  view.rerender({ owner: 'final', repo: 'other' });
  await waitFor(() => assert.equal(view.result.current.latestVersion, laterVersion));
  await act(async () => { lateFailure.reject(new TypeError('old request failed')); });
  assert.equal(view.result.current.latestVersion, laterVersion, 'retired failure cannot clear the new repository');
});

test('pending polls never overlap, and unmount retires saved timer and request callbacks', async () => {
  const clock = timers();
  const pending = deferred<Response>();
  let calls = 0;
  let signal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init) => { calls += 1; signal = init?.signal as AbortSignal; return pending.promise; };
  const view = renderHook(() => useVersionCheck('owner', 'repo'));
  const retiredPoll = [...clock.intervals.values()][0];
  await clock.poll();
  await clock.poll();
  assert.equal(calls, 1);
  view.unmount();
  assert.equal(clock.intervals.size, 0);
  assert.equal(clock.timeouts.size, 0, 'unmount clears the deadline even if the transport ignores abort');
  assert.equal((signal as AbortSignal | null)?.aborted, true);
  await act(async () => { await retiredPoll(); pending.resolve(page(`v${retiredVersion}`)); });
  assert.equal(calls, 1);
  assert.equal(clock.timeouts.size, 0);
});

test('request deadlines abort stalled reads and allow the next scheduled poll', async () => {
  const clock = timers();
  let signal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    signal = init?.signal as AbortSignal;
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const view = renderHook(() => useVersionCheck('owner', 'repo'));
  await act(async () => { for (const callback of clock.timeouts.values()) callback(); });
  assert.equal((signal as AbortSignal | null)?.aborted, true);
  assert.deepEqual(view.result.current, emptyState);
  assert.equal(clock.timeouts.size, 0);
  globalThis.fetch = async () => page(`v${nextVersion}`);
  await clock.poll();
  assert.equal(view.result.current.latestVersion, nextVersion);
});

test('StrictMode effect replay aborts the retired request without suppressing the active one', async () => {
  const clock = timers();
  const pending: ReturnType<typeof deferred<Response>>[] = [];
  const signals: AbortSignal[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = deferred<Response>();
    pending.push(request);
    signals.push(init?.signal as AbortSignal);
    return request.promise;
  };
  const view = renderHook(() => useVersionCheck('owner', 'repo'), {
    reactStrictMode: true,
  });
  assert.equal(pending.length, 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(clock.intervals.size, 1);
  await act(async () => { pending[1].resolve(page(`v${nextVersion}`)); });
  await act(async () => { pending[0].resolve(page(`v${retiredVersion}`)); });
  assert.equal(view.result.current.latestVersion, nextVersion);
});
