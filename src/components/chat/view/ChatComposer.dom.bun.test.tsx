import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { createElement, type ComponentProps } from 'react';
import type { DropzoneInputProps, DropzoneRootProps } from 'react-dropzone';
import { I18nextProvider } from 'react-i18next';

import { defaultProjectPermissions } from '../../../hooks/useProjectPermissions';
import english from '../../../i18n/locales/en/chat.json';
import korean from '../../../i18n/locales/ko/chat.json';

import ChatComposer from './ChatComposer';

type ComposerProps = ComponentProps<typeof ChatComposer>;

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { chat: english }, ko: { chat: korean } } });

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function composerProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    pendingPermissionRequests: [],
    handlePermissionDecision() {},
    isLoading: false,
    onAbortSession() {},
    sessionState: null,
    onShowTokenUsage() {},
    onSubmit() {},
    onSteer() {},
    isDragActive: false,
    queuedDrafts: [],
    onEditQueuedDraft() {},
    onDeleteQueuedDraft() {},
    onMoveQueuedDraft() {},
    pendingCommandGate: null,
    onConfirmCommandGate() {},
    onCancelCommandGate() {},
    attachedImages: [],
    onRemoveImage() {},
    uploadingImages: new Map(),
    imageErrors: new Map(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    onSelectFile() {},
    filteredCommands: [],
    skillCommands: [{ name: '/skill:review', type: 'skill' }],
    selectedCommandIndex: 0,
    onCommandSelect() {},
    onCloseCommandMenu() {},
    isCommandMenuOpen: false,
    frequentCommands: [],
    getRootProps: <T extends DropzoneRootProps>(props?: T) => props ?? ({} as T),
    getInputProps: <T extends DropzoneInputProps>(props?: T) => props ?? ({} as T),
    openImagePicker() {},
    inputHighlightRef: { current: null },
    renderInputWithMentions: (text) => text,
    textareaRef: { current: null },
    input: '',
    onInputChange() {},
    onTextareaClick() {},
    onTextareaKeyDown() {},
    onTextareaPaste() {},
    onTextareaScrollSync() {},
    onTextareaInput() {},
    placeholder: 'Message Gajae Code',
    isTextareaExpanded: false,
    sendByCtrlEnter: true,
    modelPreset: 'openai-codex/gpt-6-astra',
    modelPresetOptions: [{ value: 'current', label: 'Current' }],
    modelOptions: [{ value: 'openai-codex/gpt-6-astra', label: 'Astra' }],
    reasoningEffort: 'xhigh',
    permissions: defaultProjectPermissions('project-one'),
    ...overrides,
  };
}

function composer(props: ComposerProps) {
  return createElement(I18nextProvider, { i18n }, createElement(ChatComposer, props));
}

test('the chat toolbar does not expose a project or worktree selector', async () => {
  await i18n.changeLanguage('en');
  const view = render(composer(composerProps()));
  assert.equal(view.queryByRole('combobox', { name: 'Run location' }), null);
  assert.equal(view.queryByText('New worktree'), null);
  assert.equal(view.queryByText('Project', { exact: true }), null);
});

function slot(container: HTMLElement, name: string) {
  const element = container.querySelector<HTMLElement>(`[data-slot="prompt-input${name ? `-${name}` : ''}"]`);
  assert.ok(element, `missing prompt input ${name || 'form'}`);
  return element;
}

