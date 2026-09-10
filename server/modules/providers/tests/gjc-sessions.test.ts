import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appConfigDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { GjcSessionSynchronizer } from '@/modules/providers/list/gjc/gjc-session-synchronizer.provider.js';
import { GjcSessionsProvider } from '@/modules/providers/list/gjc/gjc-sessions.provider.js';
import { exportSessionTranscript } from '@/modules/providers/services/session-export.service.js';
import { fetchCompleteHistory, sessionsService } from '@/modules/providers/services/sessions.service.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};
const patchLiveSessionDir = (nextSessionDir: string) => {
  const original = process.env.GJC_LIVE_SESSION_DIR;
  process.env.GJC_LIVE_SESSION_DIR = nextSessionDir;
  return () => {
    if (original === undefined) {
      delete process.env.GJC_LIVE_SESSION_DIR;
    } else {
      process.env.GJC_LIVE_SESSION_DIR = original;
    }
  };
};


async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'gjc-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes one synthetic gjc JSONL transcript.
 *
 * The header line carries the authoritative id/cwd at the top level (unlike
 * Codex which nests them under `payload`). Message lines use gjc's
 * `message.content[]` part shape.
 */
const writeGjcTranscript = async (
  homeDir: string,
  gjcSessionId: string,
  workspacePath: string,
  options: {
    firstUserMessage?: string;
    withConversation?: boolean;
    sessionsDir?: string;
  } = {},
): Promise<string> => {
  const sessionsDir = options.sessionsDir ?? path.join(homeDir, '.gjc', 'agent', 'sessions', '-workspace');
  await mkdir(sessionsDir, { recursive: true });

  const lines: string[] = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: gjcSessionId,
      timestamp: '2026-07-09T00:00:00.000Z',
      cwd: workspacePath,
    }),
  ];

  if (options.firstUserMessage !== undefined) {
    lines.push(JSON.stringify({
      type: 'message',
      id: 'msg-1',
      parentId: null,
      timestamp: '2026-07-09T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: options.firstUserMessage }] },
    }));
  }

  if (options.withConversation) {
    lines.push(JSON.stringify({
      type: 'message',
      id: 'msg-2',
      parentId: 'msg-1',
      timestamp: '2026-07-09T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'Let me think.' },
          { type: 'text', text: 'Here is the answer.' },
          { type: 'toolCall', toolName: 'Bash', toolInput: { command: 'ls' }, toolCallId: 'call-1' },
        ],
      },
    }));
    lines.push(JSON.stringify({
      type: 'message',
      id: 'msg-3',
      parentId: 'msg-2',
      timestamp: '2026-07-09T00:00:03.000Z',
      // Real gjc shape: a tool RESULT is its own top-level message with
      // role 'toolResult', toolCallId/toolName on the message, and plain text parts.
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'Bash',
        content: [{ type: 'text', text: 'file.txt' }],
        isError: false,
      },
    }));
    // Non-message control events must be ignored by both indexer and history reader.
    lines.push(JSON.stringify({ type: 'model_change', timestamp: '2026-07-09T00:00:04.000Z', model: 'x' }));
  }

  const filePath = path.join(sessionsDir, `2026-07-09T00-00-00_${gjcSessionId}.jsonl`);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

