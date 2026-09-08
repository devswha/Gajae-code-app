import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DESKTOP_UPDATE_BRIDGE_NAME, type DesktopDraftOwner, type DesktopUpdateBridge,
} from '../../shared/desktopUpdateProtocol';

import { installComposerFreezeBridge } from './composerFreezeBridge';
import { isComposerFrozen, resetComposerFreezeForTests } from './composerFreeze';

// These are the exact bytes embedded by updater_bridge.rs, not a JS reimplementation.
const source = readFileSync(new URL('../../src-tauri/src/updater_bridge.js', import.meta.url), 'utf8');
const nativeFactory = new Function('window', 'location', 'fetch', 'Event', `return (${source});`);
const host = window as unknown as Record<string, unknown>;
const owner: DesktopDraftOwner = { prepare: async () => { throw new Error('unexpected freeze'); }, isCurrent: () => false, cancel: () => false };
function install(fetcher: typeof fetch = (() => { throw new Error('unexpected fetch'); }) as typeof fetch) {
  const location = { origin: 'http://127.0.0.1:43123' };
  nativeFactory(window, location, fetcher, Event)('a'.repeat(64), location.origin);
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
