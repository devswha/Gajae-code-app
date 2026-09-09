import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import '../../../i18n/config';
import enChat from '../../../i18n/locales/en/chat.json';
import type { ChatMessage } from '../types/types';
import { assignMessageKeys } from '../utils/messageKeys';
import type { ToolOutputDensity } from '../utils/toolOutputDensity';

import ChatMessagesPane from './ChatMessagesPane';

/*
 * The block folds and unfolds on a click, keeps the cards inside working, and
 * disappears when the level switches to detailed - all state and events, so
 * this mounts the real pane in a DOM.
 */

afterEach(cleanup);

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 2, 0, 0, seconds)).toISOString();
const call = (toolName: string, seconds: number, toolInput: unknown, isError = false): ChatMessage => ({
  id: `row-${toolName}-${seconds}`,
  type: 'assistant', content: '', timestamp: at(seconds), isToolUse: true, toolName, toolInput, toolId: `${toolName}-${seconds}`,
  toolResult: { content: isError ? 'exit 1: missing module' : 'fine', isError, timestamp: at(seconds + 1) },
});

const transcript: ChatMessage[] = [
  { type: 'user', content: 'go', timestamp: at(0) },
  call('read', 1, { path: 'src/alpha.ts' }),
  call('read', 2, { path: 'src/beta.ts' }),
  call('bash', 3, { command: 'npm test' }, true),
  { type: 'assistant', content: 'All done here.', timestamp: at(10) },
];

const paneProps = (density: ToolOutputDensity, messages = transcript) => ({
  scrollContainerRef: { current: null },
  onWheel: () => {},
  onTouchMove: () => {},
  isLoadingSessionMessages: false,
  chatMessages: messages,
  selectedSession: { id: 's1', provider: 'gjc' as const },
  currentSessionId: 's1',
  provider: 'gjc' as const,
  isLoadingMoreMessages: false,
  hasMoreMessages: false,
  totalMessages: messages.length,
  visibleMessageCount: messages.length,
  visibleMessages: messages,
  loadEarlierMessages: () => {},
  loadAllMessages: () => {},
  allMessagesLoaded: true,
  isLoadingAllMessages: false,
  loadAllJustFinished: false,
  showLoadAllOverlay: false,
  createDiff: () => [],
  density,
  selectedProject: { displayName: 'demo', fullPath: '/demo', projectId: 'demo' },
});

const toggle = () => screen.getByRole('button', { name: enChat.workBlock.toggle });

test('the block opens on a click to the rows the pane would have shown, and closes again', () => {
  render(createElement(ChatMessagesPane, paneProps('balanced')));

  const button = toggle();
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.match(button.textContent ?? '', /Worked for 10s/);
  assert.match(button.textContent ?? '', /2 files read · 1 command/);
  assert.match(button.textContent ?? '', new RegExp(`${enChat.tools.error}.*1 failed`));
  // Folded: the answer is on the page, the rows are not.
  assert.ok(screen.getByText('All done here.'));
  assert.equal(screen.queryByText('src/alpha.ts'), null);
  assert.equal(screen.queryByText(/npm test/), null);

  fireEvent.click(button);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  const body = document.getElementById(button.getAttribute('aria-controls') ?? '');
  assert.ok(body, 'the body the toggle controls is in the DOM');
  // Balanced folds the two reads into one group row and opens the failed
  // shell command on the spot, as it does outside a block.
  const groupRow = within(body).getByRole('button', { expanded: false });
  assert.match(groupRow.textContent ?? '', /Read.*×2/);
  assert.ok(within(body).getByText(/npm test/));
  assert.ok(within(body).getByText(/exit 1: missing module/));

  // The card's own fold still works inside the block.
  fireEvent.click(groupRow);
  assert.equal(groupRow.getAttribute('aria-expanded'), 'true');
  assert.ok(within(body).getByText('alpha.ts'));
  assert.ok(within(body).getByText('beta.ts'));

  fireEvent.click(button);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(screen.queryByText('alpha.ts'), null);
});

test('compact folds the block too, and its failure stays folded inside once opened', () => {
  render(createElement(ChatMessagesPane, paneProps('compact')));

  const button = toggle();
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  fireEvent.click(button);
  const body = document.getElementById(button.getAttribute('aria-controls') ?? '');
  assert.ok(body);
  // Compact: every row a folded group, the failed one marked but closed.
  const rows = within(body).getAllByRole('button', { expanded: false });
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => (row.textContent ?? '').includes(enChat.tools.error)));
  assert.equal(within(body).queryByText(/exit 1: missing module/), null);
});

