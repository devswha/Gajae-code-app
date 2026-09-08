import type { BrowserRequestFrame } from './browser-protocol.js';

/** Actual NDJSON queue owner, including the realtime control-plane bypass. */
export class BrowserRequestQueue {
  private globalRequestQueue = Promise.resolve();
  private readonly sessionRequestQueues = new Map<string, Promise<void>>();
  private queued = 0;
  private running = 0;
  private requestSequence = 0;

  constructor(
    private readonly handle: (frame: BrowserRequestFrame) => Promise<void>,
    private readonly changed: () => void,
    private readonly reportError: (error: unknown) => void,
  ) {}

  snapshot() {
    return { queued: this.queued, running: this.running, requestSequence: this.requestSequence };
  }

  enqueue(frame: BrowserRequestFrame): void {
    if (frame.sequence !== undefined && (!Number.isSafeInteger(frame.sequence) || frame.sequence <= this.requestSequence)) {
      throw new Error('invalid_sequence: Browser request sequence must increase.');
    }
    this.requestSequence = frame.sequence ?? this.requestSequence + 1;
    this.queued++;
    this.changed();
    const dispatch = async () => {
      this.queued--;
      this.running++;
      this.changed();
      try { await this.handle(frame); }
      finally {
        this.running--;
        this.changed();
      }
    };
    const realtimeInput = frame.method === 'browser.input'
      && (frame.payload.input as { kind?: unknown } | undefined)?.kind !== 'viewport';
    if (frame.method === 'session.close' || frame.method === 'screencast.unsubscribe'
      || realtimeInput || frame.method === 'shutdown') {
      void dispatch().catch(this.reportError);
      return;
    }
    if (frame.sessionId) {
      const previous = this.sessionRequestQueues.get(frame.sessionId) ?? Promise.resolve();
      const next = previous.then(dispatch).catch(this.reportError);
      this.sessionRequestQueues.set(frame.sessionId, next);
      void next.finally(() => {
        if (this.sessionRequestQueues.get(frame.sessionId!) === next) this.sessionRequestQueues.delete(frame.sessionId!);
        this.changed();
      });
    } else {
      this.globalRequestQueue = this.globalRequestQueue.then(dispatch).catch(this.reportError);
    }
  }
}