for (const language of ['en', 'ko']) {
  test(`${language} draft storage failure exposes a real retry action without sending`, async () => {
    await i18n.changeLanguage(language);
    let retries = 0;
    let sends = 0;
    const view = render(composer(composerProps({
      draftPersistence: { phase: 'error', reason: 'conflict' },
      onRetryDraftPersistence: async () => { retries += 1; return true; },
      onSubmit: () => { sends += 1; },
      queuedDrafts: [{ id: 'recovered', content: 'Review me', images: [], requiresReview: true }],
    })));
    const warning = view.getByRole('alert');
    assert.ok(warning.textContent?.includes(i18n.t('input.draftPersistence.failed', { ns: 'chat' })));
    const retry = within(warning).getByRole('button', { name: i18n.t('input.draftPersistence.retry', { ns: 'chat' }) });
    await act(async () => { fireEvent.click(retry); });
    assert.equal(retries, 1);
    assert.equal(sends, 0);
    assert.ok(view.getByText(`· ${i18n.t('input.queue.reviewBeforeSending', { ns: 'chat' })}`));
    assert.equal(view.queryByText(i18n.t('input.queue.willSend', { ns: 'chat' })), null);
  });
}

// happy-dom does not calculate flex geometry. These assertions protect the
// layout structure and sizing rules; native WebKit QA measures the real bounds.
for (const language of ['en', 'ko']) {
  test(`the long ${language} Ctrl+Enter hint stays outside toolbar sizing while typing and clearing`, async () => {
    await i18n.changeLanguage(language);
    const props = composerProps();
    const view = render(composer(props));
    const form = slot(view.container, '');
    const footer = slot(form, 'footer');
    const tools = slot(footer, 'tools');
    const hint = within(form).getByText(i18n.t('input.hintText.ctrlEnter', { ns: 'chat' }));
    const send = within(footer).getByRole('button', { name: i18n.t('input.send', { ns: 'chat' }) });
    const actions = send.parentElement!;
    const toolsMarkup = tools.outerHTML;
    const actionClasses = actions.className;
    const hintClasses = hint.className.replace(/opacity-(0|100)/, '');

    assert.ok((hint.textContent?.length ?? 0) > 50, 'exercise the full translated shortcut help');
    assert.equal(hint.parentElement?.getAttribute('data-slot'), 'prompt-input', 'hint must occupy its own form row');
    assert.equal(footer.nextElementSibling === hint, true, 'hint must follow, not compete with, the toolbar');
    assert.equal(footer.children.length, 2, 'toolbar contains only tools and actions');
    assert.equal(actions.contains(hint), false);
    assert.ok(hint.classList.contains('wrap-anywhere'), 'long localized text must wrap within its row');
    assert.ok(footer.classList.contains('flex-wrap'), 'a narrow pane can wrap the action group');
    assert.ok(footer.classList.contains('items-end'), 'Send/Stop stays at the bottom of wrapped tools');
    assert.ok(tools.classList.contains('flex-wrap'), 'narrow panes must keep trailing tools reachable');
    assert.equal(tools.classList.contains('overflow-hidden'), false);

    for (const input of ['Draft message', '   ', 'Another draft', '']) {
      view.rerender(composer({ ...props, input }));
      const currentHint = within(form).getByText(i18n.t('input.hintText.ctrlEnter', { ns: 'chat' }));
      assert.equal(currentHint === hint, true, 'typing must keep the hint row mounted');
      assert.equal(hint.className.replace(/opacity-(0|100)/, ''), hintClasses, 'typing only changes hint opacity');
      assert.ok(hint.classList.contains(input.trim() ? 'opacity-0' : 'opacity-100'));
      assert.equal(hint.hidden, false);
      assert.equal(hint.style.display, '');
      assert.equal(slot(footer, 'tools') === tools, true);
      assert.equal(tools.outerHTML, toolsMarkup, 'typing does not change tool slots or widths');
      assert.equal(send.parentElement === actions, true);
      assert.equal(actions.className, actionClasses);
      assert.equal(send.hasAttribute('disabled'), !input.trim());
    }
  });
}

