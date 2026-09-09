import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import type { Project, ProjectSession } from '../../../types/app';
import { resetComposerFreezeForTests } from '../../../shared/composerFreeze';
import { draftInputKey, readQueuedMessages, writeQueuedMessages } from '../utils/chatStorage';

import { useChatComposerState } from './useChatComposerState';

/*
 * Drafts belong to a conversation, and the wiring that makes that true lives
 * in effects: which key is read when the session in view changes, and which
 * key the next keystroke is written under. A static render cannot reach either,
 * which is why the original bug - opening a second conversation and finding the
 * first one's unsent text, then overwriting it - survived a green suite.
 */

const project: Project = {
  projectId: 'proj-1',
  displayName: 'Project one',
  fullPath: '/repos/project-one',
  origin: 'explicit',
};

const session = (id: string): ProjectSession => ({ id, __provider: 'gjc', summary: `Session ${id}` } as ProjectSession);

const baseArgs = {
  selectedProject: project,
  selectedSession: null as ProjectSession | null,
  currentSessionId: null as string | null,
  gjcModel: 'gjc/test-model',
  reasoningEffort: 'default',
  isLoading: false,
  canAbortSession: false,
  tokenBudget: null,
  sendMessage: (_message: unknown) => {},
  scrollToBottom: () => undefined,
  addMessage: (_message: unknown) => {},
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
};

type ComposerArgs = Parameters<typeof useChatComposerState>[0];
const composer = (overrides: Partial<ComposerArgs> = {}) =>
  renderHook(
    (props: Partial<ComposerArgs>) => useChatComposerState({ ...baseArgs, ...props }),
    { initialProps: overrides },
  );

// The composer fetches slash commands and mentionable files on mount. There is
// no server here, and a real socket error is noise that has nothing to do with
// what these tests assert.
globalThis.fetch = (async () => new Response('[]', {
  status: 200,
  headers: { 'content-type': 'application/json' },
})) as typeof fetch;

afterEach(() => {
  cleanup();
  resetComposerFreezeForTests();
  localStorage.clear();
});

test('typing in one session does not reach another session in the same project', () => {
  const view = composer({ selectedSession: session('session-a') });

  act(() => { view.result.current.setInput('draft for A'); });
  view.rerender({ selectedSession: session('session-b') });
  act(() => { view.result.current.setInput('draft for B'); });

  assert.equal(localStorage.getItem(draftInputKey('proj-1', 'session-a')), 'draft for A');
  assert.equal(localStorage.getItem(draftInputKey('proj-1', 'session-b')), 'draft for B');
});

test('switching back to a session restores that session own draft', () => {
  const view = composer({ selectedSession: session('session-a') });

  act(() => { view.result.current.setInput('draft for A'); });
  view.rerender({ selectedSession: session('session-b') });
  act(() => { view.result.current.setInput('draft for B'); });
  view.rerender({ selectedSession: session('session-a') });

  assert.equal(view.result.current.input, 'draft for A');
});

test('opening a session with no draft shows an empty composer, not the last one', () => {
  // The regression in its most visible form: the previous conversation's text
  // appearing in a composer that should be blank.
  const view = composer({ selectedSession: session('session-a') });

  act(() => { view.result.current.setInput('draft for A'); });
  view.rerender({ selectedSession: session('session-fresh') });

  assert.equal(view.result.current.input, '');
});

test('a draft typed before any session exists is loaded back into the same chat', () => {
  const view = composer({ selectedSession: null, currentSessionId: null });

  act(() => { view.result.current.setInput('typed before the session existed'); });

  assert.equal(
    localStorage.getItem(draftInputKey('proj-1')),
    'typed before the session existed',
    'a chat with no session yet keeps its text in the project slot',
  );

  view.unmount();
  const reopened = composer({ selectedSession: null, currentSessionId: null });
  assert.equal(reopened.result.current.input, 'typed before the session existed');
});

