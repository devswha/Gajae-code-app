import { randomUUID } from 'node:crypto';

import {
  gjcTerminalNotificationDispatchesDb,
  userDb,
} from '@/modules/database/index.js';
import {
  createNotificationEvent,
  notifyUserIfEnabled,
} from '@/modules/notifications/services/notification-orchestrator.service.js';
import { enterNotificationActivity } from '@/modules/notifications/services/desktop-update-activity.service.js';

import type { JobProjectionEvent, JobTerminalOutcome } from '../../../../shared/gjc-job-projection-protocol.js';

type TerminalPayload = {
  schemaVersion: 1;
  kind: 'job_terminal';
  runId: string;
  appSessionId?: string;
  outcome: JobTerminalOutcome;
  reason: string;
};

type JobAuthority = {
  list?(params: Record<string, unknown>): Promise<unknown>;
  replayEvents(params: Record<string, unknown>): Promise<unknown>;
};
type JobSnapshot = { jobId: string; lastSequence?: number };
type Replay = { events?: unknown[]; nextCursor?: number };
type NotificationFacade = {
  createNotificationEvent(event: Record<string, unknown>): unknown;
  notifyUserIfEnabled(input: { userId: number | null; event: unknown }): unknown;
};
type DispatchResult = { result: 'accepted' | 'deduped' | 'failed'; settled?: Promise<void> };

export type GjcTerminalNotificationAdapter = {
  onCommittedEvent(jobId: string, event: JobProjectionEvent): 'accepted' | 'deduped' | 'ignored' | 'failed';
  startupCatchUp(): Promise<void>;
};

export type GjcTerminalNotificationAdapterOptions = {
  authority: Pick<JobAuthority, 'list' | 'replayEvents'>;
  notifications?: NotificationFacade;
  resolveUserId?: () => number | null;
};

const TERMINAL_OUTCOMES = new Set<JobTerminalOutcome>(['succeeded', 'failed', 'aborted', 'interrupted']);
const REPLAY_BYTE_BUDGET = 60 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const terminalPayload = (value: unknown): TerminalPayload | undefined => {
  if (!isObject(value)
    || value.schemaVersion !== 1
    || value.kind !== 'job_terminal'
    || typeof value.runId !== 'string'
    || !TERMINAL_OUTCOMES.has(value.outcome as JobTerminalOutcome)
    || typeof value.reason !== 'string'
    || (value.appSessionId !== undefined && typeof value.appSessionId !== 'string')) return undefined;
  return value as TerminalPayload;
};

const boundedFailure = (error: unknown): string => {
  const value = error instanceof Error ? error.message : String(error ?? 'notification failed');
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 512) || 'notification failed';
};

const snapshots = (value: unknown): JobSnapshot[] => Array.isArray(value)
  ? value.filter((item): item is JobSnapshot => isObject(item) && typeof item.jobId === 'string')
  : isObject(value) && Array.isArray(value.items)
    ? value.items.filter((item): item is JobSnapshot => isObject(item) && typeof item.jobId === 'string')
    : [];

// Budget-truncated pages can be shorter than the requested limit, so page
// length is not a termination signal; only a null/absent nextCursor is.
const listNextCursor = (value: unknown): string | null => (
  isObject(value) && typeof value.nextCursor === 'string' && value.nextCursor ? value.nextCursor : null
);

