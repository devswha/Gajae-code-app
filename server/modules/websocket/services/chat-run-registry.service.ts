import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { generateMessageId } from '@/shared/utils.js';
import type { LLMProvider, NormalizedMessage, RealtimeClientConnection } from '@/shared/types.js';

import type { DesktopOwnerActivity } from '../../../../shared/desktopUpdateProtocol.js';

type ChatRunStatus = 'running' | 'completed';
type ChatRun = {
  appSessionId: string; provider: LLMProvider; providerSessionId: string | null;
  status: ChatRunStatus; replayGeneration: string; lastSeq: number; events: NormalizedMessage[];
  writer: ChatSessionWriter; startedAt: number; completedAt: number | null;
  /** Approval requests the browser has been shown and has not answered yet, by request id. */
  pendingApprovals: Map<string, PendingApproval>;
};
type AppSessionId = string;
type RunCompletion = { exitCode: number; aborted?: boolean };
export type RunningRunSummary = { sessionId: string; provider: LLMProvider; startedAt: number; lastSeq: number; awaitingInput: boolean };
/** What the server knows about an open approval; the tool name is the one the provider itself reported. */
export type PendingApproval = { appSessionId: string; toolName: string | null };

type StartRunInput = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  connection: RealtimeClientConnection;
  userId: string | number | null;
};

const completedRunLifetime = 5 * 60 * 1000;
const eventBufferLimit = 5000;
const runsByAppSession = new Map<string, ChatRun>();
const activityEpoch = randomUUID();
let activityRevision = 0n;
let pendingPublications = 0;
const getGeneration = (): string => `${activityEpoch}:${activityRevision}`;

function scheduleCompletedRunRemoval(run: ChatRun): void {
  const timer = setTimeout(() => {
    if (runsByAppSession.get(run.appSessionId) === run && run.status === 'completed') {
      runsByAppSession.delete(run.appSessionId);
      activityRevision += 1n;
    }
  }, completedRunLifetime);
  void timer.unref?.();
}

function decorateRunEvent(run: ChatRun, event: NormalizedMessage): NormalizedMessage | null {
  if (runsByAppSession.get(run.appSessionId) !== run) return null;
  if (run.status === 'completed' && event.kind === 'complete') return null;

  const sequence = ++run.lastSeq;
  activityRevision += 1n;
  const publishedEvent: NormalizedMessage = {
    ...event,
    id: event.id || generateMessageId(event.kind),
    timestamp: event.timestamp || new Date().toISOString(),
    sessionId: run.appSessionId,
    replayGeneration: run.replayGeneration,
    seq: sequence,
  };

  // The registry is the one place every approval frame passes through, so it
  // can answer "is this run waiting on the user" for the running-sessions poll
  // without reaching into the provider that raised the question.
  const requestId = typeof event.requestId === 'string' ? event.requestId : null;
  if (requestId && event.kind === 'permission_request') {
    run.pendingApprovals.set(requestId, {
      appSessionId: run.appSessionId,
      toolName: typeof event.toolName === 'string' && event.toolName ? event.toolName : null,
    });
  }
  if (requestId && event.kind === 'permission_cancelled') run.pendingApprovals.delete(requestId);

  if (event.kind === 'complete') {
    publishedEvent.actualSessionId = run.appSessionId;
    run.pendingApprovals.clear();
    Object.assign(run, { status: 'completed' as ChatRunStatus, completedAt: Date.now() });
    scheduleCompletedRunRemoval(run);
  }

  run.events.push(publishedEvent);
  if (run.events.length > eventBufferLimit) run.events.splice(0, run.events.length - eventBufferLimit);
  return publishedEvent;
}

async function broadcastSessionUpsert(sessionId: string): Promise<void> {
  pendingPublications += 1;
  activityRevision += 1n;
  try { await publishSessionUpsert(sessionId); }
  finally { pendingPublications -= 1; activityRevision += 1n; }
}

async function publishSessionUpsert(sessionId: string): Promise<void> {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session || session.isArchived) return;

  const projectPath = session.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const fallbackName = path.basename(projectPath ?? '') || (projectPath ?? '');
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(fallbackName, projectPath);
  const payload = JSON.stringify({
    kind: 'session_upserted',
    sessionId: session.session_id,
    providerSessionId: session.provider_session_id,
    provider: session.provider,
    session: {
      id: session.session_id,
      summary: session.custom_name || '',
      messageCount: 0,
      lastActivity: session.updated_at ?? session.created_at ?? new Date().toISOString(),
    },
    project: project && {
      projectId: project.project_id,
      path: project.project_path,
      fullPath: project.project_path,
      displayName,
      isStarred: Boolean(project.isStarred),
      origin: project.origin,
    },
    timestamp: new Date().toISOString(),
  });

  for (const client of connectedClients) {
    if (client.readyState === WS_OPEN_STATE) client.send(payload);
  }
}

function persistProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || providerSessionId === run.providerSessionId) return;
  run.providerSessionId = providerSessionId;
  activityRevision += 1n;
  const context = { appSessionId: run.appSessionId, providerSessionId };
  const report = (label: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(label, { ...context, error: message });
  };

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, run.provider, providerSessionId);
    void broadcastSessionUpsert(run.appSessionId).catch((error) => {
      report('[ChatRunRegistry] Failed to broadcast canonical session mapping', error);
    });
  } catch (error) {
    report('[ChatRunRegistry] Failed to persist provider session id mapping', error);
  }
}

