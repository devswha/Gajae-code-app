import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { useQueuedMessageAutoSend } from '../../../hooks/useQueuedMessageAutoSend';
import type { SessionActivityMap } from '../../../hooks/useSessionProtection';
import english from '../../../i18n/locales/en/chat.json';
import { beginComposerOperation, cancelComposerFreeze, finishComposerOperation, isComposerFreezeCurrent, isComposerFrozen, prepareComposerFreeze, resetComposerFreezeForTests, type ComposerFreezeReceipt } from '../../../shared/composerFreeze';
import { readQueuedMessages, writeQueuedMessages } from '../utils/chatStorage';
import { boundedComposerDraft, composerRouteKey, ComposerStorageError, type ComposerDraft, type ComposerDraftRepository, type ComposerRoute, type StoredComposerDraft } from '../utils/composerDraftStorage';
import ChatComposer from '../view/ChatComposer';

import { useChatComposerState } from './useChatComposerState';

// A deterministic commit/read-back seam, not an IDB polyfill or native G3
// certification. composerDraftStorage's transaction tests cover strict commit.
class Repository implements ComposerDraftRepository {
  records = new Map<string, StoredComposerDraft>();
  beforeSave?: () => Promise<void>;
  readBack?: (draft: StoredComposerDraft) => StoredComposerDraft;
  writes = 0;
  async load(route: ComposerRoute) {
    const record = this.records.get(composerRouteKey(route));
    return record ? this.readBack?.(clone(record)) ?? clone(record) : null;
  }
  async save(value: ComposerDraft, expectedRevision: number) {
    const { draft } = boundedComposerDraft(value);
    this.writes += 1;
    await this.beforeSave?.();
    const key = composerRouteKey(draft);
    if ((this.records.get(key)?.revision ?? 0) !== expectedRevision) throw new ComposerStorageError('conflict');
    const revision = expectedRevision + 1;
    this.records.set(key, clone({ ...draft, revision }));
    return revision;
  }
}
function clone(record: StoredComposerDraft): StoredComposerDraft {
  const files = (items: File[]) => items.map((file) => new File([file], file.name, { type: file.type, lastModified: file.lastModified }));
  return { ...record, images: files(record.images), queue: record.queue.map((item) => ({ ...item, options: item.options ? structuredClone(item.options) : undefined, images: files(item.images) })) };
}
const dataFiles = () => [
  new File([new Uint8Array([0, 255, 17, 0, 96])], 'first.png', { type: 'image/png', lastModified: 111 }),
  new File([new Uint8Array([128, 0, 254, 21])], 'second.png', { type: 'image/png', lastModified: 222 }),
];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
type Args = Parameters<typeof useChatComposerState>[0];
const base: Args = {
  selectedProject: { projectId: 'freeze-project', fullPath: '/fixture', displayName: 'Fixture', origin: 'explicit' },
  selectedSession: { id: 'a', __provider: 'gjc' }, currentSessionId: null,
  gjcModel: 'fixture/model', reasoningEffort: 'xhigh', isLoading: true, canAbortSession: false, tokenBudget: null,
  sendMessage() {}, addMessage() {}, scrollToBottom() {}, setIsUserScrolledUp() {}, setPendingPermissionRequests() {},
};
const composer = (repository: ComposerDraftRepository, overrides: Partial<Args> = {}) => renderHook((props: Partial<Args>) => useChatComposerState({ ...base, draftRepository: repository, ...props }), { initialProps: overrides });
const saved = (view: ReturnType<typeof composer>) => waitFor(() => assert.equal(view.result.current.draftPersistence.phase, 'saved'));
const submit = () => ({ preventDefault() {} }) as never;
const rejectedWith = (reason: string) => (error: unknown) => Boolean(error && typeof error === 'object' && 'reason' in error && error.reason === reason);
let epoch = 0;
const request = (ttlMs = 2000) => ({ token: `fixture-${++epoch}`, epoch, ttlMs });
async function freeze(ttlMs?: number) {
  let receipt!: ComposerFreezeReceipt;
  await act(async () => { receipt = await prepareComposerFreeze(request(ttlMs)); });
  return receipt;
}
const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { chat: english } } });
const originalFetch = globalThis.fetch;
beforeEach(() => { resetComposerFreezeForTests(); epoch = 0; localStorage.clear(); globalThis.fetch = async () => new Response('[]'); });
afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-composer-attachment-picker]').forEach((input) => input.dispatchEvent(new Event('cancel')));
  resetComposerFreezeForTests(); localStorage.clear(); globalThis.fetch = originalFetch;
});

