#!/usr/bin/env bun
/// <reference lib="dom" />
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  Browser as BrowserBinary,
  BrowserTag,
  ChromeReleaseChannel,
  computeSystemExecutablePath,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  resolveBuildId,
} from '@puppeteer/browsers';
import puppeteer, {
  type Browser,
  type CDPSession,
  type KeyInput,
  type LaunchOptions,
  type Page,
  type Target,
} from 'puppeteer-core';
import { PUPPETEER_REVISIONS } from 'puppeteer-core/internal/revisions.js';
import { createEvaluationError, valueFromPrimitiveRemoteObject } from 'puppeteer-core/internal/cdp/utils.js';

import {
  DEFAULT_BROWSER_VIEWPORT,
  normalizeBrowserViewport,
  type BrowserViewportSize,
} from '../../../shared/browserViewport.js';

import {
  BROWSER_PROTOCOL_VERSION,
  BrowserNdjsonDecoder,
  safeSessionId,
  serializeBrowserFrame,
  type BrowserCommand,
  type BrowserChildActivity,
  type BrowserEventFrame,
  type BrowserInput,
  type BrowserRequestFrame,
  type BrowserResponseFrame,
  type BrowserSessionState,
  type BrowserTabState,
  type BrowserWaitUntil,
} from './browser-protocol.js';
import { normalizeAutomationUrl } from './automation-url.js';
import { BrowserRequestQueue } from './browser-runtime.js';

const PUPPETEER_KEY_NAMES = new Set([
  'Backspace', 'Tab', 'Enter', 'Escape', 'Shift', 'Control', 'Alt', 'Meta',
  'CapsLock', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'NumLock', 'ScrollLock',
  'Pause', 'PrintScreen', 'ContextMenu',
]);

export function toPuppeteerKeyInput(key: string, code?: string): string | null {
  void code;
  if (key === 'OS') return 'Meta';
  if (key === 'Scroll') return 'ScrollLock';
  if (key === 'Esc') return 'Escape';
  if (key === 'Del') return 'Delete';
  if (key === ' ') return 'Space';
  if (PUPPETEER_KEY_NAMES.has(key) || /^F(?:[1-9]|1[0-2])$/.test(key) || key.length === 1) return key;
  return null;
}

type Tab = {
  id: string;
  page: Page;
  loading: boolean;
  refs: Map<number, number>;
  cdp?: CDPSession;
  screencasting: boolean;
  screencastListenerAttached: boolean;
  viewport: BrowserViewportSize;
};

type Session = {
  id: string;
  tabs: Map<string, Tab>;
  activeTabId: string | null;
  subscribed: boolean;
  closeRequested: boolean;
  closing?: Promise<{ closed: boolean }>;
  tasks: Set<BackgroundTask>;
};

type BackgroundTask<T = unknown> = { promise: Promise<T>; uncertain: boolean };

type BrowserRuntimeOptions = {
  changed?: () => void;
  emit?: typeof emit;
  executablePath?: string;
  profilePath?: string;
  launch?: BrowserLaunchDependencies['launch'];
  processGroupExists?: (pid: number) => boolean;
};

type AxNode = {
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string | number | boolean };
};

const CACHE_ROOT = process.env.GAJAE_BROWSER_CACHE_DIR ?? join(homedir(), '.gajae-app', 'browser', 'chromium');
const PROFILE_ROOT = process.env.GAJAE_BROWSER_PROFILE_DIR ?? join(homedir(), '.gajae-app', 'browser', 'profile');
const MAX_RUN_CODE_BYTES = 64 * 1024;
const MAX_RESULT_TEXT = 256 * 1024;

/** Console-style page evaluation: preserve completion values and support top-level await. */
export async function evaluateBrowserScript(cdp: Pick<CDPSession, 'send'>, code: string): Promise<unknown> {
  const objectGroup = `gajae-browser-run-${randomUUID()}`;
  try {
    let response = await cdp.send('Runtime.evaluate', {
      expression: code,
      replMode: true,
      awaitPromise: true,
      returnByValue: false,
      objectGroup,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: false,
    });
    // Do not retry failed code in another wrapper: it may already have changed the page.
    if (response.exceptionDetails) throw createEvaluationError(response.exceptionDetails);
    if (response.result.objectId) {
      // REPL completion can itself be a Promise. Await the existing value,
      // rather than serializing it to {} or executing the source a second time.
      response = response.result.subtype === 'promise'
        ? await cdp.send('Runtime.awaitPromise', { promiseObjectId: response.result.objectId, returnByValue: true })
        : await cdp.send('Runtime.callFunctionOn', {
          objectId: response.result.objectId,
          functionDeclaration: 'function() { return this; }',
          returnByValue: true,
          awaitPromise: true,
          objectGroup,
        });
    }
    if (response.exceptionDetails) throw createEvaluationError(response.exceptionDetails);
    return valueFromPrimitiveRemoteObject(response.result);
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }
}

type AppBrowserLaunchOptions = Omit<LaunchOptions, 'executablePath' | 'channel'> & { userDataDir: string };
type BrowserLaunchDependencies = {
  platform?: NodeJS.Platform;
  explicitExecutable?: boolean;
  launch?: (options: LaunchOptions) => Promise<Browser>;
  systemExecutable?: () => string;
  onLaunchFailure?: () => void;
};