test('an established session leaves the unstarted chat draft where it is', () => {
  // Both slots exist at once, and they are not the same conversation.
  localStorage.setItem(draftInputKey('proj-1'), 'typed into the new chat');

  const view = composer({ selectedSession: session('session-a') });
  act(() => { view.result.current.setInput('draft for A'); });

  assert.equal(localStorage.getItem(draftInputKey('proj-1')), 'typed into the new chat');
  assert.equal(localStorage.getItem(draftInputKey('proj-1', 'session-a')), 'draft for A');
});

test('clearing the composer removes the stored draft rather than storing an empty one', () => {
  const view = composer({ selectedSession: session('session-a') });

  act(() => { view.result.current.setInput('draft for A'); });
  act(() => { view.result.current.setInput(''); });

  assert.equal(localStorage.getItem(draftInputKey('proj-1', 'session-a')), null);
});

const submit = () => ({ preventDefault() {} }) as never;
const typeText = (view: ReturnType<typeof composer>, text: string) => act(() => {
  view.result.current.handleInputChange({ target: { value: text, selectionStart: text.length } } as never);
});

test('automatic queue dispatch keeps the model and effort chosen when queued', async () => {
  const sent: unknown[] = [];
  const sendMessage = (message: unknown) => { sent.push(message); };
  writeQueuedMessages('a', [{ content: 'queued work', options: { model: 'queued-model', effort: 'xhigh', sessionSummary: 'queued summary' } }]);
  const view = composer({ selectedSession: session('a'), isLoading: true, sendMessage });
  view.rerender({ selectedSession: session('a'), isLoading: false, gjcModel: 'different-model', reasoningEffort: 'low', sendMessage });
  await waitFor(() => assert.equal(sent.length, 1));
  assert.deepEqual(sent[0], {
    type: 'chat.send', sessionId: 'a', content: 'queued work',
    options: { model: 'queued-model', effort: 'xhigh', sessionSummary: 'queued summary', images: [], goalUiVersion: 1 },
  });
});

test('steering acknowledgements affect their owning queue even when another session steers identical text', () => {
  const echoed: unknown[] = [];
  const addMessage = (message: unknown) => { echoed.push(message); };
  const view = composer({ selectedSession: session('a'), isLoading: true, addMessage });
  typeText(view, 'same steer');
  act(() => { view.result.current.handleSteer(submit()); });
  view.rerender({ selectedSession: session('b'), isLoading: true, addMessage });
  typeText(view, 'same steer');
  act(() => { view.result.current.handleSteer(submit()); });
  act(() => { view.result.current.resolveSteerResult('same steer', true, 'a'); });
  assert.equal(view.result.current.queuedDrafts.length, 1, 'B still awaits its own acknowledgement');
  assert.equal(view.result.current.queuedDrafts[0].pendingSteer, true);
  assert.equal(readQueuedMessages('a').length, 0, 'accepted steering is removed from A storage');
  assert.deepEqual(echoed, [], 'A steering must never echo into B');
  act(() => { view.result.current.resolveSteerResult('same steer', true, 'b'); });
  assert.equal(view.result.current.queuedDrafts.length, 0);
  assert.equal(echoed.length, 1);
});

test('a rejected background steer stays queued in its own session', () => {
  const view = composer({ selectedSession: session('a'), isLoading: true });
  typeText(view, 'keep for A');
  act(() => { view.result.current.handleSteer(submit()); });
  view.rerender({ selectedSession: session('b'), isLoading: true });
  act(() => { view.result.current.resolveSteerResult('keep for A', false, 'a'); });
  assert.deepEqual(view.result.current.queuedDrafts, []);
  assert.equal(readQueuedMessages('a')[0]?.content, 'keep for A');
});

test('returning to an awaiting steer does not turn it into an ordinary queued send', () => {
  const view = composer({ selectedSession: session('a'), isLoading: true });
  typeText(view, 'wait for acknowledgement');
  act(() => { view.result.current.handleSteer(submit()); });
  view.rerender({ selectedSession: session('b'), isLoading: true });
  view.rerender({ selectedSession: session('a'), isLoading: true });
  assert.equal(view.result.current.queuedDrafts[0]?.pendingSteer, true);
});