test('operation IDs reject duplicate/reused admission and stale releases cannot clear another lifetime', async () => {
  const first = beginComposerOperation('steer', 'one-shot-id')!;
  assert.ok(first);
  assert.equal(beginComposerOperation('send', 'one-shot-id'), null);
  await assert.rejects(prepareComposerFreeze(request()), rejectedWith('busy'));
  finishComposerOperation('one-shot-id'); first(); first();
  assert.equal(beginComposerOperation('steer', 'one-shot-id'), null, 'an exact-ID late ACK must never address a reused lifetime');
  const newer = beginComposerOperation('steer', 'different-id')!;
  finishComposerOperation('one-shot-id'); first();
  await assert.rejects(prepareComposerFreeze(request()), rejectedWith('busy'));
  newer(); await freeze();
});

test('even test-only page reset cannot let an old release closure delete a replacement entry', async () => {
  const old = beginComposerOperation('send', 'fixture-id')!;
  resetComposerFreezeForTests();
  const current = beginComposerOperation('send', 'fixture-id')!;
  old(); old();
  await assert.rejects(prepareComposerFreeze(request()), rejectedWith('busy'));
  current(); await freeze();
});

/** Real production ChatComposer plus production hook; no alternative send UI. */
function Composer({ repository }: { repository: Repository }) {
  const c = useChatComposerState({ ...base, draftRepository: repository });
  return <I18nextProvider i18n={i18n}>
    <output data-testid="persistence">{c.draftPersistence.phase}</output>
    <ChatComposer
      {...c} pendingPermissionRequests={[]} handlePermissionDecision={c.handlePermissionDecision}
      isLoading sessionState={null} onShowTokenUsage={() => {}} onAbortSession={c.handleAbortSession}
      onSubmit={c.handleSubmit} onSteer={c.handleSteer}
      onEditQueuedDraft={c.editQueuedDraft} onDeleteQueuedDraft={c.deleteQueuedDraft} onMoveQueuedDraft={c.moveQueuedDraft}
      onConfirmCommandGate={c.confirmCommandGate} onCancelCommandGate={c.cancelCommandGate}
      onRemoveImage={(index) => c.setAttachedImages((files) => files.filter((_, position) => position !== index))}
      onSelectFile={c.selectFile} onCommandSelect={c.handleCommandSelect}
      onCloseCommandMenu={c.resetCommandMenuState} isCommandMenuOpen={c.showCommandMenu}
      onInputChange={c.handleInputChange} onTextareaClick={c.handleTextareaClick} onTextareaKeyDown={c.handleKeyDown}
      onTextareaPaste={c.handlePaste} onTextareaScrollSync={c.syncInputOverlayScroll} onTextareaInput={c.handleTextareaInput}
      placeholder="Freeze fixture" onRetryDraftPersistence={c.retryDraftPersistence}
    />
  </I18nextProvider>;
}

test('real composer freezes synchronously, commits all dataFiles and queued options, and keeps new edits', async () => {
  const repository = new Repository();
  const view = render(<Composer repository={repository} />);
  await waitFor(() => assert.equal(view.getByTestId('persistence').textContent, 'saved'));
  const textarea = view.getByPlaceholderText('Freeze fixture') as HTMLTextAreaElement;
  const form = textarea.closest('form')!;
  const files = dataFiles();
  fireEvent.change(textarea, { target: { value: 'queued with file' } });
  fireEvent.paste(textarea, { clipboardData: { items: [], files: [files[0]] } });
  fireEvent.submit(form);
  fireEvent.change(textarea, { target: { value: 'active with file' } });
  fireEvent.paste(textarea, { clipboardData: { items: [], files: [files[1]] } });
  const commit = deferred(); repository.beforeSave = () => commit.promise;
  let acknowledged = false;
  let pending!: Promise<ComposerFreezeReceipt>;
  act(() => {
    pending = prepareComposerFreeze(request()).then((receipt) => { acknowledged = true; return receipt; });
    assert.equal(isComposerFrozen(), true);
    fireEvent.submit(form); // Before React has rerendered the disabled buttons.
  });
  assert.equal(textarea.value, 'active with file');
  await act(async () => { await Promise.resolve(); });
  assert.equal(acknowledged, false);
  let receipt!: ComposerFreezeReceipt;
  await act(async () => { commit.resolve(); receipt = await pending; });
  assert.equal(receipt.drafts[0].fileCount, 2);
  assert.equal(receipt.drafts[0].queuedIntentCount, 1);
  assert.equal(receipt.installerAuthority, false);
  assert.equal(receipt.scope, 'page');
  assert.equal(isComposerFreezeCurrent(receipt), true);
  assert.equal(isComposerFreezeCurrent({ ...receipt }), false, 'serialized evidence is not a live page lease');
  const stored = [...repository.records.values()][0];
  assert.deepEqual(new Uint8Array(await stored.queue[0].images[0].arrayBuffer()), new Uint8Array(await files[0].arrayBuffer()));
  assert.deepEqual(new Uint8Array(await stored.images[0].arrayBuffer()), new Uint8Array(await files[1].arrayBuffer()));
  assert.equal(stored.queue[0].options?.effort, 'xhigh');
  assert.equal(view.getByRole('button', { name: english.input.queue.sendNext }).hasAttribute('disabled'), true);
  fireEvent.change(textarea, { target: { value: 'late input must survive' } });
  assert.equal(isComposerFreezeCurrent(receipt), false);
  assert.equal(isComposerFrozen(), false);
  assert.equal(textarea.value, 'late input must survive');
});

