export const GJC_WORKER_PROTOCOL_VERSION = 1 as const;
export const GJC_WORKER_MAX_FRAME_BYTES = 64 * 1024 * 1024;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const GJC_WORKER_REQUEST_METHODS = [
  'worker.initialize',
  'worker.activity',
  'worker.admission',
  'session.start',
  'session.resume',
  'turn.start',
  'turn.abort',
  'turn.steer',
  'goal.inspect',
  'goal.control',
  'ask.reply',
  'models.catalog',
  'oauth.providers',
  'oauth.status',
  'oauth.start',
  'oauth.submit',
  'oauth.cancel',
  'worker.shutdown',
] as const;

export const GJC_WORKER_EVENT_METHODS = [
  'session.created',
  'message.delta',
  'message.completed',
  'tool.started',
  'tool.completed',
  'ask.presented',
  'usage.updated',
  'turn.completed',
  'turn.failed',
  'worker.status',
  'oauth.phase',
  'oauth.providers.updated',
  'provider.auth.updated',
] as const;

export type GjcWorkerRequestMethod = typeof GJC_WORKER_REQUEST_METHODS[number];
export type GjcWorkerEventMethod = typeof GJC_WORKER_EVENT_METHODS[number];
type GjcWorkerGlobalRequestMethod = Extract<GjcWorkerRequestMethod, 'worker.initialize' | 'worker.shutdown' | 'worker.activity' | 'worker.admission' | 'models.catalog' | `oauth.${string}`>;
export type GjcWorkerGlobalEventMethod = Extract<GjcWorkerEventMethod, 'oauth.phase' | 'oauth.providers.updated' | 'provider.auth.updated'>;

type GjcWorkerSuccess = {
  ok: true;
  result?: JsonValue;
};

type GjcWorkerFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: JsonValue;
  };
};

export type GjcWorkerResponsePayload = GjcWorkerSuccess | GjcWorkerFailure;

/** Fixed-size, credential-free ownership evidence. Counts can overlap. */
export type GjcWorkerActivity = {
  /** Opaque revision of ALL accounted activity, not merely current counters. */
  generation: string;
  complete: boolean;
  starting: number;
  queued: number;
  running: number;
  settling: number;
  approvals: number;
  retained: number;
  unknown: string[];
};
/** generation binds the host incarnation/revision AND runtime generation. */
export type GjcWorkerActivityObservation = GjcWorkerActivity & { fenceId: string | null };
export type GjcWorkerAdmissionRequest = { fenceId: string; closed: boolean };

type GlobalRequestMethod = GjcWorkerGlobalRequestMethod;
type ScopedRequestMethod = Exclude<GjcWorkerRequestMethod, GlobalRequestMethod>;

type GjcWorkerGlobalRequestFrame = {
  protocolVersion: typeof GJC_WORKER_PROTOCOL_VERSION;
  kind: 'request';
  id: string;
  method: Exclude<GlobalRequestMethod, 'worker.activity' | 'worker.admission'>;
  payload: JsonObject;
};

type GjcWorkerScopedRequestFrame = {
  protocolVersion: typeof GJC_WORKER_PROTOCOL_VERSION;
  kind: 'request';
  id: string;
  method: ScopedRequestMethod;
  sessionId: string;
  payload: JsonObject;
};

export type GjcWorkerRequestFrame = GjcWorkerGlobalRequestFrame | GjcWorkerScopedRequestFrame | {
  protocolVersion: typeof GJC_WORKER_PROTOCOL_VERSION;
  kind: 'request';
  id: string;
} & ({ method: 'worker.activity'; payload: Record<string, never> }
  | { method: 'worker.admission'; payload: GjcWorkerAdmissionRequest });

type GjcWorkerGlobalResponseFrame = {
  protocolVersion: typeof GJC_WORKER_PROTOCOL_VERSION;
  kind: 'response';
  id: string;
  method: Exclude<GlobalRequestMethod, 'worker.activity' | 'worker.admission'>;
  payload: GjcWorkerResponsePayload;
};

type GjcWorkerScopedResponseFrame = {
  protocolVersion: typeof GJC_WORKER_PROTOCOL_VERSION;
  kind: 'response';
  id: string;
  method: ScopedRequestMethod;
  sessionId: string;
  payload: GjcWorkerResponsePayload;
};

export type GjcWorkerResponseFrame = GjcWorkerGlobalResponseFrame | GjcWorkerScopedResponseFrame | {
  protocolVersion: typeof GJC_WORKER_PROTOCOL_VERSION;
  kind: 'response';
  id: string;
} & ({ method: 'worker.activity'; payload: GjcWorkerFailure | { ok: true; result: GjcWorkerActivityObservation } }
  | { method: 'worker.admission'; payload: GjcWorkerFailure | { ok: true; result: { fenceId: string | null } } });

