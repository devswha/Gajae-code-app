import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import ts from 'typescript';

import { createDesktopRestartRuntime, DESKTOP_RESTART_REQUIRED_OWNERS } from './desktop-restart-runtime.js';

test('production owner inventory cannot shrink when readers are not integrated', async () => {
  const authority = createDesktopRestartRuntime();
  assert.ok(Object.isFrozen(DESKTOP_RESTART_REQUIRED_OWNERS));
  const snapshot = await authority.snapshot();
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.idle, false);
  assert.deepEqual(snapshot.blockers.map((blocker) => blocker.owner), [...DESKTOP_RESTART_REQUIRED_OWNERS]);
  assert.ok(snapshot.blockers.every((blocker) => blocker.code === 'owner_missing'));
  assert.equal((await authority.prepare({ attemptId: 'test', epoch: 'native-test' })).ok, false);
  assert.equal(authority.state, 'open');
});

test('one available reader does not authorize restart while the other producers are unknown', async () => {
  const authority = createDesktopRestartRuntime({
    'gjc-worker': {
      getGeneration: () => 'g1',
      read: () => ({ owner: 'gjc-worker', generation: 'g1', complete: true, starting: 0, queued: 0, running: 0, settling: 0, approvals: 0, retained: 0, unknown: [] }),
    },
  });
  const snapshot = await authority.snapshot();
  assert.equal(snapshot.owners.length, 1);
  assert.equal(snapshot.idle, false);
  assert.ok(snapshot.blockers.some((blocker) => blocker.owner === 'ui-drafts'));
});

test('production connects ownership readers and the same admission before startup callbacks', () => {
  // Construction coverage only: this does not import index.js, launch a server,
  // touch user data, or substitute for the owners' behavioral race tests.
  const source = ts.createSourceFile('index.js', readFileSync(new URL('../index.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let construction: ts.CallExpression | undefined;
  let factory: ts.CallExpression | undefined;
  const configureCalls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      if (name === 'createDesktopRestartRuntime') construction = node;
      if (name === 'createGjcAppFactory') factory = node;
      if (name.startsWith('configure') || name.endsWith('.configureDesktopRestartAdmission')) configureCalls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(construction && factory);
  assert.ok(construction.getStart(source) < factory.getStart(source));
  const readers = construction.arguments[0];
  assert.ok(readers && ts.isObjectLiteralExpression(readers));
  const names = readers.properties.map((property) => {
    assert.ok(ts.isPropertyAssignment(property));
    assert.ok(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name));
    return property.name.text;
  });
  assert.deepEqual(names, DESKTOP_RESTART_REQUIRED_OWNERS);
  for (const name of [
    'configureGjcJobOrchestratorDesktopAdmission', 'configureSessionWorktreeDesktopAdmission',
    'configureNativeDesktopRestartAdmission', 'configureAutomationDesktopAdmission',
    'configureSessionsWatcherDesktopAdmission', 'configureNotificationDesktopAdmission',
    'configureInternalDesktopAdmission',
  ]) {
    const call = configureCalls.find((candidate) => candidate.expression.getText(source) === name);
    assert.ok(call, `${name} must configure the production owner`);
    assert.equal(call.arguments[0]?.getText(source), 'desktopRestartAdmission');
    assert.ok(call.getStart(source) > construction.getStart(source));
    assert.ok(call.getStart(source) < factory.getStart(source), `${name} must precede startup catch-up`);
  }
  const worker = configureCalls.find((call) => call.expression.getText(source) === 'getGjcWorkerSupervisor().configureDesktopRestartAdmission');
  assert.ok(worker && worker.getStart(source) < factory.getStart(source));
  assert.match(worker.getText(source), /desktopRestartAdmission\.enter\(source\)/u);
  const workerFence = construction.arguments[1];
  assert.ok(workerFence);
  assert.match(workerFence.getText(source), /fenceForDesktopRestart\(fenceId\)/u);
  assert.match(workerFence.getText(source), /releaseDesktopRestartFence\(fenceId\)/u);
});