test('offscreen and unmounted pending writes remain in the receipt until their commit', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  const files = dataFiles(); const commit = deferred(); repository.beforeSave = () => commit.promise;
  act(() => { view.result.current.setInput('A'); view.result.current.setAttachedImages([files[0]]); });
  view.rerender({ selectedSession: { id: 'b', __provider: 'gjc' } });
  act(() => { view.result.current.setInput('B'); view.result.current.setAttachedImages([files[1]]); });
  await waitFor(() => assert.ok(repository.writes >= 2));
  view.unmount();
  let done = false;
  const pending = prepareComposerFreeze(request()).then((receipt) => { done = true; return receipt; });
  await Promise.resolve(); assert.equal(done, false);
  commit.resolve();
  const receipt = await pending;
  assert.deepEqual(receipt.drafts.map((item) => [JSON.parse(item.routeKey)[1], item.fileCount]), [['a', 1], ['b', 1]]);
  assert.equal(isComposerFreezeCurrent(receipt), true);
  cancelComposerFreeze(receipt);
  const reopened = composer(repository); await saved(reopened);
  assert.equal(reopened.result.current.input, 'A');
  assert.deepEqual(new Uint8Array(await reopened.result.current.attachedImages[0].arrayBuffer()), new Uint8Array(await files[0].arrayBuffer()));
  const next = await freeze();
  assert.equal(next.drafts.filter((item) => JSON.parse(item.routeKey)[1] === 'a').length, 1, 'settled remount replaces only its prior owner');
});

for (const operation of ['upload', 'allocation'] as const) {
  test(`an accepted ${operation} makes freeze fail/reopen without aborting its eventual send`, async () => {
    const repository = new Repository(); const work = deferred(); let entered = false; const sent: unknown[] = [];
    globalThis.fetch = async (url) => {
      if (String(url).endsWith(operation === 'upload' ? '/images' : '/providers/sessions')) {
        entered = true; await work.promise;
        return new Response(operation === 'upload' ? '{"images":[]}' : '{"data":{"sessionId":"allocated"}}');
      }
      return new Response('[]');
    };
    const view = composer(repository, { isLoading: false, ...(operation === 'allocation' ? { selectedSession: null } : {}), sendMessage: (message) => { sent.push(message); } });
    await saved(view);
    act(() => { view.result.current.setInput('accepted work'); if (operation === 'upload') view.result.current.setAttachedImages(dataFiles()); });
    let sending!: Promise<void>;
    act(() => { sending = view.result.current.handleSubmit(submit()); });
    await waitFor(() => assert.equal(entered, true));
    await act(async () => { await assert.rejects(prepareComposerFreeze(request()), rejectedWith('busy')); });
    assert.equal(isComposerFrozen(), false);
    assert.equal(view.result.current.input, 'accepted work');
    await act(async () => { work.resolve(); await sending; });
    assert.equal(sent.length, 1);
    await freeze();
  });
}

