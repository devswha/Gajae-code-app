import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_RESTART_PREPARE_MS,
  DESKTOP_RESTART_PROTOCOL,
  DESKTOP_RESTART_TOKEN_MS,
  isDesktopNativeCommand,
  isDesktopNativeReply,
  isDesktopRestartCommand,
  isRestartControlCommand,
  isRestartControlFrame,
  isRestartControlResult,
  isRestartId,
  type RestartControlCommand,
  type RestartControlResult,
} from '../../shared/desktopRestartProtocol.js';
import snapshot from '../../shared/fixtures/desktop-update-status.json' with { type: 'json' };

const attemptId = 'c'.repeat(64);
const epoch = 'b'.repeat(64);
const prepared = { action: 'restartPrepared', attemptId, draftEpoch: 1 };
const prepare = { action: 'prepare', attemptId, draftEpoch: 1, remainingMs: 5_000 };
const commit = { action: 'commit', attemptId, token: 'test-token:1' };
const challenge = { protocolVersion: 1, kind: 'restartChallenge', attemptId, draftEpoch: 1, ttlMs: 5_000 };
const disposition = { protocolVersion: 1, kind: 'restartAborted', attemptId, draftEpoch: 1, snapshot };
const result: RestartControlResult = {
  ok: true, state: 'prepared', attemptId, token: 'test-token:1', expiresInMs: 10_000, error: null,
};
const frame = { protocolVersion: 1, kind: 'restartControl', id: 1, epoch, command: prepare };