type GjcWorkerStatusEventFrame = {
  protocolVersion: typeof GJC_WORKER_PROTOCOL_VERSION;
  kind: 'event';
  id: string;
  method: 'worker.status';
  sessionId?: string;
  payload: JsonObject;
};
type GjcWorkerGlobalEventFrame = {
  protocolVersion: typeof GJC_WORKER_PROTOCOL_VERSION;
  kind: 'event';
  id: string;
  method: GjcWorkerGlobalEventMethod;
  payload: JsonObject;
};


type GjcWorkerScopedEventFrame = {
  protocolVersion: typeof GJC_WORKER_PROTOCOL_VERSION;
  kind: 'event';
  id: string;
  method: Exclude<GjcWorkerEventMethod, 'worker.status' | GjcWorkerGlobalEventMethod>;
  sessionId: string;
  payload: JsonObject;
};
export type GjcWorkerEventFrame = GjcWorkerStatusEventFrame | GjcWorkerGlobalEventFrame | GjcWorkerScopedEventFrame;
export type GjcWorkerFrame = GjcWorkerRequestFrame | GjcWorkerResponseFrame | GjcWorkerEventFrame;

export class GjcWorkerProtocolError extends Error {
  readonly code: string;
  readonly details?: JsonValue;

  constructor(code: string, message: string, details?: JsonValue) {
    super(message);
    this.name = 'GjcWorkerProtocolError';
    this.code = code;
    this.details = details;
  }
}

const requestMethods = new Set<string>(GJC_WORKER_REQUEST_METHODS);
const eventMethods = new Set<string>(GJC_WORKER_EVENT_METHODS);
const globalMethods = new Set<string>(['worker.initialize', 'worker.shutdown', 'worker.activity', 'worker.admission', 'models.catalog', 'oauth.providers', 'oauth.status', 'oauth.start', 'oauth.submit', 'oauth.cancel']);
const globalEventMethods = new Set<string>(['oauth.phase', 'oauth.providers.updated', 'provider.auth.updated']);
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const redacted = '[redacted]';

function fail(code: string, message: string): never {
  throw new GjcWorkerProtocolError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJson(value: unknown, ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    fail('invalid_json_value', 'Frame contains a non-finite number.');
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    if (ancestors.has(value)) fail('invalid_json_value', 'Frame must not contain circular references.');
    ancestors.add(value);
    for (const item of Object.values(value)) validateJson(item, ancestors);
    ancestors.delete(value);
    return;
  }
  fail('invalid_json_value', 'Frame contains a value that is not valid JSON.');
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('unknown_field', 'Frame contains an unknown field.');
  }
}

function assertIdentifier(value: unknown, field: 'id' | 'sessionId'): asserts value is string {
  if (typeof value !== 'string' || !safeIdentifier.test(value)) {
    fail(field === 'id' ? 'invalid_id' : 'invalid_session_id', `Frame ${field} must be a non-empty safe identifier.`);
  }
}

function assertPayload(value: unknown): asserts value is JsonObject {
  if (!isPlainObject(value)) fail('invalid_payload', 'Frame payload must be a plain object.');
  validateJson(value);
}

function assertResponsePayload(value: unknown): asserts value is GjcWorkerResponsePayload {
  if (!isPlainObject(value) || typeof value.ok !== 'boolean') {
    fail('invalid_response_payload', 'Response payload must contain a boolean ok field.');
  }
  if (value.ok) {
    assertExactKeys(value, ['ok', 'result']);
    if ('result' in value) validateJson(value.result);
    return;
  }
  assertExactKeys(value, ['ok', 'error']);
  if (!isPlainObject(value.error)) fail('invalid_response_payload', 'Failed response payload must contain an error object.');
  assertExactKeys(value.error, ['code', 'message', 'details']);
  if (typeof value.error.code !== 'string' || typeof value.error.message !== 'string') {
    fail('invalid_response_payload', 'Response error code and message must be strings.');
  }
  if ('details' in value.error) validateJson(value.error.details);
}

const activityCounts = ['starting', 'queued', 'running', 'settling', 'approvals', 'retained'] as const;
const activityIdentifier = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);

export function isGjcWorkerActivity(value: unknown): value is GjcWorkerActivity {
  if (!isPlainObject(value)) return false;
  const keys = ['generation', 'complete', ...activityCounts, 'unknown'];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !descriptors[key] || !Object.hasOwn(descriptors[key], 'value'))) return false;
  return activityIdentifier(value.generation) && typeof value.complete === 'boolean'
    && activityCounts.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
    && Array.isArray(value.unknown) && value.unknown.length <= 32 && value.unknown.every(activityIdentifier);
}

