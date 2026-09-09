import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';

import type { Project, ProjectSession } from '../../../types/app';
import { resetComposerFreezeForTests } from '../../../shared/composerFreeze';
import { decideQueuedDispatch, useQueuedMessageAutoSend } from '../../../hooks/useQueuedMessageAutoSend';
import type { SessionActivityMap } from '../../../hooks/useSessionProtection';
import { draftInputKey, queuedMessageKey, readQueuedMessages, writeQueuedMessages } from '../utils/chatStorage';
import { boundedComposerDraft, COMPOSER_STORAGE_LIMITS, composerRouteKey, ComposerStorageError, type ComposerDraftRepository, type ComposerDraft, type StoredComposerDraft } from '../utils/composerDraftStorage';
import { ComposerDraftPersistenceHarness } from '../tests/fixtures/ComposerDraftPersistenceHarness';

import { useChatComposerState } from './useChatComposerState';

// happy-dom and Bun have no IndexedDB; this repository seam controls async
// races/errors, not IDB conformance. Real structured clone is exercised by the
// same harness in the isolated in-app browser.
class Repository implements ComposerDraftRepository {
  records = new Map<string, StoredComposerDraft>();
  writes = 0;
  beforeLoad?: (route: { projectId: string; conversation: string | null }) => Promise<void>;
  beforeSave?: () => Promise<void>;
  async load(route: { projectId: string; conversation: string | null }) {
    await this.beforeLoad?.(route);
    const value = this.records.get(composerRouteKey(route));
    return value ? clone(value) : null;
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
function clone(value: StoredComposerDraft): StoredComposerDraft {
  const files = (items: File[]) => items.map((file) => new File([file], file.name, { type: file.type, lastModified: file.lastModified }));
  return { ...value, images: files(value.images), queue: value.queue.map((item) => ({ ...item, options: item.options ? structuredClone(item.options) : undefined, images: files(item.images) })) };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const project: Project = { projectId: 'project-a', fullPath: '/qa/project-a', displayName: 'A', origin: 'explicit' };
const session = (id = 'session-a') => ({ id, __provider: 'gjc' }) as ProjectSession;
type Args = Parameters<typeof useChatComposerState>[0];
const base: Args = { selectedProject: project, selectedSession: session(), currentSessionId: null, gjcModel: 'test/model', reasoningEffort: 'xhigh', isLoading: true, canAbortSession: false, tokenBudget: null, sendMessage() {}, addMessage() {}, scrollToBottom() {}, setIsUserScrolledUp() {}, setPendingPermissionRequests() {} };
const composer = (repository: Repository, props: Partial<Args> = {}) => renderHook((overrides: Partial<Args>) => useChatComposerState({ ...base, draftRepository: repository, ...overrides }), { initialProps: props });
const saved = async (view: ReturnType<typeof composer>) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); await waitFor(() => assert.equal(view.result.current.draftPersistence.phase, 'saved')); };
const submit = () => ({ preventDefault() {} }) as never;
const image = (body = 'fixture') => new File([body], 'fixture.png', { type: 'image/png', lastModified: 12345 });
const snapshot = (input = 'old', conversation = 'session-a'): StoredComposerDraft => ({ projectId: project.projectId, conversation, input, images: [image()], queue: [], revision: 1 });
globalThis.fetch = (async () => new Response('[]', { headers: { 'content-type': 'application/json' } })) as typeof fetch;
afterEach(() => { cleanup(); resetComposerFreezeForTests(); localStorage.clear(); });

test('actual composer form events save and hydrate a File attachment after remount', async () => {
  const repository = new Repository();
  let view = render(<ComposerDraftPersistenceHarness repository={repository} />);
  await waitFor(() => assert.equal(view.getByRole('status').textContent, 'saved:none'));
  fireEvent.change(view.getByLabelText('Draft'), { target: { value: 'keep this image' } });
  fireEvent.click(view.getByText('Paste fixture image'));
  await waitFor(() => assert.equal(view.getByRole('status').textContent, 'saved:none'));
  view.unmount();
  view = render(<ComposerDraftPersistenceHarness repository={repository} />);
  await waitFor(() => assert.match(view.getByLabelText('Fixture file hydration').textContent ?? '', /true:draft-fixture.svg:image\/svg\+xml:1234567:.*fixture attachment/));
  assert.equal((view.getByLabelText('Draft') as HTMLTextAreaElement).value, 'keep this image');
});

test('queued File bytes, id, order and options survive remount without automatic replay', async () => {
  const repository = new Repository();
  const sent: unknown[] = [];
  const props = { sendMessage: (message: unknown) => { sent.push(message); } };
  const view = composer(repository, props);
  await saved(view);
  act(() => { view.result.current.setInput('follow up'); view.result.current.setAttachedImages([image('queued image')]); });
  await act(async () => view.result.current.handleSubmit(submit()));
  await saved(view);
  const id = view.result.current.queuedDrafts[0].id;
  assert.ok(id);
  assert.equal(decideQueuedDispatch(readQueuedMessages('session-a')[0], true).action, 'hold', 'text-only offscreen sender cannot consume IDB intents');
  view.unmount();
  const reopened = composer(repository, { ...props, isLoading: false });
  await saved(reopened);
  assert.equal(reopened.result.current.queuedDrafts[0].id, id);
  assert.equal(reopened.result.current.queuedDrafts[0].requiresReview, true);
  assert.equal(await reopened.result.current.queuedDrafts[0].images[0].text(), 'queued image');
  assert.deepEqual(reopened.result.current.queuedDrafts[0].options, { model: 'test/model', effort: 'xhigh', sessionSummary: 'follow up' });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
  assert.deepEqual(sent, []);
});

test('stale restore cannot overwrite a live keystroke or pasted File', async () => {
  const repository = new Repository();
  repository.records.set(composerRouteKey(snapshot()), snapshot());
  const gate = deferred(); repository.beforeLoad = () => gate.promise;
  const view = composer(repository);
  act(() => { view.result.current.handleInputChange({ target: { value: 'live edit', selectionStart: 9 } } as never); view.result.current.setAttachedImages([image('new image')]); });
  assert.equal(view.result.current.draftReady, false);
  await act(async () => gate.resolve());
  await saved(view);
  assert.equal(view.result.current.input, 'live edit');
  assert.equal(await view.result.current.attachedImages[0].text(), 'new image');
  assert.equal(repository.records.get(composerRouteKey(snapshot()))?.input, 'live edit');
});

test('late A restore stays in A after switching to B with the same conversation id', async () => {
  const repository = new Repository();
  repository.records.set(composerRouteKey(snapshot()), snapshot('A from disk'));
  const gate = deferred(); repository.beforeLoad = (route) => route.projectId === 'project-a' ? gate.promise : Promise.resolve();
  const view = composer(repository);
  const other = { ...project, projectId: 'project-b' };
  view.rerender({ selectedProject: other });
  act(() => view.result.current.setInput('live B'));
  await saved(view);
  await act(async () => gate.resolve());
  assert.equal(view.result.current.input, 'live B');
  assert.equal(view.result.current.attachedImages.length, 0);
  view.rerender({ selectedProject: project });
  assert.equal(view.result.current.input, 'A from disk');
  assert.equal(await view.result.current.attachedImages[0].text(), 'fixture');
});

test('storage remains pending until commit and serializes keystrokes behind an in-flight save', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  const gate = deferred(); repository.beforeSave = () => gate.promise;
  act(() => view.result.current.setInput('first'));
  await act(async () => { await Promise.resolve(); });
  const writes = repository.writes;
  act(() => { for (let i = 0; i < 50; i += 1) view.result.current.setInput(`new ${i}`); });
  assert.equal(repository.writes, writes, 'only one in-flight write, no per-keystroke promise backlog');
  assert.equal(view.result.current.draftPersistence.phase, 'pending');
  assert.notEqual(repository.records.get(composerRouteKey(snapshot()))?.input, 'new 49');
  await act(async () => gate.resolve()); await saved(view);
  assert.equal(repository.records.get(composerRouteKey(snapshot()))?.input, 'new 49');
});