function applyGeneratedTitle(run: ChatRun, title: string): void {
  try {
    if (!sessionsDb.applyGeneratedSessionName(run.appSessionId, title)) return;
    void broadcastSessionUpsert(run.appSessionId).catch((error) => {
      console.error('[ChatRunRegistry] Failed to broadcast generated session title', { appSessionId: run.appSessionId, error: error instanceof Error ? error.message : String(error) });
    });
  } catch (error) {
    console.error('[ChatRunRegistry] Failed to store generated session title', { appSessionId: run.appSessionId, error: error instanceof Error ? error.message : String(error) });
  }
}

function createRun(input: StartRunInput): ChatRun {
  const run = {
    appSessionId: input.appSessionId,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    status: 'running' as ChatRunStatus,
    replayGeneration: randomUUID(),
    lastSeq: 0,
    events: [],
    writer: null as unknown as ChatSessionWriter,
    startedAt: Date.now(),
    completedAt: null,
    pendingApprovals: new Map<string, PendingApproval>(),
  } satisfies ChatRun;

  run.writer = new ChatSessionWriter({
    appSessionId: input.appSessionId,
    connection: input.connection,
    userId: input.userId,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    onProviderSessionId: (providerSessionId) => persistProviderSessionId(run, providerSessionId),
    onSessionTitle: (title) => applyGeneratedTitle(run, title),
    decorateOutboundEvent: (event) => decorateRunEvent(run, event),
  });
  return run;
}

function isCurrentRunningRun(run: ChatRun): boolean {
  return run.status === 'running' && runsByAppSession.get(run.appSessionId) === run;
}

export const chatRunRegistry = {
  getGeneration,

  /** Registry ownership only; worker/SDK settlement is a separate required reader. */
  snapshotActivity(): DesktopOwnerActivity {
    let running = 0;
    let approvals = 0;
    for (const run of runsByAppSession.values()) {
      if (run.status === 'running') running += 1;
      approvals += run.pendingApprovals.size;
    }
    return { owner: 'chat', generation: getGeneration(), complete: true, starting: 0,
      queued: 0, running, settling: pendingPublications, approvals, retained: 0, unknown: [] };
  },

  startRun(input: StartRunInput): ChatRun | null {
    const currentRun = runsByAppSession.get(input.appSessionId);
    if (currentRun?.status === 'running') return null;

    const run = createRun(input);
    runsByAppSession.set(input.appSessionId, run);
    activityRevision += 1n;
    return run;
  },

  getRun(appSessionId: AppSessionId): ChatRun | undefined {
    return runsByAppSession.get(appSessionId);
  },

  isProcessing(appSessionId: AppSessionId): boolean {
    return runsByAppSession.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): RunningRunSummary[] {
    const activeRuns: RunningRunSummary[] = [];
    for (const run of runsByAppSession.values()) {
      if (run.status !== 'running') continue;
      activeRuns.push({
        sessionId: run.appSessionId, provider: run.provider, startedAt: run.startedAt, lastSeq: run.lastSeq,
        awaitingInput: run.pendingApprovals.size > 0,
      });
    }
    return activeRuns;
  },

  /**
   * The browser answered an approval; the run is no longer waiting on it.
   * Returns what the server recorded when the request was raised, so a
   * decision can be persisted against the provider's tool name rather than
   * whatever the browser claims.
   */
  getPendingApproval(requestId: string): PendingApproval | null {
    for (const run of runsByAppSession.values()) {
      const pending = run.pendingApprovals.get(requestId);
      if (pending) return pending;
    }
    return null;
  },

  resolvePendingApproval(requestId: string): PendingApproval | null {
    let resolved: PendingApproval | null = null;
    for (const run of runsByAppSession.values()) {
      const pending = run.pendingApprovals.get(requestId);
      if (pending) {
        resolved ??= pending;
        run.pendingApprovals.delete(requestId);
        activityRevision += 1n;
      }
    }
    return resolved;
  },

  /** A viewer of the session joins the live stream; the ones already attached keep it. */
  attachConnection(appSessionId: AppSessionId, connection: RealtimeClientConnection): boolean {
    const run = runsByAppSession.get(appSessionId);
    if (!run) return false;
    run.writer.attachConnection(connection);
    activityRevision += 1n;
    return true;
  },

  /** A socket went away; no run keeps sending to it. */
  detachConnection(connection: RealtimeClientConnection): void {
    for (const run of runsByAppSession.values()) run.writer.detachConnection(connection);
    activityRevision += 1n;
  },

  replayEvents(appSessionId: AppSessionId, afterSeq: number, replayGeneration?: unknown): NormalizedMessage[] {
    const run = runsByAppSession.get(appSessionId);
    if (!run) return [];
    // A sequence is meaningful only inside its run. This also makes legacy
    // callers and clients returning after a server restart replay from zero.
    const cursor = replayGeneration === run.replayGeneration && Number.isSafeInteger(afterSeq)
      && afterSeq >= 0 && afterSeq <= run.lastSeq ? afterSeq : 0;
    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > cursor);
  },

  completeRun(appSessionId: AppSessionId, opts: RunCompletion): void {
    const run = runsByAppSession.get(appSessionId);
    if (run?.status === 'running') run.writer.sendComplete(opts);
  },

  completeRunIfCurrent(run: ChatRun, opts: RunCompletion): void {
    if (isCurrentRunningRun(run)) run.writer.sendComplete(opts);
  },

  clearAll(): void {
    runsByAppSession.clear();
    activityRevision += 1n;
  },
};
