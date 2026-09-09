import { randomUUID } from 'node:crypto';

import type { DesktopOwnerActivity } from '../../shared/desktopUpdateProtocol.js';
import type { GjcWorkerOptions, GjcWorkerRun, GjcWorkerWriter } from '../gjc-worker-client.js';
import { sessionsDb, sessionWorktreesDb } from '../modules/database/index.js';
import { resolveProjectRunPermissions } from '../modules/projects/index.js';
import { AppError, createNormalizedMessage } from '../shared/utils.js';
import type { DesktopWorkAdmission } from '../shared/interfaces.js';

import { getProductionJobOrchestrator, withOwnedJobDesktopContinuation, type JobOrchestrator } from './gjc-job-orchestrator.js';
import { validateSessionRepository, validateSessionWorktree } from './session-worktree-paths.js';

type Ticket = {
  controller: AbortController; aborted: boolean; worker?: GjcWorkerRun; finished?: Promise<void>;
  disposed: boolean; settled: boolean; workerSettled: boolean; unconfirmed: boolean;
  release?: () => void;
};
const tickets = new Map<string, Ticket>();
const activityEpoch = randomUUID();
let activityRevision = 0n;
let abortTasks = 0;
let desktopAdmission: DesktopWorkAdmission | undefined;
const activityChanged = () => { activityRevision += 1n; };

export function configureSessionWorktreeDesktopAdmission(admission?: DesktopWorkAdmission): void {
  desktopAdmission = admission;
  activityChanged();
}
export function snapshotSessionWorktreeActivity(): DesktopOwnerActivity {
  let starting = 0; let running = 0; let settling = abortTasks; let retained = 0;
  let unconfirmed = false;
  for (const ticket of tickets.values()) {
    if (!ticket.finished) starting += 1;
    else if (!ticket.settled) running += 1;
    else retained += 1;
    if (!ticket.workerSettled || (ticket.disposed && !ticket.settled)) settling += 1;
    unconfirmed ||= ticket.unconfirmed;
  }
  return {
    owner: 'worktrees', generation: `${activityEpoch}:${activityRevision}`, complete: !unconfirmed,
    starting, queued: 0, running, settling, approvals: 0, retained,
    unknown: unconfirmed ? ['worktree_stop_unconfirmed'] : [],
  };
}
export function createSessionWorktreeDesktopRestartReader(): { getGeneration(): string; read(): DesktopOwnerActivity } {
  return Object.freeze({ getGeneration: () => `${activityEpoch}:${activityRevision}`, read: snapshotSessionWorktreeActivity });
}

function releaseTicket(abortHandle: string, ticket: Ticket): void {
  if (ticket.finished && (!ticket.settled || !ticket.workerSettled)) return;
  // The map remains the owner of uncertainty even after the caller disposes.
  ticket.release?.();
  ticket.release = undefined;
  if (ticket.disposed && !ticket.unconfirmed && tickets.get(abortHandle) === ticket) {
    tickets.delete(abortHandle);
    activityChanged();
  }
}

