import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { connect as connectSocket, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';

import { isDesktopUpdateCommand, isDesktopUpdateSnapshot, type DesktopUpdateCommand, type DesktopUpdateSnapshot } from '../../shared/desktopUpdateProtocol.js';

const MAX_INIT_BYTES = 4096;
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_PENDING = 4;
const secretPattern = /^[a-f0-9]{64}$/;
const initPrefix = 'GJC_DESKTOP_UPDATE_INIT ';
const CHALLENGE_DOMAIN = 'gajae-native-update-v1\0';

type Binding = { protocolVersion: 1; socket: string; secret: string; epoch: string };
type Options = {
  input?: Readable;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pid?: number;
  connect?: typeof connectSocket;
};

function authenticChallenge(value: Record<string, unknown>, binding: Binding, nonce: string): boolean {
  if (Object.keys(value).length !== 5 || value.protocolVersion !== 1 || value.kind !== 'challenge'
    || value.epoch !== binding.epoch || value.nonce !== nonce
    || typeof value.proof !== 'string' || !secretPattern.test(value.proof)) return false;
  // The key is the UTF-8 initialization secret, NOT its hex-decoded bytes.
  const expected = createHmac('sha256', binding.secret)
    .update(`${CHALLENGE_DOMAIN}${binding.epoch}\0${nonce}`, 'utf8').digest();
  return timingSafeEqual(expected, Buffer.from(value.proof, 'hex'));
}

/** A relay, not an updater: no downloads, lifecycle, installer or private key APIs. */
export class DesktopUpdateRelay {
  private binding: Binding | null = null;
  private readonly pending = new Set<Socket>();
  private sequence = 0;
  private retired = false;
  private readonly pid: number;
  private readonly connect: typeof connectSocket;
  private readonly input: Readable;
  private inputBuffer = Buffer.alloc(0);

  constructor(options: Options = {}) {
    this.input = options.input ?? process.stdin;
    this.connect = options.connect ?? connectSocket;
    this.pid = options.pid ?? process.pid;
    const env = options.env ?? process.env;
    if ((options.platform ?? process.platform) !== 'darwin' || env.GJC_DESKTOP !== '1' || env.GJC_DESKTOP_UPDATE_PIPE !== '1') {
      this.retired = true;
      return;
    }
    // Only the supervisor's fresh stdin supplies this secret. It is never an
    // environment variable, browser response, stdout frame or descendant input.
    this.input.on('data', this.onData);
    this.input.once('end', this.onEnd);
    this.input.once('error', this.onEnd);
  }

  private readonly onEnd = () => { this.retire(); };
  private readonly onData = (chunk: Buffer | string) => {
    if (this.retired) return;
    if (this.binding) { this.retire(); return; }
    if (this.inputBuffer.length + Buffer.byteLength(chunk) > MAX_INIT_BYTES) { this.retire(); return; }
    this.inputBuffer = Buffer.concat([this.inputBuffer, Buffer.from(chunk)]);
    const newline = this.inputBuffer.indexOf(10);
    if (newline === -1) return;
    try {
      const line = this.inputBuffer.toString('utf8', 0, newline);
      if (newline !== this.inputBuffer.length - 1 || !line.startsWith(initPrefix)) throw new Error();
      const value = JSON.parse(line.slice(initPrefix.length)) as Record<string, unknown>;
      if (Object.keys(value).length !== 4 || value.protocolVersion !== 1
        || typeof value.socket !== 'string' || !value.socket.startsWith('/') || value.socket.length > 1024
        || typeof value.secret !== 'string' || !secretPattern.test(value.secret)
        || typeof value.epoch !== 'string' || !secretPattern.test(value.epoch)) throw new Error();
      this.binding = value as Binding;
      this.inputBuffer.fill(0);
      this.inputBuffer = Buffer.alloc(0);
    } catch {
      this.retire();
    }
  };

  isAvailable(): boolean { return !this.retired && this.binding !== null; }

  retire(): void {
    this.retired = true;
    this.binding = null;
    this.inputBuffer.fill(0);
    this.inputBuffer = Buffer.alloc(0);
    this.input.off('data', this.onData);
    this.input.off('end', this.onEnd);
    this.input.off('error', this.onEnd);
    for (const socket of this.pending) socket.destroy();
  }

  request(command: DesktopUpdateCommand, view: string, origin: string): Promise<DesktopUpdateSnapshot> {
    const binding = this.binding;
    if (this.retired || !binding || !isDesktopUpdateCommand(command)) return Promise.reject(new Error('updater_unavailable'));
    if (typeof view !== 'string' || !secretPattern.test(view) || typeof origin !== 'string'
      || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)) return Promise.reject(new Error('updater_unauthorized'));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error('updater_busy'));
    const sequence = ++this.sequence;
    const acceptedCommand: DesktopUpdateCommand = command.action === 'setAutomatic'
      ? { action: command.action, automatic: command.automatic } : { action: command.action };
    return new Promise((resolve, reject) => {
      let settled = false;
      let bytes = Buffer.alloc(0);
      let receivedBytes = 0;
      let phase: 'connecting' | 'challenge' | 'response' = 'connecting';
      let nonce = '';
      let socket: Socket | undefined;
      const deadline = performance.now() + REQUEST_TIMEOUT_MS;
      const finish = (error?: string, value?: DesktopUpdateSnapshot) => {
        if (settled) return;
        if (!error && performance.now() >= deadline) error = 'updater_timeout';
        settled = true;
        clearTimeout(timer);
        if (socket) {
          this.pending.delete(socket);
          socket.destroy();
        }
        bytes.fill(0);
        if (error) reject(new Error(error));
        else resolve(value!);
      };
      // One deadline covers connect, proof verification AND the command reply.
      // Neither authentication nor partial data renews the budget.
      const timer = setTimeout(() => finish('updater_timeout'), REQUEST_TIMEOUT_MS);
      try { socket = this.connect(binding.socket); }
      catch { finish('updater_unavailable'); return; }
      const connectedSocket = socket;
      this.pending.add(socket);
      socket.once('connect', () => {
        if (settled) return;
        if (performance.now() >= deadline) { finish('updater_timeout'); return; }
        if (this.retired || this.binding !== binding) { finish('updater_unavailable'); return; }
        try {
          nonce = randomBytes(32).toString('hex');
          phase = 'challenge';
          // A replaceable same-UID socket path is not native identity. Disclose
          // no secret, view, origin or command until this endpoint proves it.
          connectedSocket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'challenge', epoch: binding.epoch, pid: this.pid, nonce })}\n`);
        } catch { finish('updater_unavailable'); }
      });
      socket.on('data', (chunk: Buffer) => {
        if (settled) return;
        if (performance.now() >= deadline) { finish('updater_timeout'); return; }
        // Bound the entire two-frame exchange before allocating a concatenation.
        if (receivedBytes + chunk.length > MAX_RESPONSE_BYTES) { finish('updater_protocol_error'); return; }
        receivedBytes += chunk.length;
        bytes = Buffer.concat([bytes, chunk]);
        const newline = bytes.indexOf(10);
        if (newline === -1) return;
        try {
          if (newline !== bytes.length - 1) throw new Error();
          const response: unknown = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
          if (!response || typeof response !== 'object' || Array.isArray(response)
            || this.retired || this.binding !== binding) throw new Error();
          const frame = response as Record<string, unknown>;
          if (phase === 'challenge') {
            if (!authenticChallenge(frame, binding, nonce)) { finish('updater_unauthorized'); return; }
            if (performance.now() >= deadline) { finish('updater_timeout'); return; }
            bytes.fill(0);
            bytes = Buffer.alloc(0);
            phase = 'response';
            // Keep this authenticated descriptor; reconnecting would discard
            // the endpoint proof. Native separately enforces LOCAL_PEERPID.
            connectedSocket.write(`${JSON.stringify({ protocolVersion: 1, secret: binding.secret, epoch: binding.epoch, pid: this.pid, sequence, view, origin, command: acceptedCommand })}\n`);
            return;
          }
          if (phase !== 'response' || frame.protocolVersion !== 1 || frame.sequence !== sequence) throw new Error();
          if (frame.ok === true && isDesktopUpdateSnapshot(frame.snapshot)) finish(undefined, frame.snapshot);
          else if (frame.ok === false && typeof frame.error === 'string' && /^[a-z_]{1,64}$/.test(frame.error)) finish(frame.error);
          else throw new Error();
        } catch { finish('updater_protocol_error'); }
      });
      socket.once('error', () => finish('updater_unavailable'));
      socket.once('close', () => finish('updater_unavailable'));
    });
  }
}
