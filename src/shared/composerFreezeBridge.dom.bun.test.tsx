import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';

import {
  DESKTOP_UPDATE_BRIDGE_EVENT, DESKTOP_UPDATE_BRIDGE_NAME,
  type DesktopDraftOwner, type DesktopDraftFreezeReceipt, type DesktopDraftFreezeRequest, type DesktopUpdateBridge,
} from '../../shared/desktopUpdateProtocol';
import App from '../App';
import { useDurableComposerDraft } from '../components/chat/hooks/useDurableComposerDraft';
import { boundedComposerDraft, composerRouteKey, type ComposerDraftRepository, type StoredComposerDraft } from '../components/chat/utils/composerDraftStorage';

import { beginComposerOperation, cancelComposerFreeze, isComposerFreezeCurrent, isComposerFrozen, prepareComposerFreeze, registerComposerFreezeParticipant, resetComposerFreezeForTests } from './composerFreeze';
import { installComposerFreezeBridge, useComposerFreezeBridge } from './composerFreezeBridge';

const globals = window as unknown as Record<string, unknown>;
const originalInjection = Object.getOwnPropertyDescriptor(window, DESKTOP_UPDATE_BRIDGE_NAME);
const originalFetch = globalThis.fetch;
let epoch = 0;
const request = (ttlMs = 2000): DesktopDraftFreezeRequest => ({ token: `bridge-${++epoch}`, epoch, ttlMs });
const rejects = (reason: string) => (error: unknown) => (error as { reason?: string }).reason === reason;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const announce = () => act(() => window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)));
const inject = (bridge: unknown) => Object.defineProperty(window, DESKTOP_UPDATE_BRIDGE_NAME, { configurable: true, writable: true, value: bridge });
function provider() {
  const owners: DesktopDraftOwner[] = []; let unsubscribed = 0; let commands = 0;
  const bridge: DesktopUpdateBridge = {
    protocolVersion: 1,
    request: async () => { commands += 1; throw new Error('registration must not issue native commands'); },
    registerDraftOwner(owner) { assert.equal(this, bridge); owners.push(owner); return () => { unsubscribed += 1; }; },
  };
  return { bridge, owners, get current() { return owners.at(-1)!; }, get unsubscribed() { return unsubscribed; }, get commands() { return commands; } };
}
beforeEach(() => { resetComposerFreezeForTests(); localStorage.clear(); epoch = 0; inject(undefined); });
afterEach(() => {
  cleanup(); resetComposerFreezeForTests(); localStorage.clear(); globalThis.fetch = originalFetch;
  if (originalInjection) Object.defineProperty(window, DESKTOP_UPDATE_BRIDGE_NAME, originalInjection);
  else delete globals[DESKTOP_UPDATE_BRIDGE_NAME];
});

test('web, legacy, malformed, and wrong-protocol bridges neither register nor freeze', () => {
  let registrations = 0;
  const registerDraftOwner = () => { registrations += 1; return () => {}; };
  globalThis.fetch = async () => { assert.fail('registration must not fetch'); };
  const view = renderHook(useComposerFreezeBridge);
  for (const bridge of [undefined, null, {}, { protocolVersion: 1, request() {} },
    { protocolVersion: 2, request() {}, registerDraftOwner }, { protocolVersion: 1, registerDraftOwner },
    { protocolVersion: 1, request() {}, registerDraftOwner: true }]) {
    inject(bridge); announce(); assert.equal(isComposerFrozen(), false);
  }
  // Event payloads and posted messages are not native injection/permission.
  window.dispatchEvent(new CustomEvent(DESKTOP_UPDATE_BRIDGE_EVENT, { detail: provider().bridge }));
  window.dispatchEvent(new MessageEvent('message', { data: { installerAuthority: true } }));
  assert.equal(registrations, 0); view.unmount();
});

test('initial and late injection register once, preserve method context, and leave admission open', () => {
  const view = renderHook(useComposerFreezeBridge); const native = provider();
  inject(native.bridge); announce(); announce();
  assert.equal(native.owners.length, 1); assert.equal(native.commands, 0); assert.equal(isComposerFrozen(), false);
  view.unmount(); assert.equal(native.unsubscribed, 1);
  const remount = renderHook(useComposerFreezeBridge);
  assert.equal(native.owners.length, 2); remount.unmount(); assert.equal(native.unsubscribed, 2);
});

