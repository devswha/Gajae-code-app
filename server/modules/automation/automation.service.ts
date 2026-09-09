import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import net, { type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DesktopWorkAdmission } from '@/shared/interfaces.js';

import type { DesktopOwnerActivity } from '../../../shared/desktopUpdateProtocol.js';

import { AutomationGrantStore, type AutomationGrant } from './automation-grants.js';
import { BrowserSidecarClient, type BrowserEventListener } from './browser-sidecar-client.js';
import type { BrowserCommand, BrowserInput, BrowserSessionState } from './browser-protocol.js';
import { automationOrigin } from './automation-url.js';
import { CuaDriverClient, isCuaSafeTool, type CuaSafeTool } from './cua-client.js';

type BridgeRequest = {
  id: string;
  token: string;
  surface: 'browser' | 'computer';
  sessionId: string;
  operation?: 'open' | 'close' | 'command' | 'authorize';
  payload?: Record<string, unknown>;
  tool?: string;
  arguments?: Record<string, unknown>;
};

type CuaApplication = {
  bundle_id?: unknown;
  name?: unknown;
  pid?: unknown;
};

type CuaWindow = {
  pid?: unknown;
  window_id?: unknown;
};

type CuaApplicationAuthorization = {
  granted: boolean;
  application: string | null;
  label: string | null;
};

const MAX_BRIDGE_LINE = 2 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeBridgeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function structuredObject(value: unknown): Record<string, unknown> {
  const record = object(value);
  return object(record.structuredContent ?? record.result ?? record);
}

function applicationRecords(value: unknown): CuaApplication[] {
  const apps = structuredObject(value).apps;
  return Array.isArray(apps)
    ? apps.filter((app): app is CuaApplication => Boolean(app && typeof app === 'object' && !Array.isArray(app)))
    : [];
}

function windowRecords(value: unknown): CuaWindow[] {
  const windows = structuredObject(value).windows;
  return Array.isArray(windows)
    ? windows.filter((window): window is CuaWindow => Boolean(window && typeof window === 'object' && !Array.isArray(window)))
    : [];
}

function cuaToolError(value: unknown): string | null {
  const record = object(value);
  if (record.isError !== true) return null;
  const content = Array.isArray(record.content) ? record.content : [];
  const message = content
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n');
  return message || 'CUA Driver rejected the session request.';
}

function requestedPid(args: Record<string, unknown>): number | undefined {
  if (typeof args.pid === 'number' && Number.isSafeInteger(args.pid) && args.pid > 0) return args.pid;
  const target = object(args.target);
  return typeof target.pid === 'number' && Number.isSafeInteger(target.pid) && target.pid > 0
    ? target.pid
    : undefined;
}

function requestedWindowId(args: Record<string, unknown>): number | undefined {
  if (typeof args.window_id === 'number' && Number.isSafeInteger(args.window_id) && args.window_id > 0) {
    return args.window_id;
  }
  const target = object(args.target);
  return typeof target.window_id === 'number' && Number.isSafeInteger(target.window_id) && target.window_id > 0
    ? target.window_id
    : undefined;
}

const COMPUTER_DISCOVERY_TOOLS = new Set<CuaSafeTool>([
  'start_session', 'end_session', 'list_apps', 'get_accessibility_tree', 'move_cursor',
]);

/**
 * Synthetic identity for the app-owned Chrome-for-Testing sidecar. It runs
 * outside any installed app bundle, so the CUA inventory cannot resolve its
 * windows to a bundle id — without this identity every computer action against
 * the Workspace Browser window fails as "unresolvable" even though the target
 * is the app's own browser.
 */
const WORKSPACE_BROWSER_APPLICATION_ID = 'app.gajae.workspace-browser';
const WORKSPACE_BROWSER_LABEL = 'Workspace Browser';

type ComputerSession = {
  label: string;
  starting?: Promise<{ label: string; result: unknown }>;
  ending?: Promise<unknown>;
  uncertain?: boolean;
};

export function automationSupport(platform: NodeJS.Platform, arch: string, environment: NodeJS.ProcessEnv) {
  const override = environment.GAJAE_AUTOMATION === '1';
  const desktop = environment.GJC_DESKTOP === '1';
  const mac = platform === 'darwin' && arch === 'arm64';
  return {
    browser: override || (desktop && (mac || (platform === 'linux' && arch === 'x64'))),
    computer: override || (desktop && mac),
  };
}

