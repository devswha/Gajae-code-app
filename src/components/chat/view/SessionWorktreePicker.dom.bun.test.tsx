import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import { useChatComposerState } from '../hooks/useChatComposerState';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { useProjectGitSummary } from '../../workspace/hooks/useProjectGitSummary';
import { useProjectChanges } from '../../workspace/hooks/useProjectChanges';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; localStorage.clear(); });

test('composer creates through the ordinary route, then sends the allocated app identity', async () => {
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const sent: unknown[] = [];
  globalThis.fetch = (async (input, options) => {
    const url = String(input);
    requests.push({ url, ...(options?.body ? { body: JSON.parse(String(options.body)) } : {}) });
    const body = url.includes('/files') ? [] : url.endsWith('/providers/sessions')
      ? { success: true, data: { sessionId: 'project-app-session', projectPath: '/fixture/project' } }
      : { success: true, data: { commands: [], skills: [], isWorkspace: false, candidates: [] } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const project = { projectId: 'project-one', fullPath: '/fixture/project', displayName: 'Project' };
  const view = renderHook(() => useChatComposerState({
    selectedProject: project,
    selectedSession: null, currentSessionId: null, gjcModel: 'openai-codex/gpt-6-astra', reasoningEffort: 'xhigh',
    isLoading: false, canAbortSession: false, tokenBudget: null,
    sendMessage: (message) => { sent.push(message); return true; }, scrollToBottom() {}, addMessage() {}, setIsUserScrolledUp() {}, setPendingPermissionRequests() {},
  }));
  act(() => {
    view.result.current.handleInputChange({ target: { value: 'fixture prompt', selectionStart: 14 } } as never);
  });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  const create = requests.find(({ url }) => url.endsWith('/providers/sessions'));
  assert.deepEqual(create?.body, { provider: 'gjc', projectPath: '/fixture/project' });
  assert.equal(requests.some(({ url }) => url.includes('/worktree-sessions')), false);
  assert.ok(sent.some((message) => (message as { type: string; sessionId: string }).type === 'chat.send' && (message as { sessionId: string }).sessionId === 'project-app-session'));
});

test('file references resolve through the selected session to its worktree', async () => {
  const requests: string[] = [];
  const opened: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify([{ type: 'file', name: 'README.md', path: '/repo/.gjc-worktrees/job-one/README.md' }]));
  }) as typeof fetch;
  const project = { projectId: 'project-one', fullPath: '/repo', displayName: 'Project' };
  const view = renderHook(() => useFileOpenResolver(project, (file) => opened.push(file), 'session-one', '/repo/.gjc-worktrees/job-one'));
  act(() => view.result.current('README.md'));
  await waitFor(() => assert.deepEqual(opened, ['/repo/.gjc-worktrees/job-one/README.md']));
  assert.ok(requests[0].endsWith('/api/projects/project-one/files?sessionId=session-one'));
});

test('an unavailable session directory never opens a relative file at the server root', async () => {
  const opened: string[] = [];
  globalThis.fetch = (async () => new Response('{}', { status: 409 })) as typeof fetch;
  const project = { projectId: 'project-one', fullPath: '/repo', displayName: 'Project' };
  const view = renderHook(() => useFileOpenResolver(project, (file) => opened.push(file), 'session-one'));
  await act(async () => {
    view.result.current('README.md');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.deepEqual(opened, []);
});

test('failed session creation keeps the draft and does not send or fall back to a worktree session', async () => {
  const requests: string[] = [];
  const messages: Array<{ type?: string }> = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    const create = url.endsWith('/providers/sessions');
    return new Response(JSON.stringify(url.includes('/files') ? [] : create ? { error: { message: 'Unable to create a session.' } } : {}), { status: create ? 400 : 200 });
  }) as typeof fetch;
  const view = renderHook(() => useChatComposerState({
    selectedProject: { projectId: 'project-one', fullPath: '/fixture/project', displayName: 'Project' },
    selectedSession: null, currentSessionId: null, gjcModel: 'openai-codex/gpt-6-astra', reasoningEffort: 'xhigh',
    isLoading: false, canAbortSession: false, tokenBudget: null,
    sendMessage: () => assert.fail('Must not send'), scrollToBottom() {}, addMessage: (message) => messages.push(message), setIsUserScrolledUp() {}, setPendingPermissionRequests() {},
  }));
  act(() => {
    view.result.current.handleInputChange({ target: { value: 'keep this draft', selectionStart: 15 } } as never);
  });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  assert.equal(view.result.current.input, 'keep this draft');
  assert.ok(messages.some((message) => message.type === 'error'));
  assert.ok(requests.some((url) => url.endsWith('/providers/sessions')));
  assert.equal(requests.some((url) => url.includes('/worktree-sessions')), false);
});

test('file references retry a pending worktree and preserve explicit absolute paths', async () => {
  let attempts = 0;
  const opened: string[] = [];
  globalThis.fetch = (async () => {
    attempts++;
    return attempts === 1 ? new Response('{}', { status: 409 }) : new Response(JSON.stringify([
      { type: 'file', name: 'README.md', path: '/repo/.gjc-worktrees/job-one/README.md' },
    ]));
  }) as typeof fetch;
  const project = { projectId: 'project-one', fullPath: '/repo', displayName: 'Project' };
  const view = renderHook(() => useFileOpenResolver(project, (file) => opened.push(file), 'session-one'));
  await act(async () => { view.result.current('README.md'); });
  assert.deepEqual(opened, []);
  await act(async () => { view.result.current('README.md'); });
  assert.deepEqual(opened, ['/repo/.gjc-worktrees/job-one/README.md']);
  await act(async () => { view.result.current('/other/README.md'); });
  assert.equal(opened.at(-1), '/other/README.md');
  assert.equal(attempts, 2);
});

test('Git context switches by session identity and treats structured workspace failures as unavailable', async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('sessionId=second')) return new Response(JSON.stringify({ error: { code: 'SESSION_WORKTREE_UNAVAILABLE' } }), { status: 409 });
    return new Response(JSON.stringify({ branch: 'job/first', files: [], modified: [], untracked: [] }));
  }) as typeof fetch;
  const view = renderHook(({ sessionId }) => ({
    status: useProjectGitSummary('project-one', true, sessionId),
    changes: useProjectChanges('project-one', true, sessionId),
  }), { initialProps: { sessionId: 'first' } });
  await waitFor(() => assert.equal(view.result.current.status.state.kind, 'ready'));
  view.rerender({ sessionId: 'second' });
  await waitFor(() => {
    assert.equal(view.result.current.status.state.kind, 'unavailable');
    assert.equal(view.result.current.changes.state.kind, 'unavailable');
  });
  assert.ok(requests.some((url) => url.includes('/git/status?project=project-one&sessionId=second')));
  assert.ok(requests.some((url) => url.includes('/git/diff?project=project-one&sessionId=second')));
});
