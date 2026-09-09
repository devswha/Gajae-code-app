import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DESKTOP_UPDATE_BRIDGE_NAME, type DesktopDraftOwner, type DesktopUpdateBridge, type DesktopDraftFreezeReceipt,
} from '../../shared/desktopUpdateProtocol';

import { installComposerFreezeBridge } from './composerFreezeBridge';
import { isComposerFrozen, resetComposerFreezeForTests } from './composerFreeze';

// These are the exact bytes embedded by updater_bridge.rs, not a JS reimplementation.
const source = readFileSync(new URL('../../src-tauri/src/updater_bridge.js', import.meta.url), 'utf8');
const nativeFactory = new Function('window', 'location', 'fetch', 'Event', `return (${source});`);
const host = window as unknown as Record<string, unknown>;
const owner: DesktopDraftOwner = { prepare: async () => { throw new Error('unexpected freeze'); }, isCurrent: () => false, seal: () => false, cancel: () => false };
function install(fetcher: typeof fetch = (() => { throw new Error('unexpected fetch'); }) as typeof fetch, token = 'a'.repeat(64)) {
  const location = { origin: 'http://127.0.0.1:43123' };
  nativeFactory(window, location, fetcher, Event)(token, location.origin);
  return { bridge: host[DESKTOP_UPDATE_BRIDGE_NAME] as DesktopUpdateBridge, location };
}
const cleanup = () => { window.dispatchEvent(new Event('pagehide')); delete host[DESKTOP_UPDATE_BRIDGE_NAME]; resetComposerFreezeForTests(); };

test('native injection registers exactly one page owner without freezing or sending a request', (t) => {
  t.after(cleanup);
  const { bridge } = install();
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge).sort(), ['protocolVersion', 'registerDraftOwner', 'request']);
  const unsubscribe = bridge.registerDraftOwner!(owner);
  assert.equal(isComposerFrozen(), false);
  assert.throws(() => bridge.registerDraftOwner!(owner), /conflict/u);
  unsubscribe();
  const next = bridge.registerDraftOwner!(owner);
  unsubscribe(); // Old cleanup must not release the newer registration.
  assert.throws(() => bridge.registerDraftOwner!(owner), /conflict/u);
  next();
});

const challenge = { protocolVersion: 1, kind: 'restartChallenge', attemptId: 'd'.repeat(64), draftEpoch: 1, ttlMs: 5000 };
const restartCommand = { action: 'restart' as const, targetId: 'f'.repeat(64) };
const received = (value: unknown) => ({ ok: true, json: async () => value }) as Response;
const abortReply = { protocolVersion: 1, kind: 'restartAborted', attemptId: challenge.attemptId, draftEpoch: 1, snapshot: { phase: 'deferred' } };
const draftReceipt = (): DesktopDraftFreezeReceipt => ({ token: challenge.attemptId, epoch: 1, expiresAt: Date.now() + 5000,
  scope: 'page', installerAuthority: false, drafts: [] });

test('download and restart require a bounded native target; download does not freeze the draft', async t => {
  t.after(cleanup);
  const commands: unknown[] = [];
  const { bridge } = install((async (_url, init) => { commands.push(JSON.parse(String(init?.body))); return received({ phase: 'downloading' }); }) as typeof fetch);
  for (const action of ['download', 'restart']) {
    for (const command of [{ action }, { action, targetId: '' }, { action, targetId: 'g'.repeat(64) }, { action, targetId: 'f'.repeat(64), path: '/tmp/installer' }]) {
      await assert.rejects(bridge.request(command as never), /invalid_command/);
    }
  }
  assert.equal(commands.length, 0);
  await bridge.request({ action: 'download', targetId: 'f'.repeat(64) });
  assert.deepEqual(commands, [{ action: 'download', targetId: 'f'.repeat(64) }]);
  assert.equal(isComposerFrozen(), false);
});