function assertActivityPayload(method: string, value: JsonObject | GjcWorkerResponsePayload, response: boolean): void {
  if (method !== 'worker.activity' && method !== 'worker.admission') return;
  if (!response) {
    const request = value as JsonObject;
    if (method === 'worker.activity') {
      if (Object.keys(value).length !== 0) fail('invalid_payload', 'Activity requests must have an empty payload.');
    } else if (Object.keys(request).length !== 2 || !activityIdentifier(request.fenceId) || typeof request.closed !== 'boolean') {
      fail('invalid_payload', 'Admission request is invalid.');
    }
    return;
  }
  if (!value.ok) return;
  const result = value.result;
  if (!isPlainObject(result) || (result.fenceId !== null && !activityIdentifier(result.fenceId))) {
    fail('invalid_response_payload', 'Worker ownership response is invalid.');
  }
  if (method === 'worker.admission') {
    if (Object.keys(result).length !== 1) fail('invalid_response_payload', 'Admission response is invalid.');
  } else {
    const { fenceId: _fenceId, ...activity } = result;
    if (!isGjcWorkerActivity(activity)) fail('invalid_response_payload', 'Activity response is invalid.');
  }
}

function byteLength(input: string | Uint8Array): number {
  return typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
}

/** Parses and strictly validates one complete worker protocol frame. */
export function parseGjcWorkerFrame(input: string | Uint8Array): GjcWorkerFrame {
  if (byteLength(input) > GJC_WORKER_MAX_FRAME_BYTES) fail('frame_too_large', 'Frame exceeds the maximum byte length.');

  let parsed: unknown;
  try {
    const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
    parsed = JSON.parse(text);
  } catch {
    fail('malformed_frame', 'Frame must be valid UTF-8 JSON.');
  }

  if (!isPlainObject(parsed)) fail('invalid_envelope', 'Frame envelope must be a plain object.');
  if (parsed.protocolVersion !== GJC_WORKER_PROTOCOL_VERSION) fail('unsupported_protocol_version', 'Frame uses an unsupported worker protocol version.');
  if (parsed.kind !== 'request' && parsed.kind !== 'response' && parsed.kind !== 'event') {
    fail('invalid_envelope', 'Frame kind is invalid.');
  }

  if (parsed.kind === 'request') {
    assertExactKeys(parsed, ['protocolVersion', 'kind', 'id', 'method', 'sessionId', 'payload']);
    assertIdentifier(parsed.id, 'id');
    if (typeof parsed.method !== 'string' || !requestMethods.has(parsed.method)) fail('unknown_method', 'Request method is not supported.');
    assertPayload(parsed.payload);
    assertActivityPayload(parsed.method, parsed.payload, false);
    if (globalMethods.has(parsed.method)) {
      if ('sessionId' in parsed) fail('invalid_session_scope', 'Global requests must omit sessionId.');
    } else {
      assertIdentifier(parsed.sessionId, 'sessionId');
    }
    return parsed as GjcWorkerRequestFrame;
  }

  if (parsed.kind === 'response') {
    assertExactKeys(parsed, ['protocolVersion', 'kind', 'id', 'method', 'sessionId', 'payload']);
    assertIdentifier(parsed.id, 'id');
    if (typeof parsed.method !== 'string' || !requestMethods.has(parsed.method)) fail('unknown_method', 'Response method must be a request method.');
    assertResponsePayload(parsed.payload);
    assertActivityPayload(parsed.method, parsed.payload, true);
    if (globalMethods.has(parsed.method)) {
      if ('sessionId' in parsed) fail('invalid_session_scope', 'Global responses must omit sessionId.');
    } else {
      assertIdentifier(parsed.sessionId, 'sessionId');
    }
    return parsed as GjcWorkerResponseFrame;
  }

  assertExactKeys(parsed, ['protocolVersion', 'kind', 'id', 'method', 'sessionId', 'payload']);
  assertIdentifier(parsed.id, 'id');
  if (typeof parsed.method !== 'string' || !eventMethods.has(parsed.method)) fail('unknown_method', 'Event method is not supported.');
  assertPayload(parsed.payload);
  if (globalEventMethods.has(parsed.method)) {
    if ('sessionId' in parsed) fail('invalid_session_scope', 'Global events must omit sessionId.');
  } else if (parsed.method !== 'worker.status') {
    assertIdentifier(parsed.sessionId, 'sessionId');
  } else if ('sessionId' in parsed) {
    assertIdentifier(parsed.sessionId, 'sessionId');
  }
  return parsed as GjcWorkerEventFrame;
}

