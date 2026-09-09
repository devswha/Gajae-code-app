import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement, type FormEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Project } from '../../../types/app';
import { useChatComposerState, type PendingCommandGate } from '../hooks/useChatComposerState';
import { draftInputKey } from '../utils/chatStorage';

/*
 * The confirmation gate.
 *
 * The property that matters is negative: while a form is held, zero frames have
 * left the composer. Unlike the tool-approval banner — which asks about work the
 * server already started — this must stop the command before it begins, so every
 * test here asserts on what was NOT sent.
 */

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

function captureComposer(
  sentMessages: unknown[],
  addedMessages: unknown[],
  gates: Array<PendingCommandGate | null>,
) {
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
      onCommandGateChange: (gate) => { gates.push(gate); },
    });
    return null;
  }

  renderToStaticMarkup(createElement(Capture));
  assert.ok(composer);
  return composer;
}

/**
 * The static renderer never re-renders, so the raised gate is observed through
 * the change callback rather than the returned state.
 */
async function submit(text: string) {
  storage.clear();
  const sentMessages: unknown[] = [];
  const addedMessages: unknown[] = [];
  const gates: Array<PendingCommandGate | null> = [];
  const composer = captureComposer(sentMessages, addedMessages, gates);
  composer.handleVoiceTranscript(text);
  await composer.handleSubmit(submitEvent);
  return { composer, sentMessages, addedMessages, gates, gate: gates.at(-1) ?? null };
}

test('a destructive form sends nothing and raises a gate instead', async () => {
  for (const text of [
    '/clear',
    '/session delete',
    '/memory clear',
    '/logout',
    '/ssh rm e2e-host',
    '/contribute-pr',
    '/skill:ralplan',
  ]) {
    const { sentMessages, addedMessages, gate } = await submit(text);

    assert.deepEqual(sentMessages, [], `${text} must send nothing`);
    assert.deepEqual(addedMessages, [], `${text} must not post a message`);
    assert.ok(gate, `${text} must raise a gate`);
    assert.equal(gate?.text, text);
    assert.ok((gate?.summary ?? '').length > 0);
  }
});

test('the gate retains its draft but repeated Enter cannot bypass confirmation', async () => {
  const { composer, sentMessages, gate } = await submit('/session delete');

  assert.deepEqual(sentMessages, []);
  assert.equal(storage.get(draftInputKey(selectedProject.projectId, 'session-1')), '/session delete');
  assert.equal(gate?.text, '/session delete');
  await composer.handleSubmit(submitEvent);
  assert.deepEqual(sentMessages, []);
});

test('an unclassified form gates rather than running unannounced', async () => {
  const { sentMessages, gate } = await submit('/some-future-command');

  assert.deepEqual(sentMessages, []);
  assert.equal(gate?.classified, false);
});

test('a safe read runs without a gate', async () => {
  for (const text of ['/dump', '/jobs', '/context', '/session info', '/ssh list']) {
    const { sentMessages, gates } = await submit(text);

    assert.deepEqual(gates, [], `${text} must not gate`);
    assert.equal(sentMessages.length, 1, `${text} must dispatch`);
    assert.equal((sentMessages[0] as { content: string }).content, text);
  }
});

test('confirming dispatches the held text exactly once, byte for byte', async () => {
  const { composer, sentMessages, gates } = await submit('/session delete');
  assert.deepEqual(sentMessages, []);

  composer.confirmCommandGate();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(sentMessages.length, 1, 'confirm must dispatch exactly one frame');
  assert.equal((sentMessages[0] as { content: string }).content, '/session delete');
  // Raised, then cleared before the replay.
  assert.equal(gates.at(-1), null);
});

test('cancelling clears the gate and still sends nothing', async () => {
  const { composer, sentMessages, gates, gate } = await submit('/clear');
  assert.ok(gate);

  composer.cancelCommandGate();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(sentMessages, []);
  assert.equal(gates.at(-1), null);
});

test('prose is unaffected while nothing is gated', async () => {
  const { sentMessages, gates } = await submit('please refactor the parser');

  assert.deepEqual(gates, []);
  assert.equal(sentMessages.length, 1);
  assert.equal((sentMessages[0] as { content: string }).content, 'please refactor the parser');
});
