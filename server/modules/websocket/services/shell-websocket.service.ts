import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import type { DesktopWorkAdmission } from '@/shared/interfaces.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

import type { DesktopOwnerActivity } from '../../../../shared/desktopUpdateProtocol.js';

type ShellIncomingMessage = { type?: string; data?: string; cols?: number; rows?: number; projectPath?: string; sessionId?: string; hasSession?: boolean; provider?: string; initialCommand?: string; isPlainShell?: boolean; forceRestart?: boolean; };
type PtySessionEntry = { pty: IPty; ws: WebSocket | null; buffer: string[]; timeoutId: NodeJS.Timeout | null; projectPath: string; sessionId: string | null; urlText: string; reportedUrls: Set<string>; };
type ShellWebSocketDependencies = {
  desktopRestartAdmission?: DesktopWorkAdmission;
  resolveProviderSessionId: (sessionId: string, provider: string) => string | null | undefined;
  stripAnsiSequences: (content: string) => string;
  normalizeDetectedUrl: (url: string) => string | null;
  extractUrlsFromText: (content: string) => string[];
  shouldAutoOpenUrlFromOutput: (content: string) => boolean;
};

const sessions = new Map<string, PtySessionEntry>();
// A key may already name a replacement while its old PTY is still exiting.
// These are the same owned entries, retained until their own onExit callback.
const retiringSessions = new Set<PtySessionEntry>();
let shellActivityRevision = 0n;
let startingPtys = 0;
// node-pty proves only the leader's exit, not arbitrary detached descendants.
// Keep one bounded, process-lifetime uncertainty latch; neither kill(), onExit,
// timer expiry nor a socket disconnect can independently clear this proof gap.
let unverifiedPtyDescendants = false;

export function getShellActivityGeneration(): string {
  return `shell:${shellActivityRevision}`;
}

export function snapshotShellActivity(): DesktopOwnerActivity {
  let retained = 0;
  for (const session of sessions.values()) {
    if (session.ws === null) retained += 1;
  }
  return {
    owner: 'shell', generation: getShellActivityGeneration(), complete: !unverifiedPtyDescendants,
    starting: startingPtys, queued: 0, running: sessions.size, settling: retiringSessions.size,
    approvals: 0, retained, unknown: unverifiedPtyDescendants ? ['pty_descendants_unverified'] : [],
  };
}

function retireSession(session: PtySessionEntry): void {
  if (retiringSessions.has(session)) return;
  retiringSessions.add(session);
  shellActivityRevision += 1n;
}

// Revocation outlives the PTY entry: its exit must not let a delayed init from
// a replaced connection seize the session before the current owner restarts.
const supersededSockets = new WeakSet<WebSocket>();
const SESSION_GRACE_PERIOD = 30 * 60 * 1000;
const URL_WINDOW_LENGTH = 32768;
const SAFE_ID = /^[a-zA-Z0-9_.\-:]+$/;

const text = (value: unknown, otherwise = ''): string => typeof value === 'string' ? value : otherwise;
const flag = (value: unknown): boolean => typeof value === 'boolean' && value;
const dimension = (value: unknown, otherwise: number): number => typeof value === 'number' && Number.isFinite(value) ? value : otherwise;
const decode = (raw: RawData): ShellIncomingMessage | null => parseIncomingJsonObject(raw) as ShellIncomingMessage | null;

function nativeSession(message: ShellIncomingMessage, dependencies: ShellWebSocketDependencies): string {
  if (!flag(message.hasSession) || !text(message.sessionId)) return '';
  const sessionId = text(message.sessionId);
  let mapped: string | null | undefined;
  try {
    mapped = dependencies.resolveProviderSessionId(sessionId, text(message.provider, 'gjc'));
  } catch (error) {
    console.error('Failed to resolve provider session ID:', error);
  }
  const result = mapped === undefined ? sessionId : mapped;
  return result && SAFE_ID.test(result) ? result : '';
}

function shellCommand(message: ShellIncomingMessage, dependencies: ShellWebSocketDependencies): string {
  const command = text(message.initialCommand);
  const provider = text(message.provider, 'gjc');
  if (flag(message.isPlainShell) || (!!command && !flag(message.hasSession)) || provider === 'plain-shell') return command;
  if (provider !== 'gjc') return command;
  const resumeId = nativeSession(message, dependencies);
  if (!resumeId) return command || 'gjc';
  return os.platform() === 'win32'
    ? `gjc --resume "${resumeId}"; if ($LASTEXITCODE -ne 0) { gjc }`
    : `gjc --resume "${resumeId}" || gjc`;
}

function environmentValue(env: NodeJS.ProcessEnv, requested: string): string | undefined {
  const actualKey = Object.keys(env).find((key) => key.toLowerCase() === requested.toLowerCase());
  return actualKey ? env[actualKey] : undefined;
}