test('native challenge, actual draft receipt and synchronous seal precede the prepared ACK; duplicate requests coalesce', async (t) => {
  t.after(cleanup);
  const calls: string[] = [];
  const receipt = draftReceipt();
  let ready!: (receipt: DesktopDraftFreezeReceipt) => void;
  let sealed = false;
  const pendingDraft = new Promise<DesktopDraftFreezeReceipt>((resolve) => { ready = resolve; });
  const { bridge } = install((async (_url, init) => {
    const command = JSON.parse(String(init?.body)); calls.push(command.action);
    if (command.action === 'restart') { assert.deepEqual(command, restartCommand); return received(challenge); }
    assert.equal(command.action, 'restartPrepared');
    assert.equal(sealed, true);
    assert.deepEqual(command, { action: 'restartPrepared', attemptId: challenge.attemptId, draftEpoch: 1 });
    return received({ phase: 'restarting' });
  }) as typeof fetch);
  bridge.registerDraftOwner!({
    prepare: async (request) => { assert.deepEqual(request, { token: challenge.attemptId, epoch: 1, ttlMs: 5000 }); calls.push('prepare'); return pendingDraft; },
    isCurrent: (value) => value === receipt,
    seal: (value) => { assert.equal(value, receipt); calls.push('seal'); sealed = true; return true; },
    cancel: () => { throw new Error('a successful commit is not cancelled'); },
  });
  const first = bridge.request(restartCommand);
  assert.equal(bridge.request(restartCommand), first);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['restart', 'prepare']);
  ready(receipt); await first;
  assert.deepEqual(calls, ['restart', 'prepare', 'seal', 'restartPrepared']);
});

test('a rejected seal never sends prepared and only a confirmed native abort thaws the draft', async (t) => {
  t.after(cleanup);
  const commands: string[] = []; let cancelled = 0;
  const { bridge } = install((async (_url, init) => {
    const command = JSON.parse(String(init?.body)); commands.push(command.action);
    return received(command.action === 'restart' ? challenge : abortReply);
  }) as typeof fetch);
  bridge.registerDraftOwner!({ prepare: async () => draftReceipt(), isCurrent: () => true, seal: () => false,
    cancel: (request) => { assert.equal(request.token, challenge.attemptId); cancelled++; return true; } });
  assert.deepEqual(await bridge.request(restartCommand), { phase: 'deferred', reason: 'updater_draft_changed' });
  assert.deepEqual(commands, ['restart', 'restartCancel']); assert.equal(cancelled, 1);
});

test('confirmed native cancellation preserves bounded draft failure diagnostics without exposing exception contents', async (t) => {
  t.after(cleanup);
  for (const [error, reason] of [
    [Object.assign(new Error('private draft text'), { name: 'ComposerStorageError', reason: 'conflict' }), 'updater_draft_storage_conflict'],
    [Object.assign(new Error('private file path'), { name: 'ComposerFreezeError', reason: 'changed' }), 'updater_draft_changed'],
    [new TypeError('private expression'), 'updater_draft_browser_type'],
    [new DOMException('private attachment', 'NotReadableError'), 'updater_draft_browser_not_readable'],
    [new DOMException('private attachment', 'NotFoundError'), 'updater_draft_browser_not_found'],
    [new Error('arbitrary sensitive error'), 'updater_draft_prepare_failed'],
  ] as const) {
    const commands: string[] = [];
    const { bridge } = install((async (_url, init) => {
      const command = JSON.parse(String(init?.body)); commands.push(command.action);
      return received(command.action === 'restart' ? challenge : abortReply);
    }) as typeof fetch);
    bridge.registerDraftOwner!({ ...owner, prepare: async () => { throw error; } });
    assert.deepEqual(await bridge.request(restartCommand), { phase: 'deferred', reason });
    assert.deepEqual(commands, ['restart', 'restartCancel']);
  }
});

test('Applying navigation or a lost prepared response does not cancel native handoff and retains the seal until its abort event', async (t) => {
  t.after(cleanup);
  let sealed = false; let cancelled = 0;
  const commands: string[] = [];
  const { bridge } = install((async (_url, init) => {
    const command = JSON.parse(String(init?.body));
    commands.push(command.action);
    if (command.action === 'restart') return received(challenge);
    throw new Error('response lost');
  }) as typeof fetch);
  bridge.registerDraftOwner!({ prepare: async () => draftReceipt(), isCurrent: () => true, seal: () => { sealed = true; return true; },
    cancel: (request) => { if (request.token !== challenge.attemptId || request.epoch !== 1) return false; sealed = false; cancelled++; return true; } });
  await assert.rejects(bridge.request(restartCommand), /response lost/u);
  assert.deepEqual(commands, ['restart', 'restartPrepared']);
  assert.equal(sealed, true); assert.equal(cancelled, 0);
  window.dispatchEvent(new CustomEvent('gajae:desktop-restart:copied-cookie', { detail: abortReply }));
  assert.equal(sealed, true);
  window.dispatchEvent(new CustomEvent(`gajae:desktop-restart:${'a'.repeat(64)}`, { detail: abortReply }));
  assert.equal(sealed, false); assert.equal(cancelled, 1);
});

