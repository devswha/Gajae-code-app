import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserProtocolFrame,
  type BrowserRequestMethod,
} from '../modules/automation/browser-protocol.js';

function sidecarEntrypoint(): string {
  const source = fileURLToPath(new URL('../modules/automation/browser-sidecar.ts', import.meta.url));
  return existsSync(source) ? source : fileURLToPath(new URL('../modules/automation/browser-sidecar.js', import.meta.url));
}

class SidecarHarness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: BrowserProtocolFrame[] = [];
  readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private sequence = 0;
  private readonly closed: Promise<void>;
  private stoppedError?: Error;
  private stderr = '';

  constructor(profileDirectory: string, entrypoint = sidecarEntrypoint()) {
    this.child = spawn(join(process.cwd(), 'dist-native', 'bun'), [
      entrypoint,
    ], {
      env: { ...process.env, GAJAE_BROWSER_PROFILE_DIR: profileDirectory },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8_192); });
    this.child.on('error', (error) => this.stop(error));
    this.child.stdin.on('error', (error) => this.stop(error));
    this.closed = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        this.stop(new Error(`Browser sidecar exited (${code ?? signal}). ${this.stderr}`));
        resolve();
      });
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let frame: BrowserProtocolFrame;
      try {
        frame = JSON.parse(line) as BrowserProtocolFrame;
      } catch {
        this.stop(new Error(`Invalid browser sidecar frame: ${line.slice(0, 500)}. ${this.stderr}`));
        this.child.kill();
        return;
      }
      if (frame.kind === 'response') {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new Error(frame.error?.message ?? 'Browser sidecar request failed.'));
      } else {
        this.events.push(frame);
      }
    });
  }

  private stop(error: Error): void {
    this.stoppedError ??= error;
    for (const pending of this.pending.values()) pending.reject(this.stoppedError);
    this.pending.clear();
  }

  request(method: BrowserRequestMethod, sessionId?: string, payload: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    if (this.stoppedError) return Promise.reject(this.stoppedError);
    const id = `e2e-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.pending.delete(id); };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`Timed out waiting for browser sidecar ${method} after ${timeoutMs}ms. ${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { finish(); resolve(value); },
        reject: (error) => { finish(); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        kind: 'request',
        id,
        method,
        ...(sessionId ? { sessionId } : {}),
        payload,
      })}\n`);
    });
  }

  async waitForEvent(method: string, timeoutMs = 5_000, fromIndex = 0): Promise<BrowserProtocolFrame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events.slice(fromIndex).find((candidate) => candidate.kind === 'event' && candidate.method === method);
      if (event) return event;
      if (this.stoppedError) throw this.stoppedError;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${method}.`);
  }

  async waitForAsync(type: string, fromIndex = 0, timeoutMs = 5_000): Promise<BrowserProtocolFrame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events.slice(fromIndex).find((candidate) => (
        candidate.kind === 'event'
        && candidate.method === 'async'
        && candidate.payload.type === type
      ));
      if (event) return event;
      if (this.stoppedError) throw this.stoppedError;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for async event ${type}.`);
  }

  async shutdown(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.closed;
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
    try {
      await this.request('shutdown', undefined, {}, 2_000).catch(() => {});
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
  }
}

test('sidecar harness rejects pending requests when its process exits', { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gajae-sidecar-exit-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entrypoint = join(root, 'exiting-sidecar.ts');
  await writeFile(entrypoint, `
    console.log(JSON.stringify({ protocolVersion: 1, kind: 'event', method: 'ready', payload: {} }));
    process.stdin.once('data', () => {
      process.stderr.write('fixture sidecar exited unexpectedly\\n');
      process.exit(17);
    });
    process.stdin.resume();
  `);
  const sidecar = new SidecarHarness(join(root, 'profile'), entrypoint);
  t.after(() => sidecar.shutdown());
  await sidecar.waitForEvent('ready');
  const request = sidecar.request('initialize');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([
      request,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('pending request never settled after exit')), 1_000); }),
    ]), /sidecar exited.*17.*fixture sidecar exited unexpectedly/isu);
    assert.equal(sidecar.pending.size, 0);
  } finally {
    clearTimeout(timer);
  }
});

test('sidecar harness bounds silent requests and shutdown without a response', { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gajae-sidecar-silent-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entrypoint = join(root, 'silent-sidecar.ts');
  await writeFile(entrypoint, `
    import readline from 'node:readline';
    console.log(JSON.stringify({ protocolVersion: 1, kind: 'event', method: 'ready', payload: {} }));
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      if (JSON.parse(line).method === 'shutdown') process.exit(0);
    });
  `);
  const sidecar = new SidecarHarness(join(root, 'profile'), entrypoint);
  t.after(() => sidecar.shutdown());
  await sidecar.waitForEvent('ready');
  await assert.rejects(sidecar.request('initialize', undefined, {}, 50), /Timed out waiting for browser sidecar initialize/u);
  assert.equal(sidecar.pending.size, 0);
  await sidecar.shutdown();
  assert.equal(sidecar.child.exitCode, 0);
  await assert.rejects(sidecar.request('status'), /sidecar exited/u);
});

test('real Chromium sidecar shares structured actions, tabs, and screencast state', { timeout: 45_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gajae-browser-e2e-'));
  const server = createServer((request, response) => {
    if (request.url === '/download') {
      response.setHeader('content-type', 'application/octet-stream');
      response.setHeader('content-disposition', 'attachment; filename="fixture.txt"');
      response.end('blocked download');
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/csp') {
      response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; object-src 'none'");
      response.end('<!doctype html><title>CSP fixture</title><p>restricted evaluation</p>');
      return;
    }
    if (request.url === '/popup') {
      response.end('<!doctype html><title>Popup fixture</title><p>popup</p>');
      return;
    }
    response.end(`<!doctype html>
      <title>Gajae browser fixture</title>
      <main>
        <label>Name <input id="name" /></label>
        <button id="apply" onclick="document.querySelector('#result').textContent = document.querySelector('#name').value">Apply</button>
        <p id="result">waiting</p>
        <button id="dialog" onclick="alert('fixture dialog')">Open dialog</button>
        <a id="popup" href="/popup" target="_blank">Open popup</a>
        <a id="download" href="/download" download>Download fixture</a>
      </main>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const sidecar = new SidecarHarness(join(root, 'profile'));
  t.after(async () => {
    await sidecar.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  await sidecar.waitForEvent('ready');
  await sidecar.request('initialize');
  const status = await sidecar.request('status') as { installed: boolean };
  assert.equal(status.installed, true, 'activate the Browser panel once before running this E2E');

  const opened = await sidecar.request('session.open', 'browser-e2e', { url, allowDownload: false }) as { activeTabId: string; tabs: unknown[] };
  assert.equal(opened.tabs.length, 1);
  await sidecar.request('screencast.subscribe', 'browser-e2e');
  await sidecar.waitForEvent('frame');

  const resizedFrameStart = sidecar.events.length;
  await sidecar.request('browser.input', 'browser-e2e', {
    input: { kind: 'viewport', width: 517, height: 742 },
  });
  const resized = await sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'run', code: '({ width: window.innerWidth, height: window.innerHeight })' },
  }) as { value: { width: number; height: number } };
  assert.deepEqual(resized.value, { width: 517, height: 742 });
  const awaited = await sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'run', code: 'await Promise.resolve({ title: document.title, ready: true })' },
  }) as { value: { title: string; ready: boolean } };
  assert.deepEqual(awaited.value, { title: 'Gajae browser fixture', ready: true });
  const runScript = (code: string) => sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'run', code },
  });
  assert.deepEqual(await runScript('Promise.resolve(42)'), { value: 42 });
  assert.deepEqual(await runScript('const value = await Promise.resolve(21); value * 2'), { value: 42 });
  assert.deepEqual(await runScript('const value = await Promise.resolve(7); value * 2'), { value: 14 });
  await assert.rejects(runScript('await Promise.reject(new Error("async fixture failure"))'), /async fixture failure/);
  await assert.rejects(runScript('globalThis.failedRunCount = (globalThis.failedRunCount || 0) + 1; throw new SyntaxError("runtime fixture failure")'), /runtime fixture failure/);
  assert.deepEqual(await runScript('globalThis.failedRunCount'), { value: 1 }, 'runtime errors must never replay code');
  await assert.rejects(runScript(`globalThis.oversizedRan = true; /*${'x'.repeat(64 * 1024)}*/`), /script is too large/i);
  assert.deepEqual(await runScript('typeof globalThis.oversizedRan'), { value: 'undefined' });
  const large = await runScript('"x".repeat(300000)') as { value: string };
  assert.equal(large.value.length, 256 * 1024 + 1);
  const resizedFrame = await sidecar.waitForEvent('frame', 5_000, resizedFrameStart);
  assert.equal(resizedFrame.kind === 'event' && resizedFrame.payload.metadata && typeof resizedFrame.payload.metadata === 'object'
    ? (resizedFrame.payload.metadata as { deviceWidth?: number }).deviceWidth
    : undefined, 517);
  assert.equal(resizedFrame.kind === 'event' && resizedFrame.payload.metadata && typeof resizedFrame.payload.metadata === 'object'
    ? (resizedFrame.payload.metadata as { deviceHeight?: number }).deviceHeight
    : undefined, 742);

  const retinaFrameStart = sidecar.events.length;
  await sidecar.request('browser.input', 'browser-e2e', {
    input: { kind: 'viewport', width: 1000, height: 700, deviceScaleFactor: 2 },
  });
  assert.deepEqual(await runScript('({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })'), {
    value: { width: 1000, height: 700, scale: 2 },
  });
  const retinaFrame = await sidecar.waitForEvent('frame', 5_000, retinaFrameStart);
  assert.equal(retinaFrame.kind, 'event');
  if (retinaFrame.kind !== 'event') throw new Error('Expected a browser frame.');
  const retinaSize = await runScript(`const image = new Image();
    image.src = ${JSON.stringify(`data:image/jpeg;base64,${retinaFrame.payload.data}`)};
    await image.decode();
    ({ width: image.naturalWidth, height: image.naturalHeight });`);
  assert.deepEqual(retinaSize, { value: { width: 2000, height: 1400 } },
    'the streamed image must retain physical pixels beyond the old 1440×900 cap');
  assert.equal((retinaFrame.payload.metadata as { deviceWidth: number }).deviceWidth, 1000);
  assert.equal((retinaFrame.payload.metadata as { deviceHeight: number }).deviceHeight, 700);
  await runScript(`const corner = document.createElement('button'); corner.id = 'retina-corner';
    corner.style = 'position:fixed;right:0;bottom:0;width:40px;height:40px';
    corner.onclick = () => { window.retinaClicked = true; }; document.body.append(corner);`);
  for (const event of ['down', 'up']) {
    await sidecar.request('browser.input', 'browser-e2e', {
      input: { kind: 'mouse', event, x: 980, y: 680, button: 'left' },
    });
  }
  assert.deepEqual(await runScript('window.retinaClicked'), { value: true },
    'high-DPI preview input must reach the bottom-right CSS coordinates');

  const clipboard = (input: Record<string, unknown>) => sidecar.request('browser.input', 'browser-e2e', {
    input: { kind: 'clipboard', tabId: opened.activeTabId, ...input },
  });
  await runScript(`const input = document.querySelector('#name');
    window.cutInputEvents = 0;
    input.addEventListener('input', () => { window.cutInputEvents++; });
    input.value = '복사할 텍스트'; input.focus(); input.select();`);
  const copied = await clipboard({ event: 'read' }) as { text: string; selectionId: string };
  assert.equal(copied.text, '복사할 텍스트');
  assert.deepEqual(await runScript('document.querySelector("#name").value'), { value: '복사할 텍스트' },
    'copy must not mutate the selected input');
  await clipboard({ event: 'delete', text: copied.text, selectionId: copied.selectionId });
  assert.deepEqual(await runScript('document.querySelector("#name").value'), { value: '' });
  assert.deepEqual(await runScript('window.cutInputEvents'), { value: 1 },
    'cut must notify reactive input handlers');
  await clipboard({ event: 'paste', text: '붙여넣기 ✓' });
  assert.deepEqual(await runScript('document.querySelector("#name").value'), { value: '붙여넣기 ✓' });
  await runScript('document.querySelector("#name").select()');
  const staleCopy = await clipboard({ event: 'read' }) as { text: string; selectionId: string };
  await runScript('document.querySelector("#name").setSelectionRange(0, 1)');
  assert.deepEqual(await clipboard({ event: 'delete', text: staleCopy.text, selectionId: staleCopy.selectionId }),
    { accepted: true, deleted: false }, 'cut must not delete a changed selection');
  await runScript('document.querySelector("#name").readOnly = true; document.querySelector("#name").select()');
  const readonlyCopy = await clipboard({ event: 'read' }) as { text: string; editable: boolean; selectionId: string };
  assert.equal(readonlyCopy.editable, false);
  assert.deepEqual(await clipboard({ event: 'delete', text: readonlyCopy.text, selectionId: readonlyCopy.selectionId }),
    { accepted: true, deleted: false });
  await runScript('document.querySelector("#name").readOnly = false');
  await runScript(`const password = document.createElement('input');
    password.type = 'password'; password.value = 'private password'; password.id = 'password';
    document.body.append(password); password.focus(); password.select();`);
  const passwordCopy = await clipboard({ event: 'read' }) as { text: string; editable: boolean };
  assert.equal(passwordCopy.text, '', 'password selections must never cross the clipboard bridge');
  assert.equal(passwordCopy.editable, false);
  await runScript('document.querySelector("#password").remove()');
  await runScript(`const editable = document.createElement('div');
    editable.id = 'editable'; editable.contentEditable = 'true';
    editable.textContent = 'editable selection'; document.body.append(editable);
    editable.focus(); const range = document.createRange(); range.selectNodeContents(editable);
    getSelection().removeAllRanges(); getSelection().addRange(range);`);
  const editableCopy = await clipboard({ event: 'read' }) as { text: string; selectionId: string };
  assert.equal(editableCopy.text, 'editable selection');
  await clipboard({ event: 'delete', text: editableCopy.text, selectionId: editableCopy.selectionId });
  await clipboard({ event: 'paste', text: 'editable paste' });
  assert.deepEqual(await runScript('document.querySelector("#editable").textContent'), { value: 'editable paste' });
  await assert.rejects(clipboard({ event: 'paste', tabId: 'wrong-tab', text: 'must not insert' }), /browser tab changed/i);
  assert.deepEqual(await runScript('document.querySelector("#editable").textContent'), { value: 'editable paste' });

  const observed = await sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'observe' },
  }) as { entries: Array<{ ref: number; name: string }> };
  assert.ok(observed.entries.some((entry) => entry.name === 'Apply'));

  await sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'fill', selector: '#name', text: 'shared session' },
  });
  await sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'click', selector: '#apply' },
  });
  const extracted = await sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'extract', selector: '#result', format: 'text' },
  }) as { value: string };
  assert.equal(extracted.value, 'shared session');

  const dialogEventStart = sidecar.events.length;
  await sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'click', selector: '#dialog' },
  });
  const dialogEvent = await sidecar.waitForAsync('dialog', dialogEventStart);
  assert.equal(dialogEvent.kind === 'event' && dialogEvent.payload.disposition, 'dismissed');
  assert.equal(dialogEvent.kind === 'event' && dialogEvent.payload.message, 'fixture dialog');

  const withSecondTab = await sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'newTab' },
  }) as { tabs: unknown[] };
  assert.equal(withSecondTab.tabs.length, 2);
  const closeEventStart = sidecar.events.length;
  const afterClose = await sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'closeTab' },
  }) as { tabs: unknown[] };
  assert.equal(afterClose.tabs.length, 1);
  await sidecar.waitForAsync('tab.closed', closeEventStart);

  const popupEventStart = sidecar.events.length;
  await sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'click', selector: '#popup' },
  });
  const popupEvent = await sidecar.waitForAsync('popup', popupEventStart);
  assert.equal(popupEvent.kind === 'event' && popupEvent.payload.url, `${url}/popup`);
  const withPopup = await sidecar.request('session.state', 'browser-e2e') as { tabs: unknown[] };
  assert.equal(withPopup.tabs.length, 2);
  await sidecar.request('browser.command', 'browser-e2e', { command: { action: 'closeTab' } });

  const downloadEventStart = sidecar.events.length;
  await sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'click', selector: '#download' },
  });
  const downloadEvent = await sidecar.waitForAsync('download.attempt', downloadEventStart);
  assert.equal(downloadEvent.kind === 'event' && downloadEvent.payload.suggestedFilename, 'fixture.txt');

  const navigationEventStart = sidecar.events.length;
  await sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'navigate', url: `${url}/next` },
  });
  const navigationEvent = await sidecar.waitForAsync('navigation', navigationEventStart);
  assert.equal(navigationEvent.kind === 'event' && navigationEvent.payload.url, `${url}/next`);

  const state = await sidecar.request('session.state', 'browser-e2e') as { activeTabId: string | null; tabs: unknown[] };
  assert.equal(state.tabs.length, 1);
  assert.ok(state.activeTabId);

  const background = await sidecar.request('session.open', 'background-e2e', { url: `${url}/background`, allowDownload: false }) as { activeTabId: string; tabs: unknown[] };
  assert.equal(background.tabs.length, 1);
  assert.notEqual(background.activeTabId, state.activeTabId);
  for (const action of ['selectTab', 'closeTab']) {
    await assert.rejects(sidecar.request('browser.command', 'browser-e2e', {
      command: { action, tabId: background.activeTabId },
    }), /Browser tab was not found/u);
  }
  await sidecar.request('browser.command', 'background-e2e', {
    command: { action: 'fill', selector: '#name', text: 'background preserved' },
  });
  await sidecar.request('browser.command', 'background-e2e', { command: { action: 'click', selector: '#apply' } });

  const interrupted = assert.rejects(
    sidecar.request('browser.command', 'browser-e2e', {
      command: { action: 'run', code: 'new Promise(() => {})', timeoutMs: 30_000 },
    }),
    /closed|destroyed|Target|session|Protocol/iu,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await sidecar.request('browser.command', 'background-e2e', {
    command: { action: 'extract', selector: '#result', format: 'text' },
  }, 2_000), { value: 'background preserved' }, 'another session remains usable during a non-settling script');
  const closeStarted = Date.now();
  assert.deepEqual(await sidecar.request('session.close', 'browser-e2e', {}, 2_000), { closed: true });
  assert.ok(Date.now() - closeStarted < 2_000, 'session.close must interrupt a long browser.run');
  await interrupted;

  assert.deepEqual(await sidecar.request('browser.command', 'background-e2e', {
    command: { action: 'extract', selector: '#result', format: 'text' },
  }), { value: 'background preserved' }, 'closing one session preserves the other session');
  await assert.rejects(sidecar.request('session.state', 'browser-e2e'), /Open the browser session first/u);
  await sidecar.request('session.open', 'csp-e2e', { url: `${url}/csp`, allowDownload: false });
  assert.deepEqual(await sidecar.request('browser.command', 'csp-e2e', {
    command: { action: 'run', code: 'await Promise.resolve(document.title)' },
  }), { value: 'CSP fixture' });
  await assert.rejects(sidecar.request('browser.command', 'csp-e2e', {
    command: { action: 'run', code: 'eval("1 + 1")' },
  }), /unsafe-eval|Content Security Policy|Refused/i);
  await assert.rejects(sidecar.request('browser.command', 'csp-e2e', {
    command: { action: 'run', code: 'await new Promise(() => {})', timeoutMs: 50 },
  }), /timed out/);
  assert.deepEqual(await sidecar.request('session.close', 'csp-e2e'), { closed: true });
  assert.deepEqual(await sidecar.request('session.close', 'browser-e2e'), { closed: false });
  const reopened = await sidecar.request('session.open', 'browser-e2e', { url, allowDownload: false }) as { activeTabId: string; tabs: unknown[] };
  assert.equal(reopened.tabs.length, 1);
  assert.notEqual(reopened.activeTabId, state.activeTabId);
  await assert.rejects(sidecar.request('browser.command', 'browser-e2e', {
    command: { action: 'selectTab', tabId: state.activeTabId },
  }), /Browser tab was not found/u);
  assert.deepEqual(await sidecar.request('session.close', 'browser-e2e'), { closed: true });
  assert.deepEqual(await sidecar.request('session.close', 'background-e2e'), { closed: true });
});