function preferredPath(env: NodeJS.ProcessEnv): { key: string; value: string | undefined } {
  const key = Object.keys(env).find((entry) => entry.toLowerCase() === 'path') ?? 'PATH';
  const original = env[key];
  if (!original) return { key, value: original };
  const lowerCaseOnWindows = (entry: string): string => os.platform() === 'win32' ? entry.toLowerCase() : entry;
  const entries = original.split(path.delimiter).filter(Boolean);
  const npmPrefix = environmentValue(env, 'npm_config_prefix');
  const appData = environmentValue(env, 'APPDATA');
  const candidates = [
    npmPrefix ?? '',
    npmPrefix ? path.join(npmPrefix, 'bin') : '',
    appData ? path.join(appData, 'npm') : '',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ].filter(Boolean);
  const existing = new Set(entries.map(lowerCaseOnWindows));
  const promoted = candidates.filter((candidate, index) => candidates.indexOf(candidate) === index && existing.has(lowerCaseOnWindows(candidate)));
  if (!promoted.length) return { key, value: original };
  const promotedKeys = new Set(promoted.map(lowerCaseOnWindows));
  return { key, value: [...promoted, ...entries.filter((entry) => !promotedKeys.has(lowerCaseOnWindows(entry)))].join(path.delimiter) };
}

function sessionKey(projectPath: string, sessionId: string | null, plain: boolean, command: string): string {
  const suffix = plain && command ? `_cmd_${createHash('sha256').update(command).digest('hex').slice(0, 16)}` : '';
  return `${projectPath}_${sessionId ?? 'default'}${suffix}`;
}

