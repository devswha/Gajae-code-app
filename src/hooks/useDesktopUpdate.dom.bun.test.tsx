import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, renderHook } from '@testing-library/react';

import {
  DESKTOP_UPDATE_BRIDGE_EVENT, DESKTOP_UPDATE_BRIDGE_NAME,
  isDesktopUpdateCommand, type DesktopUpdateCommand, type DesktopUpdateSnapshot,
} from '../../shared/desktopUpdateProtocol';

import { useDesktopUpdate } from './useDesktopUpdate';

const globals = window as unknown as Record<string, unknown>;
const originalInjection = Object.getOwnPropertyDescriptor(window, DESKTOP_UPDATE_BRIDGE_NAME);
const originalSetInterval = window.setInterval;
const originalClearInterval = window.clearInterval;
const originalSetTimeout = window.setTimeout;
const originalClearTimeout = window.clearTimeout;
afterEach(() => {
  cleanup();
  if (originalInjection) Object.defineProperty(window, DESKTOP_UPDATE_BRIDGE_NAME, originalInjection);
  else delete globals[DESKTOP_UPDATE_BRIDGE_NAME];
  window.setInterval = originalSetInterval;
  window.clearInterval = originalClearInterval;
  window.setTimeout = originalSetTimeout;
  window.clearTimeout = originalClearTimeout;
});

function native(extra: Partial<DesktopUpdateSnapshot> = {}): DesktopUpdateSnapshot {
  return { protocolVersion: 1, phase: 'idle', automatic: true, productVersion: '2.0.0-beta.10',
    desktopVersion: '0.2.4', targetProductVersion: null, targetDesktopVersion: null,
    discoveryIncomplete: false, reason: null, installationAvailable: false,
    downloadedBytes: null, totalBytes: null, notes: null, ...extra };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function bridge(request: (command: DesktopUpdateCommand) => Promise<unknown>) {
  globals[DESKTOP_UPDATE_BRIDGE_NAME] = { protocolVersion: 1, request };
}
const flush = async () => { await act(async () => {}); };
const changed = () => act(() => { window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); });