test('unmount does not remove the active-upload fence, and late upload keeps the old route draft', async () => {
  const repository = new Repository(); const work = deferred(); let entered = false;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/images')) { entered = true; await work.promise; return new Response('{"images":[]}'); }
    return new Response('[]');
  };
  const view = composer(repository, { isLoading: false }); await saved(view);
  act(() => { view.result.current.setInput('unsent original route'); view.result.current.setAttachedImages(dataFiles()); });
  let sending!: Promise<void>;
  act(() => { sending = view.result.current.handleSubmit(submit()); });
  await waitFor(() => assert.equal(entered, true)); view.unmount();
  await assert.rejects(prepareComposerFreeze(request()), rejectedWith('busy'));
  work.resolve(); await sending;
  const receipt = await freeze();
  assert.equal(receipt.drafts[0].fileCount, 2);
  assert.equal([...repository.records.values()][0].input, 'unsent original route');
});

test('steering stays busy offscreen until its acknowledgement durably settles the original intent', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  act(() => view.result.current.setInput('steer A'));
  act(() => view.result.current.handleSteer(submit())); await saved(view);
  view.rerender({ selectedSession: { id: 'b', __provider: 'gjc' } }); await saved(view);
  await act(async () => { await assert.rejects(prepareComposerFreeze(request()), rejectedWith('busy')); });
  act(() => view.result.current.resolveSteerResult('steer A', true, 'a'));
  const receipt = await freeze();
  assert.equal(receipt.drafts.reduce((sum, item) => sum + item.queuedIntentCount, 0), 0);
});

test('a replacement composer settles an unmounted steer using its retained original project', async () => {
  const repository = new Repository(); const original = composer(repository); await saved(original);
  act(() => original.result.current.setInput('unmounted steer'));
  act(() => original.result.current.handleSteer(submit())); await saved(original); original.unmount();
  const replacement = composer(repository, { selectedProject: { ...base.selectedProject!, projectId: 'other-project' }, selectedSession: { id: 'b', __provider: 'gjc' } });
  await saved(replacement);
  act(() => replacement.result.current.setInput('keep B')); await saved(replacement);
  await act(async () => { await assert.rejects(prepareComposerFreeze(request()), rejectedWith('busy')); });
  act(() => replacement.result.current.resolveSteerResult('unmounted steer', true, 'a'));
  await freeze();
  assert.equal(repository.records.get(JSON.stringify(['freeze-project', 'a']))?.queue.length, 0);
  assert.equal(repository.records.has(JSON.stringify(['other-project', 'a'])), false);
  assert.equal(replacement.result.current.input, 'keep B');
});

test('cancel, superseding epochs and TTL invalidate late commits and never unlock a newer lease', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  act(() => view.result.current.setInput('durable after cancellation')); await saved(view);
  const commit = deferred(); repository.beforeSave = () => commit.promise;
  const first = request(); let old!: Promise<ComposerFreezeReceipt>;
  act(() => { old = prepareComposerFreeze(first); });
  const rejected = assert.rejects(old, rejectedWith('cancelled'));
  assert.equal(cancelComposerFreeze({ ...first, token: 'wrong' }), false);
  act(() => { assert.equal(cancelComposerFreeze(first), true); });
  await rejected;
  const second = request(); let next!: Promise<ComposerFreezeReceipt>;
  act(() => { next = prepareComposerFreeze(second); });
  assert.equal(cancelComposerFreeze(first), false);
  await assert.rejects(prepareComposerFreeze(first), rejectedWith('stale'));
  let receipt!: ComposerFreezeReceipt;
  await act(async () => { commit.resolve(); receipt = await next; });
  assert.equal(isComposerFreezeCurrent(receipt), true);
  const expiring = await freeze(30);
  assert.equal(isComposerFreezeCurrent(receipt), false);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  assert.equal(isComposerFreezeCurrent(expiring), false);
  assert.equal(isComposerFrozen(), false);
});

test('a genuinely stalled commit expires without aborting the write or issuing a late ACK', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  const commit = deferred(); repository.beforeSave = () => commit.promise;
  act(() => { view.result.current.setInput('late commit'); view.result.current.setAttachedImages(dataFiles()); });
  await act(async () => { await assert.rejects(prepareComposerFreeze(request(25)), rejectedWith('timeout')); });
  assert.equal(isComposerFrozen(), false);
  assert.equal(repository.records.size, 0);
  await act(async () => { commit.resolve(); }); await saved(view);
  assert.equal([...repository.records.values()][0].input, 'late commit');
  assert.equal(isComposerFrozen(), false);
  assert.equal((await freeze()).drafts[0].fileCount, 2);
});

