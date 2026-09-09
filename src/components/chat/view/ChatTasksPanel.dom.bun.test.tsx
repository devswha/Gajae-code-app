import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import enCommon from '../../../i18n/locales/en/common.json';
import koCommon from '../../../i18n/locales/ko/common.json';
import type { NormalizedMessage, SessionStore } from '../../../stores/useSessionStore';
import type { SessionTodoPhase } from '../hooks/useSessionTodos';

import ChatTasksPanel from './ChatTasksPanel';

afterEach(cleanup);

const plan: SessionTodoPhase[] = [{
  name: 'Implementation',
  tasks: [
    { content: 'Read the existing layout', status: 'completed', notes: [] },
    { content: 'Move tasks above the conversation', status: 'in_progress', notes: ['Keep chat scroll independent.'] },
    { content: 'Verify a narrow screen', status: 'pending', notes: [] },
    { content: 'Keep a duplicate right-hand list', status: 'abandoned', notes: [] },
  ],
}];

function createStore() {
  const messages = new Map<string, NormalizedMessage[]>();
  const listeners = new Map<string, Set<() => void>>();
  const empty: NormalizedMessage[] = [];
  let sequence = 0;
  const store = {
    getMessages: (id: string) => messages.get(id) ?? empty,
    subscribeSession: (id: string, listener: () => void) => {
      const subscriptions = listeners.get(id) ?? new Set();
      listeners.set(id, subscriptions);
      subscriptions.add(listener);
      return () => { subscriptions.delete(listener); };
    },
  } satisfies Pick<SessionStore, 'getMessages' | 'subscribeSession'>;
  return {
    store: store as SessionStore,
    listeners: (id: string) => listeners.get(id)?.size ?? 0,
    publish: (id: string, phases: SessionTodoPhase[]) => {
      sequence += 1;
      messages.set(id, [{
        id: `todo-${sequence}`, sessionId: id, provider: 'gjc', kind: 'tool_use',
        timestamp: '2026-09-07T00:00:00Z', toolId: `todo-${sequence}`, toolName: 'todo_write',
        toolInput: { ops: [] }, toolResult: { content: 'Updated', isError: false, toolUseResult: { phases } },
      } as unknown as NormalizedMessage]);
      listeners.get(id)?.forEach((listener) => listener());
    },
  };
}

async function setup(lng = 'en') {
  const i18n = createInstance();
  await i18n.init({ lng, fallbackLng: 'en', resources: { en: { translation: enCommon }, ko: { translation: koCommon } }, interpolation: { escapeValue: false } });
  const state = createStore();
  const ui = (sessionId?: string) => <I18nextProvider i18n={i18n}><ChatTasksPanel sessionId={sessionId} sessionStore={state.store} /></I18nextProvider>;
  return { ...state, ui, i18n };
}

test('sessions without tasks leave no empty card or reserved chat height', async () => {
  const state = await setup();
  state.publish('a', plan);
  const view = render(state.ui());
  assert.equal(view.container.innerHTML, '');
  assert.equal(state.listeners('a'), 0);
  view.rerender(state.ui('empty'));
  assert.equal(view.container.innerHTML, '');
  act(() => state.publish('empty', [{ name: 'Empty phase', tasks: [] }]));
  assert.equal(view.container.innerHTML, '');
});

test('tasks start expanded with progress, phase, notes and non-color status labels', async () => {
  const state = await setup();
  state.publish('a', plan);
  const view = render(state.ui('a'));
  const button = view.getByRole('button', { name: 'Tasks' });
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(button.tabIndex, 0);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.ok(document.getElementById(button.getAttribute('aria-controls')!));
  assert.equal(view.getByRole('status').textContent, '1 of 4 done');
  assert.equal(view.getByRole('status').getAttribute('aria-live'), 'polite');
  assert.ok(view.getByRole('heading', { name: 'Implementation' }));
  const rows = view.getAllByRole('listitem');
  assert.equal(rows.length, 4);
  assert.match(rows[0].textContent!, /Completed:.*Read the existing layout/);
  assert.match(rows[1].textContent!, /In progress:.*Move tasks above the conversation/);
  assert.match(rows[2].textContent!, /Pending:.*Verify a narrow screen/);
  assert.match(rows[3].textContent!, /Abandoned:.*Keep a duplicate right-hand list/);
  assert.ok(within(rows[1]).getByText('Keep chat scroll independent.'));
  assert.match(view.getByText('Read the existing layout').className, /line-through/);
  assert.match(view.getByRole('group', { name: 'Tasks' }).className, /overflow-y-auto.*overscroll-contain/);
  assert.equal(view.getByRole('group', { name: 'Tasks' }).tabIndex, 0);
});

