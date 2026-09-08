import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(overrides: Record<string, unknown> = {}) {
  // Evaluate only the actual shutdown function with explicit fake services.
  // Importing index.js would start the real server and access operator data.
  const source = ts.createSourceFile('index.js', readFileSync(new URL('../index.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let shutdown: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'shutdownRuntimeServices'
      && node.initializer && ts.isArrowFunction(node.initializer)) shutdown = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(shutdown);
  const events: string[] = [];
  const process = { exitCode: 0, exit: (code: number) => events.push(`exit:${code}`) };
  const context = {
    shutdownStarted: false,
    markInternalActivityUncertain: () => events.push('shutdown'),
    gjcJobOrchestrator: { interruptForShutdown: async () => { events.push('durable-fence'); }, close: () => events.push('jobs-close') },
    closeSessionsWatcher: async () => { events.push('watcher-close'); },
    drainWebSocketClients: async () => { events.push('drain'); },
    wss: { clients: [], close() {} }, server: { close() {}, closeAllConnections() {} },
    shutdownGjcWorker: async () => { events.push('worker-close'); },
    automationService: { shutdown: async () => {} },
    removeLocalServerMarker: async () => {},
    console: { error() {} }, process,
    setInterval: () => events.push('hold-unconfirmed-exit'),
    ...overrides,
  };
  return { run: runInNewContext(`(${shutdown.getText(source)})`, context) as () => Promise<void>, events, process, context };
}

test('durable interruption precedes watcher waits and late pre-start cancellation cannot erase it', async () => {
  const watcherDone = deferred();
  let job: string = 'running';
  const f = fixture();
  f.context.gjcJobOrchestrator.interruptForShutdown = async () => { f.events.push('durable-fence'); job = 'interrupted'; };
  f.context.closeSessionsWatcher = async () => {
    f.events.push('watcher-close');
    // Models/credentials may reject a pending worker during this await. Native
    // lease checks only allow cancellation while its original run is running.
    if (job === 'running') job = 'ready';
    await watcherDone.promise;
  };
  const closing = f.run(); await tick();
  assert.deepEqual(f.events, ['shutdown', 'durable-fence', 'watcher-close']);
  assert.equal(job, 'interrupted');
  watcherDone.resolve(); await closing;
  assert.equal(f.events.at(-1), 'exit:0');
  assert.equal(job, 'interrupted');
});

test('watcher close cannot begin before the durable fence acknowledges completion', async () => {
  const fenced = deferred();
  const f = fixture();
  f.context.gjcJobOrchestrator.interruptForShutdown = async () => { f.events.push('durable-fence'); await fenced.promise; };
  const closing = f.run(); await tick();
  assert.deepEqual(f.events, ['shutdown', 'durable-fence']);
  fenced.resolve(); await closing;
  assert.equal(f.events.at(-1), 'exit:0');
  await f.run();
  assert.equal(f.events.filter((event) => event === 'durable-fence').length, 1);
});

test('unconfirmed watcher close retains the durable interruption and refuses normal process exit', async () => {
  const f = fixture();
  f.context.closeSessionsWatcher = async () => { f.events.push('watcher-close'); throw new Error('physical close unconfirmed'); };
  await f.run();
  assert.deepEqual(f.events, ['shutdown', 'durable-fence', 'watcher-close']);
  assert.equal(f.process.exitCode, 1);
});
