import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { fetchCompleteHistory } from '@/modules/providers/services/sessions.service.js';
import { sessionTranscriptWorkspace } from '@/modules/providers/services/session-worktrees.service.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

export type SessionExport = {
  filename: string;
  /** Header-safe form of the same name, for the plain `filename` parameter. */
  asciiFilename: string;
  contentType: string;
  body: string;
};

/**
 * Kinds that exist to drive the live UI rather than to record what was said:
 * stream fragments, status lines, permission prompts and run bookkeeping. They
 * are the transcript's plumbing, and a saved conversation is not improved by
 * replaying them.
 */
const TRANSIENT_KINDS = new Set([
  'stream_delta',
  'stream_end',
  'complete',
  'status',
  'permission_request',
  'permission_cancelled',
  'session_created',
]);

/**
 * A fence long enough to survive whatever the content itself contains. Tool
 * output routinely holds Markdown, so a fixed three-backtick fence would let a
 * result close its own block and spill formatting over the rest of the file.
 */
function fenceFor(content: string): string {
  const longestRun = [...content.matchAll(/`+/g)]
    .reduce((longest, match) => Math.max(longest, match[0].length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function codeBlock(content: string, language = ''): string {
  const body = content.replace(/\s+$/, '');
  const fence = fenceFor(body);
  return `${fence}${language}\n${body}\n${fence}`;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A file name that is safe on every platform the app runs on and still says
 * which conversation it holds.
 */
export function exportFileName(title: string, sessionId: string, exportedAt: Date): string {
  const slug = title
    // Composed, not decomposed: NFKD splits Hangul into jamo, so a Korean title
    // came back as a string that looks right and compares unequal.
    .normalize('NFC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  const day = exportedAt.toISOString().slice(0, 10);
  const stem = slug || sessionId.replace(/[^A-Za-z0-9]+/g, '-');
  return `${stem}-${day}.md`;
}

/**
 * HTTP header values cannot carry anything above latin1 - Node rejects the
 * whole response with ERR_INVALID_CHAR - so a Korean session title would have
 * turned its own download into a 500. The real name still travels in
 * `filename*`; this is what the plain `filename` parameter falls back to.
 */
export function asciiFileName(filename: string, sessionId: string, exportedAt: Date): string {
  if (/^[\x20-\x7E]+$/.test(filename)) return filename;
  const day = exportedAt.toISOString().slice(0, 10);
  return `${sessionId.replace(/[^A-Za-z0-9]+/g, '-')}-${day}.md`;
}

function renderToolCall(message: NormalizedMessage): string {
  const parts: string[] = [`### Tool: ${message.toolName || 'unknown'}`];
  if (message.timestamp) parts.push(`*${message.timestamp}*`);

  const input = stringify(message.toolInput);
  if (input.trim()) parts.push(codeBlock(input, 'json'));

  const result = message.toolResult;
  if (result && result.content !== undefined) {
    const output = stringify(result.content);
    if (output.trim()) {
      parts.push(result.isError ? '**Error**' : '**Output**');
      parts.push(codeBlock(output));
    }
  }

  return parts.join('\n\n');
}

function renderMessage(message: NormalizedMessage): string | null {
  if (TRANSIENT_KINDS.has(message.kind)) return null;

  switch (message.kind) {
    case 'tool_use':
      return renderToolCall(message);

    case 'tool_result': {
      const output = stringify(message.content);
      if (!output.trim()) return null;
      return [
        `### Tool result${message.toolId ? ` (${message.toolId})` : ''}`,
        message.isError ? '**Error**' : '**Output**',
        codeBlock(output),
      ].join('\n\n');
    }

    case 'thinking': {
      const content = stringify(message.content);
      if (!content.trim()) return null;
      return [`### Thinking`, `*${message.timestamp}*`, content].join('\n\n');
    }

    case 'system_notice':
      return `> **${(message.level ?? 'info').toUpperCase()}** ${stringify(message.content).replace(/\n/g, '\n> ')}`;

    case 'error':
      return ['### Error', codeBlock(stringify(message.content))].join('\n\n');

    case 'task_notification':
      return `> ${stringify(message.content)}`;

    default: {
      const content = stringify(message.content);
      const attachments = Array.isArray(message.images) ? message.images.length : 0;
      if (!content.trim() && attachments === 0) return null;

      const speaker = message.role === 'user' ? 'User' : 'Assistant';
      const parts = [`## ${speaker}`, `*${message.timestamp}*`];
      if (content.trim()) {
        // Command output was never prose; keeping it fenced preserves it and
        // stops it being read as Markdown by whatever opens the file.
        parts.push(message.isLocalCommandStdout ? codeBlock(content) : content);
      }
      if (attachments > 0) {
        parts.push(`*${attachments} image attachment${attachments === 1 ? '' : 's'} not included in this export.*`);
      }
      return parts.join('\n\n');
    }
  }
}

/**
 * Renders one session's stored transcript as a Markdown document.
 *
 * Deliberately not the runtime's `/export`: that is a builtin slash command
 * which only runs inside a live turn and writes a file into the project
 * directory. This reads the same persisted transcript the chat view reads, so
 * it works for any session - including one nobody is in - and produces a
 * download instead of an artifact in the user's repository.
 *
 * The provider is asked directly rather than through `sessionsService`, whose
 * history is prepared for transport and replaces tool output over 64KB with a
 * bounded preview. An export that quietly dropped the middle of a build log
 * would be worse than no export.
 */
export async function exportSessionTranscript(
  sessionId: string,
  exportedAt: Date = new Date(),
): Promise<SessionExport> {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    throw new AppError(`Session "${sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }

  const projectPath = session.project_path ?? '';
  const title = session.custom_name?.trim()
    || (projectPath ? path.basename(projectPath) : '')
    || sessionId;

  let messages: NormalizedMessage[] = [];
  const executionCwd = session.provider_session_id ? sessionTranscriptWorkspace(sessionId, projectPath) : null;
  if (session.provider_session_id) {
    const history = await fetchCompleteHistory(sessionId, {
      provider: session.provider as LLMProvider,
      projectPath: executionCwd!,
      providerSessionId: session.provider_session_id,
    });
    messages = history.messages;
  }

  const rendered = messages
    .map(renderMessage)
    .filter((section): section is string => Boolean(section));

  const header = [
    `# ${title}`,
    [
      `- Session: ${sessionId}`,
      `- Provider: ${session.provider}`,
      projectPath ? `- Project: ${projectPath}` : null,
      executionCwd && executionCwd !== projectPath ? `- Working directory: ${executionCwd}` : null,
      session.created_at ? `- Created: ${session.created_at}` : null,
      `- Exported: ${exportedAt.toISOString()}`,
      `- Messages: ${rendered.length}`,
    ].filter(Boolean).join('\n'),
  ].join('\n\n');

  const body = rendered.length > 0
    ? `${header}\n\n---\n\n${rendered.join('\n\n---\n\n')}\n`
    : `${header}\n\n---\n\n*This session has no recorded messages.*\n`;

  const filename = exportFileName(title, sessionId, exportedAt);

  return {
    filename,
    asciiFilename: asciiFileName(filename, sessionId, exportedAt),
    contentType: 'text/markdown; charset=utf-8',
    body,
  };
}
