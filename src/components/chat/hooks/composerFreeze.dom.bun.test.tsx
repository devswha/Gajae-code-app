import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { StrictMode } from 'react';
import { I18nextProvider } from 'react-i18next';

import { useQueuedMessageAutoSend } from '../../../hooks/useQueuedMessageAutoSend';
import type { SessionActivityMap } from '../../../hooks/useSessionProtection';
import english from '../../../i18n/locales/en/chat.json';
import { beginComposerOperation, cancelComposerFreeze, finishComposerOperation, invalidateComposerFreeze, isComposerFreezeCurrent, isComposerFrozen, isComposerSealed, prepareComposerFreeze, registerComposerSealRollbackOwner, resetComposerFreezeForTests, sealComposerFreeze, type ComposerFreezeReceipt } from '../../../shared/composerFreeze';
import { draftInputKey, readQueuedMessages, safeLocalStorage, writeQueuedMessages } from '../utils/chatStorage';
import { boundedComposerDraft, browserComposerDraftRepository, composerRouteKey, ComposerStorageError, type ComposerDraft, type ComposerDraftRepository, type ComposerRoute, type StoredComposerDraft } from '../utils/composerDraftStorage';
import { installComposerDraftStorageTestDriver } from '../utils/composerDraftStorage.testDriver';
import ChatComposer from '../view/ChatComposer';

import { useChatComposerState } from './useChatComposerState';
import { useDurableComposerDraft } from './useDurableComposerDraft';