test('collapsed cards keep current work and progress live without reopening or losing focus', async () => {
  const state = await setup();
  state.publish('a', plan);
  const view = render(state.ui('a'));
  const button = view.getByRole('button', { name: 'Tasks' });
  button.focus();
  fireEvent.click(button);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(view.queryByRole('list'), null);
  assert.ok(view.getByText('Move tasks above the conversation'));
  assert.equal(view.queryByText('Keep chat scroll independent.'), null);

  const next: SessionTodoPhase[] = [{ name: 'Verification', tasks: [
    { content: 'Move tasks above the conversation', status: 'completed', notes: [] },
    { content: 'Verify a narrow screen', status: 'in_progress', notes: ['Keyboard focus still works.'] },
  ] }];
  act(() => state.publish('a', next));
  assert.equal(view.getByRole('button', { name: 'Tasks' }), button);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, button);
  assert.equal(view.getByRole('status').textContent, '1 of 2 done');
  assert.ok(view.getByText('Verify a narrow screen'));
  assert.equal(view.queryByText('Move tasks above the conversation'), null);
  fireEvent.click(button);
  assert.ok(view.getByText('Keyboard focus still works.'));
});

test('session changes reset disclosure state and unsubscribe from the previous plan', async () => {
  const state = await setup();
  state.publish('a', plan);
  state.publish('b', [{ name: 'Other session', tasks: [{ content: 'Only session B', status: 'pending', notes: [] }] }]);
  const view = render(state.ui('a'));
  fireEvent.click(view.getByRole('button', { name: 'Tasks' }));
  view.rerender(state.ui('b'));
  assert.equal(view.getByRole('button', { name: 'Tasks' }).getAttribute('aria-expanded'), 'true');
  assert.ok(view.getByText('Only session B'));
  assert.equal(view.queryByText('Move tasks above the conversation'), null);
  assert.equal(state.listeners('a'), 0);
  assert.equal(state.listeners('b'), 1);
  act(() => state.publish('a', []));
  assert.ok(view.getByText('Only session B'));
  view.rerender(state.ui());
  assert.equal(view.container.innerHTML, '');
  assert.equal(state.listeners('b'), 0);
});

test('a live first plan appears automatically and an authoritative clear removes the card', async () => {
  const state = await setup();
  const view = render(state.ui('a'));
  assert.equal(view.container.innerHTML, '');
  act(() => state.publish('a', plan));
  assert.equal(view.getByRole('button', { name: 'Tasks' }).getAttribute('aria-expanded'), 'true');
  act(() => state.publish('a', []));
  assert.equal(view.container.innerHTML, '');
});

test('all-completed plans remain inspectable and do not invent a current task', async () => {
  const state = await setup();
  state.publish('a', [{ name: '', tasks: [{ content: 'Finished work', status: 'completed', notes: [] }] }]);
  const view = render(state.ui('a'));
  assert.ok(view.getByText('Finished work'));
  fireEvent.click(view.getByRole('button', { name: 'Tasks' }));
  assert.equal(view.getByRole('status').textContent, '1 of 1 done');
  assert.equal(view.queryByText('Finished work'), null);
});

test('Korean task labels and long content remain intact', async () => {
  const state = await setup('ko');
  const longTask = `한글경로/${'아주긴파일이름'.repeat(50)}`;
  state.publish('a', [{ name: '구현', tasks: [{ content: longTask, status: 'in_progress', notes: ['검증 결과\n다음 단계'] }] }]);
  const view = render(state.ui('a'));
  assert.ok(view.getByRole('button', { name: '할 일' }));
  assert.equal(view.getByRole('status').textContent, '1개 중 0개 완료');
  assert.match(view.getByRole('listitem').textContent!, /진행 중:/);
  assert.match(view.getByText(longTask).className, /wrap-anywhere/);
  assert.ok(view.getByText('검증 결과 다음 단계'));
});

test('the real chat mounts tasks before the transcript and uses the selected session first', () => {
  const source = readFileSync(new URL('./ChatInterface.tsx', import.meta.url), 'utf8');
  assert.ok(source.indexOf('<ChatTasksPanel ') > 0);
  assert.ok(source.indexOf('<ChatTasksPanel ') < source.indexOf('<ChatMessagesPane'));
  assert.match(source, /<ChatTasksPanel sessionId=\{selectedSession\?\.id \?\? session\.currentSessionId \?\? undefined\} sessionStore=\{sessionStore\}/);
});
