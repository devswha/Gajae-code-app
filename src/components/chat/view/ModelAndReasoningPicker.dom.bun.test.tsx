import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createElement, type ComponentProps } from 'react';
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';

import '../../../i18n/config';
import { useEscapeToAbort } from '../hooks/useEscapeToAbort';

import ModelAndReasoningPicker from './ModelAndReasoningPicker';
import type { ReasoningEffort } from './reasoningEffort';

afterEach(cleanup);

const searchName = 'Search providers and models';
type PickerProps = ComponentProps<typeof ModelAndReasoningPicker>;

function renderPicker(overrides: Partial<PickerProps> = {}) {
  return render(createElement(ModelAndReasoningPicker, {
    value: 'openai-codex/astra',
    presetOptions: [],
    modelOptions: [{
      value: 'openai-codex/astra',
      label: 'Astra',
      effort: { values: [{ value: 'xhigh' }] },
    }],
    onSelect() {},
    reasoningEffort: 'xhigh',
    onSelectReasoningEffort() {},
    ...overrides,
  }));
}

async function openPicker() {
  const selectedModels: string[] = [];
  const selectedEfforts: ReasoningEffort[] = [];
  const view = render(createElement(ModelAndReasoningPicker, {
    value: 'openai-codex/astra',
    presetOptions: [],
    modelOptions: [{
      value: 'openai-codex/astra',
      label: 'Astra',
      effort: { values: [{ value: 'xhigh' }] },
    }],
    onSelect: (modelId) => { selectedModels.push(modelId); },
    reasoningEffort: 'xhigh',
    onSelectReasoningEffort: (effort) => { selectedEfforts.push(effort); },
  }));
  const trigger = screen.getByRole('button', { name: 'Model and reasoning settings' });
  fireEvent.click(trigger);
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: searchName });
  await waitFor(() => assert.equal(document.activeElement === search, true));
  return { ...view, trigger, search, selectedModels, selectedEfforts };
}

function assertDismissed(trigger: HTMLElement) {
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(screen.queryByRole('textbox', { name: searchName }) === null, true);
  assert.equal(document.activeElement === trigger, true);
}

function AbortProbe({ canAbort, onAbort }: { canAbort: boolean; onAbort: () => void }) {
  useEscapeToAbort(canAbort, onAbort);
  return null;
}

test('short model labels size the trigger naturally without growing the model slot', () => {
  const view = renderPicker();
  const trigger = screen.getByRole('button', { name: 'Model and reasoning settings' });
  const root = trigger.parentElement!;
  const model = screen.getByText('Astra');
  const reasoning = screen.getByText('Extra high');

  assert.ok(root.classList.contains('w-fit'));
  assert.ok(root.classList.contains('max-w-full'));
  assert.ok(root.classList.contains('sm:max-w-56'));
  assert.ok(root.classList.contains('shrink-0'));
  assert.ok(trigger.classList.contains('w-fit'));
  assert.ok(trigger.classList.contains('max-w-full'));
  assert.ok(model.classList.contains('min-w-0'));
  assert.ok(model.classList.contains('truncate'));
  assert.equal(model.classList.contains('flex-1'), false);
  assert.ok(reasoning.classList.contains('shrink-0'));
  assert.ok(reasoning.classList.contains('whitespace-nowrap'));
  assert.match(trigger.textContent ?? '', /Astra.*·.*Extra high/);

  view.unmount();
});

test('long model labels retain ellipsis while reasoning stays readable', () => {
  const longLabel = 'Astra with an intentionally long model name for narrow panes';
  const view = renderPicker({
    value: 'openai-codex/long-astra',
    modelOptions: [{
      value: 'openai-codex/long-astra',
      label: longLabel,
      effort: { values: [{ value: 'xhigh' }] },
    }],
  });
  const trigger = screen.getByRole('button', { name: 'Model and reasoning settings' });
  const model = screen.getByText(longLabel);
  const reasoning = screen.getByText('Extra high');

  assert.ok(model.classList.contains('min-w-0'));
  assert.ok(model.classList.contains('truncate'));
  assert.equal(model.classList.contains('flex-1'), false);
  assert.ok(reasoning.classList.contains('shrink-0'));
  assert.ok(reasoning.classList.contains('whitespace-nowrap'));
  assert.match(trigger.textContent ?? '', /Extra high/);

  view.unmount();
});

test('loading keeps a visible fixed-width model skeleton in the content-sized trigger', () => {
  const view = renderPicker({
    value: 'default',
    modelOptions: [],
    loading: true,
  });
  const trigger = screen.getByRole('button', { name: 'Model and reasoning settings' });
  const skeleton = trigger.querySelector('span.bg-muted');

  assert.equal(trigger.getAttribute('aria-busy'), 'true');
  assert.equal(trigger.hasAttribute('disabled'), true);
  assert.ok(skeleton);
  assert.ok(skeleton.classList.contains('w-24'));
  assert.equal(skeleton.classList.contains('w-full'), false);

  view.unmount();
});