test('quota failure retains live File and old committed record without a success acknowledgement', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  const old = repository.records.get(composerRouteKey(snapshot()));
  localStorage.setItem(draftInputKey('unrelated'), 'must survive');
  repository.beforeSave = async () => { throw new DOMException('full', 'QuotaExceededError'); };
  act(() => { view.result.current.setInput('not yet durable'); view.result.current.setAttachedImages([image()]); });
  await waitFor(() => assert.deepEqual(view.result.current.draftPersistence, { phase: 'error', reason: 'quota' }));
  assert.equal(view.result.current.input, 'not yet durable');
  assert.equal(await view.result.current.attachedImages[0].text(), 'fixture');
  assert.deepEqual(repository.records.get(composerRouteKey(snapshot())), old);
  assert.equal(localStorage.getItem(draftInputKey('unrelated')), 'must survive');
});

test('delete/reorder/edit survive remount and editing keeps the unrelated active draft', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  for (const text of ['one', 'two', 'three']) {
    act(() => { view.result.current.setInput(text); view.result.current.setAttachedImages([image(text)]); });
    await act(async () => view.result.current.handleSubmit(submit()));
  }
  const ids = view.result.current.queuedDrafts.map((item) => item.id);
  act(() => view.result.current.moveQueuedDraft(2, 0));
  act(() => view.result.current.deleteQueuedDraft(1));
  act(() => { view.result.current.setInput('other draft'); view.result.current.setAttachedImages([image('other')]); });
  act(() => view.result.current.editQueuedDraft(0));
  await saved(view);
  assert.equal(view.result.current.input, 'three');
  assert.equal(await view.result.current.attachedImages[0].text(), 'three');
  view.unmount(); const reopened = composer(repository); await saved(reopened);
  assert.equal(reopened.result.current.queuedDrafts[0].id, ids[1]);
  assert.deepEqual(reopened.result.current.queuedDrafts.map((item) => item.content), ['two', 'other draft']);
  assert.equal(await reopened.result.current.queuedDrafts[1].images[0].text(), 'other');
});