test('a superseded verifier cannot start later-route writes after the new lease has acknowledged', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  act(() => { view.result.current.setInput('route A'); view.result.current.setAttachedImages(dataFiles()); }); await saved(view);
  view.rerender({ selectedSession: { id: 'b', __provider: 'gjc' } }); await saved(view);
  act(() => view.result.current.setInput('route B')); await saved(view);
  const reading = deferred(); let intercepted = false;
  repository.readBack = (record) => {
    if (!intercepted && record.conversation === 'a') {
      intercepted = true;
      const file = record.images[0];
      const arrayBuffer = file.arrayBuffer.bind(file);
      file.arrayBuffer = async () => { await reading.promise; return arrayBuffer(); };
    }
    return record;
  };
  let pending!: Promise<ComposerFreezeReceipt>;
  act(() => { pending = prepareComposerFreeze(request()); });
  const rejected = assert.rejects(pending, rejectedWith('stale'));
  await waitFor(() => assert.equal(intercepted, true));
  const current = await freeze(); await rejected;
  const writes = repository.writes;
  await act(async () => { reading.resolve(); });
  assert.equal(repository.writes, writes, 'late old verification must not write B');
  assert.equal(isComposerFreezeCurrent(current), true);
});

test('a synchronous native freeze request inside accepted send fails busy without duplicate sending', async () => {
  const repository = new Repository(); let attempted!: Promise<ComposerFreezeReceipt>; let sends = 0;
  const view = composer(repository, { isLoading: false, sendMessage: () => { sends += 1; attempted = prepareComposerFreeze(request()); void attempted.catch(() => {}); } });
  await saved(view);
  act(() => view.result.current.setInput('one accepted send'));
  await act(async () => view.result.current.handleSubmit(submit()));
  await assert.rejects(attempted, rejectedWith('busy'));
  assert.equal(sends, 1);
  assert.equal(isComposerFrozen(), false);
});

test('steer and voice-send callbacks captured before freeze cannot dispatch new work', async () => {
  const repository = new Repository(); const sent: unknown[] = [];
  const view = composer(repository, { sendMessage: (message) => { sent.push(message); } }); await saved(view);
  act(() => view.result.current.setInput('kept input')); await saved(view);
  const steer = view.result.current.handleSteer;
  const receipt = await freeze();
  act(() => { steer(submit()); });
  act(() => { view.result.current.handlePermissionDecision('pending-request', { allow: true }); });
  assert.equal(sent.length, 0);
  assert.equal(view.result.current.input, 'kept input');
  act(() => { view.result.current.handleVoiceTranscript('late transcript', true); });
  assert.equal(sent.length, 0);
  assert.equal(view.result.current.input, 'kept input late transcript');
  assert.equal(view.result.current.queuedDrafts.length, 0);
  assert.equal(isComposerFreezeCurrent(receipt), false);
});

test('a pending command confirmation retains its text and Files in the durable draft', async () => {
  const repository = new Repository(); const view = composer(repository, { isLoading: false }); await saved(view);
  act(() => { view.result.current.setInput('/clear'); view.result.current.setAttachedImages(dataFiles()); });
  await act(async () => view.result.current.handleSubmit(submit()));
  assert.ok(view.result.current.pendingCommandGate);
  const receipt = await freeze();
  assert.equal(receipt.drafts[0].fileCount, 2);
  assert.equal([...repository.records.values()][0].input, '/clear');
  act(() => { view.result.current.confirmCommandGate(); });
  assert.ok(view.result.current.pendingCommandGate);
  act(() => { view.result.current.handleInputChange({ target: { value: 'replacement draft', selectionStart: 17 } } as never); });
  assert.equal(view.result.current.pendingCommandGate, null, 'editing invalidates the old confirmation');
  assert.equal(view.result.current.input, 'replacement draft');
});

test('storage events and direct projection changes invalidate an already-issued receipt', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  act(() => view.result.current.setInput('local')); await saved(view);
  const first = await freeze();
  act(() => { window.dispatchEvent(new Event('storage')); });
  assert.equal(isComposerFreezeCurrent(first), false);
  const second = await freeze();
  localStorage.setItem('draft_input_session_a', 'external overwrite');
  act(() => { assert.equal(isComposerFreezeCurrent(second), false); });
  assert.equal(isComposerFrozen(), false);
});