test('Escape from an empty search dismisses the portal, restores trigger focus, and allows reopening', async () => {
  const { trigger, search, selectedModels, selectedEfforts } = await openPicker();

  fireEvent.keyDown(search, { key: 'Escape' });

  assertDismissed(trigger);
  assert.deepEqual(selectedModels, []);
  assert.deepEqual(selectedEfforts, []);

  const closedEscape = createEvent.keyDown(trigger, { key: 'Escape' });
  fireEvent(trigger, closedEscape);
  assert.equal(closedEscape.defaultPrevented, false, 'the closed picker releases Escape');

  fireEvent.click(trigger);
  const reopenedSearch = screen.getByRole('textbox', { name: searchName });
  await waitFor(() => assert.equal(document.activeElement === reopenedSearch, true));
  fireEvent.keyDown(reopenedSearch, { key: 'Escape' });
  assertDismissed(trigger);
});

for (const query of ['astra', 'no-such-model']) {
  test(`Escape first clears the search "${query}" without dismissing, then dismisses on the next press`, async () => {
    const { trigger, search } = await openPicker();
    fireEvent.change(search, { target: { value: query } });
    assert.equal(search.value, query);

    fireEvent.keyDown(search, { key: 'Escape' });

    assert.equal(search.value, '');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement === search, true);
    assert.equal(screen.queryByRole('option', { name: 'Astra' }) !== null, true);

    fireEvent.keyDown(search, { key: 'Escape' });
    assertDismissed(trigger);
  });
}

for (const optionName of ['ChatGPT', 'Astra', 'Extra high']) {
  test(`Escape from the focused "${optionName}" option dismisses and restores trigger focus`, async () => {
    const { trigger, selectedModels, selectedEfforts } = await openPicker();
    const option = screen.getByRole('option', { name: optionName });
    option.focus();
    assert.equal(document.activeElement === option, true);

    fireEvent.keyDown(option, { key: 'Escape' });

    assertDismissed(trigger);
    assert.deepEqual(selectedModels, []);
    assert.deepEqual(selectedEfforts, []);
  });
}

test('Escape outside the search restores trigger focus even when the filter has no matches', async () => {
  const { trigger, search } = await openPicker();
  fireEvent.change(search, { target: { value: 'no-such-model' } });
  assert.equal(trigger.hasAttribute('disabled'), true);
  const defaultOption = screen.getByRole('button', { name: /Keep current configuration/ });
  defaultOption.focus();
  assert.equal(document.activeElement === defaultOption, true);

  fireEvent.keyDown(defaultOption, { key: 'Escape' });

  assert.equal(trigger.hasAttribute('disabled'), false);
  assertDismissed(trigger);
});

for (const query of ['', 'astra']) {
  test(`an already-prevented Escape leaves the picker and search "${query}" alone`, async () => {
    const { trigger, search } = await openPicker();
    fireEvent.change(search, { target: { value: query } });
    const escape = createEvent.keyDown(search, { key: 'Escape' });
    escape.preventDefault();

    fireEvent(search, escape);

    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(search.value, query);
    assert.equal(document.activeElement === search, true);
  });

  test(`global Stop owns Escape with search "${query}" until the run is no longer stoppable`, async () => {
    const { trigger, search } = await openPicker();
    fireEvent.change(search, { target: { value: query } });
    let aborts = 0;
    const onAbort = () => { aborts++; };
    // Register the real capture listener after the popup's bubble listener.
    const abortView = render(createElement(AbortProbe, { canAbort: true, onAbort }));
    const escape = createEvent.keyDown(search, { key: 'Escape' });

    fireEvent(search, escape);

    assert.equal(aborts, 1);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(search.value, query);
    assert.equal(document.activeElement === search, true);

    abortView.rerender(createElement(AbortProbe, { canAbort: false, onAbort }));
    if (query) {
      fireEvent.keyDown(search, { key: 'Escape' });
      assert.equal(search.value, '');
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(document.activeElement === search, true);
    }
    fireEvent.keyDown(search, { key: 'Escape' });
    assertDismissed(trigger);
    assert.equal(aborts, 1);
  });
}

test('other keys leave the popup open and outside clicks dismiss without stealing focus', async () => {
  const { trigger, search } = await openPicker();
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');

  render(createElement('button', null, 'Outside'));
  const outside = screen.getByRole('button', { name: 'Outside' });
  outside.focus();
  fireEvent.mouseDown(outside);

  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(screen.queryByRole('textbox', { name: searchName }) === null, true);
  assert.equal(document.activeElement === outside, true);
});