// A deterministic commit/read-back seam, not an IDB polyfill or native G3
// certification. composerDraftStorage's transaction tests cover strict commit.
class Repository implements ComposerDraftRepository {
  records = new Map<string, StoredComposerDraft>();
  beforeLoad?: () => Promise<void>;
  beforeSave?: () => Promise<void>;
  readBack?: (draft: StoredComposerDraft) => StoredComposerDraft;
  writes = 0;
  async load(route: ComposerRoute) {
    await this.beforeLoad?.();
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
const svgFile = () => new File(['<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><text>restart fixture</text></svg>'.padEnd(172, ' ')], 'fixture.svg', { type: 'image/svg+xml', lastModified: 1234567 });
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
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
beforeEach(() => { resetComposerFreezeForTests(); epoch = 0; localStorage.clear(); globalThis.fetch = async () => new Response('[]'); });
afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-composer-attachment-picker]').forEach((input) => input.dispatchEvent(new Event('cancel')));
  resetComposerFreezeForTests(); localStorage.clear(); globalThis.fetch = originalFetch;
  if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
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
function Composer({ repository, overrides = {} }: { repository: Repository; overrides?: Partial<Args> }) {
  const c = useChatComposerState({ ...base, draftRepository: repository, ...overrides });
  return <I18nextProvider i18n={i18n}>
    <output data-testid="persistence">{c.draftPersistence.phase}</output>
    <ChatComposer
      {...c} pendingPermissionRequests={[]} handlePermissionDecision={c.handlePermissionDecision}
      isLoading={overrides.isLoading ?? base.isLoading} sessionState={null} onShowTokenUsage={() => {}} onAbortSession={c.handleAbortSession}
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

for (const conversation of ['a', null]) {
  for (const unmount of [false, true]) {
    test(`fresh-page SVG restore keeps prepare/seal current through frozen rerenders (${conversation ?? 'new chat'}, ${unmount ? 'unmounted' : 'mounted'})`, async () => {
      const repository = new Repository();
      const overrides: Partial<Args> = { selectedSession: conversation ? { id: conversation, __provider: 'gjc' } : null, isLoading: false };
      const previous = composer(repository, overrides); await saved(previous);
      const file = svgFile();
      act(() => { previous.result.current.setInput('persisted unsent draft'); previous.result.current.setAttachedImages([file]); });
      await saved(previous); previous.unmount();
      // A restart loses the page registry, but keeps both committed records and
      // localStorage projections. The repository seam clones each restored File.
      resetComposerFreezeForTests();
      const view = render(<Composer repository={repository} overrides={overrides} />, { wrapper: StrictMode });
      await waitFor(() => assert.equal(view.getByTestId('persistence').textContent, 'saved'));
      const textarea = view.getByPlaceholderText('Freeze fixture') as HTMLTextAreaElement;
      assert.equal(textarea.value, 'persisted unsent draft');
      assert.ok(view.getByRole('img', { name: 'fixture.svg' }));
      const writes = repository.writes;
      const commit = deferred(); repository.beforeSave = () => commit.promise;
      let pending!: Promise<ComposerFreezeReceipt>; let acknowledged = false;
      act(() => { pending = prepareComposerFreeze(request()).then((receipt) => { acknowledged = true; return receipt; }); });
      // Exercise a committed frozen render before verification can finish, not
      // only the pre-paint state inside one asynchronous act().
      view.rerender(<Composer repository={repository} overrides={{ ...overrides, selectedProject: { ...base.selectedProject! } }} />);
      assert.equal(isComposerFrozen(), true);
      assert.equal(textarea.readOnly, false);
      await waitFor(() => assert.equal(repository.writes, writes + 1));
      assert.equal(acknowledged, false);
      if (unmount) view.unmount();
      let receipt!: ComposerFreezeReceipt;
      await act(async () => { commit.resolve(); receipt = await pending; });
      assert.equal(isComposerFreezeCurrent(receipt), true);
      assert.equal(receipt.drafts.length, 1, 'rerenders must not replace or duplicate the registered owner');
      assert.equal(receipt.drafts[0].routeKey, composerRouteKey({ projectId: 'freeze-project', conversation }));
      assert.equal(receipt.drafts[0].fileCount, 1);
      assert.equal(receipt.drafts[0].queuedIntentCount, 0);
      act(() => { assert.equal(sealComposerFreeze(receipt), true); });
      if (!unmount) {
        view.rerender(<Composer repository={repository} overrides={{ ...overrides }} />);
        assert.equal(textarea.readOnly, true);
        fireEvent.input(textarea, { target: { value: 'blocked after seal' } });
        assert.equal(textarea.value, 'persisted unsent draft');
      }
      assert.equal(isComposerFreezeCurrent(receipt), true, 'the seal notification must not re-register or reactivate unchanged ownership');
      assert.equal(repository.writes, writes + 1);
      const stored = repository.records.get(receipt.drafts[0].routeKey)!;
      assert.equal(stored.input, 'persisted unsent draft');
      assert.notEqual(stored.images[0], file);
      assert.equal(stored.images[0].size, 172);
      assert.equal(stored.images[0].type, file.type);
      assert.equal(stored.images[0].lastModified, file.lastModified);
      assert.deepEqual(await stored.images[0].arrayBuffer(), await file.arrayBuffer());
    });
  }
}

test('prepare waits for a restored SVG and its complete read-back bytes without invalidating the frozen rerender', async () => {
  const repository = new Repository(); const file = svgFile();
  const record = { projectId: 'freeze-project', conversation: 'a', input: 'still restoring', images: [file], queue: [], revision: 1 };
  repository.records.set(composerRouteKey(record), record);
  const key = draftInputKey(record.projectId, record.conversation);
  localStorage.setItem(key, record.input); localStorage.setItem(`composer_owner_${key}`, composerRouteKey(record));
  const restore = deferred(); repository.beforeLoad = () => restore.promise;
  const view = composer(repository, { isLoading: false });
  assert.equal(view.result.current.draftPersistence.phase, 'loading');
  assert.equal(view.result.current.attachedImages.length, 0);
  let pending!: Promise<ComposerFreezeReceipt>; let acknowledged = false;
  act(() => { pending = prepareComposerFreeze(request()).then((receipt) => { acknowledged = true; return receipt; }); });
  const bytes = deferred(); let reading = false;
  repository.readBack = (draft) => {
    if (repository.writes) {
      const arrayBuffer = draft.images[0].arrayBuffer.bind(draft.images[0]);
      draft.images[0].arrayBuffer = async () => { reading = true; await bytes.promise; return arrayBuffer(); };
    }
    return draft;
  };
  await act(async () => { restore.resolve(); });
  await waitFor(() => assert.equal(reading, true));
  assert.equal(view.result.current.input, record.input);
  assert.equal(view.result.current.attachedImages[0].size, 172);
  assert.equal(view.result.current.composerFrozen, true);
  view.rerender({ isLoading: false, selectedSession: { ...base.selectedSession! } });
  assert.equal(acknowledged, false, 'saved metadata alone must not acknowledge unread attachment bytes');
  let receipt!: ComposerFreezeReceipt;
  await act(async () => { bytes.resolve(); receipt = await pending; });
  act(() => { assert.equal(sealComposerFreeze(receipt), true); });
  assert.equal(isComposerFreezeCurrent(receipt), true);
  assert.equal(receipt.drafts[0].fileCount, 1);
});

for (const stage of ['read-back load', 'restored File bytes', 'read-back File bytes'] as const) {
  test(`unexpected ${stage} errors reject prepare without losing the restored SVG or its original exception`, async () => {
    const repository = new Repository();
    const record = { projectId: 'freeze-project', conversation: 'a', input: 'saved but unreadable', images: [svgFile()], queue: [], revision: 1 };
    repository.records.set(composerRouteKey(record), record);
    const view = composer(repository, { isLoading: false }); await saved(view);
    const failure = new DOMException('Synthetic storage read failure', stage === 'read-back load' ? 'UnknownError' : 'NotReadableError');
    const restored = view.result.current.attachedImages[0];
    const arrayBuffer = restored.arrayBuffer.bind(restored);
    if (stage === 'read-back load') repository.beforeLoad = async () => { throw failure; };
    else if (stage === 'restored File bytes') restored.arrayBuffer = async () => { throw failure; };
    else repository.readBack = (draft) => { draft.images[0].arrayBuffer = async () => { throw failure; }; return draft; };
    // Normalize browser exceptions, retaining the cause for private diagnostics.
    // Neither the saved status nor File metadata can stand in for readable bytes.
    await act(async () => { await assert.rejects(prepareComposerFreeze(request()), (error) => error instanceof ComposerStorageError && error.reason === 'storage' && error.cause === failure); });
    assert.equal(isComposerFrozen(), false);
    assert.equal(isComposerSealed(), false);
    assert.deepEqual(view.result.current.draftPersistence, { phase: 'error', reason: 'storage' });
    assert.equal(view.result.current.input, record.input);
    assert.equal(restored.size, 172);
    const stored = repository.records.get(composerRouteKey(record))!;
    assert.equal(stored.input, record.input);
    assert.deepEqual(await stored.images[0].arrayBuffer(), await record.images[0].arrayBuffer());
    repository.beforeLoad = undefined; repository.readBack = undefined; restored.arrayBuffer = arrayBuffer;
    await act(async () => { assert.equal(await view.result.current.retryDraftPersistence(), true); });
    const receipt = await freeze();
    act(() => { assert.equal(sealComposerFreeze(receipt), true); });
    assert.equal(isComposerFreezeCurrent(receipt), true);
  });
}

test('matching empty byte reads cannot acknowledge nonempty SVG metadata', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  act(() => { view.result.current.setInput('nonempty SVG'); view.result.current.setAttachedImages([svgFile()]); }); await saved(view);
  view.result.current.attachedImages[0].arrayBuffer = async () => new ArrayBuffer(0);
  repository.readBack = (draft) => { draft.images[0].arrayBuffer = async () => new ArrayBuffer(0); return draft; };
  await act(async () => { await assert.rejects(prepareComposerFreeze(request()), rejectedWith('conflict')); });
  assert.deepEqual(view.result.current.draftPersistence, { phase: 'error', reason: 'conflict' });
  assert.equal(isComposerFrozen(), false); assert.equal(view.result.current.attachedImages[0].size, 172);
});

test('a superseded verifier failing late cannot replace a newer saved status or invalidate its seal', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  act(() => { view.result.current.setInput('current SVG'); view.result.current.setAttachedImages([svgFile()]); }); await saved(view);
  const gate = deferred(); let reading = false;
  repository.readBack = (draft) => {
    if (!reading) draft.images[0].arrayBuffer = async () => { reading = true; await gate.promise; throw new DOMException('Synthetic retired read', 'NotFoundError'); };
    return draft;
  };
  let pending!: Promise<ComposerFreezeReceipt>;
  act(() => { pending = prepareComposerFreeze(request()); });
  const rejected = assert.rejects(pending, rejectedWith('stale'));
  await waitFor(() => assert.equal(reading, true));
  const current = await freeze(); await rejected;
  act(() => { assert.equal(sealComposerFreeze(current), true); });
  await act(async () => { gate.resolve(); });
  assert.deepEqual(view.result.current.draftPersistence, { phase: 'saved', reason: null });
  assert.equal(isComposerFreezeCurrent(current), true);
});

