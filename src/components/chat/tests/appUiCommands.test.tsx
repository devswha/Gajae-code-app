import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement, type FormEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Project } from '../../../types/app';
import {
  APP_UI_COMMANDS,
  APP_UNSUPPORTED_COMMAND_HINTS,
  TUI_ONLY_COMMAND_HINTS,
  findAppUiCommand,
  getLocalCommandNotice,
  getTuiOnlyCommandNotice,
  isAppUsableCommand,
  runAppUiCommand,
} from '../appUiCommands';
import { useChatComposerState } from '../hooks/useChatComposerState';
import CommandMenu from '../view/CommandMenu';

const selectedProject: Project = {
  projectId: 'project-1',
  displayName: 'Project one',
  fullPath: '/repos/project-one',
  origin: 'explicit',
};

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
  configurable: true,
});

const submitEvent: FormEvent<HTMLFormElement> = {
  preventDefault: () => undefined,
} as FormEvent<HTMLFormElement>;

test('app command registry is well-formed and disjoint from TUI-only notices', () => {
  const names = APP_UI_COMMANDS.map((command) => command.name);

  assert.ok(names.length > 0);
  for (const name of names) {
    assert.match(name, /^\/[a-z-]+$/);
  }
  assert.equal(new Set(names).size, names.length, 'app command names must be unique');

  for (const noticeName of Object.keys(TUI_ONLY_COMMAND_HINTS)) {
    assert.match(noticeName, /^\/[a-z-]+$/);
    assert.equal(
      findAppUiCommand(noticeName),
      undefined,
      `${noticeName} cannot be both an app command and a TUI-only notice`,
    );
  }

  // The canonical entry this feature exists for.
  assert.equal(findAppUiCommand('/resume')?.actionId, 'open-session-picker');
});

test('runAppUiCommand dispatches each action id to its action', () => {
  const calls: string[] = [];
  const actions = {
    openSessionPicker: () => { calls.push('open-session-picker'); },
    startNewChat: () => { calls.push('start-new-chat'); },
    openSettings: () => { calls.push('open-settings'); },
    openModelPicker: () => { calls.push('open-model-picker'); },
    openCostModal: () => { calls.push('open-cost-modal'); },
  };

  for (const command of APP_UI_COMMANDS) {
    runAppUiCommand(command, actions);
  }

  assert.deepEqual(calls, APP_UI_COMMANDS.map((command) => command.actionId));
});

test('getTuiOnlyCommandNotice covers /retry and skips app/unknown commands', () => {
  assert.match(getTuiOnlyCommandNotice('/retry') ?? '', /not available in the app/);
  assert.equal(getTuiOnlyCommandNotice('/resume'), null);
  assert.equal(getTuiOnlyCommandNotice('/definitely-not-a-command'), null);
});

function captureComposer(sentMessages: unknown[], addedMessages: unknown[]) {
  // Each command case starts with its own empty draft; pending confirmations
  // now deliberately survive instead of clearing the previous case's text.
  storage.clear();
  let composer: ReturnType<typeof useChatComposerState> | undefined;

  function Capture() {
    composer = useChatComposerState({
      selectedProject,
      selectedSession: null,
      currentSessionId: 'session-1',
      gjcModel: 'gpt-test',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sentMessages.push(message); },
      scrollToBottom: () => undefined,
      addMessage: (message) => { addedMessages.push(message); },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    });
    return null;
  }

  renderToStaticMarkup(createElement(Capture));
  assert.ok(composer);
  return composer;
}

test('typed /resume is intercepted as an app command and never sent to the model', async () => {
  const sentMessages: unknown[] = [];
  const addedMessages: unknown[] = [];
  const composer = captureComposer(sentMessages, addedMessages);

  composer.handleVoiceTranscript('/resume');
  await composer.handleSubmit(submitEvent);

  assert.deepEqual(sentMessages, []);
  assert.deepEqual(addedMessages, []);
});