test('native receives the original page receipt identity, never a serialized permission claim', async () => {
  const native = provider(); inject(native.bridge); renderHook(useComposerFreezeBridge);
  const receipt = await native.current.prepare(request());
  assert.equal(isComposerFreezeCurrent(receipt), true);
  assert.equal(native.current.isCurrent(receipt), true);
  assert.equal(native.current.isCurrent(structuredClone(receipt)), false);
  assert.equal(native.current.isCurrent({ ...receipt, installerAuthority: true } as never), false);
  assert.equal(receipt.scope, 'page'); assert.equal(receipt.installerAuthority, false); assert.equal(native.commands, 0);
  assert.equal(native.current.cancel({ ...receipt, token: 'wrong' }), false);
  assert.equal(native.current.isCurrent(receipt), true);
  assert.equal(native.current.cancel(receipt), true); assert.equal(native.current.cancel(receipt), false);
});

test('replacement cancels only the old provider and stale callbacks cannot thaw or supersede the new lease', async () => {
  const first = provider(); inject(first.bridge); renderHook(useComposerFreezeBridge);
  const old = first.current; const prior = await old.prepare(request());
  const second = provider(); inject(second.bridge); announce();
  assert.equal(first.unsubscribed, 1); assert.equal(isComposerFreezeCurrent(prior), false);
  const nextRequest = request(); const next = await second.current.prepare(nextRequest);
  assert.equal(old.isCurrent(next), false); assert.equal(old.cancel(nextRequest), false);
  await assert.rejects(old.prepare({ token: 'stale-provider', epoch: 999, ttlMs: 2000 }), rejects('stale'));
  assert.equal(second.current.isCurrent(next), true);
  announce(); assert.equal(second.owners.length, 1); assert.equal(second.current.isCurrent(next), true);
  assert.equal(second.current.isCurrent(await second.current.prepare(request())), true, 'stale provider did not reserve epoch 999');
});

test('pending preparation is cancelled on replacement; late verification cannot acknowledge or thaw the newer provider', async () => {
  const gate = deferred();
  registerComposerFreezeParticipant({ async flushAndVerify() { await gate.promise; return []; } });
  const first = provider(); inject(first.bridge); renderHook(useComposerFreezeBridge);
  const pending = first.current.prepare(request());
  const rejected = assert.rejects(pending, rejects('cancelled'));
  const second = provider(); inject(second.bridge); announce();
  const next = second.current.prepare(request());
  await rejected; gate.resolve();
  const receipt = await next;
  assert.equal(second.current.isCurrent(receipt), true); assert.equal(first.current.cancel(receipt), false);
  assert.equal(isComposerFreezeCurrent(receipt), true);
});

test('unmount cancels pending preparation and removes the ready listener; saved provider methods stay retired', async () => {
  const gate = deferred(); registerComposerFreezeParticipant({ async flushAndVerify() { await gate.promise; return []; } });
  const native = provider(); inject(native.bridge); const view = renderHook(useComposerFreezeBridge);
  const owned = native.current; const pending = owned.prepare(request()); const rejected = assert.rejects(pending, rejects('cancelled'));
  view.unmount(); await rejected; assert.equal(isComposerFrozen(), false); assert.equal(native.unsubscribed, 1);
  const replacement = provider(); inject(replacement.bridge); announce(); gate.resolve();
  assert.equal(replacement.owners.length, 0);
  await assert.rejects(owned.prepare(request()), rejects('stale'));
  assert.equal(owned.cancel({ token: 'anything', epoch: 1 }), false);
});

test('cleanup after rejected duplicate keys cannot cancel another caller’s actual page preparation', async () => {
  const native = provider(); inject(native.bridge); const view = renderHook(useComposerFreezeBridge);
  const key = request(); const external = await prepareComposerFreeze(key);
  const duplicate = native.current.prepare(key); const rejected = assert.rejects(duplicate, rejects('stale'));
  view.unmount(); // Before the rejected attempt's catch has removed its ticket.
  await rejected; assert.equal(isComposerFreezeCurrent(external), true); cancelComposerFreeze(key);
});