test('real repository prepare migrates restored legacy Files before rewrite and seals again after reopening', async () => {
  const driver = installComposerDraftStorageTestDriver(); driver.controls.invalidateLegacyOnPut = true;
  const legacy = { projectId: 'freeze-project', conversation: 'a', input: 'persisted draft with SVG', images: [svgFile()],
    queue: [{ id: 'review', content: 'queued SVG', images: [svgFile()], options: { effort: 'xhigh' }, requiresReview: true }], revision: 7 };
  const key = composerRouteKey(legacy);
  driver.records.set(key, legacy); driver.sizes.set(key, { bytes: boundedComposerDraft(legacy).bytes, revision: 7 });
  const view = composer(browserComposerDraftRepository, { isLoading: false }); await saved(view);
  const restored = view.result.current.attachedImages[0];
  const first = await freeze();
  assert.equal(first.drafts[0].fileCount, 2); assert.equal(first.drafts[0].queuedIntentCount, 1);
  act(() => { assert.equal(sealComposerFreeze(first), true); });
  assert.equal((driver.records.get(key) as { schemaVersion: number }).schemaVersion, 2);
  assert.deepEqual(await restored.arrayBuffer(), await legacy.images[0].arrayBuffer());
  assert.equal(view.result.current.input, legacy.input);
  view.unmount(); resetComposerFreezeForTests();
  const reopened = composer(browserComposerDraftRepository, { isLoading: false }); await saved(reopened);
  assert.equal(reopened.result.current.input, legacy.input);
  assert.equal(reopened.result.current.queuedDrafts[0].requiresReview, true);
  assert.deepEqual(reopened.result.current.queuedDrafts[0].options, { effort: 'xhigh' });
  const second = await freeze();
  act(() => { assert.equal(sealComposerFreeze(second), true); });
  assert.equal(isComposerFreezeCurrent(second), true);
  assert.deepEqual(await reopened.result.current.attachedImages[0].arrayBuffer(), await legacy.images[0].arrayBuffer());
});

