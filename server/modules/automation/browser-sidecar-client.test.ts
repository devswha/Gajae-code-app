import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BrowserEventFrame, BrowserSessionState } from './browser-protocol.js';
import { BrowserSidecarClient } from './browser-sidecar-client.js';

test('cached state reads never spawn a sidecar or Chromium and unknown snapshots are independent', async (t) => {
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('Metadata reads must not spawn.'); });
  syncBuiltinESMExports();
  const client = new BrowserSidecarClient();
  try {
    const snapshot = client.cachedState('observer-only');
    const empty: BrowserSessionState = { sessionId: 'observer-only', activeTabId: null, tabs: [] };
    assert.deepEqual(snapshot, empty);
    snapshot.sessionId = 'mutated';
    snapshot.activeTabId = 'fake-tab';
    snapshot.tabs.push({ id: 'fake-tab', title: '', url: 'https://mutated.test/', loading: false, canGoBack: false, canGoForward: false });
    assert.deepEqual(client.cachedState('observer-only'), { sessionId: 'observer-only', activeTabId: null, tabs: [] });
    assert.deepEqual(client.cachedState('another-session'), { sessionId: 'another-session', activeTabId: null, tabs: [] });
    await Promise.resolve();
    assert.equal(spawn.mock.callCount(), 0);
    assert.equal(client.browserPid, undefined);
    await client.shutdown();
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

test('a crashed sidecar is restarted and restores the shared tabs and screencast subscription', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gajae-browser-client-recovery-'));
  const sidecarPath = join(directory, 'fake-sidecar.mjs');
  const callsPath = join(directory, 'calls.ndjson');
  await writeFile(sidecarPath, `
    import { appendFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    import readline from 'node:readline';
    const callsPath = ${JSON.stringify(callsPath)};
    const sessions = new Map();
    let sequence = 0;
    let browserProcess;
    const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const state = id => sessions.get(id) ?? { sessionId: id, activeTabId: null, tabs: [] };
    const respond = (request, result) => write({ protocolVersion: 1, kind: 'response', id: request.id, method: request.method, ...(request.sessionId ? { sessionId: request.sessionId } : {}), ok: true, result });
    write({ protocolVersion: 1, kind: 'event', method: 'ready', payload: { protocolVersion: 1 } });
    readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
      const request = JSON.parse(line);
      appendFileSync(callsPath, JSON.stringify({ method: request.method, sessionId: request.sessionId }) + '\\n');
      if (request.method === 'initialize') return respond(request, { ready: true, protocolVersion: 1 });
      if (request.method === 'status') return respond(request, { state: 'ready', installed: true, buildId: 'fake' });
      if (request.method === 'session.open') {
        if (!browserProcess) {
          browserProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { detached: true, stdio: 'ignore' });
          browserProcess.unref();
          appendFileSync(callsPath, JSON.stringify({ browserPid: browserProcess.pid }) + '\\n');
          write({ protocolVersion: 1, kind: 'event', method: 'async', payload: { type: 'browser.process', pid: browserProcess.pid } });
        }
        const tab = { id: 'tab-' + (++sequence), title: 'Recovered', url: request.payload.url ?? 'about:blank', loading: false, canGoBack: false, canGoForward: false };
        const next = { sessionId: request.sessionId, activeTabId: tab.id, tabs: [tab] };
        sessions.set(request.sessionId, next);
        return respond(request, next);
      }
      if (request.method === 'session.state' || request.method === 'screencast.subscribe') return respond(request, state(request.sessionId));
      if (request.method === 'screencast.unsubscribe') return respond(request, { subscribed: false });
      if (request.method === 'session.close') {
        const closed = sessions.delete(request.sessionId);
        return respond(request, { closed });
      }
      if (request.method === 'browser.command' && request.payload.command?.action === 'reload') {
        const next = state(request.sessionId);
        next.tabs[0].title = 'Updated by state event';
        write({ protocolVersion: 1, kind: 'event', method: 'state', sessionId: request.sessionId, payload: next });
        return respond(request, { reloaded: true });
      }
      if (request.method === 'browser.command' && request.payload.command?.action === 'run') return process.exit(23);
      if (request.method === 'shutdown') {
        if (browserProcess?.pid) {
          try { process.kill(-browserProcess.pid, 'SIGKILL'); } catch {}
        }
        respond(request, { shutdown: true });
        return setImmediate(() => process.exit(0));
      }
      respond(request, state(request.sessionId));
    });
  `);

  const client = new BrowserSidecarClient({
    runtimePath: process.execPath,
    sidecarPath,
    recoveryAttempts: 2,
    recoveryDelayMs: 10,
  });
  const events: BrowserEventFrame[] = [];
  client.subscribe((event) => events.push(event));
  try {
    const url = 'https://recovery.example.test/path';
    // Merely observing a never-opened session must not enlist it in recovery.
    client.cachedState('observer-only');
    await client.open('recovery-session', { url, allowDownload: false });
    await client.subscribeFrames('recovery-session');
    const callsBeforeRead = await readFile(callsPath, 'utf8');
    const cached = client.cachedState('recovery-session');
    assert.equal(cached.tabs[0]?.url, url);
    const original = structuredClone(cached);
    cached.sessionId = 'mutated';
    cached.activeTabId = 'mutated-tab';
    cached.tabs[0]!.url = 'https://mutated.test/';
    cached.tabs[0]!.title = 'Mutated';
    cached.tabs.push({ ...cached.tabs[0]!, id: 'extra-tab' });
    assert.deepEqual(client.cachedState('recovery-session'), original);
    assert.equal(await readFile(callsPath, 'utf8'), callsBeforeRead, 'cached reads must not issue sidecar requests');

    await client.command('recovery-session', { action: 'reload' });
    assert.equal(client.cachedState('recovery-session').tabs[0]?.title, 'Updated by state event');

    await assert.rejects(
      client.command('recovery-session', { action: 'run', code: 'never settles' }),
      /disconnected/iu,
    );
    await waitFor(
      () => events.some((event) => event.method === 'async' && event.payload.type === 'sidecar.recovered'),
      'the browser sidecar did not publish a recovery event',
    );

    const restored = await client.state('recovery-session') as BrowserSessionState;
    assert.equal(restored.tabs.length, 1);
    assert.equal(restored.tabs[0]?.url, url);
    assert.ok(events.some((event) => event.method === 'error' && event.payload.recovering === true));
    assert.ok(events.some((event) => event.method === 'state' && event.payload.activeTabId === null));
    assert.ok(events.every((event) => event.sessionId !== 'observer-only'), 'cache reads must not create recoverable sessions');
    assert.deepEqual(client.cachedState('recovery-session'), restored);

    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method?: string; browserPid?: number });
    assert.equal(calls.filter((call) => call.method === 'initialize').length, 2);
    assert.equal(calls.filter((call) => call.method === 'session.open').length, 2);
    assert.equal(calls.filter((call) => call.method === 'screencast.subscribe').length, 2);
    const browserPids = calls.flatMap((call) => call.browserPid ? [call.browserPid] : []);
    assert.equal(browserPids.length, 2);
    assert.throws(() => process.kill(browserPids[0]!, 0), /ESRCH/iu, 'the crashed sidecar\'s orphan browser must be reaped');
    await client.close('recovery-session');
    assert.deepEqual(client.cachedState('recovery-session'), { sessionId: 'recovery-session', activeTabId: null, tabs: [] });
  } finally {
    await client.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
