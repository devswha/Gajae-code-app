import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import '../patches/gjc-sdk-lifecycle/manifest.test.mjs';
import { applySdkLifecyclePatch } from './apply-sdk-lifecycle-patch.mjs';

test('installed patched SDK passes the real retained-lifetime contract with isolated fixture data', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'patches/gjc-sdk-lifecycle/manifest.json'), 'utf8'));
  await applySdkLifecyclePatch(root, manifest, { checkOnly: true });
  const bun = path.join(root, 'dist-native', process.platform === 'win32' ? 'bun.exe' : 'bun');
  const version = spawnSync(bun, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(version.status, 0, version.error?.message ?? version.stderr);
  assert.equal(version.stdout.trim(), '1.4.0');
  const env = { ...process.env, GJC_SDK_LIFECYCLE_CANDIDATE: root };
  for (const key of ['TMUX', 'TMUX_PANE', 'KITTY_WINDOW_ID', 'TERM_SESSION_ID', 'WT_SESSION']) delete env[key];
  // The candidate dependencies are read-only; every test creates its own data
  // directory and offline provider. Nothing is copied into a shipped payload.
  const result = spawnSync(bun, ['test', 'patches/gjc-sdk-lifecycle/lifecycle.bun.test.ts'], {
    cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /\n [1-9][0-9]* pass\n/u);
  assert.match(result.stderr, /\n 0 fail\n/u);
});