test('model and permission slots retain bounded sizing as metadata loads beside a hidden hint', async () => {
  await i18n.changeLanguage('en');
  const props = composerProps({ input: 'Draft message' });
  const view = render(composer({
    ...props, modelPreset: 'default', modelOptions: [], modelPresetOptions: [], modelPresetsLoading: true, permissions: null,
  }));
  const tools = slot(view.container, 'tools');
  const model = within(tools).getByRole('button', { name: 'Model and reasoning settings' });
  const modelSlot = model.parentElement!;
  const permissionSlot = tools.children[3];
  const skills = within(tools).getByRole('button', { name: english.input.skills.label });

  assert.ok(modelSlot.classList.contains('w-fit'));
  assert.ok(modelSlot.classList.contains('max-w-full'), 'model slot must fit a narrow tools row');
  assert.ok(modelSlot.classList.contains('sm:max-w-56'));
  assert.equal(modelSlot.classList.contains('w-40'), false);
  assert.equal(modelSlot.classList.contains('sm:w-56'), false);
  assert.ok(modelSlot.classList.contains('shrink-0'));
  assert.ok(model.querySelector('.w-24'), 'loading model slot must keep a visible skeleton width');
  assert.ok(permissionSlot.classList.contains('w-28'));
  assert.ok(permissionSlot.classList.contains('shrink-0'));
  assert.equal(permissionSlot.getAttribute('aria-hidden'), 'true');
  assert.equal(model.hasAttribute('disabled'), true);

  view.rerender(composer({ ...props, modelPresetsLoading: false }));
  assert.equal(within(tools).getByRole('button', { name: 'Model and reasoning settings' }) === model, true);
  assert.equal(model.parentElement === modelSlot, true);
  assert.equal(model.hasAttribute('disabled'), false);
  const permissions = within(tools).getByRole('button', { name: 'Permission mode' }).parentElement!;
  assert.equal(tools.children[3] === permissions, true);
  assert.ok(permissions.classList.contains('w-28'));
  assert.ok(permissions.classList.contains('shrink-0'));
  assert.equal(within(tools).getByRole('button', { name: english.input.skills.label }) === skills, true);
});

for (const sendByCtrlEnter of [false, true]) {
  test(`Send, Stop, Queue and Steer retain their native button roles with Ctrl+Enter ${sendByCtrlEnter}`, async () => {
    await i18n.changeLanguage('en');
    const props = composerProps({ sendByCtrlEnter });
    const view = render(composer(props));
    const form = slot(view.container, '');
    const footer = slot(form, 'footer');

    for (const state of [
      { isLoading: false, input: '', labels: [english.input.send] },
      { isLoading: false, input: 'Draft message', labels: [english.input.send] },
      { isLoading: true, input: '', labels: [`${english.input.stop} · Esc`] },
      { isLoading: true, input: 'Draft message', labels: [english.input.queue.steerNow, english.input.queue.sendNext, `${english.input.stop} · Esc`] },
      { isLoading: true, input: '/help', labels: [english.input.queue.sendNext, `${english.input.stop} · Esc`] },
    ]) {
      view.rerender(composer({ ...props, isLoading: state.isLoading, input: state.input }));
      const actions = footer.lastElementChild as HTMLElement;
      const buttons = within(actions).getAllByRole('button');
      assert.deepEqual(buttons.map((button) => button.getAttribute('aria-label')), state.labels);
      assert.deepEqual(buttons.map((button) => button.getAttribute('type')), state.labels.map(() => state.isLoading ? 'button' : 'submit'));
      assert.equal(buttons.some((button) => button.hasAttribute('disabled')), !state.isLoading && !state.input);

      if (sendByCtrlEnter || (state.isLoading && state.input)) {
        const hintText = state.isLoading && state.input ? english.input.hintText.queue : english.input.hintText.ctrlEnter;
        const hint = within(form).getByText(hintText);
        assert.equal(hint.parentElement?.getAttribute('data-slot'), 'prompt-input', 'queue help must not consume action width either');
        assert.equal(footer.nextElementSibling === hint, true);
      } else {
        assert.equal(footer.nextElementSibling, null, 'default Enter mode keeps its existing idle appearance');
      }
    }
  });
}