test('an unreadable real-repository legacy draft stays errored through prepare, typing, clear, and retry without overwrite', async () => {
  const driver = installComposerDraftStorageTestDriver();
  const file = svgFile(); file.arrayBuffer = async () => { throw new DOMException('Synthetic missing persisted Blob', 'NotFoundError'); };
  const legacy = { projectId: 'freeze-project', conversation: 'a', input: 'unreadable legacy draft', images: [file], queue: [], revision: 7 };
  const key = composerRouteKey(legacy); const projection = draftInputKey(legacy.projectId, legacy.conversation);
  driver.records.set(key, legacy); driver.sizes.set(key, { bytes: boundedComposerDraft(legacy).bytes, revision: 7 });
  localStorage.setItem(projection, legacy.input); localStorage.setItem(`composer_owner_${projection}`, key);
  const view = composer(browserComposerDraftRepository);
  await waitFor(() => assert.deepEqual(view.result.current.draftPersistence, { phase: 'error', reason: 'storage' }));
  assert.equal(view.result.current.draftReady, false); assert.equal(view.result.current.input, legacy.input);
  await act(async () => { await assert.rejects(prepareComposerFreeze(request()), rejectedWith('storage')); });
  act(() => view.result.current.handleClearInput());
  act(() => view.result.current.setInput('new typing must not erase the unreadable record'));
  await act(async () => { assert.equal(await view.result.current.retryDraftPersistence(), false); });
  assert.deepEqual(view.result.current.draftPersistence, { phase: 'error', reason: 'storage' });
  assert.equal(driver.commits, 0); assert.equal(driver.records.get(key), legacy);
  assert.equal((driver.sizes.get(key) as { revision: number }).revision, 7);
});

test('a prior-page offscreen projection blocks a restored visible SVG until its durable owner is hydrated', async () => {
  const repository = new Repository(); const previous = composer(repository); await saved(previous);
  act(() => { previous.result.current.setInput('visible unsent'); previous.result.current.setAttachedImages([svgFile()]); }); await saved(previous);
  previous.rerender({ selectedSession: { id: 'offscreen', __provider: 'gjc' } }); await saved(previous);
  act(() => previous.result.current.setInput('offscreen unsent')); await saved(previous);
  previous.unmount(); resetComposerFreezeForTests();
  const view = composer(repository); await saved(view);
  await act(async () => { await assert.rejects(prepareComposerFreeze(request()), rejectedWith('unavailable')); });
  assert.equal(isComposerFrozen(), false);
  assert.equal(view.result.current.input, 'visible unsent');
  assert.equal(view.result.current.attachedImages[0].size, 172);
  assert.equal(localStorage.getItem(draftInputKey('freeze-project', 'offscreen')), 'offscreen unsent');
  const offscreen = renderHook(() => useDurableComposerDraft('freeze-project', 'offscreen', repository));
  await waitFor(() => assert.equal(offscreen.result.current.persistence.phase, 'saved'));
  offscreen.unmount();
  const receipt = await freeze();
  assert.equal(receipt.drafts.length, 2);
  act(() => { assert.equal(sealComposerFreeze(receipt), true); });
  assert.equal(isComposerFreezeCurrent(receipt), true);
});

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