test('typed /cost is an app command and does not fetch', async () => {
  const sentMessages: unknown[] = [];
  const addedMessages: unknown[] = [];
  const composer = captureComposer(sentMessages, addedMessages);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('app command must not fetch');
  };

  try {
    composer.handleVoiceTranscript('/cost');
    await composer.handleSubmit(submitEvent);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(findAppUiCommand('/cost')?.actionId, 'open-cost-modal');
  assert.equal(fetchCalls, 0);
  assert.deepEqual(sentMessages, []);
  assert.deepEqual(addedMessages, []);
});

test('typed TUI-only command gets a local notice instead of a model prompt', async () => {
  const sentMessages: unknown[] = [];
  const addedMessages: unknown[] = [];
  const composer = captureComposer(sentMessages, addedMessages);

  composer.handleVoiceTranscript('/retry');
  await composer.handleSubmit(submitEvent);

  assert.deepEqual(sentMessages, []);
  assert.equal(addedMessages.length, 1);
  const notice = addedMessages[0] as { type: string; content: string };
  assert.equal(notice.type, 'assistant');
  assert.match(notice.content, /`\/retry`/);
  assert.match(notice.content, /not available in the app/);
});

test('an unknown slash command is held for confirmation, not sent blind', async () => {
  // Before the gate this fell straight through to chat.send. Fail-closed now:
  // a form the app cannot classify asks once instead of running unannounced.
  const sentMessages: unknown[] = [];
  const addedMessages: unknown[] = [];
  const composer = captureComposer(sentMessages, addedMessages);

  composer.handleVoiceTranscript('/not-a-real-command hello');
  await composer.handleSubmit(submitEvent);

  assert.deepEqual(sentMessages, []);
  assert.deepEqual(addedMessages, []);
});

test('a TUI command the app can already do points at how to do it', () => {
  // An empty hint is correct where the app genuinely has no equivalent
  // (/monitors, /pet). It is wrong where one exists, because the notice then
  // reads as "you cannot do this here" about something the app does fine —
  // /copy said exactly that while every message carried a copy button.
  const hasAppEquivalent: Readonly<Record<string, RegExp>> = {
    '/retry': /open the session|send a new message/i,
    '/background': /keep running/i,
    '/theme': /command palette/i,
    '/help': /browse every command/i,
    '/copy': /copy button/i,
    '/drop': /sidebar/i,
    '/hotkeys': /command palette/i,
  };

  for (const [name, mentions] of Object.entries(hasAppEquivalent)) {
    const hint = TUI_ONLY_COMMAND_HINTS[name];
    assert.ok(hint, `${name} has an app equivalent but carries no hint`);
    assert.match(hint, mentions, `${name} should name its app equivalent`);
  }
});

/*
 * Forms that used to reach the model as prose.
 *
 * `/help` was synthesized as a provider-typed command and then excluded by the
 * provider filter, so it fell straight through to chat.send. `/move` has a
 * runtime handler but no app disposition. The four aliases were absent from
 * every registry, so the model received "/quit" as a user message.
 */
test('/help is answered locally instead of being forwarded as prose', async () => {
  for (const form of ['/help', 'help', '/help extra arg']) {
    const sentMessages: unknown[] = [];
    const addedMessages: unknown[] = [];
    const composer = captureComposer(sentMessages, addedMessages);

    composer.handleVoiceTranscript(form);
    await composer.handleSubmit(submitEvent);

    assert.deepEqual(sentMessages, [], `${form} must not be sent`);
    assert.equal(addedMessages.length, 1, `${form} must render a notice`);
    assert.match((addedMessages[0] as { content: string }).content, /not available in the app/);
  }
});

test('/move is declined locally and names the app affordance', async () => {
  for (const form of ['/move', '/move /somewhere/else']) {
    const sentMessages: unknown[] = [];
    const addedMessages: unknown[] = [];
    const composer = captureComposer(sentMessages, addedMessages);

    composer.handleVoiceTranscript(form);
    await composer.handleSubmit(submitEvent);

    assert.deepEqual(sentMessages, [], `${form} must not be sent`);
    assert.equal(addedMessages.length, 1);
    const notice = (addedMessages[0] as { content: string }).content;
    assert.match(notice, /not available in the app/);
    assert.match(notice, /switch projects from the sidebar/);
  }
});

