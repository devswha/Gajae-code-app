import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { normalizedToChatMessages } from '../hooks/useChatMessages';
import { isToolCallRunning } from '../utils/toolActivity';
import { assignMessageKeys } from '../utils/messageKeys';
import { buildPaneList, isTurnWorkBlockItem } from '../utils/turnWork';

/*
 * The conversion is what the transcript renders from, and the pane's rows
 * are memoised on the objects it returns. A row that did not change must
 * convert to the same object, or every streamed delta re-renders the whole
 * session; a row that did change - or a call whose result landed - must not.
 */

const row = (extra: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: extra.id ?? `id-${Math.random()}`, sessionId: 's', timestamp: '2026-09-02T00:00:00Z', provider: 'gjc', kind: 'text', ...extra,
});

test('an unchanged row converts to the same ChatMessage object on the next pass', () => {
  const user = row({ id: 'u', role: 'user', content: 'hi' });
  const call = row({ id: 'c', kind: 'tool_use', toolId: 't1', toolName: 'read', toolInput: { path: 'a.ts' } });
  const answer = row({ id: 'a', role: 'assistant', content: 'done' });
  const first = normalizedToChatMessages([user, call, answer]);

  // The streaming row is replaced; everything else is the same object.
  const streaming = (content: string) => row({ id: '__streaming_s', kind: 'stream_delta', content });
  const second = normalizedToChatMessages([user, call, answer, streaming('he')]);
  const third = normalizedToChatMessages([user, call, answer, streaming('hello')]);

  assert.equal(second[0], first[0]);
  assert.equal(second[1], first[1]);
  assert.equal(second[2], first[2]);
  assert.equal(third[3].content, 'hello');
  assert.notEqual(third[3], second[3]);
  assert.equal(third[3].isStreaming, true);
});

test('a call converts again when its result lands, whether inline or as its own row', () => {
  const call = row({ id: 'c', kind: 'tool_use', toolId: 't1', toolName: 'read', toolInput: { path: 'a.ts' } });
  const pending = normalizedToChatMessages([call])[0];
  assert.equal(pending.toolResult, null);
  assert.equal(pending.id, 'c');
  assert.equal(pending.toolId, 't1');

  const result = row({ id: 'r', kind: 'tool_result', toolId: 't1', content: 'contents', isError: false });
  const [paired, ...rest] = normalizedToChatMessages([call, result]);
  assert.equal(rest.length, 0, 'the result row folds into the call');
  assert.notEqual(paired, pending);
  assert.equal(paired.toolResult?.content, 'contents');

  // The same pairing on the next pass is the same object.
  assert.equal(normalizedToChatMessages([call, result])[0], paired);

  // A later result row for the same call supersedes the earlier one.
  const updated = row({ id: 'r2', kind: 'tool_result', toolId: 't1', content: 'more', isError: false });
  const [superseded] = normalizedToChatMessages([call, result, updated]);
  assert.notEqual(superseded, paired);
  assert.equal(superseded.toolResult?.content, 'more');

  // An inline result is the row's own: a new row object, a new conversion.
  const inline = { ...call, toolResult: { content: 'inline', isError: false } };
  const [own] = normalizedToChatMessages([inline]);
  assert.notEqual(own, pending);
  assert.equal(own.toolResult?.content, 'inline');
  for (const message of [paired, superseded, own]) {
    assert.equal(message.id, 'c', 'the tool call retains its persisted row ID when its result changes');
    assert.equal(message.toolId, 't1', 'row identity does not replace the tool pairing ID');
  }
});

test('prepending text with the same timestamp and content prefix keeps distinct row IDs and keys', () => {
  const prefix = 'The same leading text that exceeds the forty-eight character key preview: ';
  const existing = row({ id: 'existing', role: 'assistant', content: `${prefix}existing` });
  const first = normalizedToChatMessages([existing]);
  const firstKeys = assignMessageKeys(first);
  const older = row({ id: 'older', role: 'assistant', content: `${prefix}older` });
  const prepended = normalizedToChatMessages([older, existing]);
  const prependedKeys = assignMessageKeys(prepended);

  assert.equal(older.timestamp, existing.timestamp);
  assert.deepEqual(prepended.map((message) => message.id), ['older', 'existing']);
  assert.equal(prepended[1], first[0]);
  assert.equal(prependedKeys(prepended[1]), firstKeys(first[0]));
  assert.notEqual(prependedKeys(prepended[0]), prependedKeys(prepended[1]));
});

test('changing a text row replaces its output without changing its ID or key', () => {
  const original = row({ id: 'answer', role: 'assistant', content: 'Before' });
  const first = normalizedToChatMessages([original]);
  const updated = normalizedToChatMessages([{ ...original, content: 'After' }]);

  assert.notEqual(updated[0], first[0]);
  assert.equal(updated[0].content, 'After');
  assert.equal(updated[0].id, original.id);
  assert.equal(assignMessageKeys(updated)(updated[0]), assignMessageKeys(first)(first[0]));
});