test('prepare remains editable; sealing requires the exact fresh receipt and never reopens on expiry or invalidation', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  act(() => view.result.current.setInput('prepared draft')); await saved(view);
  const editable = await freeze();
  act(() => view.result.current.setInput('edit still allowed'));
  assert.equal(isComposerFrozen(), false); assert.equal(sealComposerFreeze(editable), false); await saved(view);
  const receipt = await freeze(50);
  assert.equal(sealComposerFreeze({ ...receipt }), false);
  act(() => { assert.equal(sealComposerFreeze(receipt), true); });
  assert.equal(isComposerSealed(), true); assert.equal(isComposerFreezeCurrent(receipt), true);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 70)); });
  assert.equal(isComposerFrozen(), true); assert.equal(isComposerSealed(), true);
  assert.equal(isComposerFreezeCurrent(receipt), false, 'expired evidence is reported, not silently thawed');
  act(() => invalidateComposerFreeze());
  assert.equal(cancelComposerFreeze(receipt), false, 'ordinary token cancellation is not native rollback');
  await assert.rejects(prepareComposerFreeze(request()), rejectedWith('sealed'));
  act(() => view.result.current.setInput('must not overwrite'));
  assert.equal(view.result.current.input, 'edit still allowed');
  const rollback = registerComposerSealRollbackOwner(() => true); // Test-only native rollback capability.
  assert.equal(rollback.cancel({ ...receipt, token: 'wrong' }), false);
  act(() => { assert.equal(rollback.cancel(receipt), true); });
  assert.equal(isComposerSealed(), false);
  act(() => view.result.current.setInput('after confirmed rollback')); await saved(view);
  assert.equal(view.result.current.input, 'after confirmed rollback'); rollback.unregister();
});

test('Window capture seals and rejects an input in flight before React paints or receives the event', async () => {
  let receipt: ComposerFreezeReceipt | undefined; let sealedDuringEvent = false; let readOnlyDuringSeal: boolean | undefined;
  const firstCapture = (event: Event) => {
    if (!receipt) return;
    sealedDuringEvent = sealComposerFreeze(receipt);
    readOnlyDuringSeal = (event.target as HTMLTextAreaElement).readOnly;
  };
  window.addEventListener('input', firstCapture, true); // Earlier than the root/field guard.
  let reachedDocument = 0; const downstream = () => { reachedDocument += 1; };
  document.addEventListener('input', downstream, true);
  try {
    const repository = new Repository(); const view = render(<Composer repository={repository} />);
    await waitFor(() => assert.equal(view.getByTestId('persistence').textContent, 'saved'));
    const textarea = view.getByPlaceholderText('Freeze fixture') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'saved before seal' } });
    fireEvent.paste(textarea, { clipboardData: { items: [], files: dataFiles() } });
    await waitFor(() => assert.equal(view.getByTestId('persistence').textContent, 'saved'));
    receipt = await freeze();
    assert.equal(textarea.readOnly, false, 'prepare alone is editable');
    const input = new Event('input', { bubbles: true, cancelable: true });
    act(() => { textarea.value = 'racing browser input'; textarea.dispatchEvent(input); });
    assert.equal(sealedDuringEvent, true); assert.equal(readOnlyDuringSeal, false, 'capture closes before React paint');
    assert.equal(input.defaultPrevented, true); assert.equal(reachedDocument, 0);
    assert.equal(textarea.value, 'saved before seal'); assert.equal(textarea.readOnly, true);
    assert.equal([...repository.records.values()][0].input, 'saved before seal');
    assert.equal([...repository.records.values()][0].images.length, 2);
  } finally { window.removeEventListener('input', firstCapture, true); document.removeEventListener('input', downstream, true); }
});