test('save conflicts never overwrite another window or acknowledge unsaved input', async () => {
  const repository = new Repository(); const a = composer(repository); await saved(a);
  const b = composer(repository); await saved(b);
  act(() => a.result.current.setInput('window A')); await saved(a);
  act(() => b.result.current.setInput('window B'));
  await waitFor(() => assert.equal(b.result.current.draftPersistence.reason, 'conflict'));
  assert.equal(b.result.current.input, 'window B');
  assert.equal(repository.records.get(composerRouteKey(snapshot()))?.input, 'window A');
});

test('limits reject the entire snapshot rather than truncating text or losing files', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  const text = 'x'.repeat(COMPOSER_STORAGE_LIMITS.textLength + 1);
  act(() => view.result.current.setInput(text));
  await waitFor(() => assert.equal(view.result.current.draftPersistence.reason, 'limit'));
  assert.equal(view.result.current.input, text);
  assert.equal(repository.records.get(composerRouteKey(snapshot())), undefined);
});

test('explicit clear while restore is pending does not resurrect an IDB-only draft', async () => {
  const repository = new Repository(); repository.records.set(composerRouteKey(snapshot()), snapshot());
  const gate = deferred(); repository.beforeLoad = () => gate.promise;
  const view = composer(repository);
  act(() => view.result.current.handleClearInput());
  await act(async () => gate.resolve()); await saved(view);
  assert.equal(view.result.current.input, '');
  assert.equal(view.result.current.attachedImages.length, 0);
  assert.equal(repository.records.get(composerRouteKey(snapshot()))?.input, '');
});