test('accepting a background steer preserves an ordinary queued message with the same text', () => {
  writeQueuedMessages('a', [{ content: 'repeat this' }]);
  const view = composer({ selectedSession: session('a'), isLoading: true });
  typeText(view, 'repeat this');
  act(() => { view.result.current.handleSteer(submit()); });
  view.rerender({ selectedSession: session('b'), isLoading: true });
  act(() => { view.result.current.resolveSteerResult('repeat this', true, 'a'); });
  assert.deepEqual(readQueuedMessages('a'), [{ content: 'repeat this' }]);
});

test('steering confirmation arriving after five seconds still retires the queued draft', { timeout: 10_000 }, async () => {
  const sent: unknown[] = [];
  const sendMessage = (message: unknown) => { sent.push(message); };
  const view = composer({ selectedSession: session('a'), isLoading: true, sendMessage });
  typeText(view, 'slow steering reply');
  act(() => view.result.current.handleSteer(submit()));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5_100)); });
  act(() => view.result.current.resolveSteerResult('slow steering reply', true, 'a'));
  assert.deepEqual(view.result.current.queuedDrafts, [], 'a timeout cannot turn uncertainty into rejection');
  assert.equal(readQueuedMessages('a').length, 0);
  assert.equal(sent.length, 1);
});

test('remounting preserves the pending status of an unresolved steer', () => {
  const view = composer({ selectedSession: session('a'), isLoading: true });
  typeText(view, 'await acceptance');
  act(() => view.result.current.handleSteer(submit()));
  view.unmount();
  const reopened = composer({ selectedSession: session('a'), isLoading: true });
  assert.equal(reopened.result.current.queuedDrafts[0]?.pendingSteer, true);
});

