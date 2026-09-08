import type { DesktopOwnerActivity } from '../../shared/desktopUpdateProtocol.js';

import { GjcNativeClient, GjcNativeRequestError, type GjcNativeClientOptions } from './gjc-git-client.js';

type GjcArchivedFilter = 'exclude' | 'include' | 'only';
export type GjcJobListParams = Record<string, unknown> & { archived?: GjcArchivedFilter };
export type GjcJobReferenceParams = Record<string, unknown> & { jobId: string };
export type GjcJobsClientOptions = GjcNativeClientOptions & { database: string };
const MAX_JOBS_FRAME_BYTES = 64 * 1024;
const REQUEST_ID_BYTES = '00000000-0000-0000-0000-000000000000';
export class GjcJobsClientError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'GjcJobsClientError';
  }
}
/** An event that cannot fit in the native jobs NDJSON frame; chunking is deferred to Slice 4. */
export class GjcJobsEventTooLargeError extends GjcJobsClientError {
  constructor() {
    super('GJC job event exceeds the 64 KiB native authority frame limit.', 'event_too_large');
    this.name = 'GjcJobsEventTooLargeError';
  }
}

/** Process owner for the durable native jobs protocol. A down client rejects new run admission. */
export type GjcCancelAdmissionParams = Record<string, unknown> & {
  terminalEvent?: { eventId: string; payload: unknown };
};
export class GjcJobsClient extends GjcNativeClient {
  constructor(options: GjcJobsClientOptions) { super('jobs', options, ['jobs', '--database', options.database]); }
  override async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return await super.request(method, params);
    } catch (error) {
      if (error instanceof GjcNativeRequestError) {
        throw new GjcJobsClientError(error.message, error.code);
      }
      if (error instanceof Error && error.message === 'GJC native client is unavailable.') {
        throw new GjcJobsClientError(error.message, 'authority_unavailable');
      }
      throw error;
    }
  }
  reserve(params: Record<string, unknown>): Promise<unknown> { return this.request('capacity.reserve', params); }
  prepare(params: Record<string, unknown>): Promise<unknown> { return this.request('job.prepare', params); }
  admit(params: Record<string, unknown>): Promise<unknown> { return this.request('job.admit', params); }
  reserveStart(params: Record<string, unknown>): Promise<unknown> { return this.request('job.reserveStart', params); }
  turnAdmit(params: Record<string, unknown>): Promise<unknown> { return this.request('job.turnAdmit', params); }
  readmit(params: Record<string, unknown>): Promise<unknown> { return this.request('job.readmit', params); }
  transition(params: Record<string, unknown>): Promise<unknown> { return this.request('job.transition', params); }
  markDispatching(params: Record<string, unknown>): Promise<unknown> { return this.request('job.markDispatching', params); }
  finalize(params: Record<string, unknown>): Promise<unknown> { return this.request('job.finalize', params); }
  runFinalize(params: Record<string, unknown>): Promise<unknown> { return this.request('run.finalize', params); }
  cancelAdmission(params: GjcCancelAdmissionParams): Promise<unknown> { return this.request('job.cancelAdmission', params); }
  appendEvent(params: Record<string, unknown>): Promise<unknown> {
    // Keep worker output from killing the shared authority. Durable event chunking/blob projection is Slice 4.
    const frame = JSON.stringify({ ...params, protocolVersion: 1, id: REQUEST_ID_BYTES, method: 'event.append' });
    if (Buffer.byteLength(frame, 'utf8') > MAX_JOBS_FRAME_BYTES) return Promise.reject(new GjcJobsEventTooLargeError());
    return this.request('event.append', params);
  }
  appendAdminEvent(params: Record<string, unknown>): Promise<unknown> {
    const frame = JSON.stringify({ ...params, protocolVersion: 1, id: REQUEST_ID_BYTES, method: 'job.appendAdminEvent' });
    if (Buffer.byteLength(frame, 'utf8') > MAX_JOBS_FRAME_BYTES) return Promise.reject(new GjcJobsEventTooLargeError());
    return this.request('job.appendAdminEvent', params);
  }
  replayEvents(params: Record<string, unknown>): Promise<unknown> { return this.request('event.replay', params); }
  list(params: GjcJobListParams = {}): Promise<unknown> { return this.request('job.list', params); }
  get(params: GjcJobReferenceParams): Promise<unknown> { return this.request('job.get', params); }
  archive(params: GjcJobReferenceParams): Promise<unknown> { return this.request('job.archive', params); }
  unarchive(params: GjcJobReferenceParams): Promise<unknown> { return this.request('job.unarchive', params); }
  reconcile(params: Record<string, unknown> = {}): Promise<unknown> { return this.request('job.reconcile', params); }
  bindProviderSession(params: Record<string, unknown>): Promise<unknown> { return this.request('run.bindProviderSession', params); }
  bindingResolve(params: Record<string, unknown>): Promise<unknown> { return this.request('binding.resolve', params); }
  bindingRelease(params: Record<string, unknown>): Promise<unknown> { return this.request('binding.release', params); }
  interruptForShutdown(): Promise<unknown> { return this.request('job.interruptForShutdown'); }

  async snapshotDesktopActivity(): Promise<DesktopOwnerActivity> {
    const generation = this.getActivityGeneration();
    const value = await this.observeActivity();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native jobs activity.');
    const result = value as Record<string, unknown>;
    const fields = ['reserved', 'queued', 'running', 'aborting', 'unknown'] as const;
    if (Object.keys(result).length !== 6 || result.schemaVersion !== 1
      || fields.some((key) => !Number.isSafeInteger(result[key]) || Number(result[key]) < 0)) throw new Error('Invalid native jobs activity.');
    const own = this.activity();
    const unknown = [...own.unknown, ...(result.unknown !== 0 ? ['native_jobs_state_unknown'] : []),
      ...(generation !== this.getActivityGeneration() ? ['native_jobs_changed'] : [])];
    return { owner: 'native-jobs', generation, complete: unknown.length === 0,
      starting: Number(result.reserved), queued: Number(result.queued), running: Number(result.running), settling: Number(result.aborting),
      approvals: 0, retained: 0, unknown };
  }
}

export function createNativeJobsDesktopRestartReader(jobs: GjcJobsClient) {
  return { getGeneration: () => jobs.getActivityGeneration(), read: () => jobs.snapshotDesktopActivity() };
}