test('recovered intents announce the existing Edit and Send recovery path once', async () => {
  const repository = new Repository();
  const record = { ...snapshot(''), images: [], queue: [{ id: 'recovered-id', content: 'review first', images: [image()] }] };
  repository.records.set(composerRouteKey(record), record);
  const notices: Array<{ content?: string }> = [];
  const view = composer(repository, { addMessage: (message) => { notices.push(message); } });
  await saved(view);
  assert.equal(notices.length, 1);
  assert.match(notices[0].content ?? '', /paused.*Edit.*Send/);
  act(() => view.result.current.setInput('another draft')); await saved(view);
  assert.equal(notices.length, 1, 'typing does not repeat the warning');
  act(() => view.result.current.editQueuedDraft(0)); await saved(view);
  assert.equal(view.result.current.input, 'review first');
  assert.equal(await view.result.current.attachedImages[0].text(), 'fixture');
});

test('an image pasted during upload survives the earlier successful send', async () => {
  const repository = new Repository(); const oldFetch = globalThis.fetch;
  const gate = deferred();
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/images')) { await gate.promise; return new Response('{"images":[]}'); }
    return new Response('[]');
  };
  try {
    const view = composer(repository, { isLoading: false }); await saved(view);
    act(() => { view.result.current.setInput('text with image'); view.result.current.setAttachedImages([image('original')]); });
    let sending!: Promise<void>;
    act(() => { sending = view.result.current.handleSubmit(submit()); });
    act(() => view.result.current.setAttachedImages([image('new paste')]));
    await act(async () => { gate.resolve(); await sending; }); await saved(view);
    assert.equal(await view.result.current.attachedImages[0].text(), 'new paste');
    assert.equal(view.result.current.input, 'text with image');
  } finally { globalThis.fetch = oldFetch; }
});

test('late steer acknowledgement persists to its original project, not the currently selected project', async () => {
  const repository = new Repository(); const view = composer(repository); await saved(view);
  act(() => view.result.current.setInput('steer in A'));
  act(() => view.result.current.handleSteer(submit())); await saved(view);
  view.rerender({ selectedProject: { ...project, projectId: 'project-b' }, selectedSession: session('session-b') });
  act(() => view.result.current.setInput('keep project B')); await saved(view);
  await act(async () => view.result.current.resolveSteerResult('steer in A', true, 'session-a'));
  await saved(view);
  assert.deepEqual(repository.records.get(composerRouteKey(snapshot()))?.queue, []);
  assert.equal(repository.records.has(JSON.stringify(['project-b', 'session-a'])), false);
  assert.equal(view.result.current.input, 'keep project B');
});

test('conflict retry rebases with live text and Files intact and re-enables manual Send', async () => {
  const repository = new Repository(); const a = composer(repository); await saved(a);
  const sent: unknown[] = [];
  const b = composer(repository, { isLoading: false, sendMessage: (message) => { sent.push(message); } }); await saved(b);
  act(() => a.result.current.setInput('other window')); await saved(a);
  act(() => { b.result.current.setInput('live local'); b.result.current.setAttachedImages([image('live file')]); });
  await waitFor(() => assert.equal(b.result.current.draftPersistence.reason, 'conflict'));
  await act(async () => b.result.current.handleSubmit(submit()));
  assert.equal(b.result.current.draftReady, true);
  assert.equal(b.result.current.input, 'live local');
  assert.equal(await b.result.current.attachedImages[0].text(), 'live file');
  assert.deepEqual(sent, [], 'recovery click itself does not silently send');
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"images":[]}');
  try { await act(async () => b.result.current.handleSubmit(submit())); } finally { globalThis.fetch = oldFetch; }
  assert.equal(sent.length, 1);
});