function timers() {
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  let id = 50_000;
  window.setInterval = ((...args: Parameters<typeof window.setInterval>) => {
    const [callback, delay] = args;
    if (delay !== 3_000) return originalSetInterval.apply(window, args);
    intervals.set(++id, callback as () => void);
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = (timer) => {
    if (typeof timer === 'number' && intervals.delete(timer)) return;
    originalClearInterval.call(window, timer);
  };
  window.setTimeout = ((...args: Parameters<typeof window.setTimeout>) => {
    const [callback, delay] = args;
    if (delay !== 10_000) return originalSetTimeout.apply(window, args);
    timeouts.set(++id, callback as () => void);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = (timer) => {
    if (typeof timer === 'number' && timeouts.delete(timer)) return;
    originalClearTimeout.call(window, timer);
  };
  return {
    intervals, timeouts,
    poll: async () => { await act(async () => { for (const callback of [...intervals.values()]) callback(); }); },
    expire: async () => { await act(async () => { for (const callback of [...timeouts.values()]) callback(); }); },
  };
}

test('ordinary web mounts have no native state, polling or command authority', async () => {
  delete globals[DESKTOP_UPDATE_BRIDGE_NAME];
  const clock = timers();
  const view = renderHook(useDesktopUpdate);
  await act(async () => {
    await view.result.current.refresh();
    await view.result.current.check();
    await view.result.current.setAutomatic(false);
    await view.result.current.restart();
  });
  assert.equal(view.result.current.bridgeActive, false);
  assert.equal(view.result.current.snapshot, null);
  assert.equal(view.result.current.connected, false);
  assert.equal(clock.intervals.size, 0);
});

test('injected presence is not authority: rejected status never enables mutations', async () => {
  timers();
  const commands: DesktopUpdateCommand[] = [];
  bridge(async (command) => { commands.push(command); throw new Error('private diagnostic must not reach UI'); });
  const view = renderHook(useDesktopUpdate);
  await flush();
  assert.equal(view.result.current.bridgeActive, true);
  assert.equal(view.result.current.snapshot, null);
  assert.equal(view.result.current.connected, false);
  assert.equal(view.result.current.error, 'unavailable');
  await act(async () => {
    await view.result.current.check(); await view.result.current.setAutomatic(false); await view.result.current.restart();
  });
  assert.deepEqual(commands, [{ action: 'status' }]);
});

test('wrong protocol, malformed and null status responses fail closed', async () => {
  timers();
  let calls = 0;
  globals[DESKTOP_UPDATE_BRIDGE_NAME] = { protocolVersion: 2, request: () => { calls += 1; return Promise.resolve(native()); } };
  const view = renderHook(useDesktopUpdate);
  await flush();
  assert.equal(calls, 0);
  for (const value of [null, {}, native({ protocolVersion: 2 as 1 }), native({ downloadedBytes: -1 }), native({ totalBytes: 1, downloadedBytes: 2 })]) {
    bridge(async () => value);
    changed();
    await flush();
    assert.equal(view.result.current.snapshot, null);
    assert.equal(view.result.current.connected, false);
    assert.equal(view.result.current.error, 'invalidResponse');
  }
});

test('status requests coalesce and only a validated status establishes native truth', async () => {
  const clock = timers();
  const waiting = deferred<unknown>();
  let calls = 0;
  bridge(async () => { calls += 1; return waiting.promise; });
  const view = renderHook(useDesktopUpdate);
  await flush();
  assert.equal(view.result.current.connected, false);
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => { first = view.result.current.refresh(); second = view.result.current.refresh(); });
  assert.equal(first, second);
  await clock.poll();
  assert.equal(calls, 1);
  const snapshot = native({ phase: 'ready', installationAvailable: false });
  await act(async () => { waiting.resolve(snapshot); await first; });
  assert.deepEqual(view.result.current.snapshot, snapshot);
  assert.equal(view.result.current.connected, true);
  assert.equal(clock.timeouts.size, 0);
  snapshot.automatic = false;
  assert.equal(view.result.current.snapshot?.automatic, true, 'native object mutation is not an event');
});

test('automatic settings are never optimistic; rejected/malformed writes retain confirmed state', async () => {
  timers();
  const commands: DesktopUpdateCommand[] = [];
  let waiting = deferred<unknown>();
  bridge(async (command) => { commands.push(command); return command.action === 'status' ? native() : waiting.promise; });
  const view = renderHook(useDesktopUpdate);
  await flush();
  act(() => { void view.result.current.setAutomatic(false); });
  await flush();
  assert.equal(view.result.current.snapshot?.automatic, true);
  assert.equal(view.result.current.pending, 'setAutomatic');
  act(() => { void view.result.current.setAutomatic(true); });
  await act(async () => { waiting.reject(new Error('not saved')); });
  assert.equal(view.result.current.snapshot?.automatic, true);
  assert.equal(view.result.current.connected, false);
  assert.equal(view.result.current.error, 'unavailable');
  await act(async () => { await view.result.current.refresh(); });
  waiting = deferred<unknown>();
  act(() => { void view.result.current.setAutomatic(false); });
  await flush();
  await act(async () => { waiting.resolve({ automatic: false }); });
  assert.equal(view.result.current.snapshot?.automatic, true);
  assert.equal(view.result.current.error, 'invalidResponse');
  await act(async () => { await view.result.current.refresh(); });
  waiting = deferred<unknown>();
  act(() => { void view.result.current.setAutomatic(false); });
  await flush();
  await act(async () => { waiting.resolve(native({ automatic: false })); });
  assert.equal(view.result.current.snapshot?.automatic, false);
  assert.equal(commands.filter((command) => command.action === 'setAutomatic').length, 3);
  assert.ok(commands.every(isDesktopUpdateCommand));
});

test('check and restart commands do not invent phases; restart requires available AND ready', async () => {
  timers();
  let snapshot = native({ automatic: false });
  const commands: DesktopUpdateCommand[] = [];
  bridge(async (command) => { commands.push(command); return snapshot; });
  const view = renderHook(useDesktopUpdate);
  await flush();
  await act(async () => { await view.result.current.check(); await view.result.current.restart(); });
  assert.equal(view.result.current.snapshot?.phase, 'idle');
  assert.deepEqual(commands, [{ action: 'status' }, { action: 'check' }]);
  for (const next of [native({ phase: 'ready' }), native({ phase: 'deferred', installationAvailable: true })]) {
    snapshot = next;
    await act(async () => { await view.result.current.refresh(); await view.result.current.restart(); });
  }
  assert.equal(commands.some((command) => command.action === 'restart'), false);
  snapshot = native({ phase: 'ready', installationAvailable: true });
  await act(async () => { await view.result.current.refresh(); await view.result.current.restart(); });
  assert.deepEqual(commands.at(-1), { action: 'restart' });
  assert.equal(view.result.current.snapshot?.phase, 'ready', 'request success is not a claim of restarting');
  const count = commands.length;
  await act(async () => { await view.result.current.setAutomatic('yes' as unknown as boolean); });
  assert.equal(commands.length, count, 'strict command validation rejects forged setter values');
});

test('disabled/recovery/applying/restarting states allow status reads, not new mutation commands', async () => {
  timers();
  let snapshot = native();
  const commands: DesktopUpdateCommand[] = [];
  bridge(async (command) => { commands.push(command); return snapshot; });
  const view = renderHook(useDesktopUpdate);
  await flush();
  for (const phase of ['disabled', 'recovery', 'applying', 'restarting'] as const) {
    snapshot = native({ phase, installationAvailable: true });
    await act(async () => {
      await view.result.current.refresh(); await view.result.current.check();
      await view.result.current.setAutomatic(false); await view.result.current.restart();
    });
  }
  assert.ok(commands.every((command) => command.action === 'status'));
});

test('retirement preserves the last snapshot but removes authority and retires old polling', async () => {
  const clock = timers();
  bridge(async () => native());
  const view = renderHook(useDesktopUpdate);
  await flush();
  const savedPoll = [...clock.intervals.values()][0];
  const late = deferred<unknown>();
  bridge(async () => late.promise);
  changed();
  await flush();
  delete globals[DESKTOP_UPDATE_BRIDGE_NAME];
  changed();
  assert.equal(view.result.current.bridgeActive, true, 'retirement must not activate web fallback');
  assert.deepEqual(view.result.current.snapshot, native());
  assert.equal(view.result.current.connected, false);
  assert.equal(view.result.current.error, 'unavailable');
  assert.equal(clock.intervals.size, 0);
  let calls = 0;
  bridge(async () => { calls += 1; return native({ productVersion: '2.0.0-beta.11' }); });
  changed();
  await flush();
  await act(async () => { savedPoll(); late.resolve(native({ productVersion: '9.0.0' })); });
  assert.equal(view.result.current.snapshot?.productVersion, '2.0.0-beta.11');
  assert.equal(calls, 1);
});

test('replaced injection without an event cannot publish an older response', async () => {
  timers();
  const late = deferred<unknown>();
  bridge(async () => late.promise);
  const view = renderHook(useDesktopUpdate);
  await flush();
  bridge(async () => native({ productVersion: '2.0.0-beta.11' }));
  await act(async () => { late.resolve(native({ productVersion: '9.0.0' })); });
  assert.equal(view.result.current.snapshot?.productVersion, '2.0.0-beta.11');
});

test('status timeout is bounded; late responses cannot overwrite a successful retry', async () => {
  const clock = timers();
  const late = deferred<unknown>();
  let calls = 0;
  bridge(async () => ++calls === 1 ? late.promise : native());
  const view = renderHook(useDesktopUpdate);
  await flush();
  let completed = false;
  void view.result.current.refresh().then(() => { completed = true; });
  await clock.expire();
  assert.equal(completed, true);
  assert.equal(view.result.current.error, 'timeout');
  assert.equal(({ ...view.result.current }).snapshot, null);
  await clock.poll();
  assert.equal(view.result.current.connected, true);
  await act(async () => { late.resolve(native({ productVersion: '9.0.0' })); });
  assert.equal(view.result.current.snapshot?.productVersion, '2.0.0-beta.10');
});

test('timed-out native writes are not cancelled or repeated, even after status becomes readable', async () => {
  const clock = timers();
  const late = deferred<unknown>();
  const commands: DesktopUpdateCommand[] = [];
  bridge(async (command) => { commands.push(command); return command.action === 'status' ? native() : late.promise; });
  const view = renderHook(useDesktopUpdate);
  await flush();
  act(() => { void view.result.current.setAutomatic(false); });
  await flush();
  await clock.expire();
  assert.equal(view.result.current.awaitingOperation, true);
  assert.equal(view.result.current.snapshot?.automatic, true);
  await clock.poll();
  assert.equal(view.result.current.connected, true);
  assert.equal(view.result.current.error, 'timeout');
  assert.equal(view.result.current.awaitingOperation, true);
  await act(async () => { await view.result.current.setAutomatic(false); await view.result.current.check(); });
  assert.equal(commands.filter((command) => command.action !== 'status').length, 1);
  await act(async () => { late.resolve(native({ automatic: false })); });
  assert.equal(view.result.current.awaitingOperation, false);
  assert.equal(view.result.current.snapshot?.automatic, true, 'late write result is ignored; a fresh status supplies truth');
  assert.equal(view.result.current.error, null);
  assert.deepEqual(commands.at(-1), { action: 'status' });
});

test('unmount clears timers/listeners, ignores saved callbacks and never cancels native execution', async () => {
  const clock = timers();
  const waiting = deferred<unknown>();
  let calls = 0;
  bridge(async () => { calls += 1; return waiting.promise; });
  const view = renderHook(useDesktopUpdate);
  await flush();
  const poll = [...clock.intervals.values()][0];
  const timeout = [...clock.timeouts.values()][0];
  const refresh = view.result.current.refresh;
  view.unmount();
  assert.equal(clock.intervals.size, 0);
  assert.equal(clock.timeouts.size, 0);
  await act(async () => { poll(); timeout(); changed(); await refresh(); waiting.resolve(native()); });
  assert.equal(calls, 1);
});