export function createGjcTerminalNotificationAdapter(
  options: GjcTerminalNotificationAdapterOptions,
): GjcTerminalNotificationAdapter {
  const notifications: NotificationFacade = options.notifications ?? {
    createNotificationEvent: createNotificationEvent as unknown as NotificationFacade['createNotificationEvent'],
    notifyUserIfEnabled: notifyUserIfEnabled as unknown as NotificationFacade['notifyUserIfEnabled'],
  };
  const resolveUserId = options.resolveUserId ?? (() => userDb.getFirstUser()?.id ?? null);

  const notifyClaimed = (
    jobId: string,
    event: JobProjectionEvent,
    payload: TerminalPayload,
    advanceCursor: boolean,
  ): DispatchResult => {
    let release: () => void;
    try { release = enterNotificationActivity(); }
    catch { return { result: 'failed' }; }
    let settled: Promise<void> | undefined;
    let claimToken: string | undefined;
    const recordFailure = (error: unknown): void => {
      if (!claimToken) return;
      try { gjcTerminalNotificationDispatchesDb.markFailed(claimToken, boundedFailure(error)); }
      catch { /* A notification failure must not change durable job completion. */ }
    };
    try {
      const userId = resolveUserId();
      const dispatch = {
        jobId,
        eventId: event.eventId,
        sequence: event.sequence,
        runId: payload.runId,
        appSessionId: payload.appSessionId ?? null,
        userId,
        outcome: payload.outcome,
        claimToken: randomUUID(),
      } as const;
      const claimed = advanceCursor
        ? gjcTerminalNotificationDispatchesDb.claimAndAdvanceCursor(dispatch)
        : gjcTerminalNotificationDispatchesDb.claim(dispatch);
      if (!claimed) return { result: 'deduped' };
      claimToken = dispatch.claimToken;

      const delivery = notifications.notifyUserIfEnabled({
        userId,
        event: notifications.createNotificationEvent({
          provider: 'gjc',
          sessionId: payload.appSessionId ?? null,
          kind: payload.outcome === 'succeeded' || payload.outcome === 'aborted' ? 'stop' : 'error',
          code: payload.outcome === 'succeeded' || payload.outcome === 'aborted' ? 'run.stopped' : 'run.failed',
          meta: payload.outcome === 'succeeded' || payload.outcome === 'aborted'
            ? { stopReason: payload.reason }
            : { error: payload.reason },
          severity: payload.outcome === 'succeeded' || payload.outcome === 'aborted' ? 'info' : 'error',
          dedupeKey: `gjc:job-terminal:${jobId}:${event.eventId}`,
        }),
      });
      if (delivery !== null && (typeof delivery === 'object' || typeof delivery === 'function')
        && typeof (delivery as { then?: unknown }).then === 'function') {
        settled = Promise.resolve(delivery)
          .then(() => { gjcTerminalNotificationDispatchesDb.markAccepted(dispatch.claimToken); })
          .catch(recordFailure)
          .finally(release);
        // Keep the synchronous API: accepted means handed to the facade. The
        // durable claim remains pending until it settles, not until UI display.
        return { result: 'accepted', settled };
      }
      gjcTerminalNotificationDispatchesDb.markAccepted(dispatch.claimToken);
      return { result: 'accepted' };
    } catch (error) {
      recordFailure(error);
      return { result: 'failed' };
    } finally {
      if (!settled) release();
    }
  };

  const scanJob = async (jobId: string): Promise<void> => {
    let after = gjcTerminalNotificationDispatchesDb.getCursor(jobId);
    for (;;) {
      const replay = await options.authority.replayEvents({ jobId, after, byteBudget: REPLAY_BYTE_BUDGET }) as Replay;
      const events = Array.isArray(replay?.events) ? replay.events : [];
      let progressed = false;
      for (const candidate of events) {
        if (!isObject(candidate)) continue;
        const sequence = candidate.sequence;
        if (typeof candidate.eventId !== 'string'
          || typeof sequence !== 'number'
          || !Number.isSafeInteger(sequence)
          || sequence < 1) continue;
        const event = { eventId: candidate.eventId, sequence, payload: candidate.payload } as JobProjectionEvent;
        const payload = terminalPayload(event.payload);
        if (payload) await notifyClaimed(jobId, event, payload, true).settled;
        else gjcTerminalNotificationDispatchesDb.advanceCursor(jobId, event.sequence);
        after = Math.max(after, event.sequence);
        progressed = true;
      }
      if (!Number.isSafeInteger(replay?.nextCursor) || !progressed) return;
      after = Math.max(after, replay.nextCursor!);
    }
  };

  return {
    onCommittedEvent(jobId, event) {
      const payload = terminalPayload(event.payload);
      if (!payload) return 'ignored';
      return notifyClaimed(jobId, event, payload, false).result;
    },

    async startupCatchUp(): Promise<void> {
      const release = enterNotificationActivity(false);
      try {
        if (!options.authority.list) return;
        const jobs: JobSnapshot[] = [];
        let afterCursor: string | undefined;
        for (;;) {
          const response = await options.authority.list({ provider: 'gjc', afterCursor, limit: 100 });
          const page = snapshots(response);
          jobs.push(...page);
          const nextCursor = listNextCursor(response);
          if (nextCursor) {
            afterCursor = nextCursor;
            continue;
          }
          // Legacy array responses carry no cursor; fall back to length-based
          // termination for that shape only.
          if (!Array.isArray(response) || page.length < 100) break;
          afterCursor = page[page.length - 1]?.jobId;
          if (!afterCursor) break;
        }
        const initialized = gjcTerminalNotificationDispatchesDb.initializeBaseline(jobs.map((job) => ({
          jobId: job.jobId,
          lastSequence: Number.isSafeInteger(job.lastSequence) && job.lastSequence! >= 0 ? job.lastSequence! : 0,
        })));
        if (initialized) return;
        for (const job of jobs) await scanJob(job.jobId);
      } finally { release(); }
    },
  };
}