for (const density of ['balanced', 'compact'] as const) {
  test(`${density}: an expanded top work block keeps its DOM and anchor through continuous prepend and append`, () => {
    const messages = [call('read', 2, { path: 'src/beta.ts' }), call('read', 3, { path: 'src/gamma.ts' })];
    const view = render(createElement(ChatMessagesPane, paneProps(density, messages)));
    const button = toggle();
    fireEvent.click(button);
    const block = button.closest('[data-work-block]');
    const anchor = button.closest('[data-scroll-anchor]');
    const key = anchor?.getAttribute('data-scroll-anchor');
    const bodyId = button.getAttribute('aria-controls');
    const body = document.getElementById(bodyId ?? '');
    assert.ok(block);
    assert.ok(anchor);
    assert.ok(key);
    assert.ok(body);
    const groupedReads = within(body).getByRole('button', { expanded: false });
    fireEvent.click(groupedReads);
    assert.equal(groupedReads.getAttribute('aria-expanded'), 'true');
    const nestedGroup = groupedReads.closest('.chat-message');
    const betaCard = within(body).getByText('beta.ts').closest('.chat-message');
    assert.ok(nestedGroup);
    assert.ok(betaCard);

    // Rebuilt message objects still represent the same normalized rows.
    const prepended = [call('read', 1, { path: 'src/alpha.ts' }), ...messages.map((message) => ({ ...message }))];
    const appended = [...prepended.map((message) => ({ ...message })), call('read', 4, { path: 'src/delta.ts' })];
    for (const updated of [prepended, appended]) {
      view.rerender(createElement(ChatMessagesPane, paneProps(density, updated)));
      assert.equal(toggle(), button, 'the expanded toggle is not remounted');
      assert.equal(button.getAttribute('aria-expanded'), 'true');
      assert.equal(button.closest('[data-work-block]'), block);
      assert.equal(button.closest('[data-scroll-anchor]'), anchor);
      assert.equal(anchor.getAttribute('data-scroll-anchor'), key);
      assert.equal(button.getAttribute('aria-controls'), bodyId);
      assert.equal(document.getElementById(bodyId ?? ''), body, 'the expanded body is not replaced');
      assert.equal(within(body).getByRole('button', { expanded: true }), groupedReads, 'the nested group toggle is not remounted');
      assert.equal(groupedReads.getAttribute('aria-expanded'), 'true');
      assert.equal(groupedReads.closest('.chat-message'), nestedGroup);
      assert.equal(within(body).getByText('beta.ts').closest('.chat-message'), betaCard, 'an existing nested card keeps its DOM');
      assert.ok(within(body).getByText('alpha.ts'));
      assert.match(button.textContent ?? '', new RegExp(`${updated.length} files read`));
      assert.equal(view.container.querySelectorAll('[data-scroll-anchor]').length, 1);
    }

    assert.ok(within(body).getByText('delta.ts'));
    fireEvent.click(groupedReads);
    assert.equal(groupedReads.getAttribute('aria-expanded'), 'false');
    assert.equal(within(body).queryByText('beta.ts'), null);
  });
}

test('a disjoint older work block receives its own anchor without stealing the expanded block DOM', () => {
  const messages = [call('read', 4, { path: 'src/current.ts' })];
  const view = render(createElement(ChatMessagesPane, paneProps('balanced', messages)));
  const button = toggle();
  fireEvent.click(button);
  const anchor = button.closest('[data-scroll-anchor]');
  const key = anchor?.getAttribute('data-scroll-anchor');
  const olderMessages: ChatMessage[] = [
    call('bash', 1, { command: 'pwd' }),
    { id: 'separator', type: 'assistant', content: 'Now inspect the file.', timestamp: at(2) },
    ...messages.map((message) => ({ ...message })),
  ];
  view.rerender(createElement(ChatMessagesPane, paneProps('balanced', olderMessages)));
  const blocks = screen.getAllByRole('button', { name: enChat.workBlock.toggle });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].getAttribute('aria-expanded'), 'false');
  assert.equal(blocks[1], button);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(button.closest('[data-scroll-anchor]'), anchor);
  assert.equal(anchor?.getAttribute('data-scroll-anchor'), key);
  const anchors = Array.from(view.container.querySelectorAll('[data-scroll-anchor]'));
  assert.equal(anchors.length, 3);
  assert.equal(new Set(anchors.map((row) => row.getAttribute('data-scroll-anchor'))).size, 3);
  assert.equal(anchors[1].getAttribute('data-scroll-anchor'), assignMessageKeys(olderMessages)(olderMessages[1]));
});