export class AutomationService {
  readonly browser = new BrowserSidecarClient();
  readonly cua = new CuaDriverClient({ onSessionClosed: (label) => {
    for (const [id, session] of this.cuaSessionLabels) {
      if (session.label === label) {
        this.cuaSessionLabels.delete(id);
        this.activityRevision++;
      }
    }
  } });
  readonly grants = new AutomationGrantStore();
  private readonly capabilities = automationSupport(process.platform, process.arch, process.env);
  readonly supported = this.capabilities.browser;
  private readonly bridgeToken = randomBytes(32).toString('hex');
  private readonly bridgePath = process.env.GAJAE_AUTOMATION_SOCKET
    ?? join(tmpdir(), `gajae-automation-${process.pid}.sock`);
  private bridge?: NetServer;
  private readonly bridgeConnections = new Set<Socket>();
  private readonly cuaSessionLabels = new Map<string, ComputerSession>();
  private bridgeStarting?: Promise<void>;
  private admission?: DesktopWorkAdmission;
  private readonly activityEpoch = randomUUID();
  private activityRevision = 0;
  private dispatching = 0;
  private closing = 0;

  constructor(admission?: DesktopWorkAdmission) {
    this.configureDesktopRestartAdmission(admission);
  }

  configureDesktopRestartAdmission(admission?: DesktopWorkAdmission): void {
    this.admission = admission;
    this.browser.configureDesktopRestartAdmission(admission);
    this.cua.configureDesktopRestartAdmission(admission);
    this.activityRevision++;
  }

  getGeneration(): string { return `${this.activityEpoch}:${this.activityRevision}`; }

  snapshotActivity(): DesktopOwnerActivity {
    const sessions = [...this.cuaSessionLabels.values()];
    const unknown = sessions.some((session) => session.uncertain) ? ['computer_session_unconfirmed'] : [];
    return {
      owner: 'automation', generation: this.getGeneration(), complete: unknown.length === 0,
      starting: Number(Boolean(this.bridgeStarting)) + sessions.filter((session) => session.starting).length,
      queued: 0, running: this.dispatching,
      settling: this.closing + sessions.filter((session) => session.ending).length,
      approvals: 0, retained: sessions.length, unknown,
    };
  }

  private enter(source: string): () => void {
    const release = this.admission?.enter(`automation.${source}`);
    this.dispatching++;
    this.activityRevision++;
    return () => {
      this.dispatching--;
      this.activityRevision++;
      release?.();
    };
  }

  async status() {
    const release = this.enter('status');
    try {
      const [browser, cua] = await Promise.all([
        this.supported
          ? this.browser.status().catch((error) => ({ state: 'error', installed: false, buildId: 'unknown', error: error instanceof Error ? error.message : String(error) }))
          : Promise.resolve({ state: 'idle', installed: false, buildId: 'unsupported' }),
        this.capabilities.computer
          ? this.cua.status()
          : Promise.resolve({ installed: false, daemon: 'unknown' as const }),
      ]);
      return {
        supported: this.supported,
        computerSupported: this.capabilities.computer,
        platform: process.platform,
        architecture: process.arch,
        browser,
        cua,
      };
    } finally { release(); }
  }

  subscribeBrowser(listener: BrowserEventListener): () => void {
    return this.browser.subscribe(listener);
  }