test('injection changes without a ready event are caught before publishing or validating a receipt', async () => {
  const first = provider(); inject(first.bridge); renderHook(useComposerFreezeBridge);
  const receipt = await first.current.prepare(request());
  const second = provider(); inject(second.bridge);
  assert.equal(first.current.isCurrent(receipt), false); assert.equal(first.unsubscribed, 1);
  assert.equal(second.owners.length, 1); assert.equal(isComposerFrozen(), false);
  const newer = await second.current.prepare(request()); assert.equal(second.current.isCurrent(newer), true);
});

test('removing injection or replacing its registration method retires the previous owner', async () => {
  const native = provider(); inject(native.bridge); renderHook(useComposerFreezeBridge);
  const old = native.current; await old.prepare(request());
  const registrations: DesktopDraftOwner[] = [];
  native.bridge.registerDraftOwner = (owner) => { registrations.push(owner); return () => {}; };
  announce(); assert.equal(native.unsubscribed, 1); assert.equal(isComposerFrozen(), false); assert.equal(registrations.length, 1);
  const receipt = await registrations[0].prepare(request());
  inject(undefined); announce(); assert.equal(isComposerFreezeCurrent(receipt), false);
});

test('busy, invalid requests and expired receipts fail closed without native commands', async () => {
  const native = provider(); inject(native.bridge); renderHook(useComposerFreezeBridge);
  const finish = beginComposerOperation('voice')!;
  await assert.rejects(native.current.prepare(request()), rejects('busy'));
  assert.equal(isComposerFrozen(), false); finish();
  const valid = request(); const receipt = await native.current.prepare(valid);
  await assert.rejects(native.current.prepare({ ...request(), ttlMs: 0 }), rejects('invalid'));
  assert.equal(native.current.isCurrent(receipt), true, 'an invalid retry cannot steal or cancel valid ownership');
  native.current.cancel(valid);
  const expiring = await native.current.prepare(request(20));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(native.current.isCurrent(expiring), false); assert.equal(isComposerFrozen(), false); assert.equal(native.commands, 0);
});

test('registration failure after prepare revokes its captured owner and cancels only its own lease', async () => {
  const native = provider(); let owned!: DesktopDraftOwner; let pending!: Promise<DesktopDraftFreezeReceipt>;
  native.bridge.registerDraftOwner = (owner) => { owned = owner; pending = owner.prepare(request()); throw new Error('registration failed'); };
  inject(native.bridge); const view = renderHook(useComposerFreezeBridge);
  await assert.rejects(pending, rejects('cancelled')); assert.equal(isComposerFrozen(), false);
  await assert.rejects(owned.prepare(request()), rejects('stale'));
  native.bridge.registerDraftOwner = (owner) => { owned = owner; return () => { throw new Error('unsubscribe failed'); }; };
  announce(); await owned.prepare(request());
  assert.doesNotThrow(() => view.unmount()); assert.equal(isComposerFrozen(), false);
});

test('invalid unsubscribe and revoked injection access do not leave usable providers or frozen input', async () => {
  const native = provider(); let captured!: DesktopDraftOwner;
  native.bridge.registerDraftOwner = ((owner: DesktopDraftOwner) => { captured = owner; return undefined; }) as never;
  inject(native.bridge); renderHook(useComposerFreezeBridge);
  await assert.rejects(captured.prepare(request()), rejects('stale')); assert.equal(isComposerFrozen(), false);
  const next = provider(); inject(next.bridge); announce(); await next.current.prepare(request());
  Object.defineProperty(window, DESKTOP_UPDATE_BRIDGE_NAME, { configurable: true, get() { throw new Error('revoked injection'); } });
  assert.doesNotThrow(announce); assert.equal(isComposerFrozen(), false); assert.equal(next.unsubscribed, 1);
});

test('reentrant replacement during register cleans up the old subscription without thawing the new provider', async () => {
  const first = provider(); const second = provider(); let old!: DesktopDraftOwner; let stopped = 0;
  let prepared!: Promise<DesktopDraftFreezeReceipt>;
  const registerSecond = second.bridge.registerDraftOwner!;
  second.bridge.registerDraftOwner = function (owner) { const stop = registerSecond.call(this, owner); prepared = owner.prepare(request()); return stop; };
  first.bridge.registerDraftOwner = (owner) => { old = owner; inject(second.bridge); window.dispatchEvent(new Event(DESKTOP_UPDATE_BRIDGE_EVENT)); return () => { stopped += 1; }; };
  inject(first.bridge); renderHook(useComposerFreezeBridge);
  const receipt = await prepared;
  assert.equal(stopped, 1); assert.equal(second.current.isCurrent(receipt), true); assert.equal(old.cancel(receipt), false);
});

