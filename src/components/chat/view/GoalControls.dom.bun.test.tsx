import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import koChat from '../../../i18n/locales/ko/chat.json';

import GoalControls, { type GoalControlsProps } from './GoalControls';

afterEach(cleanup);
const goal = { id: 'goal-a', objective: 'Finish the integration', status: 'active' as const, tokensUsed: 1234, timeUsedSeconds: 5, createdAt: 1, updatedAt: 2 };
const initial: GoalControlsProps = {
  snapshot: { supported: true, goal, runId: 'run-a', canControl: true, resumeRequired: false },
  pending: false, connected: true, control: async () => {}, refresh: () => {},
};

test('goal badge shows objective and tokens, and Pause/Resume/Cancel invoke distinct operations', async () => {
  const calls: unknown[] = [];
  const control: GoalControlsProps['control'] = async (input) => { calls.push(input); };
  const view = render(<GoalControls {...initial} control={control} />);
  assert.ok(view.getByText('Finish the integration'));
  assert.ok(view.getByText('1,234 tokens'));
  fireEvent.click(view.getByRole('button', { name: 'Pause' }));
  await waitFor(() => assert.deepEqual(calls, [{ operation: 'pause' }]));
  view.rerender(<GoalControls {...initial} snapshot={{ ...initial.snapshot!, goal: { ...goal, status: 'paused' }, runId: null }} control={control} />);
  fireEvent.click(view.getByRole('button', { name: 'Resume' }));
  fireEvent.click(view.getByRole('button', { name: 'Cancel goal' }));
  await waitFor(() => assert.deepEqual(calls, [{ operation: 'pause' }, { operation: 'resume' }, { operation: 'drop' }]));
});

test('idle active snapshots present Paused and unavailable controls cannot dispatch', () => {
  let calls = 0;
  const view = render(<GoalControls {...initial} snapshot={{ ...initial.snapshot!, resumeRequired: true, runId: null, canControl: false }} control={async () => { calls++; }} />);
  assert.equal(view.getByRole('status').textContent, 'Goal · Paused');
  fireEvent.click(view.getByRole('button', { name: 'Resume' }));
  fireEvent.click(view.getByRole('button', { name: 'Cancel goal' }));
  assert.equal(calls, 0);
});

test('goal controls are absent while loading or when no goal exists', () => {
  const view = render(<GoalControls {...initial} snapshot={undefined} />);
  assert.equal(view.container.innerHTML, '');
  view.rerender(<GoalControls {...initial} snapshot={{ ...initial.snapshot!, goal: null, runId: null }} />);
  assert.equal(view.container.innerHTML, '');
});

test('terminal goals show status without offering a new goal or controls', () => {
  const view = render(<GoalControls {...initial} snapshot={{ ...initial.snapshot!, goal: { ...goal, status: 'complete' }, runId: null }} />);
  assert.equal(view.getByRole('status').textContent, 'Goal · Complete');
  assert.ok(view.getByText('Finish the integration'));
  assert.equal(view.queryByRole('button', { name: 'New goal' }), null);
  assert.equal(view.queryByRole('button', { name: 'Pause' }), null);
  assert.equal(view.queryByRole('button', { name: 'Cancel goal' }), null);
});

test('disconnection and pending requests disable controls; server errors remain actionable', () => {
  let refreshed = 0;
  const view = render(<GoalControls {...initial} connected={false} error="The active run changed." refresh={() => { refreshed++; }} />);
  assert.equal((view.getByRole('button', { name: 'Pause' }) as HTMLButtonElement).disabled, true);
  assert.match(view.getByRole('alert').textContent!, /active run changed/);
  fireEvent.click(view.getByRole('button', { name: 'Refresh goal' }));
  assert.equal(refreshed, 1);
  view.rerender(<GoalControls {...initial} pending />);
  assert.equal((view.getByRole('button', { name: 'Cancel goal' }) as HTMLButtonElement).disabled, true);
});

test('Korean goal controls explain the inherited delegation policy', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'ko', resources: { ko: { chat: koChat } }, interpolation: { escapeValue: false } });
  const view = render(<I18nextProvider i18n={i18n}><GoalControls {...initial} /></I18nextProvider>);
  assert.equal(view.getByRole('status').textContent, '목표 · 진행 중');
  assert.ok(view.getByRole('button', { name: '일시정지' }));
  assert.ok(view.getByText('토큰 1,234개'));
  assert.match(view.getByText(/위임한 작업도/).textContent!, /같은 모델과 권한/);
});