  async openBrowser(
    sessionId: string,
    payload: { url?: string; allowDownload?: boolean; waitUntil?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.requireSupported();
    const release = this.enter('browser.open');
    try { return await this.browser.open(sessionId, payload, signal); }
    finally { release(); }
  }

  async commandBrowser(sessionId: string, command: BrowserCommand, signal?: AbortSignal): Promise<unknown> {
    this.requireSupported();
    const release = this.enter('browser.command');
    try { return await this.browser.command(sessionId, command, signal); }
    finally { release(); }
  }

  async inputBrowser(sessionId: string, input: BrowserInput): Promise<unknown> {
    this.requireSupported();
    const release = this.enter('browser.input');
    try { return await this.browser.input(sessionId, input); }
    finally { release(); }
  }

  async stopSession(sessionId: string): Promise<unknown> {
    const release = this.enter('session.stop');
    try {
      this.grants.clearSession(sessionId);
      const signal = AbortSignal.timeout(2_500);
      const [browser] = await Promise.allSettled([
        this.browser.close(sessionId, signal),
        this.endComputerSession(sessionId, signal),
      ]);
      return browser.status === 'fulfilled' ? browser.value : { closed: false };
    } finally { release(); }
  }

  grant(grant: AutomationGrant): void {
    const release = this.enter('grant');
    try {
      const value = grant.kind === 'origin' ? automationOrigin(grant.value) : grant.value.trim();
      if (!value) throw new Error('A web origin is required for this grant.');
      this.grants.grant({ ...grant, value });
    } finally { release(); }
  }

  async authorizeBrowser(
    sessionId: string,
    payload: { url?: unknown; scope?: unknown },
    signal?: AbortSignal,
  ): Promise<{ granted: boolean; origin: string | null }> {
    this.requireSupported();
    const release = this.enter('browser.authorize');
    try {
      let rawUrl = typeof payload.url === 'string' ? payload.url : undefined;
      if (!rawUrl) {
        const state = await this.browser.state(sessionId, signal) as BrowserSessionState;
        rawUrl = state.tabs.find((tab) => tab.id === state.activeTabId)?.url;
      }
      if (!rawUrl) throw new Error('Open a browser tab before requesting browser access.');
      const origin = automationOrigin(rawUrl);
      if (!origin) return { granted: true, origin: null };
      if (payload.scope === 'session' || payload.scope === 'always') {
        this.grant({
          kind: 'origin',
          value: origin,
          scope: payload.scope,
          ...(payload.scope === 'session' ? { sessionId } : {}),
        });
      }
      return { granted: this.grants.has('origin', origin, sessionId), origin };
    } finally { release(); }
  }

  async authorizeComputer(
    sessionId: string,
    payload: { tool?: unknown; arguments?: unknown; scope?: unknown; application?: unknown },
    signal?: AbortSignal,
  ): Promise<CuaApplicationAuthorization> {
    this.requireComputerSupported();
    const release = this.enter('computer.authorize');
    try {
      if (!isCuaSafeTool(payload.tool)) throw new Error('Unsupported CUA Driver tool.');
      const args = object(payload.arguments);
      let application = typeof payload.application === 'string' ? payload.application.trim() : '';
      let label: string | null = null;

      if (!application && payload.tool === 'launch_app') {
        application = typeof args.bundle_id === 'string' ? args.bundle_id.trim() : '';
        label = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null;
      }

      let pid = requestedPid(args);
      const windowId = requestedWindowId(args);
      const sidecarPid = this.browser.browserPid;
      const needsApplication = payload.tool === 'launch_app'
      || pid !== undefined
      || windowId !== undefined
      || (payload.tool === 'list_windows' && args.pid !== undefined);
      if (!application && needsApplication && !(pid !== undefined && pid === sidecarPid)) {
        const inventory = await this.cua.call(
          pid === undefined && windowId !== undefined ? 'list_windows' : 'list_apps',
          {},
          signal,
        );
        if (pid === undefined && windowId !== undefined) {
          const window = windowRecords(inventory).find((candidate) => candidate.window_id === windowId);
          if (window && typeof window.pid === 'number' && Number.isSafeInteger(window.pid) && window.pid > 0) {
            pid = window.pid;
          }
        }
        let apps = applicationRecords(inventory);
        if (pid !== undefined && apps.length === 0) {
          apps = applicationRecords(await this.cua.call('list_apps', {}, signal));
        }
        const requestedName = typeof args.name === 'string' ? args.name.trim().toLocaleLowerCase() : '';
        const match = apps.find((app) => (
          (pid !== undefined && app.pid === pid)
        || (requestedName && typeof app.name === 'string' && app.name.trim().toLocaleLowerCase() === requestedName)
        ));
        if (match && typeof match.bundle_id === 'string') application = match.bundle_id.trim();
        if (match && typeof match.name === 'string' && match.name.trim()) label = match.name.trim();
      }

      if (!application && pid !== undefined && pid === sidecarPid) {
        application = WORKSPACE_BROWSER_APPLICATION_ID;
        label = WORKSPACE_BROWSER_LABEL;
      }

      if (!application) {
        if (COMPUTER_DISCOVERY_TOOLS.has(payload.tool) || (payload.tool === 'list_windows' && !needsApplication)) {
          return { granted: true, application: null, label: null };
        }
        throw new Error('Computer action requires a resolvable application identity.');
      }
      if (!label) label = application;
      if (payload.scope === 'session' || payload.scope === 'always') {
        this.grant({
          kind: 'application',
          value: application,
          scope: payload.scope,
          ...(payload.scope === 'session' ? { sessionId } : {}),
        });
      }
      return {
        granted: this.grants.has('application', application, sessionId),
        application,
        label,
      };
    } finally { release(); }
  }

  async callComputer(sessionId: string, tool: CuaSafeTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    this.requireComputerSupported();
    const release = this.enter('computer.call');
    try {
      const { session: _ignoredSession, ...scopedArgs } = args;
      if (tool === 'end_session') return await this.endComputerSession(sessionId, signal);
      const { label, result } = await this.ensureComputerSession(
        sessionId,
        tool === 'start_session' ? scopedArgs : {},
        signal,
      );
      if (tool === 'start_session') return result;
      return await this.cua.call(tool, { ...scopedArgs, session: label }, signal);
    } finally { release(); }
  }

  async startBridge(): Promise<void> {
    if (!this.supported) return;
    if (this.bridgeStarting) return this.bridgeStarting;
    if (this.bridge) return;
    const release = this.enter('bridge.start');
    this.bridgeStarting = (async () => {
      await mkdir(join(tmpdir()), { recursive: true });
      const bridge = net.createServer((socket) => {
        this.bridgeConnections.add(socket);
        this.activityRevision++;
        socket.once('close', () => {
          this.bridgeConnections.delete(socket);
          this.activityRevision++;
        });
        this.handleBridgeSocket(socket);
      });
      await new Promise<void>((resolve, reject) => {
        bridge.once('error', reject);
        bridge.listen(this.bridgePath, () => {
          bridge.off('error', reject);
          resolve();
        });
      });
      this.bridge = bridge;
      this.activityRevision++;
      if (process.platform !== 'win32') await chmod(this.bridgePath, 0o600);
      process.env.GJC_AUTOMATION_SOCKET = this.bridgePath;
      process.env.GJC_AUTOMATION_TOKEN = this.bridgeToken;
    })().finally(() => {
      this.bridgeStarting = undefined;
      release();
    });
    return this.bridgeStarting;
  }

  async shutdown(): Promise<void> {
    this.closing++;
    this.activityRevision++;
    try {
      if (this.bridgeStarting) await this.bridgeStarting.catch(() => {});
      const computerSessions = [...this.cuaSessionLabels.keys()];
      await Promise.allSettled([
        this.browser.shutdown(),
        ...computerSessions.map((sessionId) => this.endComputerSession(sessionId, AbortSignal.timeout(2_000))),
      ]);
      await this.cua.shutdown();
      const bridge = this.bridge;
      for (const socket of this.bridgeConnections) socket.destroy();
      // Node removes the Unix socket it bound when close completes. A service
      // that never bound must not unlink another server's configured socket.
      if (bridge) await new Promise<void>((resolve) => bridge.close(() => resolve()));
      this.bridge = undefined;
      this.activityRevision++;
      if (process.env.GJC_AUTOMATION_SOCKET === this.bridgePath && process.env.GJC_AUTOMATION_TOKEN === this.bridgeToken) {
        delete process.env.GJC_AUTOMATION_SOCKET;
        delete process.env.GJC_AUTOMATION_TOKEN;
      }
    } finally {
      this.closing--;
      this.activityRevision++;
    }
  }

  private newComputerSessionLabel(): string {
    return `gajae-${randomUUID()}`;
  }

  private async ensureComputerSession(
    sessionId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ label: string; result: unknown }> {
    let session = this.cuaSessionLabels.get(sessionId);
    if (session?.ending) {
      await session.ending;
      return this.ensureComputerSession(sessionId, args, signal);
    }
    if (session?.starting) return session.starting;
    const hadLabel = Boolean(session);
    if (!session) {
      session = { label: this.newComputerSessionLabel() };
      this.cuaSessionLabels.set(sessionId, session);
    }
    const owned = session;
    this.activityRevision++;
    owned.starting = (async () => {
      let result = await this.cua.call('start_session', { ...args, session: owned.label }, signal);
      let error = cuaToolError(result);
      if (error && hadLabel) {
        // Named sessions belong to one MCP transport lease. If cua-driver or the
        // app server restarted, rotate the private label instead of exposing a
        // dead public name to the coding agent. The client retains any uncertain
        // old transport-session owner independently in its original request.
        owned.label = this.newComputerSessionLabel();
        this.activityRevision++;
        result = await this.cua.call('start_session', { ...args, session: owned.label }, signal);
        error = cuaToolError(result);
      }
      if (error) {
        throw new Error(error);
      }
      owned.uncertain = false;
      return { label: owned.label, result };
    })().catch((error) => {
      owned.uncertain = true;
      throw error;
    }).finally(() => {
      owned.starting = undefined;
      this.activityRevision++;
    });
    return owned.starting;
  }

  private async endComputerSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    const session = this.cuaSessionLabels.get(sessionId);
    if (!session) return { ended: false };
    if (session.ending) return session.ending;
    this.activityRevision++;
    session.ending = (async () => {
      if (session.starting) await session.starting.catch(() => {});
      const result = await this.cua.call('end_session', { session: session.label }, signal);
      const error = cuaToolError(result);
      if (error) throw new Error(error);
      if (!result || typeof result !== 'object' || Array.isArray(result) || object(result).ok === false || object(result).ended === false) {
        throw new Error('CUA Driver did not acknowledge session closure.');
      }
      if (this.cuaSessionLabels.get(sessionId) === session) this.cuaSessionLabels.delete(sessionId);
      return result;
    })().catch((error) => {
      session.uncertain = true;
      throw error;
    }).finally(() => {
      session.ending = undefined;
      this.activityRevision++;
    });
    return session.ending;
  }