test('StrictMode effect replay unregisters the first instance and leaves exactly one live owner', async () => {
  const native = provider(); inject(native.bridge);
  const view = renderHook(useComposerFreezeBridge, { wrapper: StrictMode });
  assert.equal(native.owners.length, 2); assert.equal(native.unsubscribed, 1);
  await assert.rejects(native.owners[0].prepare(request()), rejects('stale'));
  const receipt = await native.current.prepare(request()); assert.equal(native.current.isCurrent(receipt), true);
  view.unmount(); assert.equal(native.unsubscribed, 2); assert.equal(isComposerFrozen(), false);
});

test('root registration prepares the real global offscreen/unmounted draft registry through commit and File read-back', async () => {
  const records = new Map<string, StoredComposerDraft>(); const commit = deferred(); let hold = false; let writes = 0;
  const repository: ComposerDraftRepository = {
    async load(route) { return records.get(composerRouteKey(route)) ?? null; },
    async save(value, revision) { writes += 1; if (hold) await commit.promise; records.set(composerRouteKey(value), { ...boundedComposerDraft(value).draft, revision: revision + 1 }); return revision + 1; },
  };
  const native = provider(); inject(native.bridge); const root = renderHook(useComposerFreezeBridge);
  const draft = renderHook(({ route }) => useDurableComposerDraft('project', route, repository), { initialProps: { route: 'A' } });
  await waitFor(() => assert.equal(draft.result.current.persistence.phase, 'saved'));
  const file = new File([new Uint8Array([0, 255, 0, 42])], 'actual.png', { type: 'image/png', lastModified: 12 });
  act(() => { draft.result.current.setInput('offscreen A'); draft.result.current.setImages([file]); draft.result.current.setQueue([{ id: 'queued-A', content: 'queued', images: [file] }]); });
  await waitFor(() => assert.equal(draft.result.current.persistence.phase, 'saved'));
  draft.rerender({ route: 'B' }); await waitFor(() => assert.equal(draft.result.current.persistence.phase, 'saved'));
  hold = true; const priorWrites = writes; act(() => draft.result.current.setInput('unmounted B'));
  await waitFor(() => assert.ok(writes > priorWrites)); draft.unmount();
  let acknowledged = false;
  const pending = native.current.prepare(request()).then((receipt) => { acknowledged = true; return receipt; });
  await Promise.resolve(); assert.equal(isComposerFrozen(), true); assert.equal(acknowledged, false);
  commit.resolve(); const receipt = await pending;
  assert.equal(receipt.drafts.length, 2); assert.equal(receipt.drafts.reduce((sum, row) => sum + row.fileCount, 0), 2);
  assert.equal(receipt.drafts.reduce((sum, row) => sum + row.queuedIntentCount, 0), 1);
  assert.equal(records.get(JSON.stringify(['project', 'B']))?.input, 'unmounted B');
  assert.deepEqual(new Uint8Array(await records.get(JSON.stringify(['project', 'A']))!.images[0].arrayBuffer()), new Uint8Array([0, 255, 0, 42]));
  assert.equal(native.current.isCurrent(receipt), true); assert.equal(native.commands, 0);
  root.unmount(); assert.equal(isComposerFrozen(), false);
});

test('App installs the owner before authentication or settings/About surfaces mount', () => {
  globalThis.fetch = () => new Promise<Response>(() => {}); // Leave the existing auth bootstrap pending.
  const native = provider(); inject(native.bridge); const view = render(<App />);
  assert.equal(native.owners.length, 1); assert.equal(native.commands, 0); assert.equal(isComposerFrozen(), false);
  view.unmount(); assert.equal(native.unsubscribed, 1);
});

test('service teardown is idempotent', () => {
  const native = provider(); inject(native.bridge); const stop = installComposerFreezeBridge();
  stop(); stop(); announce(); assert.equal(native.owners.length, 1); assert.equal(native.unsubscribed, 1);
});