for (const reason of ['quota', 'unavailable', 'conflict', 'timeout'] as const) {
  test(`${reason} rejects a receipt and reopens without dropping File input`, async () => {
    const repository = new Repository(); const view = composer(repository); await saved(view);
    act(() => { view.result.current.setInput('keep me'); view.result.current.setAttachedImages(dataFiles()); }); await saved(view);
    repository.beforeSave = async () => { throw new ComposerStorageError(reason); };
    await act(async () => { await assert.rejects(prepareComposerFreeze(request()), rejectedWith(reason)); });
    assert.equal(isComposerFrozen(), false);
    assert.equal(view.result.current.input, 'keep me');
    assert.equal(view.result.current.attachedImages.length, 2);
  });
}

test('same File metadata with different committed bytes is a conflict, not an ACK', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  act(() => { view.result.current.setInput('file verification'); view.result.current.setAttachedImages(dataFiles()); }); await saved(view);
  repository.readBack = (record) => ({ ...record, images: record.images.map((file) => new File([new Uint8Array(file.size)], file.name, { type: file.type, lastModified: file.lastModified })) });
  await act(async () => { await assert.rejects(prepareComposerFreeze(request()), rejectedWith('conflict')); });
  assert.equal(isComposerFrozen(), false);
});

test('an edit during a pending commit revokes the receipt and preserves the newer dataFiles', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  const commit = deferred(); repository.beforeSave = () => commit.promise;
  act(() => view.result.current.setInput('first'));
  let pending!: Promise<ComposerFreezeReceipt>;
  act(() => { pending = prepareComposerFreeze(request()); });
  const rejected = assert.rejects(pending, rejectedWith('changed'));
  act(() => { view.result.current.setInput('newest'); view.result.current.setAttachedImages(dataFiles()); });
  await rejected;
  await act(async () => commit.resolve()); await saved(view);
  assert.equal([...repository.records.values()][0].input, 'newest');
  assert.equal([...repository.records.values()][0].images.length, 2);
});

test('orphan legacy queues and unavailable IndexedDB never masquerade as durable receipts', async () => {
  writeQueuedMessages('orphan', [{ content: 'no durable owner' }]);
  await assert.rejects(prepareComposerFreeze(request()), rejectedWith('unavailable'));
  localStorage.clear();
  const view = renderHook(() => useChatComposerState(base));
  act(() => view.result.current.setInput('no IndexedDB'));
  await act(async () => { await assert.rejects(prepareComposerFreeze(request()), rejectedWith('unavailable')); });
  assert.equal(view.result.current.input, 'no IndexedDB');
});

test('a scheduled visible queue holds on freeze and resumes exactly once on cancellation', async () => {
  const repository = new Repository(); const sent: unknown[] = [];
  const sendMessage = (message: unknown) => { sent.push(message); };
  const view = composer(repository, { sendMessage }); await saved(view);
  act(() => view.result.current.setInput('queued'));
  await act(async () => view.result.current.handleSubmit(submit())); await saved(view);
  view.rerender({ sendMessage, isLoading: false });
  const receipt = await freeze();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
  assert.equal(sent.length, 0);
  assert.equal(view.result.current.queuedDrafts.length, 1);
  act(() => { cancelComposerFreeze(receipt); });
  await waitFor(() => assert.equal(sent.length, 1));
  assert.equal(view.result.current.queuedDrafts.length, 0);
});

test('offscreen auto-dispatch holds completions/reconnects and retires an unmounted durable intent once', async () => {
  const repository = new Repository(); const draft = composer(repository); await saved(draft);
  act(() => draft.result.current.setInput('offscreen intent'));
  await act(async () => draft.result.current.handleSubmit(submit())); await saved(draft); draft.unmount();
  const receipt = await freeze();
  const sent: unknown[] = [];
  const socket = Object.assign(new EventTarget(), { readyState: WebSocket.OPEN }) as WebSocket;
  const busy: SessionActivityMap = new Map([['a', { startedAt: 1, statusText: null, canInterrupt: true, awaitingInput: false }]]);
  const view = renderHook(({ processingSessions }: { processingSessions: SessionActivityMap }) => useQueuedMessageAutoSend({
    processingSessions, activeSessionId: 'b', ws: socket, sendMessage: (message) => { sent.push(message); }, markSessionProcessing() {},
  }), { initialProps: { processingSessions: busy } });
  view.rerender({ processingSessions: new Map() });
  act(() => { socket.dispatchEvent(new Event('open')); });
  assert.equal(sent.length, 0);
  assert.equal(readQueuedMessages('a').length, 1);
  act(() => { cancelComposerFreeze(receipt); socket.dispatchEvent(new Event('open')); });
  assert.equal(sent.length, 1);
  await waitFor(() => assert.equal([...repository.records.values()][0].queue.length, 0));
  assert.deepEqual(readQueuedMessages('a'), []);
});