function secretPattern(secret: string): RegExp | undefined {
  if (!secret) return undefined;
  return new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}

/** Creates a JSON-safe copy with supplied secrets removed from property names and strings. */
export function redactGjcWorkerSecrets<T>(value: T, suppliedSecrets: readonly string[] = []): T {
  const patterns = suppliedSecrets.map(secretPattern).filter((pattern): pattern is RegExp => pattern !== undefined);
  const redactText = (text: string): string => patterns.reduce((result, pattern) => result.replace(pattern, redacted), text);
  const visit = (item: JsonValue): JsonValue => {
    if (typeof item === 'string') return redactText(item);
    if (Array.isArray(item)) return item.map(visit);
    if (isPlainObject(item)) {
      const copy: JsonObject = {};
      for (const [key, child] of Object.entries(item)) copy[redactText(key)] = visit(child);
      return copy;
    }
    return item;
  };
  validateJson(value);
  return visit(value) as T;
}

/** Validates, redacts, revalidates, and emits one compact LF-delimited frame. */
export function serializeGjcWorkerFrame(frame: GjcWorkerFrame, suppliedSecrets: readonly string[] = []): string {
  validateJson(frame);
  const validated = parseGjcWorkerFrame(JSON.stringify(frame));
  const redactedFrame = redactGjcWorkerSecrets(validated, suppliedSecrets);
  const line = JSON.stringify(parseGjcWorkerFrame(JSON.stringify(redactedFrame)));
  if (Buffer.byteLength(line, 'utf8') > GJC_WORKER_MAX_FRAME_BYTES) fail('frame_too_large', 'Frame exceeds the maximum byte length.');
  return `${line}\n`;
}

/** Incremental byte-oriented decoder for private stdio NDJSON. */
export class GjcWorkerNdjsonDecoder {
  private pending = new Uint8Array(0);
  private failed = false;

  push(chunk: Uint8Array): GjcWorkerFrame[] {
    if (this.failed) fail('decoder_failed', 'NDJSON decoder is in a failed state.');
    try {
      this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
      const frames: GjcWorkerFrame[] = [];
      let start = 0;
      for (let index = 0; index < this.pending.length; index += 1) {
        if (this.pending[index] !== 10) continue;
        let end = index;
        if (end > start && this.pending[end - 1] === 13) end -= 1;
        const line = this.pending.subarray(start, end);
        if (line.length === 0) fail('invalid_ndjson', 'NDJSON frames must not be blank.');
        if (line.length > GJC_WORKER_MAX_FRAME_BYTES) fail('frame_too_large', 'Frame exceeds the maximum byte length.');
        frames.push(parseGjcWorkerFrame(line));
        start = index + 1;
      }
      this.pending = this.pending.subarray(start);
      if (this.pending.length > GJC_WORKER_MAX_FRAME_BYTES) fail('frame_too_large', 'Frame exceeds the maximum byte length.');
      return frames;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  finish(): void {
    if (this.failed) fail('decoder_failed', 'NDJSON decoder is in a failed state.');
    if (this.pending.length > 0) {
      this.failed = true;
      fail('unterminated_frame', 'NDJSON input ended before a frame terminator.');
    }
  }
}

type PendingRequest = {
  request: GjcWorkerRequestFrame;
  resolve: (payload: GjcWorkerResponsePayload) => void;
  reject: (error: Error) => void;
};

/** Correlates requests with exactly matching responses and rejects pending work on worker exit. */
export class GjcWorkerRequestTracker {
  private readonly pending = new Map<string, PendingRequest>();

  track(request: GjcWorkerRequestFrame): Promise<GjcWorkerResponsePayload> {
    if (this.pending.has(request.id)) fail('duplicate_request_id', 'A request with this id is already pending.');
    return new Promise((resolve, reject) => this.pending.set(request.id, { request, resolve, reject }));
  }

  settle(response: GjcWorkerResponseFrame): void {
    const pending = this.pending.get(response.id);
    if (!pending) fail('unknown_response_id', 'Response does not match a pending request.');
    const requestSession = 'sessionId' in pending.request ? pending.request.sessionId : undefined;
    const responseSession = 'sessionId' in response ? response.sessionId : undefined;
    if (pending.request.method !== response.method || requestSession !== responseSession) {
      fail('mismatched_response', 'Response does not match the request method and session scope.');
    }
    this.pending.delete(response.id);
    pending.resolve(response.payload);
  }
  reject(id: string, error: Error): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    pending.reject(error);
    return true;
  }

  failAll(error: Error | string = new GjcWorkerProtocolError('worker_exited', 'Worker exited before responding.')): void {
    const failure = typeof error === 'string' ? new GjcWorkerProtocolError('worker_exited', error) : error;
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