test('switching to detailed removes the block and puts the cards back at the top level; switching back restores it', () => {
  const view = render(createElement(ChatMessagesPane, paneProps('balanced')));
  const initialButton = toggle();
  fireEvent.click(initialButton);
  assert.equal(initialButton.getAttribute('aria-expanded'), 'true');
  const initialAnchor = initialButton.closest('[data-scroll-anchor]');

  view.rerender(createElement(ChatMessagesPane, paneProps('detailed')));
  assert.equal(screen.queryByRole('button', { name: enChat.workBlock.toggle }), null);
  // Detailed: each call is its own card, open, with the failed command's output.
  assert.ok(screen.getByText('alpha.ts'));
  assert.ok(screen.getByText('beta.ts'));
  assert.ok(screen.getByText(/exit 1: missing module/));
  assert.equal(screen.queryByText(/×2/), null);
  assert.equal(initialAnchor?.isConnected, false);
  assert.deepEqual(
    Array.from(view.container.querySelectorAll('[data-scroll-anchor]'), (row) => row.getAttribute('data-scroll-anchor')),
    transcript.map(assignMessageKeys(transcript)),
  );

  view.rerender(createElement(ChatMessagesPane, paneProps('compact')));
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  assert.notEqual(toggle(), initialButton);
  assert.equal(screen.queryByText('alpha.ts'), null);

  const compactButton = toggle();
  const compactAnchor = compactButton.closest('[data-scroll-anchor]');
  fireEvent.click(compactButton);
  assert.equal(compactButton.getAttribute('aria-expanded'), 'true');
  view.rerender(createElement(ChatMessagesPane, paneProps('balanced')));
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  assert.notEqual(toggle(), compactButton);
  assert.notEqual(toggle().closest('[data-scroll-anchor]')?.getAttribute('data-scroll-anchor'), compactAnchor?.getAttribute('data-scroll-anchor'));
});

test('ordinary rows keep their message ID anchors after prepend and content updates; hidden thoughts have no empty rows', () => {
  const answer: ChatMessage = { id: 'answer', type: 'assistant', content: 'Initial answer.', timestamp: at(5) };
  const view = render(createElement(ChatMessagesPane, paneProps('balanced', [answer])));
  const messageNode = screen.getByText('Initial answer.').closest('.chat-message');
  const anchor = messageNode?.closest('[data-scroll-anchor]');
  assert.ok(messageNode);
  assert.ok(anchor);
  const changed = { ...answer, content: 'Updated answer.', timestamp: at(6) };
  const messages: ChatMessage[] = [
    { id: 'question', type: 'user', content: 'Explain.', timestamp: at(0) },
    { id: 'thought', type: 'assistant', content: 'Hidden thought.', isThinking: true, timestamp: at(1) },
    changed,
  ];
  view.rerender(createElement(ChatMessagesPane, paneProps('balanced', messages)));
  assert.equal(screen.getByText('Updated answer.').closest('.chat-message'), messageNode);
  assert.equal(messageNode.closest('[data-scroll-anchor]'), anchor);
  assert.equal(anchor.getAttribute('data-scroll-anchor'), assignMessageKeys(messages)(changed));
  assert.equal(view.container.querySelectorAll('[data-scroll-anchor]').length, 2);
  assert.equal(screen.queryByText('Hidden thought.'), null);
});

