import { randomBytes } from 'node:crypto';
import { connect as connectSocket, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

import { isRestartControlFrame, isRestartControlResult, type RestartControlCommand, type RestartControlResult } from '../../shared/desktopRestartProtocol.js';

import { authenticNativeChallenge, type DesktopNativeBinding } from './desktop-update-transport.js';

export type DesktopRestartHandler = {
  bind(nativeEpoch: string): void;
  handle(command: RestartControlCommand, nativeEpoch: string): Promise<RestartControlResult>;
  disconnected(nativeEpoch: string): void;
};
type Options = { binding: DesktopNativeBinding; pid: number; handler: DesktopRestartHandler; connect?: typeof connectSocket };
const MAX_FRAME = 4096;
const MAX_BUFFER = 16 * 1024;

/** Only the endpoint-authenticated native channel can call the backend owner.
 * Connection loss revokes its precommit epoch, never interrupts accepted work. */
export class DesktopRestartChannel {
  private socket?: Socket;
  private closed = false;
  private phase: 'challenge' | 'attaching' | 'ready' = 'challenge';
  private buffer = Buffer.alloc(0);
  private latest = 0;
  private activeId?: number;
  private bound = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly nonce = randomBytes(32).toString('hex');
  private readonly handshakeDeadline = performance.now() + 2_000;

  constructor(private readonly options: Options) {
    this.timer = setTimeout(() => this.close(), 2_000);
    this.timer.unref?.();
    try {
      this.socket = (options.connect ?? connectSocket)(options.binding.socket);
      this.socket.once('connect', () => {
        if (this.closed || performance.now() >= this.handshakeDeadline) { this.close(); return; }
        this.write({ protocolVersion: 1, kind: 'challenge', epoch: options.binding.epoch, pid: options.pid, nonce: this.nonce });
      });
      this.socket.on('data', (chunk: Buffer) => this.receive(chunk));
      this.socket.once('error', () => this.close());
      this.socket.once('close', () => this.close());
    } catch { this.close(); }
  }

  isReady(): boolean { return !this.closed && this.phase === 'ready'; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.buffer.fill(0);
    this.buffer = Buffer.alloc(0);
    this.socket?.destroy();
    // The handler retains in-flight work/worker release until it really settles.
    if (this.bound) {
      try { this.options.handler.disconnected(this.options.binding.epoch); } catch { /* Fail closed; never revive a binding. */ }
    }
  }

  private write(frame: unknown): void {
    if (this.closed) return;
    try {
      const line = `${JSON.stringify(frame)}\n`;
      if (Buffer.byteLength(line) > MAX_FRAME) { this.close(); return; }
      this.socket?.write(line);
    } catch { this.close(); }
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    if (this.buffer.length + chunk.length > MAX_BUFFER) { this.close(); return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline === -1) { if (this.buffer.length > MAX_FRAME) this.close(); return; }
      if (newline === 0 || newline > MAX_FRAME) { this.close(); return; }
      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const frame: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        this.frame(frame);
      } catch { this.close(); }
      if (this.closed) return;
    }
  }

  private frame(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { this.close(); return; }
    const frame = value as Record<string, unknown>;
    const { binding, handler, pid } = this.options;
    if (this.phase !== 'ready' && performance.now() >= this.handshakeDeadline) { this.close(); return; }
    if (this.phase === 'challenge') {
      if (!authenticNativeChallenge(frame, binding, this.nonce)) { this.close(); return; }
      this.phase = 'attaching';
      this.write({ protocolVersion: 1, kind: 'backendAttach', epoch: binding.epoch, secret: binding.secret, pid });
      return;
    }
    if (this.phase === 'attaching') {
      if (Object.keys(frame).length !== 3 || frame.protocolVersion !== 1 || frame.kind !== 'backendAttached' || frame.epoch !== binding.epoch) { this.close(); return; }
      handler.bind(binding.epoch);
      this.bound = true;
      this.phase = 'ready';
      clearTimeout(this.timer);
      return;
    }
    if (!isRestartControlFrame(frame) || frame.epoch !== binding.epoch || frame.id <= this.latest || this.activeId !== undefined) { this.close(); return; }
    this.latest = frame.id;
    const id = this.activeId = frame.id;
    // Native owns a matching total budget. This watchdog revokes only the
    // control binding if a handler is defective; it never fabricates settlement.
    this.timer = setTimeout(() => this.close(), frame.command.action === 'prepare' ? frame.command.remainingMs + 50 : 5_050);
    this.timer.unref?.();
    void Promise.resolve().then(() => {
      if (this.closed || this.activeId !== id) return undefined;
      return handler.handle(frame.command, binding.epoch);
    }).then((result) => {
      if (this.closed || this.activeId !== id) return;
      if (!isRestartControlResult(result)) { this.close(); return; }
      clearTimeout(this.timer);
      this.activeId = undefined;
      this.write({ protocolVersion: 1, kind: 'restartControlResult', epoch: binding.epoch, id, result });
    }, () => this.close());
  }
}