test('/init and /transcript are declined locally without exposing upstream session data', async () => {
  for (const form of ['/init', '/init extra', '/transcript', '/transcript extra']) {
    const sentMessages: unknown[] = [];
    const addedMessages: unknown[] = [];
    const composer = captureComposer(sentMessages, addedMessages);

    composer.handleVoiceTranscript(form);
    await composer.handleSubmit(submitEvent);

    assert.deepEqual(sentMessages, [], `${form} must not be sent`);
    assert.equal(addedMessages.length, 1);
    const notice = (addedMessages[0] as { content: string }).content;
    assert.match(notice, /not available in the app/);
  }
});

test('aliases of TUI-only commands answer exactly like their canonical name', async () => {
  for (const [alias, canonical] of [['/bg', '/background'], ['/quit', '/exit']] as const) {
    const sentMessages: unknown[] = [];
    const addedMessages: unknown[] = [];
    const composer = captureComposer(sentMessages, addedMessages);

    composer.handleVoiceTranscript(alias);
    await composer.handleSubmit(submitEvent);

    assert.deepEqual(sentMessages, [], `${alias} must not be sent`);
    assert.equal(addedMessages.length, 1);
    assert.equal(
      (addedMessages[0] as { content: string }).content,
      getTuiOnlyCommandNotice(canonical),
      `${alias} must reuse the ${canonical} notice`,
    );
  }
});

test('bare /models opens the model picker like /model does', async () => {
  const sentMessages: unknown[] = [];
  const addedMessages: unknown[] = [];
  const composer = captureComposer(sentMessages, addedMessages);

  composer.handleVoiceTranscript('/models');
  await composer.handleSubmit(submitEvent);

  assert.deepEqual(sentMessages, []);
  assert.deepEqual(addedMessages, []);
});

test('/models with arguments reaches the runtime unchanged', async () => {
  // The canonical command has a text handler, so the server dispatches the
  // alias; rewriting the text here would only hide which name the user typed.
  const sentMessages: unknown[] = [];
  const addedMessages: unknown[] = [];
  const composer = captureComposer(sentMessages, addedMessages);

  composer.handleVoiceTranscript('/models gpt-test-2');
  await composer.handleSubmit(submitEvent);

  assert.equal(sentMessages.length, 1);
  assert.equal((sentMessages[0] as { content: string }).content, '/models gpt-test-2');
});

test('/contribution-prep is gated, because /contribute-pr is', async () => {
  // An alias must not be a way around the confirmation its command carries.
  const sentMessages: unknown[] = [];
  const addedMessages: unknown[] = [];
  const composer = captureComposer(sentMessages, addedMessages);

  composer.handleVoiceTranscript('/contribution-prep focus e2e');
  await composer.handleSubmit(submitEvent);

  assert.deepEqual(sentMessages, []);
  assert.deepEqual(addedMessages, []);
});

test('/notify on and off are answered locally, other verbs still dispatch', async () => {
  // Upstream returns on/off as a residual prompt for its notifications
  // extension. The app opts out of that daemon, so the residual used to land
  // on the model as prose.
  for (const form of ['/notify on', '/notify off', '/notify ON']) {
    const sentMessages: unknown[] = [];
    const addedMessages: unknown[] = [];
    const composer = captureComposer(sentMessages, addedMessages);

    composer.handleVoiceTranscript(form);
    await composer.handleSubmit(submitEvent);

    assert.deepEqual(sentMessages, [], `${form} must not be sent`);
    assert.equal(addedMessages.length, 1);
    assert.match(
      (addedMessages[0] as { content: string }).content,
      /Settings → Notifications/,
    );
  }

  // The read-only verbs are consumed by the builtin and must keep working.
  // /notify test and /notify recovery are gated (external effect, lock reset)
  // and are covered by the gate tests.
  for (const form of ['/notify', '/notify status', '/notify health']) {
    const sentMessages: unknown[] = [];
    const addedMessages: unknown[] = [];
    const composer = captureComposer(sentMessages, addedMessages);

    composer.handleVoiceTranscript(form);
    await composer.handleSubmit(submitEvent);

    assert.equal(sentMessages.length, 1, `${form} must still dispatch`);
    assert.equal((sentMessages[0] as { content: string }).content, form);
  }
});

