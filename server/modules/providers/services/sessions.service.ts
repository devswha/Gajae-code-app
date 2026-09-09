import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { resolveSessionProjectPath } from '@/modules/providers/services/session-project-path.service.js';
import { sessionTranscriptWorkspace } from '@/modules/providers/services/session-worktrees.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { FetchHistoryOptions, FetchHistoryResult, LLMProvider, NormalizedMessage } from '@/shared/types.js';
import { boundToolResultDetails, prepareMessagesForTransport } from '@/shared/tool-output-transport.js';
import { AppError } from '@/shared/utils.js';

type CreateAppSessionResult = { sessionId: string; provider: LLMProvider; projectPath: string };
type ArchivedSessionListItem = { sessionId: string; provider: LLMProvider; projectId: string | null; projectPath: string | null; projectDisplayName: string; sessionTitle: string; createdAt: string | null; updatedAt: string | null; lastActivity: string | null; isStarred: boolean; isProjectArchived: boolean };

function sessionNotFound(sessionId: string): AppError {
  return new AppError(`Session "${sessionId}" was not found.`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
}

function archivedProjectName(projectPath: string | null, configuredName: string | null | undefined): string {
  const preferred = typeof configuredName === 'string' ? configuredName.trim() : '';
  if (preferred) return preferred;
  return projectPath ? path.basename(projectPath) || projectPath : 'Unknown Project';
}

async function unlinkWhenPresent(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function requiredSession(sessionId: string) {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row) throw sessionNotFound(sessionId);
  return row;
}

export function prepareHistoryMessagesForTransport(messages: NormalizedMessage[], includeImages = true): NormalizedMessage[] {
  return prepareMessagesForTransport(messages, includeImages);
}

export const COMPLETE_HISTORY_PAGE_SIZE = 500;

/**
 * Walks a transcript newest-first in bounded pages. Unbounded provider reads
 * are rejected past the page cap, so in-server consumers that need the whole
 * conversation, or one row somewhere in it, page instead. A tail that grows
 * between pages only shifts later offsets forward; the rows it re-serves are
 * already known and skipped, so nothing is dropped.
 *
 * `until` stops the walk early once the newest pages already satisfy the caller.
 */
export async function fetchCompleteHistory(
  sessionId: string,
  options: Omit<FetchHistoryOptions, 'limit' | 'offset'> & { providerSessionId: string; provider: LLMProvider },
  until?: (page: NormalizedMessage[]) => boolean,
): Promise<FetchHistoryResult> {
  const { provider: providerName, ...providerOptions } = options;
  const provider = providerRegistry.resolveProvider(providerName);
  const messages: NormalizedMessage[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let last: FetchHistoryResult | null = null;
  for (;;) {
    const page = await provider.sessions.fetchHistory(sessionId, { ...providerOptions, limit: COMPLETE_HISTORY_PAGE_SIZE, offset });
    last = page;
    const fresh = page.messages.filter((message) => !seen.has(message.id));
    for (const message of fresh) seen.add(message.id);
    messages.unshift(...fresh);
    if (!page.hasMore || page.messages.length === 0 || until?.(fresh)) break;
    offset += page.messages.length;
  }
  return { ...last, messages, total: last.total, hasMore: false, offset: 0, limit: null };
}

export const sessionsService = {
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map(({ id }) => id);
  },

  listRunningSessions(): ReturnType<typeof chatRunRegistry.listRunningRuns> {
    return chatRunRegistry.listRunningRuns();
  },

  normalizeMessage(providerName: string, raw: unknown, sessionId: string | null): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  async createAppSession(provider: LLMProvider, projectPath: string): Promise<CreateAppSessionResult> {
    const project = await resolveSessionProjectPath(projectPath);
    const sessionId = randomUUID();
    sessionsDb.createAppSession(sessionId, provider, project);
    return { sessionId, provider, projectPath: project };
  },

  async fetchHistory(sessionId: string, options: Pick<FetchHistoryOptions, 'limit' | 'offset' | 'includeImages'> = {}): Promise<FetchHistoryResult> {
    const row = requiredSession(sessionId);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? null;
    if (!row.provider_session_id) return { messages: [], total: 0, hasMore: false, offset, limit };

    const provider = providerRegistry.resolveProvider(row.provider as LLMProvider);
    const history = await provider.sessions.fetchHistory(sessionId, {
      limit,
      offset,
      projectPath: sessionTranscriptWorkspace(sessionId, row.project_path ?? ''),
      providerSessionId: row.provider_session_id,
    });
    const remapped = history.messages.map((message) => ({ ...message, sessionId }));
    return { ...history, messages: prepareHistoryMessagesForTransport(remapped, options.includeImages !== false) };
  },

  async fetchToolResult(sessionId: string, toolId: string): Promise<{ toolId: string; toolResult: NonNullable<NormalizedMessage['toolResult']>; toolDetailsOmitted?: boolean }> {
    const row = sessionsDb.getSessionById(sessionId);
    if (!row?.provider_session_id) throw sessionNotFound(sessionId);
    const embeddedResult = (message: NormalizedMessage) => (message.kind === 'tool_use' && message.toolId === toolId ? message.toolResult : undefined);
    const independentResult = (message: NormalizedMessage) => (message.kind === 'tool_result' && message.toolId === toolId ? message : undefined);
    const history = await fetchCompleteHistory(sessionId, {
      provider: row.provider as LLMProvider,
      projectPath: sessionTranscriptWorkspace(sessionId, row.project_path ?? ''),
      providerSessionId: row.provider_session_id,
    }, (page) => page.some((message) => embeddedResult(message) || independentResult(message)));
    const embedded = history.messages.map(embeddedResult).find(Boolean);
    const independent = history.messages.map(independentResult).find(Boolean);
    const result = embedded ?? (independent ? {
      content: independent.content,
      isError: independent.isError,
      toolUseResult: independent.toolUseResult,
    } : null);
    if (!result) {
      throw new AppError(`Tool result "${toolId}" was not found.`, { code: 'TOOL_RESULT_NOT_FOUND', statusCode: 404 });
    }
    const bounded = boundToolResultDetails(result);
    return { toolId, toolResult: bounded.toolResult, ...(bounded.detailsOmitted ? { toolDetailsOmitted: true } : {}) };
  },

  listArchivedSessions(): ArchivedSessionListItem[] {
    const knownProjects = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();
    return sessionsDb.getArchivedSessions().map((row) => {
      const projectPath = row.project_path?.trim() ? row.project_path : null;
      let project = null;
      if (projectPath) {
        if (!knownProjects.has(projectPath)) knownProjects.set(projectPath, projectsDb.getProjectPath(projectPath));
        project = knownProjects.get(projectPath) ?? null;
      }
      return {
        sessionId: row.session_id,
        provider: row.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: archivedProjectName(projectPath, project?.custom_project_name),
        sessionTitle: row.custom_name?.trim() || row.session_id,
        createdAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? null,
        lastActivity: row.updated_at ?? row.created_at ?? null,
        isStarred: Boolean(row.isStarred),
        isProjectArchived: Boolean(project?.isArchived),
      };
    });
  },

  archiveSessionsIdleFor(olderThanDays: number, options: { dryRun?: boolean; excludeSessionIds?: readonly string[] } = {}): { olderThanDays: number; cutoff: string; matched: number; archived: number; dryRun: boolean; sessions: Array<{ sessionId: string; sessionTitle: string; lastActivity: string | null }> } {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
      throw new AppError('olderThanDays must be a positive number of days.', { code: 'INVALID_RETENTION_WINDOW', statusCode: 400 });
    }
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const excluded = new Set(options.excludeSessionIds ?? []);
    const matches = sessionsDb.getActiveSessionsUpdatedBefore(cutoff).filter(({ session_id }) => !excluded.has(session_id));
    const dryRun = options.dryRun === true;
    if (!dryRun) matches.forEach(({ session_id }) => sessionsDb.updateSessionIsArchived(session_id, true));
    return {
      olderThanDays, cutoff, dryRun,
      matched: matches.length,
      archived: dryRun ? 0 : matches.length,
      sessions: matches.map((row) => ({ sessionId: row.session_id, sessionTitle: row.custom_name?.trim() || row.session_id, lastActivity: row.updated_at ?? row.created_at ?? null })),
    };
  },

  async deleteOrArchiveSessionById(sessionId: string, options: { force?: boolean; deletedFromDisk?: boolean } = {}): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const row = requiredSession(sessionId);
    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return { sessionId, action: 'archived', deletedFromDisk: false };
    }
    const deletedFromDisk = options.deletedFromDisk && row.jsonl_path ? await unlinkWhenPresent(row.jsonl_path) : false;
    if (!sessionsDb.deleteSessionById(sessionId)) throw sessionNotFound(sessionId);
    return { sessionId, action: 'deleted', deletedFromDisk };
  },

  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    requiredSession(sessionId);
    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  toggleSessionStarById(sessionId: string): { sessionId: string; isStarred: boolean } {
    const row = requiredSession(sessionId);
    const isStarred = !row.isStarred;
    sessionsDb.updateSessionIsStarred(sessionId, isStarred);
    return { sessionId, isStarred };
  },

  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    requiredSession(sessionId);
    sessionsDb.updateSessionCustomName(sessionId, summary, 'user');
    return { sessionId, summary };
  },

  /**
   * Replaces the stored title with one derived afresh from the transcript. The
   * user asked for it explicitly, so a hand-written name is overwritten here
   * and nowhere else; the indexer never touches a name it did not set.
   */
  async regenerateSessionTitle(sessionId: string): Promise<{ sessionId: string; summary: string }> {
    const row = requiredSession(sessionId);
    const synchronizer = providerRegistry.resolveProvider(row.provider as LLMProvider).sessionSynchronizer;
    if (!row.jsonl_path || !synchronizer.deriveSessionTitle) {
      throw new AppError('This session has no transcript to derive a title from yet.', { code: 'SESSION_TITLE_UNAVAILABLE', statusCode: 409 });
    }
    const summary = await synchronizer.deriveSessionTitle(row.jsonl_path);
    if (!summary) {
      throw new AppError('This session has no message to derive a title from yet.', { code: 'SESSION_TITLE_UNAVAILABLE', statusCode: 409 });
    }
    sessionsDb.updateSessionCustomName(sessionId, summary, 'derived');
    return { sessionId, summary };
  },
};