test('gjc synchronizer indexes sessions and derives the title from the first user message', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-sync-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    await writeGjcTranscript(tempRoot, 'gjc-1', workspacePath, { firstUserMessage: 'Add a gjc provider' });
    await withIsolatedDatabase(async () => {
      const synchronizer = new GjcSessionSynchronizer();
      const reconciliation = await synchronizer.reconcile();

      assert.deepEqual(reconciliation, { processed: 1, sessionIds: ['gjc-1'] });
      const indexed = sessionsDb.getSessionById('gjc-1');
      assert.equal(indexed?.provider, 'gjc');
      assert.equal(indexed?.project_path, workspacePath);
      assert.equal(indexed?.custom_name, 'Add a gjc provider');
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc titles are concise: the first message loses its command and mentions and is cut at a sentence', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-title-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    const filePath = await writeGjcTranscript(tempRoot, 'gjc-titled', workspacePath, {
      firstUserMessage: '/plan @src/server/index.ts Fix the boot order so the watcher starts after the database. Right now it races and the first scan is lost.',
      withConversation: true,
    });
    await withIsolatedDatabase(async () => {
      const synchronizer = new GjcSessionSynchronizer();
      await synchronizer.reconcile();
      assert.equal(sessionsDb.getSessionById('gjc-titled')?.custom_name, 'Fix the boot order so the watcher…');

      // A hand-written name survives every later sync...
      sessionsDb.updateSessionCustomName('gjc-titled', 'Boot order race', 'user');
      await synchronizer.synchronizeFile(filePath);
      assert.equal(sessionsDb.getSessionById('gjc-titled')?.custom_name, 'Boot order race');

      // ...until the user explicitly asks for the derived title back.
      const regenerated = await sessionsService.regenerateSessionTitle('gjc-titled');
      assert.deepEqual(regenerated, { sessionId: 'gjc-titled', summary: 'Fix the boot order so the watcher…' });
      assert.equal(sessionsDb.getSessionById('gjc-titled')?.custom_name, 'Fix the boot order so the watcher…');
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('regenerating a title needs a transcript with a user message behind it', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-title-empty-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    await writeGjcTranscript(tempRoot, 'gjc-no-prompt', workspacePath);
    await withIsolatedDatabase(async () => {
      await new GjcSessionSynchronizer().reconcile();
      await assert.rejects(sessionsService.regenerateSessionTitle('gjc-no-prompt'), { code: 'SESSION_TITLE_UNAVAILABLE' });

      sessionsDb.createAppSession('app-only', 'gjc', workspacePath);
      await assert.rejects(sessionsService.regenerateSessionTitle('app-only'), { code: 'SESSION_TITLE_UNAVAILABLE' }, 'no transcript yet');
      await assert.rejects(sessionsService.regenerateSessionTitle('missing'), { code: 'SESSION_NOT_FOUND' });
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc reconciliation includes transcripts modified after the shared scan cursor', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-reconcile-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    const transcript = await writeGjcTranscript(tempRoot, 'gjc-reconciled', workspacePath);
    await withIsolatedDatabase(async () => {
      appConfigDb.set('gjc_initial_scan_done', 'true');
      const scanCursor = new Date();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await appendFile(transcript, `${JSON.stringify({
        type: 'message',
        id: 'msg-after-gap',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'Recovered' }] },
      })}\n`, 'utf8');

      const reconciliation = await new GjcSessionSynchronizer().reconcile(scanCursor);

      assert.deepEqual(reconciliation, {
        processed: 1,
        sessionIds: ['gjc-reconciled'],
      });
      assert.equal(sessionsDb.getSessionById('gjc-reconciled')?.provider, 'gjc');

      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        new GjcSessionSynchronizer().reconcile(scanCursor, controller.signal),
        { name: 'AbortError' }
      );
      await assert.rejects(
        new GjcSessionSynchronizer().synchronizeFile(transcript, controller.signal),
        { name: 'AbortError' }
      );
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc reconciliation purges pending symlinks that escape session roots', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-reconcile-link-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const sessionRoot = path.join(tempRoot, '.gjc', 'agent', 'sessions', '-workspace');
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(sessionRoot, { recursive: true }),
  ]);
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    const outsideTranscript = await writeGjcTranscript(
      tempRoot,
      'gjc-outside',
      workspacePath,
      { sessionsDir: path.join(tempRoot, 'outside') }
    );
    const linkedTranscript = path.join(sessionRoot, 'linked.jsonl');
    await symlink(outsideTranscript, linkedTranscript, 'file');

    await withIsolatedDatabase(async () => {
      appConfigDb.set('gjc_initial_scan_done', 'true');
      appConfigDb.set('gjc_pending_session_files', JSON.stringify([{
        filePath: linkedTranscript,
        rootPath: sessionRoot,
      }]));

      const synchronizer = new GjcSessionSynchronizer();
      const reconciliation = await synchronizer.reconcile(new Date(0));

      assert.deepEqual(reconciliation, { processed: 0, sessionIds: [] });
      assert.equal(await synchronizer.synchronizeFile(linkedTranscript), null);
      const internalTarget = await writeGjcTranscript(
        tempRoot,
        'gjc-internal-link',
        workspacePath,
        { sessionsDir: sessionRoot }
      );
      const internalLink = path.join(sessionRoot, 'internal-link.jsonl');
      await symlink(internalTarget, internalLink, 'file');
      assert.equal(await synchronizer.synchronizeFile(internalLink), null);
      assert.equal(sessionsDb.getSessionById('gjc-outside'), null);
      assert.equal(sessionsDb.getSessionById('gjc-internal-link'), null);
      assert.equal(appConfigDb.get('gjc_pending_session_files'), '[]');
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc synchronizer falls back to Untitled when no user message exists', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-sync-untitled-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    await writeGjcTranscript(tempRoot, 'gjc-empty', workspacePath, {});
    await withIsolatedDatabase(async () => {
      await new GjcSessionSynchronizer().synchronize();
      assert.equal(sessionsDb.getSessionById('gjc-empty')?.custom_name, 'Untitled gjc Session');
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc sessions provider normalizes message content parts and folds tool results', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    await writeGjcTranscript(tempRoot, 'gjc-history', workspacePath, {
      firstUserMessage: 'Question?',
      withConversation: true,
    });
    await withIsolatedDatabase(async () => {
      await new GjcSessionSynchronizer().synchronize();

      const provider = new GjcSessionsProvider();
      const history = await provider.fetchHistory('gjc-history');

      // total counts non-tool_result messages: user text, thinking, assistant text, tool_use.
      assert.equal(history.total, 4);
      assert.equal(history.messages[0]?.kind, 'text');
      assert.equal(history.messages[0]?.role, 'user');
      assert.equal(history.messages[0]?.content, 'Question?');
      assert.equal(history.messages[1]?.kind, 'thinking');
      assert.equal(history.messages[1]?.content, 'Let me think.');
      assert.equal(history.messages[2]?.kind, 'text');
      assert.equal(history.messages[2]?.role, 'assistant');
      assert.equal(history.messages[2]?.content, 'Here is the answer.');
      assert.equal(history.messages[3]?.kind, 'tool_use');
      assert.equal(history.messages[3]?.toolName, 'Bash');
      assert.deepEqual(history.messages[3]?.toolResult, { content: 'file.txt', isError: false });
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
test('gjc sessions provider excludes hidden and internal-role messages from history', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-hidden-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const sessionsDir = path.join(tempRoot, '.gjc', 'agent', 'sessions', '-workspace');
  await mkdir(workspacePath, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'gjc-hidden-history', timestamp: '2026-07-09T00:00:00.000Z', cwd: workspacePath }),
      JSON.stringify({ type: 'message', id: 'hidden', timestamp: '2026-07-09T00:00:01.000Z', message: { role: 'user', display: false, content: [{ type: 'text', text: 'Do not show me' }] } }),
      JSON.stringify({ type: 'message', id: 'custom', timestamp: '2026-07-09T00:00:02.000Z', message: { role: 'custom', content: [{ type: 'text', text: 'volatile-project-context' }] } }),
      JSON.stringify({ type: 'message', id: 'developer', timestamp: '2026-07-09T00:00:03.000Z', message: { role: 'developer', content: [{ type: 'text', text: 'Internal instructions' }] } }),
      JSON.stringify({ type: 'message', id: 'hook', timestamp: '2026-07-09T00:00:04.000Z', message: { role: 'hook', content: [{ type: 'text', text: 'Hook output' }] } }),
      JSON.stringify({ type: 'message', id: 'user', timestamp: '2026-07-09T00:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Visible question' }] } }),
      JSON.stringify({ type: 'message', id: 'assistant', timestamp: '2026-07-09T00:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Visible answer' }] } }),
    ];
    await writeFile(
      path.join(sessionsDir, '2026-07-09T00-00-00_gjc-hidden-history.jsonl'),
      `${lines.join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      await new GjcSessionSynchronizer().synchronize();

      const history = await new GjcSessionsProvider().fetchHistory('gjc-hidden-history');

      assert.equal(history.total, 2);
      assert.deepEqual(
        history.messages.map((message) => message.content),
        ['Visible question', 'Visible answer'],
      );
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc sessions provider returns a folded tool call for the newest one-message page', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-tail-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    await writeGjcTranscript(tempRoot, 'gjc-tail-history', workspacePath, {
      firstUserMessage: 'Question?',
      withConversation: true,
    });
    await withIsolatedDatabase(async () => {
      await new GjcSessionSynchronizer().synchronize();

      const history = await new GjcSessionsProvider().fetchHistory('gjc-tail-history', { limit: 1 });

      assert.equal(history.total, 4);
      assert.equal(history.messages.length, 1);
      assert.equal(history.messages[0]?.kind, 'tool_use');
      assert.deepEqual(history.messages[0]?.toolResult, { content: 'file.txt', isError: false });
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc sessions provider bounds page payloads without hiding older history', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-ring-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const sessionsDir = path.join(tempRoot, '.gjc', 'agent', 'sessions', '-workspace');
  await mkdir(workspacePath, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    const messageCount = 5_001;
    const startTime = Date.parse('2026-07-09T00:00:00.000Z');
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'gjc-ring-history', timestamp: '2026-07-09T00:00:00.000Z', cwd: workspacePath }),
    ];
    // The oldest visible row is a tool call whose result only the paged walk can reach.
    lines.push(JSON.stringify({
      type: 'message', id: 'oldest-call', timestamp: new Date(startTime - 2).toISOString(),
      message: { role: 'assistant', content: [{ type: 'toolCall', toolName: 'read', toolInput: { path: 'a.ts' }, toolCallId: 'call-oldest' }] },
    }));
    lines.push(JSON.stringify({
      type: 'message', id: 'oldest-result', timestamp: new Date(startTime - 1).toISOString(),
      message: { role: 'toolResult', toolCallId: 'call-oldest', toolName: 'read', content: [{ type: 'text', text: 'oldest output' }], isError: false },
    }));
    for (let index = 0; index < messageCount; index += 1) {
      lines.push(JSON.stringify({
        type: 'message',
        id: `message-${index}`,
        timestamp: new Date(startTime + index).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: `message-${index}` }] },
      }));
    }
    const transcriptPath = path.join(sessionsDir, '2026-07-09T00-00-00_gjc-ring-history.jsonl');
    await writeFile(transcriptPath, `${lines.join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      await new GjcSessionSynchronizer().synchronize();

      const provider = new GjcSessionsProvider();
      await assert.rejects(provider.fetchHistory('gjc-ring-history'), { code: 'HISTORY_PAGE_TOO_LARGE' });
      // In-server consumers never issue the unbounded read; they page instead.
      const complete = await fetchCompleteHistory('gjc-ring-history', { provider: 'gjc', providerSessionId: 'gjc-ring-history' });
      assert.equal(complete.messages.length, 5_002);
      assert.equal(complete.total, 5_002);
      assert.equal(complete.hasMore, false);
      assert.equal(complete.messages[0]?.toolId, 'call-oldest');
      assert.equal(complete.messages[0]?.toolResult?.content, 'oldest output');
      assert.equal(complete.messages.at(-1)?.content, 'message-5000');
      assert.equal(new Set(complete.messages.map((message) => message.id)).size, 5_002, 'pages overlap only by identity');
      const oldestResult = await sessionsService.fetchToolResult('gjc-ring-history', 'call-oldest');
      assert.equal(oldestResult.toolResult.content, 'oldest output');
      await assert.rejects(sessionsService.fetchToolResult('gjc-ring-history', 'call-missing'), { code: 'TOOL_RESULT_NOT_FOUND' });
      const exported = await exportSessionTranscript('gjc-ring-history');
      assert.ok(exported.body.includes('message-0\n'), 'export reaches the oldest prompt');
      assert.ok(exported.body.includes('message-5000'));
      await rm(transcriptPath);
      const gone = await provider.fetchHistory('gjc-ring-history', { limit: 20 });
      assert.deepEqual({ total: gone.total, hasMore: gone.hasMore, messages: gone.messages }, { total: 0, hasMore: false, messages: [] }, 'a removed transcript is an empty window, not a 500');
      await writeFile(transcriptPath, `${lines.join('\n')}\n`, 'utf8');
      const history = await provider.fetchHistory('gjc-ring-history', { limit: 5_000 });
      assert.equal(history.total, 5_002);
      assert.equal(history.messages.length, 5_000);
      assert.equal(history.messages[0]?.content, 'message-1');
      assert.equal(history.messages.at(-1)?.content, 'message-5000');
      assert.equal(history.hasMore, true);
      const oldest = await provider.fetchHistory('gjc-ring-history', { limit: 20, offset: 5_000 });
      assert.equal(oldest.messages[0]?.toolId, 'call-oldest');
      assert.equal(oldest.messages[1]?.content, 'message-0');
      assert.equal(oldest.total, 5_002);
      assert.equal(oldest.hasMore, false);
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc synchronizer excludes subagent transcripts inside session sidecar dirs', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-subagent-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    // Top-level session (depth 2: sessions/<slug>/<file>.jsonl).
    await writeGjcTranscript(tempRoot, 'gjc-parent', workspacePath, { firstUserMessage: 'Parent session' });

    // Subagent transcript inside the session's sidecar dir (depth 3) — e.g. a ralplan
    // pass. It repeats the `type:session` header but must NOT be indexed as a session.
    const sidecar = path.join(
      tempRoot, '.gjc', 'agent', 'sessions', '-workspace', '2026-07-09T00-00-00_gjc-parent',
    );
    await mkdir(sidecar, { recursive: true });
    const subLines = [
      JSON.stringify({ type: 'session', version: 3, id: '2-CriticPass1', timestamp: '2026-07-09T00:00:00.000Z', cwd: workspacePath }),
      JSON.stringify({ type: 'message', id: 'm', timestamp: '2026-07-09T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'subagent pass' }] } }),
    ];
    await writeFile(path.join(sidecar, '2-CriticPass1.jsonl'), `${subLines.join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      const processed = await new GjcSessionSynchronizer().synchronize();
      assert.equal(processed, 1); // only the top-level session, not the sidecar subagent
      assert.ok(sessionsDb.getSessionById('gjc-parent'));
      assert.ok(!sessionsDb.getSessionById('2-CriticPass1'));
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc synchronizer streams past leading non-user lines to the first user message', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-sync-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    const sessionsDir = path.join(tempRoot, '.gjc', 'agent', 'sessions', '-workspace');
    await mkdir(sessionsDir, { recursive: true });
    // Real gjc transcripts open with the session header and a display:false custom
    // "volatile-project-context" message BEFORE the first user message. The streaming
    // title reader must skip both and stop at the user message.
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'gjc-stream', timestamp: '2026-07-09T00:00:00.000Z', cwd: workspacePath }),
      JSON.stringify({ type: 'message', id: 'ctx', timestamp: '2026-07-09T00:00:00.500Z', message: { role: 'custom', customType: 'volatile-project-context', content: '<system-reminder>noise</system-reminder>', display: false } }),
      JSON.stringify({ type: 'message', id: 'u1', timestamp: '2026-07-09T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Fix the pagination bug' }] } }),
      JSON.stringify({ type: 'message', id: 'a1', timestamp: '2026-07-09T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
    ];
    await writeFile(path.join(sessionsDir, '2026-07-09T00-00-00_gjc-stream.jsonl'), `${lines.join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      const processed = await new GjcSessionSynchronizer().synchronize();
      assert.equal(processed, 1);
      assert.equal(sessionsDb.getSessionById('gjc-stream')?.custom_name, 'Fix the pagination bug');
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
test('gjc synchronizer ignores the shared cursor until its first scan completes', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-initial-scan-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    await mkdir(workspacePath, { recursive: true });
    await writeGjcTranscript(tempRoot, 'gjc-initial', workspacePath, { firstUserMessage: 'Index prior sessions' });
    await withIsolatedDatabase(async () => {
      const synchronizer = new GjcSessionSynchronizer();

      assert.equal(appConfigDb.get('gjc_initial_scan_done'), null);
      const processed = await synchronizer.synchronize(new Date('2999-01-01T00:00:00.000Z'));

      assert.equal(processed, 1);
      assert.ok(sessionsDb.getSessionById('gjc-initial'));
      assert.equal(appConfigDb.get('gjc_initial_scan_done'), 'true');
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc synchronizer retries a transcript whose header was incomplete', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-incomplete-header-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));
  const incompleteSessionId = 'gjc-incomplete';

  try {
    await mkdir(workspacePath, { recursive: true });
    await writeGjcTranscript(tempRoot, 'gjc-complete', workspacePath, { firstUserMessage: 'Complete session' });
    const sessionsDir = path.join(tempRoot, '.gjc', 'agent', 'sessions', '-workspace');
    const incompletePath = path.join(sessionsDir, `2026-07-09T00-00-00_${incompleteSessionId}.jsonl`);

    await withIsolatedDatabase(async () => {
      const synchronizer = new GjcSessionSynchronizer();
      await synchronizer.synchronize();
      await writeFile(incompletePath, '{"type":"session","id":"gjc-incomplete"', 'utf8');

      await synchronizer.synchronize(new Date(0));
      assert.equal(sessionsDb.getSessionById(incompleteSessionId), null);

      await writeFile(incompletePath, `${JSON.stringify({
        type: 'session',
        version: 3,
        id: incompleteSessionId,
        timestamp: '2026-07-09T00:00:00.000Z',
        cwd: workspacePath,
      })}\n`, 'utf8');

      const retried = await synchronizer.synchronize(new Date('2999-01-01T00:00:00.000Z'));

      assert.equal(retried, 1);
      assert.ok(sessionsDb.getSessionById(incompleteSessionId));
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc synchronizer resolves a symlinked session root before filtering subagents', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-symlink-root-'));
  const realHomeDir = path.join(tempRoot, 'real-home');
  const decoyHomeDir = path.join(tempRoot, 'decoy-home');
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(realHomeDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await symlink(realHomeDir, decoyHomeDir, 'dir');
  const restoreHomeDir = patchHomeDir(decoyHomeDir);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    const transcriptPath = await writeGjcTranscript(realHomeDir, 'gjc-symlink', workspacePath, {
      firstUserMessage: 'Keep top-level session',
    });
    await withIsolatedDatabase(async () => {
      const sessionId = await new GjcSessionSynchronizer().synchronizeFile(transcriptPath);

      assert.equal(sessionId, 'gjc-symlink');
      assert.ok(sessionsDb.getSessionById('gjc-symlink'));
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc synchronizer indexes transcripts from the live session directory', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-live-sessions-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const liveSessionsDir = path.join(tempRoot, 'live-sessions');
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(liveSessionsDir);

  try {
    await mkdir(workspacePath, { recursive: true });
    await writeGjcTranscript(tempRoot, 'gjc-live', workspacePath, {
      firstUserMessage: 'Persist live session',
      sessionsDir: liveSessionsDir,
    });
    await withIsolatedDatabase(async () => {
      const processed = await new GjcSessionSynchronizer().synchronize();

      assert.equal(processed, 1);
      assert.equal(sessionsDb.getSessionById('gjc-live')?.project_path, workspacePath);
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('history transport truncates oversized gjc tool output and serves the full result on demand', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-transport-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    const output = `시작-${'x'.repeat(90_000)}-끝`;
    const sessionsDir = path.join(tempRoot, '.gjc', 'agent', 'sessions', '-workspace');
    await mkdir(sessionsDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'gjc-transport',
        timestamp: '2026-07-09T00:00:00.000Z',
        cwd: workspacePath,
      }),
      JSON.stringify({
        type: 'message',
        id: 'msg-1',
        parentId: null,
        timestamp: '2026-07-09T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Run the big command' }] },
      }),
      JSON.stringify({
        type: 'message',
        id: 'msg-2',
        parentId: 'msg-1',
        timestamp: '2026-07-09T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', toolName: 'Bash', toolInput: { command: 'make noise' }, toolCallId: 'call-large' },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'msg-3',
        parentId: 'msg-2',
        timestamp: '2026-07-09T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-large',
          toolName: 'Bash',
          content: [{ type: 'text', text: output }],
          isError: false,
        },
      }),
    ];
    await writeFile(
      path.join(sessionsDir, '2026-07-09T00-00-00_gjc-transport.jsonl'),
      `${lines.join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      await new GjcSessionSynchronizer().synchronize();

      const history = await sessionsService.fetchHistory('gjc-transport', { includeImages: false });
      const toolUse = history.messages.find((message) => message.kind === 'tool_use');

      assert.equal(toolUse?.toolResultTruncated, true);
      assert.equal(toolUse?.toolResultBytes, Buffer.byteLength(output));
      assert.ok(String(toolUse?.toolResult?.content).length < output.length);
      assert.equal(String(toolUse?.toolResult?.content).includes('\uFFFD'), false);
      assert.equal(String(toolUse?.toolResult?.content).startsWith('시작-'), true);
      assert.equal(String(toolUse?.toolResult?.content).endsWith('-끝'), true);

      const full = await sessionsService.fetchToolResult('gjc-transport', 'call-large');
      assert.equal(full.toolResult.content, output);
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('GJC pages count visible rows, preserve results and reach history beyond the old buffer', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-visible-pages-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));
  try {
    const sessionId = 'visible-pages';
    const filePath = await writeGjcTranscript(tempRoot, sessionId, workspacePath, { firstUserMessage: 'oldest prompt' });
    const records: string[] = [];
    for (let i = 0; i < 300; i++) {
      const time = new Date(Date.UTC(2026, 6, 9, 0, 0, 10 + i)).toISOString();
      records.push(JSON.stringify({ type: 'message', id: `call-${i}`, parentId: 'msg-1', timestamp: time,
        message: { role: 'assistant', content: [{ type: 'toolCall', toolName: 'read', toolCallId: `tool-${i}`, toolInput: { path: `file-${i}` } }] } }));
      records.push(JSON.stringify({ type: 'message', id: `result-${i}`, parentId: `call-${i}`, timestamp: time,
        message: { role: 'toolResult', toolCallId: `tool-${i}`, content: [{ type: 'text', text: `output-${i}` }], details: { index: i } } }));
    }
    await appendFile(filePath, `${records.join('\n')}\n`, 'utf8');
    await withIsolatedDatabase(async () => {
      await new GjcSessionSynchronizer().synchronize();
      const provider = new GjcSessionsProvider();
      let offset = 0;
      let more = true;
      const ids = new Set<string>();
      while (more) {
        const page = await provider.fetchHistory(sessionId, { limit: 20, offset });
        assert.equal(page.total, 301);
        assert.ok(page.messages.length > 0, `page at ${offset} must make progress`);
        for (const row of page.messages) {
          assert.equal(ids.has(row.id), false);
          ids.add(row.id);
          if (row.kind === 'tool_use') {
            const i = Number(row.toolId!.split('-')[1]);
            assert.equal(row.toolResult?.content, `output-${i}`);
            assert.deepEqual(row.toolResult?.toolUseResult, { index: i });
          }
        }
        offset += page.messages.length;
        more = page.hasMore;
      }
      assert.equal(ids.size, 301);
      assert.ok(ids.has('msg-1:0:text'));
      const exhausted = await provider.fetchHistory(sessionId, { limit: 20, offset: 400 });
      assert.equal(exhausted.hasMore, false);
      assert.equal(exhausted.messages.length, 0);
      assert.equal(exhausted.total, 301);

      // Deep offset must not be capped by the number of payloads retained.
      const later = Array.from({ length: 5100 }, (_, i) => JSON.stringify({ type: 'message', id: `later-${i}`, parentId: 'msg-1',
        timestamp: new Date(Date.UTC(2026, 6, 10, 0, 0, i)).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `later ${i}` }] } }));
      await appendFile(filePath, `${later.join('\n')}\n`, 'utf8');
      const oldest = await provider.fetchHistory(sessionId, { limit: 20, offset: 5400 });
      assert.equal(oldest.total, 5401);
      assert.equal(oldest.hasMore, false);
      assert.equal(oldest.messages[0]?.content, 'oldest prompt');
      await assert.rejects(provider.fetchHistory(sessionId), { code: 'HISTORY_PAGE_TOO_LARGE' });

      // A live writer appending mid-read is absorbed by re-reading; only a
      // transcript that keeps changing on every attempt surfaces as 409.
      const originalStat = fs.promises.stat;
      let stats = 0;
      let appendsPerRead = 1;
      (fs.promises as { stat: unknown }).stat = async (...args: Parameters<typeof fs.promises.stat>) => {
        stats += 1;
        // Even calls are the post-read revision check; grow the file just before it.
        if (stats % 2 === 0 && appendsPerRead > 0) {
          appendsPerRead -= 1;
          await appendFile(filePath, `${JSON.stringify({ type: 'message', id: `live-${stats}`, parentId: 'msg-1',
            timestamp: new Date(Date.UTC(2026, 6, 11, 0, 0, stats)).toISOString(), message: { role: 'user', content: [{ type: 'text', text: `live ${stats}` }] } })}\n`, 'utf8');
        }
        return originalStat(...args);
      };
      try {
        const settled = await provider.fetchHistory(sessionId, { limit: 20 });
        assert.equal(settled.total, 5402, 'the retry sees the row appended during the first attempt');
        assert.equal(settled.messages.at(-1)?.content, 'live 2');
        appendsPerRead = Number.POSITIVE_INFINITY;
        await assert.rejects(provider.fetchHistory(sessionId, { limit: 20 }), { code: 'HISTORY_CHANGED', statusCode: 409 });
      } finally {
        (fs.promises as { stat: unknown }).stat = originalStat;
      }
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('history carries the runtime tool details the transcript persisted', { concurrency: false }, async () => {
  // The runtime writes its typed per-tool `details` at message level on the
  // `role: "toolResult"` record. Dropping it here would make a reloaded
  // transcript poorer than the live turn that produced it.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-session-details-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreLiveSessionDir = patchLiveSessionDir(path.join(tempRoot, 'live-sessions'));

  try {
    const details = { kind: 'file', resolvedPath: '/repo/AGENTS.md', spillEligible: true };
    const sessionsDir = path.join(tempRoot, '.gjc', 'agent', 'sessions', '-workspace');
    await mkdir(sessionsDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'gjc-details',
        timestamp: '2026-07-09T00:00:00.000Z',
        cwd: workspacePath,
      }),
      JSON.stringify({
        type: 'message',
        id: 'msg-1',
        parentId: null,
        timestamp: '2026-07-09T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Read it' }] },
      }),
      JSON.stringify({
        type: 'message',
        id: 'msg-2',
        parentId: 'msg-1',
        timestamp: '2026-07-09T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', toolName: 'read', toolInput: { path: 'AGENTS.md' }, toolCallId: 'call-read' },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'msg-3',
        parentId: 'msg-2',
        timestamp: '2026-07-09T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-read',
          toolName: 'read',
          content: [{ type: 'text', text: '# AGENTS.md' }],
          details,
          isError: false,
        },
      }),
    ];
    await writeFile(
      path.join(sessionsDir, '2026-07-09T00-00-00_gjc-details.jsonl'),
      `${lines.join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      await new GjcSessionSynchronizer().synchronize();

      const history = await sessionsService.fetchHistory('gjc-details', { includeImages: false });
      const toolUse = history.messages.find((message) => message.kind === 'tool_use');

      assert.equal(toolUse?.toolResult?.content, '# AGENTS.md');
      // History folds the standalone result into its call before dropping the
      // row, so the details ride the nested slot the client reads for a folded
      // result. The live path sets the same name on its standalone row.
      assert.deepEqual(toolUse?.toolResult?.toolUseResult, details);
      assert.equal(toolUse?.toolDetailsOmitted, undefined);
    });
  } finally {
    restoreLiveSessionDir();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Counts `createReadStream` calls against one transcript path. Each history
 * read pass (lineage, descriptor index, payload) opens the file exactly once,
 * so the counter separates index reuse from payload streaming.
 */
const countTranscriptStreams = (filePath: string) => {
  const originalCreateReadStream = fs.createReadStream;
  let count = 0;
  (fs as { createReadStream: unknown }).createReadStream = (...args: Parameters<typeof fs.createReadStream>) => {
    if (args[0] === filePath) count += 1;
    return (originalCreateReadStream as (...inner: typeof args) => unknown)(...args);
  };
  return {
    get count() { return count; },
    restore() { (fs as { createReadStream: unknown }).createReadStream = originalCreateReadStream; },
  };
};

test('gjc history index cache reuses the descriptor index while payloads still stream', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-history-cache-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  try {
    const sessionId = 'cached-history';
    const filePath = await writeGjcTranscript(tempRoot, sessionId, workspacePath, {
      firstUserMessage: 'cached prompt',
      withConversation: true,
    });
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(sessionId, 'gjc', workspacePath, undefined, undefined, undefined, filePath);
      const provider = new GjcSessionsProvider();
      const counter = countTranscriptStreams(filePath);
      try {
        const first = await provider.fetchHistory(sessionId, { limit: 2 });
        assert.equal(counter.count, 3, 'a cold read streams lineage, index and payload passes');
        assert.equal(first.total, 4);

        const second = await provider.fetchHistory(sessionId, { limit: 2, offset: 2 });
        assert.equal(counter.count, 4, 'a cache hit re-streams only the payload pass');
        assert.equal(second.total, 4);
        assert.equal(second.hasMore, false);
        assert.equal(second.messages[0]?.content, 'cached prompt');
        assert.equal(second.messages[0]?.role, 'user');
      } finally {
        counter.restore();
      }
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc history index cache invalidates when the transcript grows', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-history-cache-grow-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  try {
    const sessionId = 'growing-history';
    const filePath = await writeGjcTranscript(tempRoot, sessionId, workspacePath, {
      firstUserMessage: 'original prompt',
      withConversation: true,
    });
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(sessionId, 'gjc', workspacePath, undefined, undefined, undefined, filePath);
      const provider = new GjcSessionsProvider();
      const counter = countTranscriptStreams(filePath);
      try {
        const first = await provider.fetchHistory(sessionId, { limit: 10 });
        assert.equal(counter.count, 3);
        assert.equal(first.total, 4);

        await appendFile(filePath, `${JSON.stringify({
          type: 'message',
          id: 'msg-appended',
          parentId: 'msg-3',
          timestamp: '2026-07-09T00:00:05.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'appended question' }] },
        })}\n`, 'utf8');

        const second = await provider.fetchHistory(sessionId, { limit: 10 });
        assert.equal(counter.count, 6, 'a changed transcript rebuilds the index');
        assert.equal(second.total, 5);
        assert.equal(second.messages.at(-1)?.content, 'appended question');

        const third = await provider.fetchHistory(sessionId, { limit: 10 });
        assert.equal(counter.count, 7, 'the rebuilt revision is cached again');
        assert.equal(third.total, 5);
      } finally {
        counter.restore();
      }
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc history index cache keys entries per session path', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-history-cache-paths-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  try {
    const filePathA = await writeGjcTranscript(tempRoot, 'cache-path-a', workspacePath, { firstUserMessage: 'prompt a' });
    const filePathB = await writeGjcTranscript(tempRoot, 'cache-path-b', workspacePath, { firstUserMessage: 'prompt b' });
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession('cache-path-a', 'gjc', workspacePath, undefined, undefined, undefined, filePathA);
      sessionsDb.createSession('cache-path-b', 'gjc', workspacePath, undefined, undefined, undefined, filePathB);
      const provider = new GjcSessionsProvider();
      const counterA = countTranscriptStreams(filePathA);
      const counterB = countTranscriptStreams(filePathB);
      try {
        await provider.fetchHistory('cache-path-a', { limit: 1 });
        assert.equal(counterA.count, 3);
        assert.equal(counterB.count, 0);

        await provider.fetchHistory('cache-path-b', { limit: 1 });
        assert.equal(counterA.count, 3, 'reading another transcript must not churn this entry');
        assert.equal(counterB.count, 3);

        await appendFile(filePathB, `${JSON.stringify({
          type: 'message',
          id: 'msg-b-appended',
          parentId: 'msg-1',
          timestamp: '2026-07-09T00:00:02.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'b grows' }] },
        })}\n`, 'utf8');

        const againA = await provider.fetchHistory('cache-path-a', { limit: 1 });
        assert.equal(counterA.count, 4, "one transcript's invalidation leaves the other entry intact");
        assert.equal(againA.total, 1);

        const againB = await provider.fetchHistory('cache-path-b', { limit: 10 });
        assert.equal(counterB.count, 6, 'only the appended transcript rebuilds its index');
        assert.equal(againB.total, 2);
        assert.equal(againB.messages.at(-1)?.content, 'b grows');
      } finally {
        counterA.restore();
        counterB.restore();
      }
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('gjc history index cache keeps mid-read HISTORY_CHANGED retry behavior', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'gjc-history-cache-live-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  try {
    const sessionId = 'live-cached-history';
    const filePath = await writeGjcTranscript(tempRoot, sessionId, workspacePath, {
      firstUserMessage: 'live prompt',
      withConversation: true,
    });
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(sessionId, 'gjc', workspacePath, undefined, undefined, undefined, filePath);
      const provider = new GjcSessionsProvider();
      // Warm the cache so the live writer races a request served from it.
      await provider.fetchHistory(sessionId, { limit: 2 });

      const originalStat = fs.promises.stat;
      let stats = 0;
      let appendsPerRead = 1;
      (fs.promises as { stat: unknown }).stat = async (...args: Parameters<typeof fs.promises.stat>) => {
        stats += 1;
        // Even calls are the post-read revision check; grow the file just before it.
        if (stats % 2 === 0 && appendsPerRead > 0) {
          appendsPerRead -= 1;
          await appendFile(filePath, `${JSON.stringify({ type: 'message', id: `live-${stats}`, parentId: 'msg-1',
            timestamp: new Date(Date.UTC(2026, 6, 11, 0, 0, stats)).toISOString(), message: { role: 'user', content: [{ type: 'text', text: `live ${stats}` }] } })}\n`, 'utf8');
        }
        return originalStat(...args);
      };
      try {
        const settled = await provider.fetchHistory(sessionId, { limit: 10 });
        assert.equal(settled.total, 5, 'the retry sees the row appended during the first attempt');
        assert.equal(settled.messages.at(-1)?.content, 'live 2');
        appendsPerRead = Number.POSITIVE_INFINITY;
        await assert.rejects(provider.fetchHistory(sessionId, { limit: 10 }), { code: 'HISTORY_CHANGED', statusCode: 409 });
      } finally {
        (fs.promises as { stat: unknown }).stat = originalStat;
      }
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