test('sealed real composer captures paste, drop, beforeinput and queue edits without reading new File data', async () => {
  const repository = new Repository(); const view = render(<Composer repository={repository} />);
  await waitFor(() => assert.equal(view.getByTestId('persistence').textContent, 'saved'));
  const textarea = view.getByPlaceholderText('Freeze fixture') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: 'queued original' } }); fireEvent.submit(textarea.closest('form')!);
  fireEvent.change(textarea, { target: { value: 'live original' } });
  await waitFor(() => assert.equal(view.getByTestId('persistence').textContent, 'saved'));
  const receipt = await freeze(); act(() => { assert.equal(sealComposerFreeze(receipt), true); });
  let reads = 0;
  for (const [type, property] of [['paste', 'clipboardData'], ['drop', 'dataTransfer'], ['beforeinput', 'data']] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, property, { get() { reads += 1; throw new Error('sealed input must not be consumed'); } });
    act(() => { textarea.dispatchEvent(event); }); assert.equal(event.defaultPrevented, true);
  }
  fireEvent.click(view.getByRole('button', { name: english.input.queue.edit }));
  fireEvent.click(view.getByRole('button', { name: english.input.queue.delete }));
  fireEvent.submit(textarea.closest('form')!);
  assert.equal(reads, 0); assert.equal(textarea.value, 'live original');
  const record = [...repository.records.values()][0]; assert.equal(record.input, 'live original');
  assert.equal(record.queue[0].content, 'queued original'); assert.equal(isComposerSealed(), true);
});

test('sealed setters and programmatic composer callbacks cannot mutate snapshots, queue projections, or input refs', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  for (const text of ['one', 'two']) {
    act(() => view.result.current.setInput(text)); await act(async () => view.result.current.handleSubmit(submit()));
  }
  act(() => { view.result.current.setInput('live'); view.result.current.setAttachedImages(dataFiles()); }); await saved(view);
  const receipt = await freeze(); act(() => { assert.equal(sealComposerFreeze(receipt), true); });
  const writes = repository.writes; const before = readQueuedMessages('a');
  const noUpdate = () => { throw new Error('sealed updater executed'); };
  act(() => {
    view.result.current.setInput(noUpdate); view.result.current.setAttachedImages(noUpdate);
    view.result.current.editQueuedDraft(0); view.result.current.deleteQueuedDraft(0); view.result.current.moveQueuedDraft(0, 1);
    view.result.current.handleVoiceTranscript('new voice', true); view.result.current.insertAtEnd('new comment');
    view.result.current.handleClearInput(); view.result.current.openImagePicker();
    view.result.current.handleInputChange({ target: { value: 'new DOM value' } } as never);
    view.result.current.handlePaste({ preventDefault() {}, get clipboardData() { throw new Error('sealed paste read'); } } as never);
    assert.equal(writeQueuedMessages('a', []), false);
    safeLocalStorage.setItem(draftInputKey('freeze-project', 'a'), 'replacement');
    safeLocalStorage.removeItem(draftInputKey('freeze-project', 'a'));
  });
  assert.equal(await view.result.current.retryDraftPersistence(), false);
  assert.equal(view.result.current.input, 'live'); assert.equal(view.result.current.attachedImages.length, 2);
  assert.deepEqual(view.result.current.queuedDrafts.map((item) => item.content), ['one', 'two']);
  assert.deepEqual(readQueuedMessages('a'), before); assert.equal(repository.writes, writes);
  const rollback = registerComposerSealRollbackOwner(() => true);
  act(() => { rollback.cancel(receipt); view.result.current.handleVoiceTranscript('appended'); }); await saved(view);
  assert.equal(view.result.current.input, 'live appended', 'blocked operations did not corrupt the live input ref');
  rollback.unregister();
});

test('sealed durable queue/update/retry APIs do not invoke new-route updaters or start new writes', async () => {
  const repository = new Repository();
  const view = renderHook(() => useDurableComposerDraft('project', 'A', repository));
  await waitFor(() => assert.equal(view.result.current.persistence.phase, 'saved'));
  act(() => view.result.current.setQueue([{ id: 'queued', content: 'keep', images: dataFiles() }]));
  await waitFor(() => assert.equal(view.result.current.persistence.phase, 'saved'));
  const receipt = await freeze(); act(() => { sealComposerFreeze(receipt); });
  const writes = repository.writes; const noUpdate = () => { throw new Error('sealed updater evaluated'); };
  act(() => {
    view.result.current.setQueue(noUpdate); view.result.current.setInput(noUpdate); view.result.current.setImages(noUpdate);
    view.result.current.updateQueue({ projectId: 'other', conversation: 'new' }, noUpdate);
  });
  assert.equal(await view.result.current.retryPersistence(), false);
  assert.equal(repository.writes, writes); assert.equal(repository.records.has(JSON.stringify(['other', 'new'])), false);
  assert.equal(view.result.current.queue[0].content, 'keep');
});