export function handleShellConnection(ws: WebSocket, dependencies: ShellWebSocketDependencies): void {
  console.log('[INFO] Shell websocket connected');
  let activePty: IPty | null = null;
  let key: string | null = null;

  const write = (payload: unknown) => ws.send(JSON.stringify(payload));
  const ownedSession = () => {
    const current = key ? sessions.get(key) : undefined;
    return current?.ws === ws && current.pty === activePty ? current : undefined;
  };
  const detach = () => {
    const current = ownedSession();
    if (!current || !key) return;
    const id = key;
    current.ws = null;
    if (current.timeoutId) clearTimeout(current.timeoutId);
    const timer = setTimeout(() => {
      // A cancelled callback may already be queued when a new owner attaches.
      if (sessions.get(id) !== current || current.ws !== null || current.timeoutId !== timer) return;
      retireSession(current);
      sessions.delete(id);
      current.timeoutId = null;
      shellActivityRevision += 1n;
      current.pty.kill();
    }, SESSION_GRACE_PERIOD);
    current.timeoutId = timer;
    shellActivityRevision += 1n;
  };
  const clearSavedSession = (id: string) => {
    const old = sessions.get(id);
    if (!old) return;
    if (old.ws && old.ws !== ws) supersededSockets.add(old.ws);
    if (old.timeoutId) clearTimeout(old.timeoutId);
    old.timeoutId = null;
    shellActivityRevision += 1n;
    retireSession(old);
    old.pty.kill();
    // kill() may report exit synchronously. Never remove a newer generation.
    if (sessions.get(id) === old) {
      sessions.delete(id);
      shellActivityRevision += 1n;
    }
  };
  const relayOutput = (id: string, child: IPty) => {
    return (chunk: string) => {
      const current = sessions.get(id);
      if (!current || current.pty !== child) return;
      if (current.buffer.length === 5000) current.buffer.shift();
      current.buffer.push(chunk);
      shellActivityRevision += 1n;
      if (!current.ws || current.ws.readyState !== WebSocket.OPEN) return;

      const stripped = dependencies.stripAnsiSequences(chunk);
      current.urlText = `${current.urlText}${stripped}`.slice(-URL_WINDOW_LENGTH);
      shellActivityRevision += 1n;
      const output = chunk.replace(/OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g, '[INFO] Opening in browser: $1');
      const urls = Array.from(new Set(dependencies.extractUrlsFromText(current.urlText)
        .map((url) => dependencies.normalizeDetectedUrl(url))
        .filter((url): url is string => Boolean(url))))
        .filter((url, _, all) => !all.some((other) => other !== url && other.startsWith(url)));
      const announce = (url: string, autoOpen: boolean) => {
        if (current.reportedUrls.has(url)) return;
        current.reportedUrls.add(url);
        shellActivityRevision += 1n;
        current.ws?.send(JSON.stringify({ type: 'auth_url', url, autoOpen }));
      };
      urls.forEach((url) => announce(url, false));
      if (dependencies.shouldAutoOpenUrlFromOutput(stripped) && urls.length) {
        announce(urls.reduce((longest, url) => url.length > longest.length ? url : longest), true);
      }
      current.ws.send(JSON.stringify({ type: 'output', data: output }));
    };
  };
  const start = (data: ShellIncomingMessage): void => {
    const projectPath = text(data.projectPath, process.cwd());
    const sessionId = text(data.sessionId) || null;
    const hasSession = flag(data.hasSession);
    const provider = text(data.provider, 'gjc');
    const command = text(data.initialCommand);
    const plain = flag(data.isPlainShell) || (!!command && !hasSession) || provider === 'plain-shell';
    const login = !!command && (command.includes('setup-token') || command.includes('cursor-agent login') || command.includes('auth login'));
    if (sessionId && !SAFE_ID.test(sessionId)) {
      write({ type: 'error', message: 'Invalid session ID' });
      return;
    }
    const nextKey = sessionKey(projectPath, sessionId, plain, command);
    const restart = login || flag(data.forceRestart);
    const previous = restart ? undefined : sessions.get(nextKey);
    const cwd = path.resolve(projectPath);
    if (!previous) {
      try {
        if (!fs.statSync(cwd).isDirectory()) throw new Error('Not a directory');
      } catch {
        write({ type: 'error', message: 'Invalid project path' });
        return;
      }
    }
    if (key !== nextKey) detach();
    key = nextKey;
    if (restart) clearSavedSession(key);
    if (previous) {
      activePty = previous.pty;
      if (previous.timeoutId) clearTimeout(previous.timeoutId);
      previous.timeoutId = null;
      if (previous.ws && previous.ws !== ws) supersededSockets.add(previous.ws);
      previous.ws = ws;
      shellActivityRevision += 1n;
      write({ type: 'output', data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n' });
      previous.buffer.forEach((data) => write({ type: 'output', data }));
      return;
    }
    const executable = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
    const commandLine = shellCommand(data, dependencies);
    const resumeId = nativeSession(data, dependencies);
    const npmPath = preferredPath(process.env);
    startingPtys += 1;
    // Even a throwing native spawn may have started a process before failing.
    unverifiedPtyDescendants = true;
    shellActivityRevision += 1n;
    let entry: PtySessionEntry;
    try {
      activePty = pty.spawn(executable, os.platform() === 'win32' ? ['-Command', commandLine] : ['-c', commandLine], {
        name: 'xterm-256color', cols: dimension(data.cols, 80), rows: dimension(data.rows, 24), cwd,
        env: { ...process.env, [npmPath.key]: npmPath.value, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3' },
      });
      entry = { pty: activePty, ws, buffer: [], timeoutId: null, projectPath, sessionId, urlText: '', reportedUrls: new Set() };
      sessions.set(key, entry);
      shellActivityRevision += 1n;
    } finally {
      startingPtys -= 1;
      shellActivityRevision += 1n;
    }
    const child = entry.pty;
    child.onExit((status) => {
      if (retiringSessions.delete(entry)) shellActivityRevision += 1n;
      const current = sessions.get(nextKey);
      if (current !== entry) return;
      if (current.timeoutId) clearTimeout(current.timeoutId);
      sessions.delete(nextKey);
      if (activePty === child) activePty = null;
      shellActivityRevision += 1n;
      if (current.ws?.readyState === WebSocket.OPEN) current.ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[33mProcess exited with code ${status.exitCode}${status.signal != null ? ` (${status.signal})` : ''}\x1b[0m\r\n` }));
    });
    child.onData(relayOutput(nextKey, child));
    const welcome = plain
      ? `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`
      : hasSession && resumeId
        ? `\x1b[36mResuming Gajae Code session ${resumeId} in: ${projectPath}\x1b[0m\r\n`
        : `\x1b[36mStarting new Gajae Code session in: ${projectPath}\x1b[0m\r\n`;
    write({ type: 'output', data: welcome });
  };
  const handlers: Record<string, (data: ShellIncomingMessage) => void> = {
    init: start,
    input: (data) => { ownedSession()?.pty.write(text(data.data)); },
    resize: (data) => { ownedSession()?.pty.resize(dimension(data.cols, 80), dimension(data.rows, 24)); },
  };

  ws.on('message', (raw) => {
    try {
      if (ws.readyState !== WebSocket.OPEN || supersededSockets.has(ws)) return;
      // A replaced connection cannot reclaim, restart or control the new owner.
      const current = key ? sessions.get(key) : undefined;
      if (current && current.ws !== ws) return;
      const data = decode(raw);
      if (!data?.type) throw new Error('Invalid websocket payload');
      if (data.type !== 'init' && data.type !== 'input' && data.type !== 'resize') return;
      if (data.type !== 'init' && !ownedSession()) return;
      // Admission is per producer message, not per connection. Keep its lease
      // through the synchronous handler and transfer to the registered PTY owner.
      const release = dependencies.desktopRestartAdmission?.enter(`shell.${data.type}`);
      shellActivityRevision += 1n;
      try { handlers[data.type]!(data); }
      finally {
        shellActivityRevision += 1n;
        release?.();
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'DESKTOP_RESTART_FENCED') {
        if (ws.readyState === WebSocket.OPEN) write({ type: 'error', code: 'DESKTOP_RESTART_FENCED', message: 'Desktop restart is being prepared. Retry this request.' });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Shell WebSocket error:', message);
      if (ws.readyState === WebSocket.OPEN) write({ type: 'output', data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n` });
    }
  });
  ws.on('close', detach);
  ws.on('error', (error) => console.error('[ERROR] Shell WebSocket error:', error));
}