/*
 * The slash menu and the typed-input path share one rule, so the menu can
 * never advertise something the composer then refuses.
 */
test('isAppUsableCommand hides exactly what the composer answers locally', () => {
  // Advertised: everything the app really runs.
  for (const name of ['/model', '/export', '/clear', '/memory', '/resume', '/settings', '/cost']) {
    assert.equal(isAppUsableCommand(name), true, `${name} should stay in the menu`);
  }

  // Hidden: everything with a local notice, including TUI-only names and
  // aliases that resolve to them.
  for (const name of Object.keys(TUI_ONLY_COMMAND_HINTS)) {
    assert.equal(isAppUsableCommand(name), false, `${name} should be hidden`);
  }
  for (const name of ['/init', '/move', '/transcript', '/skill:team', '/bg', '/quit']) {
    assert.equal(isAppUsableCommand(name), false, `${name} should be hidden`);
  }
});

test('app-usable bundled skills stay in the menu, the tmux one does not', () => {
  for (const skill of ['/skill:deep-interview', '/skill:ralplan', '/skill:ultragoal']) {
    assert.equal(isAppUsableCommand(skill), true, `${skill} should stay`);
  }
  assert.equal(isAppUsableCommand('/skill:team'), false);
});

test('/skill:team is refused on submit and names the alternative', async () => {
  const sentMessages: unknown[] = [];
  const addedMessages: unknown[] = [];
  const composer = captureComposer(sentMessages, addedMessages);

  composer.handleVoiceTranscript('/skill:team');
  await composer.handleSubmit(submitEvent);

  assert.deepEqual(sentMessages, []);
  assert.equal(addedMessages.length, 1);
  const notice = (addedMessages[0] as { content: string }).content;
  assert.match(notice, /tmux/);
  assert.match(notice, /ultragoal/);
});

test('a command-level decline hides the command, a form-level one does not', () => {
  for (const form of Object.keys(APP_UNSUPPORTED_COMMAND_HINTS)) {
    const [commandName, verb = ''] = form.split(' ');
    assert.notEqual(getLocalCommandNotice(commandName, verb), null, form);
    // "/move" hides /move from the menu; "/notify on" must NOT hide /notify,
    // because every other /notify verb still works.
    assert.equal(isAppUsableCommand(commandName), verb !== '', form);
  }
});

test('bare /model is intercepted to open the app model picker, not sent to the model', async () => {
  const sentMessages: unknown[] = [];
  const addedMessages: unknown[] = [];
  const composer = captureComposer(sentMessages, addedMessages);

  composer.handleVoiceTranscript('/model');
  await composer.handleSubmit(submitEvent);

  assert.deepEqual(sentMessages, []);
  assert.deepEqual(addedMessages, []);
});

test('/model with arguments flows through to the provider text runtime', async () => {
  // interceptWithArgs:false — "/model gpt-x" must reach GJC so direct model
  // switching keeps working exactly like the TUI.
  const sentMessages: unknown[] = [];
  const addedMessages: unknown[] = [];
  const composer = captureComposer(sentMessages, addedMessages);

  composer.handleVoiceTranscript('/model gpt-test-2');
  await composer.handleSubmit(submitEvent);

  assert.equal(sentMessages.length, 1);
  const sent = sentMessages[0] as { type: string; content: string };
  assert.equal(sent.type, 'chat.send');
  assert.equal(sent.content, '/model gpt-test-2');
  assert.deepEqual(addedMessages.filter((m) => (m as { type: string }).type === 'error'), []);
});

test('command menu groups app commands under the App Commands heading', () => {
  const html = renderToStaticMarkup(
    createElement(CommandMenu, {
      commands: [
        ...APP_UI_COMMANDS.map((command) => ({ ...command })),
        // Group headings only render when more than one namespace is present,
        // matching the real menu where provider builtins are always fetched.
        { name: '/model', description: 'Show current model selection', namespace: 'builtin', type: 'provider' },
      ],
      isOpen: true,
      onClose: () => undefined,
      position: { top: 0, left: 0 },
    }),
  );

  assert.match(html, /App Commands/);
  assert.match(html, /\/resume/);
  assert.match(html, /session picker/);
});
