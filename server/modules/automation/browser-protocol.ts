export type { BrowserTabState, BrowserSessionState } from '../../../shared/browserSessionState.js';

export const BROWSER_PROTOCOL_VERSION = 1 as const;

/** Child-owned observation, bound to one initialize handshake and request tail. */
export type BrowserChildActivity = {
  version: 1;
  epoch: string;
  revision: number;
  requestSequence: number;
  starting: number;
  queued: number;
  running: number;
  callbacks: number;
  settling: number;
  retained: number;
  browserAlive: boolean;
  unknown: readonly string[];
};

export function isBrowserChildActivity(value: unknown): value is BrowserChildActivity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const activity = value as Record<string, unknown>;
  const identifier = (field: unknown): field is string => typeof field === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(field);
  return Object.keys(activity).length === 12 && activity.version === 1 && identifier(activity.epoch)
    && ['revision', 'requestSequence', 'starting', 'queued', 'running', 'callbacks', 'settling', 'retained']
      .every((key) => Number.isSafeInteger(activity[key]) && (activity[key] as number) >= 0)
    && typeof activity.browserAlive === 'boolean'
    && Array.isArray(activity.unknown) && activity.unknown.length <= 32 && activity.unknown.every(identifier);
}

export type BrowserCommand =
  | { action: 'navigate'; url: string; waitUntil?: BrowserWaitUntil }
  | { action: 'back' }
  | { action: 'forward' }
  | { action: 'reload' }
  | { action: 'click'; ref?: number; selector?: string; x?: number; y?: number }
  | { action: 'type'; text: string; ref?: number; selector?: string }
  | { action: 'fill'; text: string; ref?: number; selector?: string }
  | { action: 'select'; values: string[]; ref?: number; selector?: string }
  | { action: 'press'; key: string }
  | { action: 'scroll'; dx?: number; dy?: number }
  | { action: 'wait'; ms?: number; selector?: string; text?: string }
  | { action: 'observe'; includeAll?: boolean }
  | { action: 'extract'; selector?: string; format?: 'text' | 'html' }
  | { action: 'screenshot' }
  | { action: 'run'; code: string; timeoutMs?: number }
  | { action: 'selectTab'; tabId: string }
  | { action: 'newTab'; url?: string }
  | { action: 'closeTab'; tabId?: string };

export type BrowserWaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';

/**
 * Clipboard operations are deliberately two-phase for copy/cut. A read only
 * observes the remote selection; the client writes that text to its own
 * clipboard before asking the sidecar to delete the still-matching selection.
 * The tab binding prevents a delayed local clipboard permission result from
 * mutating a different active tab.
 */
export type BrowserClipboardInput =
  | { kind: 'clipboard'; event: 'read'; tabId: string }
  | { kind: 'clipboard'; event: 'delete'; tabId: string; text: string; selectionId: string }
  | { kind: 'clipboard'; event: 'paste'; tabId: string; text: string };

export type BrowserInput =
  | { kind: 'mouse'; event: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'key'; event: 'down' | 'up'; key: string; code?: string; modifiers?: number }
  | { kind: 'text'; text: string }
  | { kind: 'viewport'; width: number; height: number; deviceScaleFactor?: number }
  | BrowserClipboardInput;

export function isBrowserClipboardInput(value: unknown): value is BrowserClipboardInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (input.kind !== 'clipboard' || !safeSessionId(input.tabId)) return false;
  if (input.event === 'read') return Object.keys(input).length === 3;
  if (input.event === 'paste') return Object.keys(input).length === 4 && typeof input.text === 'string';
  return input.event === 'delete'
    && Object.keys(input).length === 5
    && typeof input.text === 'string'
    && typeof input.selectionId === 'string'
    && input.selectionId.length > 0
    && input.selectionId.length <= 2_048;
}

export type BrowserRequestMethod =
  | 'initialize'
  | 'status'
  | 'session.open'
  | 'session.state'
  | 'session.close'
  | 'browser.command'
  | 'browser.input'
  | 'screencast.subscribe'
  | 'screencast.unsubscribe'
  | 'shutdown';

export type BrowserRequestFrame = {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  kind: 'request';
  id: string;
  method: BrowserRequestMethod;
  sessionId?: string;
  payload: Record<string, unknown>;
  /** Monotonic within this parent-owned sidecar transport. */
  sequence?: number;
};

export type BrowserResponseFrame = {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  kind: 'response';
  id: string;
  method: BrowserRequestMethod;
  sessionId?: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export type BrowserEventFrame = {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  kind: 'event';
  method: 'ready' | 'state' | 'frame' | 'async' | 'error' | 'download.progress';
  sessionId?: string;
  payload: Record<string, unknown>;
};

export type BrowserProtocolFrame = BrowserRequestFrame | BrowserResponseFrame | BrowserEventFrame;

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function serializeBrowserFrame(frame: BrowserProtocolFrame): string {
  const serialized = JSON.stringify(frame);
  if (Buffer.byteLength(serialized) > MAX_FRAME_BYTES) {
    throw new Error('Browser protocol frame is too large.');
  }
  return `${serialized}\n`;
}
export class BrowserNdjsonDecoder {
  private buffer = '';

  push(chunk: Buffer | string): BrowserProtocolFrame[] {
    this.buffer += chunk.toString();
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) {
      this.buffer = '';
      throw new Error('Browser protocol input exceeded its size limit.');
    }

    const frames: BrowserProtocolFrame[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        const parsed: unknown = JSON.parse(line);
        if (!isBrowserProtocolFrame(parsed)) {
          throw new Error('Invalid browser protocol frame.');
        }
        frames.push(parsed);
      }
      newline = this.buffer.indexOf('\n');
    }
    return frames;
  }
}

function isBrowserProtocolFrame(value: unknown): value is BrowserProtocolFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.protocolVersion === BROWSER_PROTOCOL_VERSION
    && (frame.kind === 'request' || frame.kind === 'response' || frame.kind === 'event');
}

export function safeSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