test('an uncertain native outcome never unseals and internal ACK actions are not public bridge commands', async (t) => {
  t.after(cleanup);
  let cancelled = 0; let requests = 0;
  const { bridge } = install((async (_url, init) => {
    requests++;
    return received(JSON.parse(String(init?.body)).action === 'restart' ? challenge : { ...abortReply, kind: 'restartUncertain', snapshot: { phase: 'recovery' } });
  }) as typeof fetch);
  await assert.rejects(bridge.request({ action: 'restartPrepared', attemptId: challenge.attemptId, draftEpoch: 1 } as never), /invalid_command/u);
  assert.equal(requests, 0);
  bridge.registerDraftOwner!({ prepare: async () => draftReceipt(), isCurrent: () => true, seal: () => true, cancel: () => { cancelled++; return true; } });
  assert.deepEqual(await bridge.request(restartCommand), { phase: 'recovery' });
  assert.equal(cancelled, 0);
});

test('retired view rollback events cannot invoke the replacement draft owner', (t) => {
  t.after(cleanup);
  install();
  const current = install(undefined, 'b'.repeat(64));
  let cancelled = 0;
  current.bridge.registerDraftOwner!({ ...owner, cancel: () => { cancelled++; return true; } });
  window.dispatchEvent(new CustomEvent(`gajae:desktop-restart:${'a'.repeat(64)}`, { detail: abortReply }));
  assert.equal(cancelled, 0);
  window.dispatchEvent(new CustomEvent(`gajae:desktop-restart:${'b'.repeat(64)}`, { detail: abortReply }));
  assert.equal(cancelled, 1);
});

test('the actual root frontend adapter attaches to the native-produced bridge', (t) => {
  t.after(cleanup);
  const { bridge } = install();
  const stop = installComposerFreezeBridge();
  assert.throws(() => bridge.registerDraftOwner!(owner), /conflict/u);
  assert.equal(isComposerFrozen(), false);
  stop();
  bridge.registerDraftOwner!(owner)();
});

test('replacement and pagehide invalidate old closures even when the origin is unchanged', async (t) => {
  t.after(cleanup);
  const original = install();
  const stop = original.bridge.registerDraftOwner!(owner);
  const current = install();
  stop();
  assert.throws(() => original.bridge.registerDraftOwner!(owner), /unauthorized/u);
  await assert.rejects(original.bridge.request({ action: 'status' }), /unauthorized/u);
  current.bridge.registerDraftOwner!(owner)();
  window.dispatchEvent(new Event('pagehide'));
  await assert.rejects(current.bridge.request({ action: 'status' }), /unauthorized/u);
});

test('native view token stays in the request closure and stale responses are not exposed as current', async (t) => {
  t.after(cleanup);
  let finish!: (value: Response) => void;
  let sent: RequestInit | undefined;
  const fetcher = ((_url: RequestInfo | URL, init?: RequestInit) => { sent = init; return new Promise<Response>((resolve) => { finish = resolve; }); }) as typeof fetch;
  const { bridge } = install(fetcher);
  const pending = bridge.request({ action: 'status' });
  const rejection = assert.rejects(pending, /unauthorized/u);
  assert.equal((sent!.headers as Record<string, string>)['X-Gajae-Update-View'], 'a'.repeat(64));
  assert.equal(sent!.credentials, 'same-origin');
  assert.equal(JSON.stringify(bridge).includes('a'.repeat(64)), false);
  install();
  finish({ ok: true, json: async () => ({ phase: 'ready' }) } as Response);
  await rejection;
});