/** Installed synchronously when chat accepts a run, before model lookup. */
export function prepareSessionWorktreeRun(sessionId: string, orchestratorFactory: () => JobOrchestrator = getProductionJobOrchestrator, admission = desktopAdmission) {
  const release = admission?.enter('worktrees:prepare');
  let row;
  try { row = sessionWorktreesDb.get(sessionId); }
  catch (error) { release?.(); throw error; }
  if (!row) { release?.(); return null; }
  const ticket: Ticket = { controller: new AbortController(), aborted: false, disposed: false, settled: false, workerSettled: true, unconfirmed: false, release };
  const abortHandle = `session-worktree-${randomUUID()}`;
  tickets.set(abortHandle, ticket);
  activityChanged();
  return {
    abortHandle,
    get aborted() { return ticket.aborted; },
    dispose() {
      if (ticket.disposed) return;
      ticket.disposed = true;
      activityChanged();
      releaseTicket(abortHandle, ticket);
    },
    run(message: string, options: GjcWorkerOptions, writer: GjcWorkerWriter): Promise<void> {
      if (ticket.finished) return Promise.reject(new Error('A worktree run ticket can only be used once.'));
      if (ticket.disposed) return Promise.reject(new Error('A disposed worktree run ticket cannot be used.'));
      let releaseRun: (() => void) | undefined;
      try { releaseRun = (admission ?? desktopAdmission)?.enterCompletion('worktrees:run'); }
      catch (error) { return Promise.reject(error); }
      const continueOwned = <T>(action: () => T) => withOwnedJobDesktopContinuation(
        () => tickets.get(abortHandle) === ticket && !ticket.settled, action,
      );
      const operation = async () => {
        const signal = ticket.controller.signal;
        const stoppedBeforeAdmission = () => {
          if (!signal.aborted) return false;
          ticket.aborted = true;
          activityChanged();
          return true;
        };
        if (stoppedBeforeAdmission()) return;
        const session = sessionsDb.getSessionById(sessionId);
        if (!session || session.provider !== 'gjc' || session.project_path !== row.repository_root || session.isArchived) throw new AppError('Session project binding changed.', { code: 'SESSION_PROJECT_MISMATCH', statusCode: 409 });
        await validateSessionRepository(row.repository_root);
        if (stoppedBeforeAdmission()) return;
        const orchestrator = orchestratorFactory();
        const binding = await continueOwned(() => orchestrator.resolveBinding('gjc', sessionId));
        if (stoppedBeforeAdmission()) return;
        let complete: Record<string, unknown> | undefined;
        const durableWriter: GjcWorkerWriter = {
          userId: writer.userId,
          getAppSessionId: () => writer.getAppSessionId?.(),
          setSessionId: (id) => writer.setSessionId?.(id),
          send: (value) => {
            if (value && typeof value === 'object' && 'kind' in value && value.kind === 'complete') complete = value as Record<string, unknown>;
            else writer.send(value);
          },
        };
        const runOptions = {
          ...options, projectPath: row.repository_root, permissions: resolveProjectRunPermissions(row.repository_root), writer: durableWriter, signal,
          retainWorkspaceOnFailure: true,
          cap: 4,
          onRun: (run: GjcWorkerRun) => {
            ticket.worker = run;
            ticket.workerSettled = false;
            activityChanged();
            void Promise.all([
              run.completion.then(() => true, () => false),
              run.outcome?.catch(() => 'unconfirmed' as const),
            ]).then(([completed, outcome]) => {
              ticket.workerSettled = true;
              ticket.unconfirmed = outcome === 'unconfirmed' || (!outcome && !completed);
              activityChanged();
              releaseTicket(abortHandle, ticket);
            });
          },
        };
        let handle;
        if (!binding) {
          // An existing provider transcript must never be moved to a fresh job
          // merely because its authority binding is missing.
          if (session.provider_session_id || row.worktree_path) throw new AppError('Worktree ownership is unavailable.', { code: 'SESSION_WORKTREE_BINDING_LOST', statusCode: 409 });
          handle = await continueOwned(() => orchestrator.start('gjc', sessionId, row.repository_root, message, {
            ...runOptions, jobId: row.job_id,
            onPrepared: async (cwd) => {
              await validateSessionWorktree(row, cwd);
              sessionWorktreesDb.setPreparedPath(sessionId, row.job_id, cwd);
            },
          }));
        } else {
          if (binding.jobId !== row.job_id || (session.provider_session_id && binding.providerSessionId !== session.provider_session_id)) throw new AppError('Worktree ownership does not match this session.', { code: 'SESSION_WORKTREE_BINDING_MISMATCH', statusCode: 409 });
          if (binding.providerSessionId && !session.provider_session_id) {
            // Recover a crash between native provider binding and app upsert.
            sessionsDb.assignProviderSessionId(sessionId, 'gjc', binding.providerSessionId);
            writer.setSessionId?.(binding.providerSessionId);
          }
          const current = sessionWorktreesDb.get(sessionId);
          if (!current) throw new Error('Session worktree was removed.');
          await validateSessionWorktree(current);
          if (stoppedBeforeAdmission()) return;
          if (binding.state === 'ready') handle = await continueOwned(() => orchestrator.turnStart('gjc', sessionId, message, runOptions));
          else if (binding.state === 'interrupted') handle = await continueOwned(() => orchestrator.resume(row.job_id, sessionId, message, runOptions));
          else throw new AppError('This worktree already has an active run.', { code: 'RUN_IN_PROGRESS', statusCode: 409 });
        }
        await handle.completion;
        const outcome = await ticket.worker?.outcome;
        if (outcome === 'unconfirmed') throw new AppError('Worktree execution has not confirmed termination.', { code: 'SESSION_WORKTREE_STOP_UNCONFIRMED', statusCode: 409 });
        ticket.aborted = signal.aborted || outcome === 'aborted';
        activityChanged();
        // Let queued chat follow-ups start only after native authority is ready.
        writer.send(createNormalizedMessage({ ...complete, kind: 'complete', provider: 'gjc', sessionId: sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId, exitCode: complete?.exitCode ?? 0, aborted: ticket.aborted }));
      };
      const finished = operation().finally(() => {
        ticket.settled = true;
        activityChanged();
        releaseRun?.();
        releaseTicket(abortHandle, ticket);
      });
      ticket.finished = finished;
      activityChanged();
      return finished;
    },
  };
}

export function sessionWorktreeWorkerHandle(handle: string): string | undefined {
  return tickets.get(handle)?.worker?.abortHandle;
}

export async function abortSessionWorktreeRun(handle: string): Promise<boolean | null> {
  const ticket = tickets.get(handle);
  if (!ticket) return null;
  const release = desktopAdmission?.enterCompletion('worktrees:abort');
  abortTasks += 1;
  activityChanged();
  const operation = (async () => {
    ticket.controller.abort();
    activityChanged();
    // This task, not the timeout below, owns the actual cancellation unwind.
    if (!ticket.finished) { ticket.aborted = true; activityChanged(); return true; }
    await ticket.finished.catch(() => {});
    if (!ticket.worker) return true;
    if (!ticket.worker.outcome) return ticket.worker.completion.then(() => true, () => false);
    const outcome = await ticket.worker.outcome.catch(() => 'unconfirmed');
    return outcome !== 'unconfirmed';
  })().finally(() => { abortTasks -= 1; activityChanged(); release?.(); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