test('history shows only an active loading indicator, without an idle count barrier', () => {
  let loadAllCalls = 0;
  let loadEarlierCalls = 0;
  const props = {
    ...paneProps('balanced'),
    hasMoreMessages: true,
    allMessagesLoaded: false,
    totalMessages: 50,
    loadAllMessages: () => { loadAllCalls += 1; },
    loadEarlierMessages: () => { loadEarlierCalls += 1; },
  };
  const view = render(createElement(ChatMessagesPane, props));
  const scrollPane = view.container.querySelector('.chat-messages-pane')!;
  const anchor = scrollPane.querySelector('[data-scroll-anchor]');
  assert.ok(anchor);
  assert.equal(view.container.querySelector('[data-pagination-status]'), null);
  assert.equal(view.container.querySelector('[data-load-all-overlay]'), null);
  // Paginated history keeps a click path to older rows and to the whole conversation.
  const controls = scrollPane.querySelector('[data-history-controls]') as HTMLElement;
  assert.ok(controls);
  fireEvent.click(within(controls).getByRole('button', { name: enChat.session.messages.loadEarlier }));
  fireEvent.click(within(controls).getByRole('button', { name: enChat.session.messages.loadAll }));
  assert.equal(loadEarlierCalls, 1);
  assert.equal(loadAllCalls, 1);

  view.rerender(createElement(ChatMessagesPane, { ...props, isLoadingMoreMessages: true }));
  const status = view.container.querySelector('[data-pagination-status]');
  assert.equal(status?.textContent, enChat.session.loading.olderMessages);
  assert.equal(status?.parentElement, scrollPane.parentElement);
  assert.equal(scrollPane.contains(status), false, 'loading does not displace the first message');
  assert.equal(scrollPane.querySelector('[data-scroll-anchor]'), anchor);
  assert.equal(view.container.querySelector('[data-load-all-overlay]'), null);

  view.rerender(createElement(ChatMessagesPane, props));
  assert.equal(view.container.querySelector('[data-pagination-status]'), null);
  assert.equal(scrollPane.querySelector('[data-scroll-anchor]'), anchor);

  view.rerender(createElement(ChatMessagesPane, { ...props, isLoadingAllMessages: true }));
  const overlay = view.container.querySelector('[data-load-all-overlay]')!;
  assert.ok(overlay);
  assert.equal(scrollPane.querySelector('[data-history-controls]'), null, 'no second entry point while loading everything');
  assert.equal(scrollPane.contains(overlay), false);
  const loadingButton = within(overlay as HTMLElement).getByRole('button') as HTMLButtonElement;
  assert.equal(loadingButton.disabled, true);
  assert.equal(loadingButton.textContent, enChat.session.messages.loadingAll);

  view.rerender(createElement(ChatMessagesPane, { ...props, hasMoreMessages: false, allMessagesLoaded: true }));
  assert.equal(view.container.querySelector('[data-load-all-overlay]'), null);
  assert.equal(scrollPane.querySelector('[data-history-controls]'), null);
  assert.equal(view.container.querySelector('[data-pagination-status]'), null);
  assert.equal(scrollPane.querySelector('[data-scroll-anchor]'), anchor);

  view.rerender(createElement(ChatMessagesPane, { ...props, hasMoreMessages: false, visibleMessageCount: 2 }));
  fireEvent.click(within(scrollPane as HTMLElement).getByRole('button', { name: enChat.session.messages.loadEarlier }));
  fireEvent.click(within(scrollPane as HTMLElement).getByRole('button', { name: enChat.session.messages.loadAll }));
  assert.equal(loadEarlierCalls, 2);
  assert.equal(loadAllCalls, 2);
});

test('a history failure stays visible with an explicit retry instead of flashing a spinner', () => {
  let retries = 0;
  const props = { ...paneProps('balanced'), hasMoreMessages: true, allMessagesLoaded: false,
    historyLoadError: true, retryOlderMessages: () => { retries += 1; } };
  const view = render(createElement(ChatMessagesPane, props));
  assert.equal(view.container.querySelector('[data-pagination-status]'), null);
  const alert = screen.getByRole('alert');
  assert.ok(alert.textContent?.includes(enChat.session.loading.olderMessagesFailed));
  fireEvent.click(within(alert).getByRole('button', { name: enChat.session.loading.retry }));
  assert.equal(retries, 1);
  view.rerender(createElement(ChatMessagesPane, { ...props, historyLoadError: false, isLoadingMoreMessages: true }));
  assert.equal(screen.queryByRole('alert'), null);
  assert.ok(view.container.querySelector('[data-pagination-status]'));
});

test('a live turn before its first tool call is a Thinking row, not a finished block', () => {
  const messages: ChatMessage[] = [{ type: 'user', content: 'hello', timestamp: at(0) }];
  render(createElement(ChatMessagesPane, {
    ...paneProps('balanced', messages),
    isProcessing: true,
    liveActivity: { kind: 'thinking' },
    runStartedAt: Date.now() - 3_000,
  }));

  assert.equal(screen.queryByRole('button', { name: enChat.workBlock.toggle }), null);
  const row = document.querySelector('[data-run-activity="pending-block"]');
  assert.ok(row);
  assert.match(row.textContent ?? '', /Thinking/);
  assert.match(row.textContent ?? '', /3s/);
});