test('a failed initial load is retryable without overwriting typing that happened during recovery', async () => {
  const repository = new Repository(); repository.beforeLoad = async () => { throw new Error('temporary failure'); };
  const view = composer(repository);
  await waitFor(() => assert.equal(view.result.current.draftPersistence.phase, 'error'));
  act(() => { view.result.current.setInput('live while unavailable'); view.result.current.setAttachedImages([image('paste')]); });
  repository.beforeLoad = undefined;
  await act(async () => assert.equal(await view.result.current.retryDraftPersistence(), true));
  assert.equal(view.result.current.draftReady, true);
  assert.equal(view.result.current.input, 'live while unavailable');
  assert.equal(await view.result.current.attachedImages[0].text(), 'paste');
});

test('incomplete legacy migrations preserve the complete raw queue on load, typing and retry', async () => {
  const cases = [
    JSON.stringify(Array.from({ length: 101 }, (_, id) => ({ id: String(id), content: `intent ${id}` }))),
    'x'.repeat(COMPOSER_STORAGE_LIMITS.textLength * 2 + 1),
    JSON.stringify([{ id: 'ok', content: 'keep this' }, { id: 'broken' }]),
  ];
  for (const raw of cases) {
    const repository = new Repository();
    localStorage.setItem(queuedMessageKey('session-a'), raw);
    const view = composer(repository);
    await waitFor(() => assert.equal(view.result.current.draftPersistence.phase, 'error'));
    act(() => view.result.current.setInput('live input'));
    await act(async () => assert.equal(await view.result.current.retryDraftPersistence(), false));
    assert.equal(localStorage.getItem(queuedMessageKey('session-a')), raw);
    assert.equal(repository.writes, 0);
    view.unmount(); localStorage.clear();
  }
});

test('IndexedDB-backed text queues retain real offscreen auto-send and reconcile the consumed id', async () => {
  const repository = new Repository();
  const sent: Array<{ type: string }> = [];
  const socket = Object.assign(new EventTarget(), { readyState: WebSocket.OPEN }) as WebSocket;
  const running: SessionActivityMap = new Map([['session-a', { startedAt: 1, statusText: null, canInterrupt: true, awaitingInput: false }]]);
  const view = renderHook(({ active, processing }: { active: string; processing: SessionActivityMap }) => {
    const sendMessage = (message: unknown) => { sent.push(message as { type: string }); return true; };
    const result = useChatComposerState({ ...base, draftRepository: repository, selectedSession: session(active), isLoading: processing.has(active), sendMessage });
    useQueuedMessageAutoSend({ processingSessions: processing, activeSessionId: active, ws: socket, sendMessage, markSessionProcessing() {} });
    return result;
  }, { initialProps: { active: 'session-a', processing: running } });
  await saved(view as ReturnType<typeof composer>);
  act(() => view.result.current.setInput('text follow up'));
  await act(async () => view.result.current.handleSubmit(submit())); await saved(view as ReturnType<typeof composer>);
  assert.equal(readQueuedMessages('session-a')[0].pendingSteer, undefined);
  view.rerender({ active: 'session-b', processing: running });
  view.rerender({ active: 'session-b', processing: new Map() });
  assert.deepEqual(sent.map((item) => item.type), ['chat.send']);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(repository.records.get(composerRouteKey(snapshot()))?.queue, []);
  view.rerender({ active: 'session-a', processing: new Map() });
  act(() => view.result.current.setInput('next input'));
  assert.deepEqual(view.result.current.queuedDrafts, []);
  assert.deepEqual(readQueuedMessages('session-a'), []);
});

test('external projection consumption is reconciled before fallback composer writes', async () => {
  const view = renderHook(() => useChatComposerState(base));
  act(() => view.result.current.setInput('queued once'));
  await act(async () => view.result.current.handleSubmit(submit()));
  act(() => writeQueuedMessages('session-a', []));
  act(() => view.result.current.setInput('fresh input'));
  assert.deepEqual(view.result.current.queuedDrafts, []);
  assert.deepEqual(readQueuedMessages('session-a'), []);
});