export async function launchBrowserWithLinuxFallback(
  executablePath: string,
  options: AppBrowserLaunchOptions,
  {
    platform = process.platform,
    explicitExecutable = Boolean(process.env.GAJAE_BROWSER_EXECUTABLE_PATH),
    launch = launchOptions => puppeteer.launch(launchOptions),
    systemExecutable = () => computeSystemExecutablePath({ browser: BrowserBinary.CHROME, channel: ChromeReleaseChannel.STABLE }),
    onLaunchFailure,
  }: BrowserLaunchDependencies = {},
): Promise<Browser> {
  try {
    return await launch({ ...options, executablePath });
  } catch (error) {
    onLaunchFailure?.();
    const message = error instanceof Error ? error.message : String(error);
    const sandboxFailure = /No usable sandbox!|SUID sandbox helper binary[^\n]*not configured correctly|Failed to move to new namespace[^\n]*Operation not permitted/i.test(message);
    if (platform !== 'linux' || explicitExecutable || !sandboxFailure) throw error;
    let fallback: string;
    try { fallback = systemExecutable(); }
    catch { throw error; }
    if (fallback === executablePath) throw error;
    // Use Puppeteer's known installed stable Chrome path, never a PATH search.
    // Retry with the same app profile and sandbox options; no personal profile
    // is opened and no sandbox-disabling flag is added.
    process.stderr.write('[Browser] Managed Chromium sandbox unavailable; trying installed stable Chrome with the app profile.\n');
    try { return await launch({ ...options, executablePath: fallback }); }
    catch (fallbackError) {
      onLaunchFailure?.();
      throw new Error(`Installed Chrome fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`, { cause: error });
    }
  }
}

function writeFrame(frame: BrowserResponseFrame | BrowserEventFrame): void {
  process.stdout.write(serializeBrowserFrame(frame));
}