test('a finished turn with no tools has no block', () => {
  const messages: ChatMessage[] = [
    { type: 'user', content: 'hello', timestamp: at(0) },
    { type: 'assistant', content: 'Hi there.', timestamp: at(2) },
  ];
  render(createElement(ChatMessagesPane, paneProps('balanced', messages)));
  assert.equal(screen.queryByRole('button', { name: enChat.workBlock.toggle }), null);
  assert.ok(screen.getByText('Hi there.'));
  assert.equal(document.querySelector('[data-run-activity]'), null);
});

test('detailed density shows an inline running row and no work block', () => {
  const messages: ChatMessage[] = [
    { type: 'user', content: 'now fix it', timestamp: at(20) },
    call('bash', 22, { command: 'npm run lint' }),
  ];
  messages[1] = { ...messages[1], toolResult: null };
  render(createElement(ChatMessagesPane, {
    ...paneProps('detailed', messages),
    isProcessing: true,
    liveActivity: { kind: 'tool', category: 'command', toolName: 'bash', subject: 'npm run lint', moreCount: 0 },
    runStartedAt: Date.now() - 12_000,
  }));

  assert.equal(screen.queryByRole('button', { name: enChat.workBlock.toggle }), null);
  const row = document.querySelector('[data-run-activity="inline"]');
  assert.ok(row);
  // The phase first, the call in flight beside it.
  assert.match(row.textContent ?? '', /Thinking… · Running npm run lint…/);
});

test('a live run: the last turn\'s block says what is happening, earlier turns stay finished', () => {
  const messages: ChatMessage[] = [
    ...transcript,
    { type: 'user', content: 'now fix it', timestamp: at(20) },
    call('edit', 21, { path: 'src/alpha.ts', edits: [] }),
    { ...call('bash', 22, { command: 'npm run lint' }), toolResult: null },
  ];
  render(createElement(ChatMessagesPane, {
    ...paneProps('balanced', messages),
    isProcessing: true,
    liveActivity: { kind: 'tool', category: 'command', toolName: 'bash', subject: 'npm run lint', moreCount: 0 },
    runStartedAt: Date.now() - 12_000,
  }));

  const blocks = screen.getAllByRole('button', { name: enChat.workBlock.toggle });
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].textContent ?? '', /Worked for 10s/);
  assert.doesNotMatch(blocks[1].textContent ?? '', /Working/);
  assert.match(blocks[1].textContent ?? '', /Thinking…/);
  assert.match(blocks[1].textContent ?? '', /12s/);
  assert.equal(blocks[1].getAttribute('aria-expanded'), 'false');
  // The latest call beside the phase, one at a time; the finished block has none.
  assert.match(blocks[1].textContent ?? '', /Thinking… · Running npm run lint… · 12s/);
  assert.doesNotMatch(blocks[1].textContent ?? '', /Editing src\/alpha\.ts/);
  assert.equal(document.querySelectorAll('[data-live-call]').length, 1);
});

test('prose between calls stays on the page between its own blocks, and only the last block is live', () => {
  // The Codex/Cursor layout: read → "Found it, fixing." → edit … while the
  // run goes on, and the sentence is never folded away when the next call lands.
  const messages: ChatMessage[] = [
    { type: 'user', content: 'fix the bug', timestamp: at(0) },
    call('read', 1, { path: 'src/alpha.ts' }),
    call('read', 2, { path: 'src/beta.ts' }),
    { type: 'assistant', content: 'Found it in beta.ts, fixing now.', timestamp: at(8) },
    { ...call('edit', 9, { path: 'src/beta.ts', edits: [] }), toolResult: null },
  ];
  render(createElement(ChatMessagesPane, {
    ...paneProps('balanced', messages),
    isProcessing: true,
    liveActivity: { kind: 'tool', category: 'edit', toolName: 'edit', subject: 'src/beta.ts', moreCount: 0 },
    runStartedAt: Date.now() - 12_000,
  }));

  const blocks = screen.getAllByRole('button', { name: enChat.workBlock.toggle });
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].textContent ?? '', /Worked for 8s/);
  assert.match(blocks[0].textContent ?? '', /2 files read/);
  assert.ok(screen.getByText('Found it in beta.ts, fixing now.'));
  assert.match(blocks[1].textContent ?? '', /Thinking… · Editing src\/beta\.ts…/);
  // In document order: block, prose, block.
  const prose = screen.getByText('Found it in beta.ts, fixing now.');
  assert.ok(blocks[0].compareDocumentPosition(prose) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(prose.compareDocumentPosition(blocks[1]) & Node.DOCUMENT_POSITION_FOLLOWING);
});