test('new routes and controller mounts remain sealed; rollback resumes deferred activation with the correct DOM value', async () => {
  const repository = new Repository(); const view = render(<Composer repository={repository} />);
  const ready = () => waitFor(() => assert.equal(view.getByTestId('persistence').textContent, 'saved'));
  await ready(); fireEvent.change(view.getByPlaceholderText('Freeze fixture'), { target: { value: 'original A' } }); await ready();
  const routeB = { selectedSession: { id: 'b', __provider: 'gjc' as const } };
  view.rerender(<Composer repository={repository} overrides={routeB} />); await ready();
  fireEvent.change(view.getByPlaceholderText('Freeze fixture'), { target: { value: 'original B' } }); await ready();
  view.rerender(<Composer repository={repository} />); await ready();
  const receipt = await freeze(); act(() => { sealComposerFreeze(receipt); }); const writes = repository.writes;
  view.rerender(<Composer repository={repository} overrides={routeB} />);
  const textarea = view.getByPlaceholderText('Freeze fixture') as HTMLTextAreaElement;
  fireEvent.input(textarea, { target: { value: 'bad B' } });
  assert.equal(textarea.value, 'original B'); assert.equal(isComposerSealed(), true); assert.equal(repository.writes, writes);
  const other = renderHook(() => useDurableComposerDraft('other', 'new', repository));
  act(() => other.result.current.setInput('blocked new owner'));
  assert.equal(other.result.current.input, ''); assert.equal(isComposerFrozen(), true);
  assert.equal(isComposerFreezeCurrent(receipt), false, 'new ownership invalidation is reported without reopening');
  const rollback = registerComposerSealRollbackOwner(() => true);
  act(() => { assert.equal(rollback.cancel(receipt), true); });
  await waitFor(() => assert.equal(other.result.current.persistence.phase, 'saved'));
  fireEvent.change(textarea, { target: { value: 'B after rollback' } }); await ready();
  assert.equal(repository.records.get(JSON.stringify(['freeze-project', 'b']))?.input, 'B after rollback'); rollback.unregister();
});

test('sealed visible and offscreen queues stay paused past TTL and resume exactly once after explicit rollback', async () => {
  const repository = new Repository(); const sent: unknown[] = [];
  const sendMessage = (message: unknown) => { sent.push(message); };
  const view = composer(repository, { sendMessage }); await saved(view);
  act(() => view.result.current.setInput('visible queued')); await act(async () => view.result.current.handleSubmit(submit())); await saved(view);
  view.rerender({ sendMessage, isLoading: false });
  const receipt = await freeze(50); act(() => { sealComposerFreeze(receipt); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); invalidateComposerFreeze(); });
  assert.equal(sent.length, 0); assert.equal(view.result.current.queuedDrafts.length, 1); assert.equal(isComposerSealed(), true);
  view.unmount();
  const socket = Object.assign(new EventTarget(), { readyState: WebSocket.OPEN }) as WebSocket;
  const busy: SessionActivityMap = new Map([['a', { startedAt: 1, statusText: null, canInterrupt: true, awaitingInput: false }]]);
  const background = renderHook(({ processingSessions }: { processingSessions: SessionActivityMap }) => useQueuedMessageAutoSend({ processingSessions, activeSessionId: 'b', ws: socket, sendMessage, markSessionProcessing() {} }), { initialProps: { processingSessions: busy } });
  background.rerender({ processingSessions: new Map() }); act(() => socket.dispatchEvent(new Event('open')));
  assert.equal(sent.length, 0);
  const rollback = registerComposerSealRollbackOwner(() => true);
  await act(async () => { rollback.cancel(receipt); });
  await waitFor(() => assert.equal(sent.length, 1)); act(() => socket.dispatchEvent(new Event('open')));
  assert.equal(sent.length, 1); assert.deepEqual(readQueuedMessages('a'), []); rollback.unregister();
});