const invalidPositive = [undefined, null, false, '1', 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
const invalidIds = [undefined, null, 1, [], {}, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(63)}\n`];
const invalidTokens = [
  undefined, false, 1, [], {}, '', 'a'.repeat(257), '.token', '_token', ':token', '-token',
  'has space', 'a\n', 'a\r', 'a\t', 'a\0b', '토큰', 'a/b', 'a\\b', 'https://attacker.test/update',
  'file:///tmp/update', '../payload', '/Applications/Gajae.app',
];
const forbiddenFields = {
  url: 'https://attacker.test/update', path: '/tmp/synthetic-installer', install: true, signal: 'SIGKILL', extra: true,
};

test('restart protocol constants and ID format are fixed and bounded', () => {
  assert.equal(DESKTOP_RESTART_PROTOCOL, 1);
  assert.equal(DESKTOP_RESTART_PREPARE_MS, 5_000);
  assert.equal(DESKTOP_RESTART_TOKEN_MS, 10_000);
  for (const id of ['0'.repeat(64), 'abcdef0123456789'.repeat(4)]) assert.equal(isRestartId(id), true);
  for (const id of invalidIds) assert.equal(isRestartId(id), false, `ID ${String(id)}`);
});

test('public native commands and private backend controls remain separate allowlists', () => {
  for (const command of [
    { action: 'status' }, { action: 'check' }, { action: 'restart' },
    { action: 'setAutomatic', automatic: false }, { action: 'setAutomatic', automatic: true },
    prepared, { ...prepared, action: 'restartCancel' },
  ]) assert.equal(isDesktopNativeCommand(command), true, JSON.stringify(command));
  const controls: RestartControlCommand[] = [
    { action: 'status' }, { action: 'prepare', attemptId, draftEpoch: 1, remainingMs: 1 },
    { action: 'commit', attemptId, token: 'test-token:1' }, { action: 'cancel', attemptId },
  ];
  for (const command of controls) assert.equal(isRestartControlCommand(command), true);
  for (const command of controls.slice(1)) assert.equal(isDesktopNativeCommand(command), false);
  for (const command of [prepared, { ...prepared, action: 'restartCancel' }, { action: 'restart' }, { action: 'check' }]) {
    assert.equal(isRestartControlCommand(command), false);
  }
  for (const action of ['install', 'signal', 'kill', 'exec', 'open', 'download', 'https://attacker.test/update', '/tmp/payload']) {
    assert.equal(isDesktopNativeCommand({ action }), false, action);
    assert.equal(isRestartControlCommand({ action, attemptId }), false, action);
  }
});

test('all restart codecs require exact own fields and reject capability-bearing additions', async (t) => {
  const shapes: Array<[string, (value: unknown) => boolean, Record<string, unknown>]> = [
    ['restart prepared', isDesktopRestartCommand, prepared],
    ['restart cancel', isDesktopRestartCommand, { ...prepared, action: 'restartCancel' }],
    ['native status', isDesktopNativeCommand, { action: 'status' }],
    ['native automatic', isDesktopNativeCommand, { action: 'setAutomatic', automatic: false }],
    ['control status', isRestartControlCommand, { action: 'status' }],
    ['control prepare', isRestartControlCommand, prepare],
    ['control commit', isRestartControlCommand, commit],
    ['control cancel', isRestartControlCommand, { action: 'cancel', attemptId }],
    ['control frame', isRestartControlFrame, frame],
    ['control result', isRestartControlResult, result],
    ['native challenge', isDesktopNativeReply, challenge],
    ['native disposition', isDesktopNativeReply, disposition],
    ['native snapshot', isDesktopNativeReply, snapshot],
  ];
  for (const [name, validate, value] of shapes) {
    await t.test(name, () => {
      assert.equal(validate(value), true);
      for (const field of Object.keys(value)) {
        const missing = { ...value }; delete missing[field];
        assert.equal(validate(missing), false, `missing ${field}`);
      }
      for (const [field, extra] of Object.entries(forbiddenFields)) {
        assert.equal(validate({ ...value, [field]: extra }), false, `extra ${field}`);
      }
      for (const invalid of [null, undefined, true, 1, 'status', [], [value]]) assert.equal(validate(invalid), false);
    });
  }
});

test('restart attempts and frame epochs reject copied-shape or malformed identifiers', () => {
  for (const id of invalidIds) {
    assert.equal(isDesktopRestartCommand({ ...prepared, attemptId: id }), false);
    assert.equal(isRestartControlCommand({ ...prepare, attemptId: id }), false);
    assert.equal(isRestartControlCommand({ ...commit, attemptId: id }), false);
    assert.equal(isRestartControlCommand({ action: 'cancel', attemptId: id }), false);
    assert.equal(isRestartControlFrame({ ...frame, epoch: id }), false);
    assert.equal(isDesktopNativeReply({ ...challenge, attemptId: id }), false);
    assert.equal(isDesktopNativeReply({ ...disposition, attemptId: id }), false);
    if (id !== null) assert.equal(isRestartControlResult({ ...result, attemptId: id }), false);
  }
});

test('draft epochs and sequence IDs must be positive safe integers', () => {
  for (const value of invalidPositive) {
    assert.equal(isDesktopRestartCommand({ ...prepared, draftEpoch: value }), false);
    assert.equal(isRestartControlCommand({ ...prepare, draftEpoch: value }), false);
    assert.equal(isDesktopNativeReply({ ...challenge, draftEpoch: value }), false);
    assert.equal(isDesktopNativeReply({ ...disposition, draftEpoch: value }), false);
    assert.equal(isRestartControlFrame({ ...frame, id: value }), false);
  }
  for (const value of [1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isDesktopRestartCommand({ ...prepared, draftEpoch: value }), true);
    assert.equal(isRestartControlCommand({ ...prepare, draftEpoch: value }), true);
    assert.equal(isDesktopNativeReply({ ...challenge, draftEpoch: value }), true);
    assert.equal(isRestartControlFrame({ ...frame, id: value }), true);
  }
});

test('preparation, challenge and token expiry budgets have inclusive upper limits', () => {
  for (const value of [...invalidPositive, 5_001]) {
    assert.equal(isRestartControlCommand({ ...prepare, remainingMs: value }), false, `prepare ${String(value)}`);
    assert.equal(isDesktopNativeReply({ ...challenge, ttlMs: value }), false, `challenge ${String(value)}`);
  }
  for (const value of [1, 5_000]) {
    assert.equal(isRestartControlCommand({ ...prepare, remainingMs: value }), true);
    assert.equal(isDesktopNativeReply({ ...challenge, ttlMs: value }), true);
  }
  for (const value of [...invalidPositive.filter((item) => item !== null), 10_001]) {
    assert.equal(isRestartControlResult({ ...result, expiresInMs: value }), false, `expiry ${String(value)}`);
  }
  for (const value of [null, 1, 10_000]) assert.equal(isRestartControlResult({ ...result, expiresInMs: value }), true);
});

test('commit and result tokens cannot carry paths, URLs, whitespace or unbounded data', () => {
  for (const token of [...invalidTokens, null]) assert.equal(isRestartControlCommand({ ...commit, token }), false, String(token));
  for (const token of invalidTokens) assert.equal(isRestartControlResult({ ...result, token }), false, String(token));
  for (const token of ['a', 'A0._:-z', 'a'.repeat(256)]) {
    assert.equal(isRestartControlCommand({ ...commit, token }), true);
    assert.equal(isRestartControlResult({ ...result, token }), true);
  }
  assert.equal(isRestartControlResult({ ...result, token: null }), true);
});

test('native replies validate nested snapshots and have no extra native authority fields', () => {
  assert.equal(isDesktopNativeReply(snapshot), true);
  assert.equal(isDesktopNativeReply(challenge), true);
  for (const kind of ['restartAborted', 'restartUncertain']) {
    assert.equal(isDesktopNativeReply({ ...disposition, kind }), true);
    for (const invalid of [null, {}, { ...snapshot, phase: 'installed' }, { ...snapshot, installationAvailable: 'yes' }, { ...snapshot, path: '/tmp/payload' }]) {
      assert.equal(isDesktopNativeReply({ ...disposition, kind, snapshot: invalid }), false);
    }
  }
  for (const kind of ['restartCommitted', 'restartInstalled', 'restartChallenge', null, 1]) {
    assert.equal(isDesktopNativeReply({ ...disposition, kind }), false);
  }
  for (const protocolVersion of [undefined, null, 0, 2, '1']) {
    assert.equal(isDesktopNativeReply({ ...challenge, protocolVersion }), false);
    assert.equal(isDesktopNativeReply({ ...disposition, protocolVersion }), false);
    assert.equal(isRestartControlFrame({ ...frame, protocolVersion }), false);
  }
});

test('control frames recursively validate commands and disallow unrecognized kinds', () => {
  for (const command of [null, [], {}, { ...prepare, path: '/tmp/payload' }, { ...commit, token: 'https://attacker.test' }, { action: 'install' }, prepared]) {
    assert.equal(isRestartControlFrame({ ...frame, command }), false);
  }
  for (const kind of [undefined, null, 1, 'backendAttach', 'backendAttached', 'restartControlResult']) {
    assert.equal(isRestartControlFrame({ ...frame, kind }), false);
  }
});

test('control results validate bounded error codes and success/error agreement', () => {
  for (const state of ['open', 'preparing', 'prepared', 'committed']) assert.equal(isRestartControlResult({ ...result, state }), true);
  assert.equal(isRestartControlResult({ ok: true, state: 'open', attemptId: null, token: null, expiresInMs: null, error: null }), true);
  for (const error of ['busy', 'native_disconnected', 'a'.repeat(64)]) {
    assert.equal(isRestartControlResult({ ...result, ok: false, error }), true);
    assert.equal(isRestartControlResult({ ...result, error }), false);
  }
  for (const error of [undefined, null, '', 'a'.repeat(65), 'BAD', 'has space', 'code1', 'a\n', '/tmp/path', 'https://attacker.test', 1, []]) {
    assert.equal(isRestartControlResult({ ...result, ok: false, error }), false, String(error));
  }
  for (const ok of [undefined, null, 0, 1, 'true']) assert.equal(isRestartControlResult({ ...result, ok }), false);
  for (const state of [undefined, null, 1, '', 'installed', 'OPEN', {}]) assert.equal(isRestartControlResult({ ...result, state }), false);
});

test('control result state must be a literal string, never an array coerced to one', async (t) => {
  for (const state of ['open', 'preparing', 'prepared', 'committed']) {
    await t.test(state, () => {
      assert.equal(isRestartControlResult({ ...result, state: [state] }), false);
    });
  }
});