for (const outcome of ['change', 'cancel'] as const) {
  test(`the attachment picker retains its actual root through unmount and settles on ${outcome}`, async () => {
    const repository = new Repository(); const view = composer(repository); await saved(view);
    const receipt = await freeze();
    act(() => view.result.current.openImagePicker());
    assert.equal(document.querySelector('[data-composer-attachment-picker]'), null);
    act(() => { cancelComposerFreeze(receipt); view.result.current.openImagePicker(); });
    const picker = document.querySelector<HTMLInputElement>('[data-composer-attachment-picker]')!;
    assert.ok(picker); view.unmount();
    await assert.rejects(prepareComposerFreeze(request()), rejectedWith('busy'));
    await act(async () => {
      if (outcome === 'change') fireEvent.change(picker, { target: { files: dataFiles() } });
      else picker.dispatchEvent(new Event('cancel'));
    });
    await waitFor(() => assert.equal(picker.isConnected, false));
    if (outcome === 'change') await waitFor(() => assert.equal([...repository.records.values()][0]?.images.length, 2));
    const final = await freeze();
    assert.equal(final.drafts.reduce((count, draft) => count + draft.fileCount, 0), outcome === 'change' ? 2 : 0);
  });
}

test('asynchronous dropped File allocation remains admitted and saves to its unmounted original composer', async () => {
  const repository = new Repository(); const view = render(<Composer repository={repository} />);
  await waitFor(() => assert.equal(view.getByTestId('persistence').textContent, 'saved'));
  const file = dataFiles()[0]; let materialize!: () => void;
  const entry = { isFile: true, file(resolve: (value: File) => void) { materialize = () => resolve(file); } };
  fireEvent.drop(view.getByPlaceholderText('Freeze fixture').closest('form')!, { dataTransfer: {
    types: ['Files'], files: [], items: [{ kind: 'file', type: file.type, webkitGetAsEntry: () => entry, getAsFile: () => file }],
  } });
  assert.equal(typeof materialize, 'function'); view.unmount();
  await assert.rejects(prepareComposerFreeze(request()), rejectedWith('busy'));
  await act(async () => materialize());
  await waitFor(() => assert.equal([...repository.records.values()][0]?.images.length, 1));
  assert.equal((await freeze()).drafts[0].fileCount, 1);
});

test('workspace resolution, descent and session allocation share the accepted send root until settlement', async () => {
  const repository = new Repository(); const stages = [deferred(), deferred(), deferred()]; let entered = -1;
  const sent: unknown[] = []; const text = 'work in child repo';
  globalThis.fetch = async (url) => {
    const path = String(url);
    const stage = path.includes(`/resolve-target?text=${encodeURIComponent(text)}`) ? 0 : path.endsWith('/descend') ? 1 : path.endsWith('/providers/sessions') ? 2 : -1;
    if (stage >= 0) { entered = stage; await stages[stage].promise; }
    if (stage === 0) return new Response(JSON.stringify({ data: { isWorkspace: true, candidates: [{ path: '/fixture/child', name: 'child', score: 100, reason: 'mention' }] } }));
    if (stage === 1) return new Response(JSON.stringify({ data: { ...base.selectedProject, projectId: 'child', fullPath: '/fixture/child' } }));
    if (stage === 2) return new Response('{"data":{"sessionId":"allocated-child"}}');
    return new Response('[]');
  };
  const view = composer(repository, { selectedSession: null, isLoading: false, sendMessage: (message) => { sent.push(message); } }); await saved(view);
  act(() => view.result.current.setInput(text));
  let sending!: Promise<void>; act(() => { sending = view.result.current.handleSubmit(submit()); });
  for (let stage = 0; stage < stages.length; stage += 1) {
    await waitFor(() => assert.equal(entered, stage));
    await act(async () => { await assert.rejects(prepareComposerFreeze(request()), rejectedWith('busy')); stages[stage].resolve(); });
  }
  await act(async () => sending);
  assert.equal(sent.length, 1); await freeze();
});
