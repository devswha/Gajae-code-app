import assert from 'node:assert/strict';
import test from 'node:test';

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