test('switching sessions during image upload cannot send or clear the next composer', async () => {
  const originalFetch = globalThis.fetch;
  let resolveUpload!: (response: Response) => void;
  globalThis.fetch = async (url) => String(url).endsWith('/images')
    ? new Promise<Response>((resolve) => { resolveUpload = resolve; })
    : new Response('[]');
  try {
    const sent: unknown[] = [];
    const messages: unknown[] = [];
    const shared = { sendMessage: (message: unknown) => { sent.push(message); }, addMessage: (message: unknown) => { messages.push(message); } };
    const view = composer({ selectedSession: session('a'), ...shared });
    typeText(view, 'with image');
    act(() => view.result.current.setAttachedImages([new File(['image'], 'a.png', { type: 'image/png' })]));
    let submitting!: Promise<void>;
    act(() => { submitting = view.result.current.handleSubmit(submit()); });
    view.rerender({ selectedSession: session('b'), ...shared });
    typeText(view, 'new draft for B');
    await act(async () => {
      resolveUpload(new Response(JSON.stringify({ images: [{ path: 'uploaded.png' }] })));
      await submitting;
    });
    assert.equal(view.result.current.input, 'new draft for B');
    assert.equal(localStorage.getItem(draftInputKey('proj-1', 'a')), 'with image');
    assert.deepEqual(messages, []);
    assert.deepEqual(sent, [], 'a submission left before dispatch stays an unsent draft');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('two submits before upload finishes allocate and send only one turn', async () => {
  const sent: unknown[] = [];
  const view = composer({ selectedSession: session('a'), sendMessage: (message) => { sent.push(message); } });
  typeText(view, 'send once');
  await act(async () => {
    await Promise.all([view.result.current.handleSubmit(submit()), view.result.current.handleSubmit(submit())]);
  });
  assert.equal(sent.length, 1);
});

test('a destructive command confirmation belongs to the conversation that requested it', async () => {
  const view = composer({ selectedSession: session('a') });
  typeText(view, '/clear');
  await act(async () => view.result.current.handleSubmit(submit()));
  assert.ok(view.result.current.pendingCommandGate);
  view.rerender({ selectedSession: session('b') });
  assert.equal(view.result.current.pendingCommandGate, null, 'a confirmation for A must not clear B');
});

test('image attachments follow their draft when switching between conversations', () => {
  const first = new File(['a'], 'a.png', { type: 'image/png' });
  const second = new File(['b'], 'b.png', { type: 'image/png' });
  const view = composer({ selectedSession: session('a') });
  act(() => view.result.current.setAttachedImages([first]));
  view.rerender({ selectedSession: session('b') });
  assert.deepEqual(view.result.current.attachedImages, []);
  act(() => view.result.current.setAttachedImages([second]));
  view.rerender({ selectedSession: session('a') });
  assert.deepEqual(view.result.current.attachedImages, [first]);
});

test('a disconnected send retains the draft and never reports an unsent user turn', async () => {
  const messages: Array<{ type: string }> = [];
  const view = composer({ selectedSession: session('a'), sendMessage: () => false, addMessage: (message) => { messages.push(message as { type: string }); } });
  typeText(view, 'keep while offline');
  await act(async () => view.result.current.handleSubmit(submit()));
  assert.equal(view.result.current.input, 'keep while offline');
  assert.equal(localStorage.getItem(draftInputKey('proj-1', 'a')), 'keep while offline');
  assert.equal(messages.some((message) => message.type === 'user'), false);
  assert.equal(messages.some((message) => message.type === 'error'), true);
});

test('a disconnected permission decision keeps its pending request visible', () => {
  let removals = 0;
  const view = composer({ selectedSession: session('a'), sendMessage: () => false, setPendingPermissionRequests: () => { removals += 1; } });
  act(() => view.result.current.handlePermissionDecision('request-a', { allow: true }));
  assert.equal(removals, 0);
});

test('a late session allocation cannot establish or send after the viewer leaves its project', async () => {
  const originalFetch = globalThis.fetch;
  let resolveAllocation: ((response: Response) => void) | undefined;
  globalThis.fetch = async (url) => String(url).endsWith('/api/providers/sessions')
    ? new Promise<Response>((resolve) => { resolveAllocation = resolve; })
    : new Response(JSON.stringify(String(url).includes('/resolve-target?') ? { data: { isWorkspace: false } } : []));
  try {
    const established: string[] = [];
    const sent: unknown[] = [];
    const view = composer({ onSessionEstablished: (id) => { established.push(id); }, sendMessage: (message) => { sent.push(message); } });
    typeText(view, 'create in A');
    let pending!: Promise<void>;
    act(() => { pending = view.result.current.handleSubmit(submit()); });
    await waitFor(() => assert.ok(resolveAllocation));
    view.rerender({ selectedProject: { ...project, projectId: 'project-b' }, selectedSession: session('b') });
    typeText(view, 'keep B');
    await act(async () => {
      resolveAllocation!(new Response(JSON.stringify({ data: { sessionId: 'late-a' } })));
      await pending;
    });
    assert.equal(view.result.current.input, 'keep B');
    assert.deepEqual(established, []);
    assert.deepEqual(sent, []);
  } finally { globalThis.fetch = originalFetch; }
});

test('a failed upload after unmount cannot report into a replacement chat', async () => {
  const originalFetch = globalThis.fetch;
  let rejectUpload!: (error: Error) => void;
  globalThis.fetch = async (url) => String(url).endsWith('/images')
    ? new Promise<Response>((_resolve, reject) => { rejectUpload = reject; }) : new Response('[]');
  try {
    const messages: unknown[] = [];
    const view = composer({ selectedSession: session('a'), addMessage: (message) => { messages.push(message); } });
    typeText(view, 'with image');
    act(() => view.result.current.setAttachedImages([new File(['a'], 'a.png', { type: 'image/png' })]));
    let pending!: Promise<void>;
    act(() => { pending = view.result.current.handleSubmit(submit()); });
    view.unmount();
    await act(async () => { rejectUpload(new Error('network ended')); await pending; });
    assert.deepEqual(messages, []);
    assert.equal(localStorage.getItem(draftInputKey('proj-1', 'a')), 'with image');
  } finally { globalThis.fetch = originalFetch; }
});