test('a text row that yields two messages yields the same two next time', () => {
  const notice = row({
    id: 'n', role: 'user',
    content: '<task-notification><status>completed</status><summary>Done</summary><result>All green</result></task-notification>',
  });
  const first = normalizedToChatMessages([notice]);
  assert.deepEqual(first.map((message) => message.content), ['Done', 'All green']);
  assert.deepEqual(first.map((message) => message.id), ['n', 'n:result']);
  const second = normalizedToChatMessages([notice]);
  assert.equal(second[0], first[0]);
  assert.equal(second[1], first[1]);

  const updated = normalizedToChatMessages([{
    ...notice,
    content: '<task-notification><status>failed</status><summary>Failed</summary><result>One failure</result></task-notification>',
  }]);
  assert.deepEqual(updated.map((message) => message.content), ['Failed', 'One failure']);
  assert.deepEqual(updated.map((message) => message.id), first.map((message) => message.id));
  assert.notEqual(updated[0], first[0]);
  assert.notEqual(updated[1], first[1]);

  const summaryOnly = normalizedToChatMessages([{
    ...notice,
    content: '<task-notification><status>running</status><summary>Working</summary></task-notification>',
  }]);
  assert.equal(summaryOnly.length, 1);
  assert.equal(summaryOnly[0].id, first[0].id, 'the summary keeps its identity when a result appears or disappears');
});

test('partial tool results preserve their running state through chat conversion', () => {
  for (const toolName of ['bash', 'Task']) {
    const call = row({ kind: 'tool_use', toolId: 'partial-tool', toolName, toolInput: {} });
    const partial = row({ kind: 'tool_result', toolId: 'partial-tool', content: '', isError: false, isFinal: false });
    const running = normalizedToChatMessages([call, partial])[0];
    assert.equal(running.toolResult?.isFinal, false);
    assert.equal(isToolCallRunning(running), true);
    if (toolName === 'Task') assert.equal(running.subagentState?.isComplete, false);
    const final = row({ kind: 'tool_result', toolId: 'partial-tool', content: '', isError: false, isFinal: true });
    const finished = normalizedToChatMessages([call, partial, final])[0];
    assert.equal(isToolCallRunning(finished), false);
    if (toolName === 'Task') assert.equal(finished.subagentState?.isComplete, true);
  }
});

test('routine auto-approval info notices are omitted for every automatic policy', () => {
  for (const reason of ['bypass', 'always allow', 'auto-approve edits']) {
    for (const tool of ['bash', 'edit', 'eval', 'mcp__files__read', 'browser.open']) {
      for (const level of [undefined, 'info'] as const) {
        const notice = row({ kind: 'system_notice', level, content: `  Auto-approved ${tool} (${reason})\n` });
        assert.deepEqual(normalizedToChatMessages([notice]), [], `${tool}: ${reason}: ${level}`);
      }
    }
  }
});

test('hiding a notice does not delete raw records or disturb projection identity', () => {
  const notice = Object.freeze(row({ kind: 'system_notice', level: 'info', content: 'Auto-approved bash (bypass)' }));
  const user = row({ role: 'user', content: 'Run the check' });
  const answer = row({ role: 'assistant', content: 'The check passed' });
  const transcript = [user, notice, answer];
  const first = normalizedToChatMessages(transcript);
  const again = normalizedToChatMessages(transcript);
  assert.deepEqual(first.map((message) => message.content), ['Run the check', 'The check passed']);
  assert.equal(transcript.length, 3);
  assert.equal(transcript[1], notice);
  assert.equal(notice.content, 'Auto-approved bash (bypass)');
  assert.equal(again[0], first[0]);
  assert.equal(again[1], first[1]);
});

test('warning and error notices remain visible even when they use the same words', () => {
  for (const level of ['warning', 'error'] as const) {
    const notice = row({ kind: 'system_notice', level, content: 'Auto-approved bash (bypass)' });
    const [message] = normalizedToChatMessages([notice]);
    assert.equal(message.content, notice.content);
    assert.equal(message.isSystemNotice, true);
    assert.equal(message.noticeLevel, level);
  }
});

test('user text, assistant text, streaming text and tool output are never matched as notices', () => {
  const content = 'Auto-approved bash (bypass)';
  const rows = [
    row({ role: 'user', content }),
    row({ role: 'assistant', content }),
    row({ kind: 'stream_delta', content }),
    row({ kind: 'error', content }),
    row({ kind: 'tool_result', content }),
    row({ kind: 'interactive_prompt', content }),
  ];
  const messages = normalizedToChatMessages(rows);
  assert.equal(messages.length, rows.length);
  assert.ok(messages.every((message) => message.content === content));
  assert.equal(messages[3].type, 'error');
  assert.equal(messages[5].isInteractivePrompt, true);
});

test('other info notices and mixed or unfamiliar notice text remain visible', () => {
  for (const content of [
    'Permission approval is required.',
    'The provider reconnected.',
    'Auto-approved bash (bypass)\nReview the next permission request.',
    'Auto-approved bash (bypass) — additional context',
    'Auto-approved bash (unknown policy)',
    'Auto-approved (bypass)',
    'Quoted: Auto-approved bash (bypass)',
  ]) {
    const [message] = normalizedToChatMessages([row({ kind: 'system_notice', level: 'info', content })]);
    assert.equal(message.content, content);
    assert.equal(message.isSystemNotice, true);
  }
});

test('an omitted auto-approval notice does not split consecutive tool work into empty rows', () => {
  const messages = normalizedToChatMessages([
    row({ role: 'user', content: 'Check it' }),
    row({ kind: 'tool_use', toolId: 'read', toolName: 'read', toolInput: { path: 'a.ts' } }),
    row({ kind: 'system_notice', level: 'info', content: 'Auto-approved bash (bypass)' }),
    row({ kind: 'tool_use', toolId: 'bash', toolName: 'bash', toolInput: { command: 'npm test' } }),
    row({ role: 'assistant', content: 'Done' }),
  ]);
  const blocks = buildPaneList(messages, 'balanced').filter(isTurnWorkBlockItem);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].messages.map((message) => message.toolName), ['read', 'bash']);
});