function emit(method: BrowserEventFrame['method'], payload: Record<string, unknown>, sessionId?: string): void {
  writeFrame({
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    kind: 'event',
    method,
    ...(sessionId ? { sessionId } : {}),
    payload,
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sanitizeError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const code = /^([a-z0-9_]+):/i.exec(raw)?.[1] ?? 'browser_error';
  const message = raw.replace(/^[a-z0-9_]+:\s*/i, '').slice(0, 1_000) || 'Browser operation failed.';
  return { code, message };
}

function waitUntil(value: unknown): BrowserWaitUntil {
  return value === 'load' || value === 'networkidle0' || value === 'networkidle2'
    ? value
    : 'domcontentloaded';
}

export class BrowserRuntime {
  private browser?: Browser;
  private browserCdp?: CDPSession;
  private launchState: 'idle' | 'starting' | 'ready' | 'error' = 'idle';
  private launchError?: string;
  private launchPromise?: Promise<Browser>;
  private buildId: string = PUPPETEER_REVISIONS.chrome;
  private readonly sessions = new Map<string, Session>();
  private readonly ownerByTarget = new WeakMap<Target, Session>();
  private readonly ownerByFrameId = new Map<string, { sessionId: string; tabId: string }>();
  private readonly background = new Set<BackgroundTask>();
  private browserProcess?: ChildProcess;
  private browserExit?: Promise<void>;
  private browserExited = true;
  private closingBrowser?: Promise<void>;
  private launchUnconfirmed = false;
  private downloadUnconfirmed = false;
  private processTreeUnobservable = false;
  private browserUnconfirmed = false;

  constructor(private readonly options: BrowserRuntimeOptions = {}) {}

  private changed(): void { this.options.changed?.(); }
  private emit: typeof emit = (...args) => (this.options.emit ?? emit)(...args);

  /** No CDP requests, lazy launch, timers, cleanup, or health reset. */
  snapshotActivity() {
    const unknown: string[] = [];
    if (this.launchUnconfirmed) unknown.push('browser_launch_unconfirmed');
    if (this.downloadUnconfirmed) unknown.push('browser_download_unconfirmed');
    if (this.processTreeUnobservable) unknown.push('browser_process_tree_unobservable');
    if (this.browserUnconfirmed) unknown.push('browser_operation_unconfirmed');
    if ([...this.background].some((task) => task.uncertain)) unknown.push('browser_callback_unconfirmed');
    return {
      starting: Number(Boolean(this.launchPromise)), callbacks: this.background.size,
      settling: Number(Boolean(this.closingBrowser)) + [...this.sessions.values()].filter((session) => session.closing).length,
      retained: this.sessions.size, browserAlive: !this.browserExited, unknown,
    };
  }

  private track<T>(session: Session | undefined, action: () => Promise<T>, uncertainOnFailure = false): BackgroundTask<T> {
    const task: BackgroundTask<T> = { promise: Promise.resolve().then(action), uncertain: false };
    this.background.add(task);
    session?.tasks.add(task);
    task.promise = task.promise.catch((error) => {
      // A local CDP failure is not proof that remote execution stopped. Only a
      // confirmed process exit clears this generation's remaining uncertainty.
      if (uncertainOnFailure && !this.browserExited) this.browserUnconfirmed = true;
      throw error;
    }).finally(() => {
      this.background.delete(task);
      session?.tasks.delete(task);
      this.changed();
    });
    // Detached callbacks still have an owner even when no caller awaits them.
    void task.promise.catch(() => {});
    this.changed();
    return task;
  }

  private async drain(session: Session): Promise<void> {
    while (session.tasks.size) await Promise.allSettled([...session.tasks].map((task) => task.promise));
  }

  private requireOpen(session: Session): void {
    if (session.closeRequested || this.sessions.get(session.id) !== session) {
      throw new Error('session_closing: Browser session is closing.');
    }
  }

  private processGroupExists(pid: number): boolean {
    if (this.options.processGroupExists) return this.options.processGroupExists(pid);
    if (process.platform === 'win32') return false; // Browser product support is macOS/Linux.
    try { process.kill(-pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }

  async status(): Promise<Record<string, unknown>> {
    const installed = await this.installedBrowser();
    return {
      state: this.launchState,
      installed: Boolean(installed),
      buildId: this.buildId,
      ...(this.launchError ? { error: this.launchError } : {}),
    };
  }

  async open(sessionId: string, payload: Record<string, unknown>): Promise<BrowserSessionState> {
    const session = this.session(sessionId);
    return this.track(session, async () => {
      this.requireOpen(session);
      const browser = await this.ensureBrowser(payload.allowDownload === true, sessionId);
      this.requireOpen(session);
      let tab = session.activeTabId ? session.tabs.get(session.activeTabId) : undefined;
      if (!tab || tab.page.isClosed()) {
        const page = await browser.newPage();
        tab = await this.registerPage(session, page);
      }
      const url = typeof payload.url === 'string' ? normalizeAutomationUrl(payload.url) : undefined;
      if (url && tab.page.url() !== url) {
        tab.loading = true;
        this.emitState(session);
        await tab.page.goto(url, { waitUntil: waitUntil(payload.waitUntil), timeout: 30_000 });
      }
      session.activeTabId = tab.id;
      if (session.subscribed) await this.ensureScreencast(session);
      return this.state(session);
    }).promise;
  }

  async close(sessionId: string): Promise<{ closed: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { closed: false };
    if (session.closing) return session.closing;
    session.closeRequested = true;
    session.subscribed = false;
    session.closing = (async () => {
      const closed = await Promise.allSettled([...session.tabs.values()].map(async (tab) => {
        tab.screencasting = false;
        if (!tab.page.isClosed()) await tab.page.close();
      }));
      if ([...this.sessions.values()].every((owner) => owner.closeRequested)) {
        if (this.launchPromise) await this.launchPromise.catch(() => {});
        // Recheck after launch: a different session may have arrived meanwhile.
        if ([...this.sessions.values()].every((owner) => owner.closeRequested)) await this.closeBrowser();
      }
      if (!this.browserExited) {
        const failure = closed.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      }
      // Do not wait for an unresolved evaluation before closing its browser.
      // Actual target/process closure settles CDP and callback tails, not the
      // caller's deadline. Page creation already in flight remains owned here.
      await this.drain(session);
      if ([...session.tabs.values()].some((tab) => !tab.page.isClosed())) {
        throw new Error('browser_close_unconfirmed: A session page is still live.');
      }
      this.sessions.delete(sessionId);
      this.emit('state', { sessionId, activeTabId: null, tabs: [] }, sessionId);
      return { closed: true };
    })().catch((error) => {
      if (!this.browserExited) this.browserUnconfirmed = true;
      throw error;
    }).finally(() => {
      session.closing = undefined;
      this.changed();
    });
    this.changed();
    return session.closing;
  }

  stateFor(sessionId: string): BrowserSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('session_not_found: Open the browser session first.');
    return this.state(session);
  }

  async subscribe(sessionId: string): Promise<BrowserSessionState> {
    const session = this.session(sessionId);
    session.subscribed = true;
    this.changed();
    return this.track(session, async () => {
      await this.ensureScreencast(session);
      return this.state(session);
    }).promise;
  }

  async unsubscribe(sessionId: string): Promise<{ subscribed: false }> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscribed = false;
      this.changed();
      await this.track(session, () => this.ensureScreencast(session)).promise;
    }
    return { subscribed: false };
  }

  async command(sessionId: string, command: BrowserCommand): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('session_not_found: Open the browser session first.');
    this.requireOpen(session);
    return this.track(session, async () => {
      this.requireOpen(session);
      if (command.action === 'selectTab') {
        if (!session.tabs.has(command.tabId)) throw new Error('tab_not_found: Browser tab was not found.');
        session.activeTabId = command.tabId;
        await this.ensureScreencast(session);
        this.emitState(session);
        return this.state(session);
      }
      if (command.action === 'newTab') {
        const browser = await this.ensureBrowser(false, sessionId);
        this.requireOpen(session);
        const page = await browser.newPage();
        const created = await this.registerPage(session, page);
        if (command.url) {
          await page.goto(normalizeAutomationUrl(command.url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        }
        session.activeTabId = created.id;
        await this.ensureScreencast(session);
        this.emitState(session);
        return this.state(session);
      }
      if (command.action === 'closeTab') {
        const closing = command.tabId ? session.tabs.get(command.tabId) : this.activeTab(session);
        if (!closing) throw new Error('tab_not_found: Browser tab was not found.');
        await this.stopScreencast(closing);
        if (!closing.page.isClosed()) await closing.page.close();
        await this.ensureScreencast(session);
        this.emitState(session);
        return this.state(session);
      }
      const tab = this.activeTab(session);
      const page = tab.page;

      switch (command.action) {
        case 'navigate':
          tab.loading = true;
          this.emitState(session);
          await page.goto(normalizeAutomationUrl(command.url), { waitUntil: waitUntil(command.waitUntil), timeout: 30_000 });
          break;
        case 'back':
          tab.loading = true;
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 });
          break;
        case 'forward':
          tab.loading = true;
          await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30_000 });
          break;
        case 'reload':
          tab.loading = true;
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
          break;
        case 'click':
          await this.click(tab, command);
          break;
        case 'type':
          await this.focus(tab, command);
          await page.keyboard.type(command.text);
          break;
        case 'fill':
          await this.focus(tab, command);
          await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
          await page.keyboard.press('A');
          await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
          await page.keyboard.type(command.text);
          break;
        case 'select':
          if (command.selector) await page.select(command.selector, ...command.values);
          else await this.callOnRef(tab, command.ref, `function(...values) {
          const options = Array.from(this.options || []);
          for (const option of options) option.selected = values.includes(option.value);
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return Array.from(this.selectedOptions || []).map(option => option.value);
        }`, command.values);
          break;
        case 'press':
          await page.keyboard.press(command.key as KeyInput);
          break;
        case 'scroll':
          await page.mouse.wheel({ deltaX: command.dx ?? 0, deltaY: command.dy ?? 600 });
          break;
        case 'wait':
          if (command.selector) await page.waitForSelector(command.selector, { timeout: command.ms ?? 10_000 });
          else if (command.text) await page.waitForFunction((text) => document.body?.innerText.includes(text), { timeout: command.ms ?? 10_000 }, command.text);
          else await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(command.ms ?? 500, 0), 30_000)));
          break;
        case 'observe':
          return this.observe(tab, command.includeAll === true);
        case 'extract': {
          const format = command.format ?? 'text';
          const result = await page.evaluate(({ selector, format }) => {
            const element = selector ? document.querySelector(selector) : document.body;
            if (!element) return null;
            return format === 'html' ? element.outerHTML : (element.textContent ?? '');
          }, { selector: command.selector, format });
          return { value: typeof result === 'string' ? result.slice(0, MAX_RESULT_TEXT) : result };
        }
        case 'screenshot': {
          const data = await page.screenshot({ type: 'jpeg', quality: 75, encoding: 'base64' });
          return { mimeType: 'image/jpeg', data };
        }
        case 'run': {
          if (Buffer.byteLength(command.code) > MAX_RUN_CODE_BYTES) throw new Error('run_too_large: Browser script is too large.');
          const timeoutMs = Math.min(Math.max(command.timeoutMs ?? 30_000, 1), 300_000);
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const evaluation = this.track(session, () => this.cdp(tab).then((cdp) => evaluateBrowserScript(cdp, command.code)), true);
          const value = await Promise.race([
            evaluation.promise,
            new Promise((_, reject) => {
              timeout = setTimeout(() => {
                evaluation.uncertain = true;
                this.changed();
                reject(new Error('run_timeout: Browser script timed out.'));
              }, timeoutMs);
            }),
          ]).finally(() => {
            if (timeout) clearTimeout(timeout);
          });
          const serialized = JSON.stringify(value);
          return { value: serialized && serialized.length > MAX_RESULT_TEXT ? `${serialized.slice(0, MAX_RESULT_TEXT)}…` : value };
        }
      }

      this.emitState(session);
      return this.state(session);
    }).promise;
  }

  async input(sessionId: string, input: BrowserInput): Promise<{ accepted: true }> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('session_not_found: Open the browser session first.');
    this.requireOpen(session);
    return this.track(session, async () => {
      this.requireOpen(session);
      const tab = this.activeTab(session);
      const cdp = await this.cdp(tab);
      if (input.kind === 'viewport') {
        const viewport = normalizeBrowserViewport(input.width, input.height);
        if (!viewport) throw new Error('invalid_viewport: Browser viewport dimensions must be positive finite numbers.');
        if (viewport.width !== tab.viewport.width || viewport.height !== tab.viewport.height) {
          const resumeScreencast = tab.screencasting && session.subscribed && session.activeTabId === tab.id;
          if (resumeScreencast) await this.stopScreencast(tab);
          tab.viewport = viewport;
          await tab.page.setViewport({ ...viewport, deviceScaleFactor: 1 });
          if (resumeScreencast) await this.startScreencast(session, tab);
        }
      } else if (input.kind === 'mouse') {
        await cdp.send('Input.dispatchMouseEvent', {
          type: input.event === 'move' ? 'mouseMoved' : input.event === 'down' ? 'mousePressed' : 'mouseReleased',
          x: input.x,
          y: input.y,
          button: input.button ?? 'left',
          clickCount: input.clickCount ?? 1,
        });
      } else if (input.kind === 'wheel') {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY,
        });
      } else if (input.kind === 'text') {
        await cdp.send('Input.insertText', { text: input.text });
      } else {
        const keyInput = toPuppeteerKeyInput(input.key, input.code);
        if (keyInput) {
          if (input.event === 'down') await tab.page.keyboard.down(keyInput as KeyInput);
          else await tab.page.keyboard.up(keyInput as KeyInput);
        } else {
          await cdp.send('Input.dispatchKeyEvent', {
            type: input.event === 'down' ? 'keyDown' : 'keyUp',
            key: input.key,
            code: input.code ?? input.key,
            modifiers: input.modifiers ?? 0,
          });
        }
      }
      return { accepted: true as const };
    }).promise;
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.close(id);
    if (this.launchPromise) await this.launchPromise.catch(() => {});
    await this.closeBrowser();
    while (this.background.size) await Promise.allSettled([...this.background].map((task) => task.promise));
  }

  private session(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = { id, tabs: new Map(), activeTabId: null, subscribed: false, closeRequested: false, tasks: new Set() };
      this.sessions.set(id, session);
      this.changed();
    }
    this.requireOpen(session);
    return session;
  }

  private activeTab(session: Session): Tab {
    const tab = session.activeTabId ? session.tabs.get(session.activeTabId) : undefined;
    if (!tab || tab.page.isClosed()) throw new Error('tab_not_found: Browser tab was not found.');
    return tab;
  }

  private async installedBrowser() {
    const override = this.options.executablePath ?? process.env.GAJAE_BROWSER_EXECUTABLE_PATH;
    if (override && existsSync(override)) {
      return { browser: BrowserBinary.CHROME, buildId: 'system-override', executablePath: override };
    }
    const installed = await getInstalledBrowsers({ cacheDir: CACHE_ROOT });
    return installed.find((item) => item.browser === BrowserBinary.CHROME && item.buildId === this.buildId)
      ?? installed.filter((item) => item.browser === BrowserBinary.CHROME).at(-1);
  }

  private async ensureBrowser(allowDownload: boolean, sessionId?: string): Promise<Browser> {
    if (this.closingBrowser) await this.closingBrowser;
    if (this.launchPromise) return this.launchPromise;
    if (!this.browserExited && !this.browser?.connected) throw new Error('browser_close_unconfirmed: Prior Chromium process has not exited.');
    if (this.browser?.connected) return this.browser;
    this.launchState = 'starting';
    this.launchError = undefined;
    this.launchPromise = (async () => {
      const platform = detectBrowserPlatform();
      if (!platform) throw new Error('unsupported_platform: Chromium is unavailable on this platform.');
      let installed = await this.installedBrowser();
      if (!installed) {
        if (!allowDownload) throw new Error('browser_download_required: Chromium must be downloaded before first use.');
        this.buildId = await resolveBuildId(BrowserBinary.CHROME, platform, BrowserTag.STABLE).catch(() => {
          this.downloadUnconfirmed = true;
          return PUPPETEER_REVISIONS.chrome;
        });
        this.emit('download.progress', { phase: 'starting', buildId: this.buildId }, sessionId);
        installed = await install({
          browser: BrowserBinary.CHROME,
          buildId: this.buildId,
          cacheDir: CACHE_ROOT,
          platform,
          downloadProgressCallback: (downloadedBytes, totalBytes) => {
            this.changed();
            this.emit('download.progress', { phase: 'downloading', downloadedBytes, totalBytes, buildId: String(PUPPETEER_REVISIONS.chrome) }, sessionId);
          },
        }).catch((error) => {
          // @puppeteer/browsers rejects downloads on stream error before close;
          // it exposes no stream/FD owner with which to certify failed cleanup.
          this.downloadUnconfirmed = true;
          throw error;
        });
        this.emit('download.progress', { phase: 'complete', buildId: this.buildId }, sessionId);
      }
      const profilePath = this.options.profilePath ?? PROFILE_ROOT;
      await mkdir(profilePath, { recursive: true });
      if (!existsSync(installed.executablePath)) throw new Error('browser_missing: Chromium executable was not found.');
      let browser: Browser;
      try {
        browser = await launchBrowserWithLinuxFallback(installed.executablePath, {
          userDataDir: profilePath,
          headless: true,
          defaultViewport: { ...DEFAULT_BROWSER_VIEWPORT, deviceScaleFactor: 1 },
          downloadBehavior: { policy: 'deny' },
          args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'],
        }, {
          launch: this.options.launch,
          onLaunchFailure: () => { this.launchUnconfirmed = true; this.changed(); },
        });
      } catch (error) {
        // The launcher does not expose a process on failure. A replacement
        // launch cannot prove that hidden generation was reaped.
        this.launchUnconfirmed = true;
        throw error;
      }
      this.browser = browser;
      this.browserProcess = browser.process() ?? undefined;
      this.browserExited = false;
      if (process.platform === 'win32' && !this.options.processGroupExists) this.processTreeUnobservable = true;
      const browserProcess = this.browserProcess;
      if (!browserProcess || !browserProcess.pid) {
        this.launchUnconfirmed = true;
        throw new Error('browser_process_unavailable: Chromium process ownership is unavailable.');
      }
      this.browserExit = new Promise<void>((resolve) => {
        browserProcess.once('close', () => {
          this.track(undefined, async () => {
            // Leader exit alone is insufficient if a renderer/helper is still
            // in the owned group. Probe only; never kill to make proof succeed.
            while (this.processGroupExists(browserProcess.pid!)) {
              this.browserUnconfirmed = true;
              this.changed();
              await new Promise<void>((done) => setTimeout(done, 25));
            }
            if (this.browserProcess === browserProcess) {
              this.browserExited = true;
              this.browserUnconfirmed = false;
              this.browser = undefined;
              this.browserCdp = undefined;
              this.launchState = 'idle';
              this.ownerByFrameId.clear();
              this.emit('async', { type: 'browser.process', pid: null });
              this.changed();
            }
            resolve();
          }).promise.catch(() => {});
        });
      });
      this.emit('async', { type: 'browser.process', pid: browserProcess.pid });
      this.changed();
      browser.on('targetcreated', (target) => {
        if (this.browserProcess !== browserProcess || this.browserExited) return;
        this.track(undefined, () => this.onTargetCreated(target), true);
      });
      browser.on('disconnected', () => {
        if (this.browserProcess !== browserProcess) return;
        if (!this.browserExited) this.browserUnconfirmed = true;
        this.changed();
        for (const session of this.sessions.values()) this.emitState(session);
      });
      const browserCdp = await browser.target().createCDPSession();
      await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
      browserCdp.on('Browser.downloadWillBegin', (event) => {
        const owner = this.ownerByFrameId.get(event.frameId);
        if (!owner) return;
        this.emit('async', {
          type: 'download.attempt',
          tabId: owner.tabId,
          url: event.url,
          suggestedFilename: event.suggestedFilename,
        }, owner.sessionId);
      });
      this.browserCdp = browserCdp;
      this.launchState = 'ready';
      return browser;
    })().catch((error) => {
      this.launchState = 'error';
      this.launchError = sanitizeError(error).message;
      throw error;
    }).finally(() => {
      this.launchPromise = undefined;
      this.changed();
    });
    this.changed();
    return this.launchPromise;
  }

  private async closeBrowser(): Promise<void> {
    if (this.closingBrowser) return this.closingBrowser;
    if (this.browserExited) return;
    const browser = this.browser;
    const exited = this.browserExit;
    if (!browser || !exited) throw new Error('browser_close_unconfirmed: Chromium closure cannot be observed.');
    this.closingBrowser = (async () => {
      // Only an explicit last-session close/shutdown enters here. Do not call
      // Puppeteer's browser.close(): its launcher has a force-kill fallback.
      // Preserve the persistent profile, close gracefully, and await real exit.
      try {
        const cdp = this.browserCdp ?? await browser.target().createCDPSession();
        await cdp.send('Browser.close');
      } catch {
        if (!this.browserExited) this.browserUnconfirmed = true;
        this.changed();
      }
      await exited;
    })().finally(() => {
      this.closingBrowser = undefined;
      this.changed();
    });
    this.changed();
    return this.closingBrowser;
  }

  private async onTargetCreated(target: Target): Promise<void> {
    const opener = target.opener();
    const session = opener ? this.ownerByTarget.get(opener) : undefined;
    if (!session || target.type() !== 'page') return;
    await this.track(session, async () => {
      const page = await target.page();
      if (!page) return;
      const tab = await this.registerPage(session, page);
      session.activeTabId = tab.id;
      this.emit('async', { type: 'popup', tabId: tab.id, url: page.url() }, session.id);
      if (session.subscribed) await this.ensureScreencast(session);
    }, true).promise;
  }

  private async registerPage(session: Session, page: Page): Promise<Tab> {
    if (session.closeRequested || this.sessions.get(session.id) !== session) {
      // This page was created by already-owned work concurrent with user close.
      if (!page.isClosed()) await page.close();
      throw new Error('session_closing: Browser session is closing.');
    }
    const existing = [...session.tabs.values()].find((tab) => tab.page === page);
    if (existing) return existing;
    const tab: Tab = {
      id: `tab-${randomUUID()}`,
      page,
      loading: false,
      refs: new Map(),
      screencasting: false,
      screencastListenerAttached: false,
      viewport: DEFAULT_BROWSER_VIEWPORT,
    };
    session.tabs.set(tab.id, tab);
    session.activeTabId = tab.id;
    this.ownerByTarget.set(page.target(), session);
    this.changed();
    await page.setViewport({ ...DEFAULT_BROWSER_VIEWPORT, deviceScaleFactor: 1 });
    const cdp = await this.cdp(tab);
    const rememberMainFrame = (frameId: string) => {
      this.ownerByFrameId.set(frameId, { sessionId: session.id, tabId: tab.id });
    };
    const frameTree = await cdp.send('Page.getFrameTree');
    rememberMainFrame(frameTree.frameTree.frame.id);
    cdp.on('Page.frameNavigated', (event) => {
      if (!event.frame.parentId) rememberMainFrame(event.frame.id);
    });
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        tab.loading = true;
        this.emitState(session);
      }
    });
    const settle = () => { tab.loading = false; this.emitState(session); };
    page.on('domcontentloaded', settle);
    page.on('load', settle);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        tab.refs.clear();
        this.emit('async', { type: 'navigation', tabId: tab.id, url: frame.url() }, session.id);
        this.emitState(session);
      }
    });
    page.on('dialog', (dialog) => {
      if (tab.page.isClosed() || this.browserExited) return;
      this.emit('async', {
        type: 'dialog',
        dialogType: dialog.type(),
        message: dialog.message(),
        disposition: 'dismissed',
      }, session.id);
      this.track(session, () => dialog.dismiss(), true);
    });
    page.on('close', () => {
      for (const [frameId, owner] of this.ownerByFrameId) {
        if (owner.sessionId === session.id && owner.tabId === tab.id) this.ownerByFrameId.delete(frameId);
      }
      session.tabs.delete(tab.id);
      this.changed();
      if (session.activeTabId === tab.id) session.activeTabId = session.tabs.keys().next().value ?? null;
      this.emit('async', { type: 'tab.closed', tabId: tab.id }, session.id);
      this.emitState(session);
    });
    this.emitState(session);
    return tab;
  }

  private async history(tab: Tab): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
    try {
      const cdp = await this.cdp(tab);
      const history = await cdp.send('Page.getNavigationHistory') as { currentIndex: number; entries: unknown[] };
      return { canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1 };
    } catch {
      return { canGoBack: false, canGoForward: false };
    }
  }

  private state(session: Session): BrowserSessionState {
    return {
      sessionId: session.id,
      activeTabId: session.activeTabId,
      tabs: [...session.tabs.values()].map((tab): BrowserTabState => ({
        id: tab.id,
        title: '',
        url: tab.page.url(),
        loading: tab.loading,
        canGoBack: false,
        canGoForward: false,
      })),
    };
  }

  private emitState(session: Session): void {
    if (this.browserExited || session.closeRequested || this.sessions.get(session.id) !== session) return;
    this.track(session, () => Promise.allSettled([...session.tabs.values()].map(async (tab): Promise<BrowserTabState> => {
      const [title, history] = await Promise.all([tab.page.title().catch(() => ''), this.history(tab)]);
      return { id: tab.id, title, url: tab.page.url(), loading: tab.loading, ...history };
    })).then((results) => {
      if (!session.closeRequested && this.sessions.get(session.id) === session) {
        const tabs = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
        this.emit('state', { sessionId: session.id, activeTabId: session.activeTabId, tabs }, session.id);
      }
    }));
  }

  private async cdp(tab: Tab): Promise<CDPSession> {
    if (!tab.cdp) tab.cdp = await tab.page.createCDPSession();
    return tab.cdp;
  }

  private async ensureScreencast(session: Session): Promise<void> {
    const active = session.activeTabId;
    const results = await Promise.allSettled([...session.tabs.values()].map(async (tab) => {
      if (tab.id === active && session.subscribed) await this.startScreencast(session, tab);
      else await this.stopScreencast(tab);
    }));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  private async startScreencast(session: Session, tab: Tab): Promise<void> {
    if (tab.screencasting || tab.page.isClosed()) return;
    const cdp = await this.cdp(tab);
    tab.screencasting = true;
    if (!tab.screencastListenerAttached) {
      tab.screencastListenerAttached = true;
      cdp.on('Page.screencastFrame', (event) => {
        if (tab.page.isClosed() || this.browserExited) return;
        this.track(session, () => cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }));
        if (!tab.screencasting || session.activeTabId !== tab.id || !session.subscribed) return;
        this.emit('frame', {
          tabId: tab.id,
          mimeType: 'image/jpeg',
          data: event.data,
          metadata: event.metadata as unknown as Record<string, unknown>,
        }, session.id);
      });
    }
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 70, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1,
    });
  }

  private async stopScreencast(tab: Tab): Promise<void> {
    if (!tab.screencasting) return;
    tab.screencasting = false;
    try { await tab.cdp?.send('Page.stopScreencast'); }
    catch (error) {
      if (!tab.page.isClosed() && !this.browserExited) {
        this.browserUnconfirmed = true;
        this.changed();
        throw error;
      }
    }
  }

  private async observe(tab: Tab, includeAll: boolean): Promise<Record<string, unknown>> {
    const cdp = await this.cdp(tab);
    const response = await cdp.send('Accessibility.getFullAXTree') as { nodes?: AxNode[] };
    tab.refs.clear();
    const entries: Array<{ ref: number; role: string; name: string; value?: string }> = [];
    for (const node of response.nodes ?? []) {
      if (node.ignored || typeof node.backendDOMNodeId !== 'number') continue;
      const role = String(node.role?.value ?? '');
      const name = String(node.name?.value ?? '').trim();
      if (!includeAll && !name && !/button|link|textbox|checkbox|radio|combobox|menuitem|tab/i.test(role)) continue;
      const ref = entries.length + 1;
      tab.refs.set(ref, node.backendDOMNodeId);
      entries.push({
        ref,
        role,
        name,
        ...(node.value?.value !== undefined ? { value: String(node.value.value) } : {}),
      });
      if (entries.length >= (includeAll ? 500 : 200)) break;
    }
    return { url: tab.page.url(), title: await tab.page.title(), entries };
  }

  private backendNode(tab: Tab, ref: number | undefined): number {
    if (typeof ref !== 'number') throw new Error('target_required: Provide a ref, selector, or coordinates.');
    const backendNodeId = tab.refs.get(ref);
    if (!backendNodeId) throw new Error('stale_ref: Observe the page again before using this ref.');
    return backendNodeId;
  }

  private async click(tab: Tab, command: Extract<BrowserCommand, { action: 'click' }>): Promise<void> {
    if (command.selector) {
      await tab.page.click(command.selector);
      return;
    }
    if (typeof command.x === 'number' && typeof command.y === 'number') {
      await tab.page.mouse.click(command.x, command.y);
      return;
    }
    const cdp = await this.cdp(tab);
    const box = await cdp.send('DOM.getBoxModel', { backendNodeId: this.backendNode(tab, command.ref) }) as { model?: { content?: number[]; border?: number[] } };
    const quad = box.model?.content ?? box.model?.border;
    if (!quad || quad.length < 8) throw new Error('element_not_visible: The referenced element has no clickable box.');
    const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
    const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
    await tab.page.mouse.click(xs.reduce((a, b) => a + b, 0) / 4, ys.reduce((a, b) => a + b, 0) / 4);
  }

  private async focus(tab: Tab, target: { ref?: number; selector?: string }): Promise<void> {
    if (target.selector) {
      await tab.page.focus(target.selector);
      return;
    }
    await this.callOnRef(tab, target.ref, 'function() { this.focus(); return true; }', []);
  }

  private async callOnRef(tab: Tab, ref: number | undefined, functionDeclaration: string, args: unknown[]): Promise<unknown> {
    const cdp = await this.cdp(tab);
    const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: this.backendNode(tab, ref) }) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error('element_unavailable: The referenced element is unavailable.');
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails) throw new Error('element_action_failed: The element action failed.');
    return result.result?.value;
  }
}