  private requireSupported(): void {
    if (!this.supported) throw new Error('Browser automation is available in the macOS arm64 and Linux x64 desktop apps.');
  }

  private requireComputerSupported(): void {
    this.requireSupported();
    if (!this.capabilities.computer) throw new Error('Native computer automation is not enabled on this platform.');
  }

  private handleBridgeSocket(socket: Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BRIDGE_LINE) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void this.handleBridgeLine(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
  }

  private async handleBridgeLine(socket: Socket, line: string): Promise<void> {
    let request: BridgeRequest | undefined;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    socket.once('close', abort);
    try {
      request = JSON.parse(line) as BridgeRequest;
      if (request.token !== this.bridgeToken || !safeBridgeId(request.id) || !safeBridgeId(request.sessionId)) {
        throw new Error('Unauthorized automation bridge request.');
      }
      // Unix sockets bypass the HTTP/WS ingress wrappers. This authenticated
      // handler owns dispatch until settlement, even after socket disconnect.
      release = this.enter('bridge.request');
      let result: unknown;
      if (request.surface === 'browser') {
        if (request.operation === 'open') result = await this.openBrowser(request.sessionId, object(request.payload), controller.signal);
        else if (request.operation === 'close') result = await this.stopSession(request.sessionId);
        else if (request.operation === 'authorize') result = await this.authorizeBrowser(request.sessionId, object(request.payload), controller.signal);
        else result = await this.commandBrowser(
          request.sessionId,
          object(request.payload?.command) as BrowserCommand,
          controller.signal,
        );
      } else if (request.surface === 'computer' && request.operation === 'authorize') {
        result = await this.authorizeComputer(request.sessionId, {
          tool: request.tool,
          arguments: request.arguments,
          ...object(request.payload),
        }, controller.signal);
      } else if (request.surface === 'computer' && isCuaSafeTool(request.tool)) {
        result = await this.callComputer(request.sessionId, request.tool, object(request.arguments), controller.signal);
      } else {
        throw new Error('Unsupported automation bridge request.');
      }
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({
        id: request && typeof request.id === 'string' ? request.id : 'invalid',
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 1_000) : 'Automation bridge request failed.',
      })}\n`);
    } finally {
      socket.off('close', abort);
      release?.();
    }
  }
}

export const automationService = new AutomationService();

/**
 * Parent composition injects the SAME server-owned admission into all owners.
 * Producer/owner map: docs/DESKTOP-UPDATE-ADMISSION.md (automation, browser, CUA).
 * Readers below never call status(), spawn, drain, cancel, or shutdown.
 */
export function configureDesktopRestartAdmission(admission?: DesktopWorkAdmission, service = automationService): void {
  service.configureDesktopRestartAdmission(admission);
}

export function createAutomationDesktopRestartReader(service = automationService) {
  return Object.freeze({ getGeneration: () => service.getGeneration(), read: () => service.snapshotActivity() });
}

export function createBrowserDesktopRestartReader(browser = automationService.browser) {
  return Object.freeze({ getGeneration: () => browser.getGeneration(), read: () => browser.snapshotActivity() });
}

export function createComputerDesktopRestartReader(service = automationService) {
  return Object.freeze({
    getGeneration: () => `${service.cua.getGeneration()}:${service.getGeneration()}`,
    read: (): DesktopOwnerActivity => {
      const activity = service.cua.snapshotActivity();
      const automation = service.snapshotActivity();
      const unknown = [...new Set([...activity.unknown, ...automation.unknown])];
      return {
        ...activity, generation: `${activity.generation}:${automation.generation}`,
        retained: activity.retained + automation.retained,
        complete: activity.complete && automation.complete, unknown,
      };
    },
  });
}