const childEpoch = randomUUID();
let activityRevision = 0;
const runtime = new BrowserRuntime({ changed: publishActivity });
const decoder = new BrowserNdjsonDecoder();
const requests = new BrowserRequestQueue(handle, publishActivity, reportQueueError);

function publishActivity(): void {
  const activity: BrowserChildActivity = {
    version: 1, epoch: childEpoch, revision: ++activityRevision,
    ...requests.snapshot(), ...runtime.snapshotActivity(),
  };
  emit('async', { type: 'browser.runtime.activity', activity });
}

async function handle(frame: BrowserRequestFrame): Promise<void> {
  let result: unknown;
  try {
    if (frame.method !== 'initialize' && frame.method !== 'status' && frame.method !== 'shutdown' && !safeSessionId(frame.sessionId)) {
      throw new Error('invalid_session: A valid browser session id is required.');
    }
    switch (frame.method) {
      case 'initialize':
        result = { ready: true, protocolVersion: BROWSER_PROTOCOL_VERSION, activityProtocol: 1, activityEpoch: childEpoch };
        break;
      case 'status':
        result = await runtime.status();
        break;
      case 'session.open':
        result = await runtime.open(frame.sessionId!, frame.payload);
        break;
      case 'session.state':
        result = runtime.stateFor(frame.sessionId!);
        break;
      case 'session.close':
        result = await runtime.close(frame.sessionId!);
        break;
      case 'browser.command':
        result = await runtime.command(frame.sessionId!, object(frame.payload.command) as BrowserCommand);
        break;
      case 'browser.input':
        result = await runtime.input(frame.sessionId!, object(frame.payload.input) as BrowserInput);
        break;
      case 'screencast.subscribe':
        result = await runtime.subscribe(frame.sessionId!);
        break;
      case 'screencast.unsubscribe':
        result = await runtime.unsubscribe(frame.sessionId!);
        break;
      case 'shutdown':
        await runtime.shutdown();
        result = { shutdown: true };
        break;
    }
    writeFrame({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: 'response',
      id: frame.id,
      method: frame.method,
      ...('sessionId' in frame ? { sessionId: frame.sessionId } : {}),
      ok: true,
      result,
    });
    if (frame.method === 'shutdown') process.exit(0);
  } catch (error) {
    writeFrame({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      kind: 'response',
      id: frame.id,
      method: frame.method,
      ...('sessionId' in frame ? { sessionId: frame.sessionId } : {}),
      ok: false,
      error: sanitizeError(error),
    });
  }
}

function reportQueueError(error: unknown): void {
  process.stderr.write(`${sanitizeError(error).message}\n`);
}

function runBrowserSidecarEntrypoint(): void {
  readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    try {
      for (const frame of decoder.push(`${line}\n`)) {
        if (frame.kind !== 'request') throw new Error('Only request frames are accepted.');
        requests.enqueue(frame);
      }
    } catch (error) {
      reportQueueError(error);
    }
  });

  emit('ready', { protocolVersion: BROWSER_PROTOCOL_VERSION });
  publishActivity();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runBrowserSidecarEntrypoint();
