import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { installStageDependencies, SERVER_BUNDLE_INPUTS, stageBundleFiles, writeInstallPackageJson, writeRuntimePackageJson } from './build-server-bundle.js';
import { assertOutOfTree } from './out-of-tree.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const sourcePackage = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
const patchDirectory = 'patches/gjc-sdk-lifecycle';

async function fixture(t, { readme = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gajae-server-patch-stage-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); const stage = path.join(root, 'stage');
  await mkdir(stage, { recursive: true });
  for (const relative of SERVER_BUNDLE_INPUTS) {
    const filename = path.join(source, relative);
    if (['dist', 'dist-server', 'dist-native', 'public', 'shared'].includes(relative)) await mkdir(filename, { recursive: true });
    else { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, '{}'); }
  }
  const manifest = await readFile(path.join(repository, patchDirectory, 'manifest.json'));
  const applier = await readFile(path.join(repository, 'scripts/apply-sdk-lifecycle-patch.mjs'));
  await writeFile(path.join(source, patchDirectory, 'manifest.json'), manifest);
  await writeFile(path.join(source, 'scripts/apply-sdk-lifecycle-patch.mjs'), applier);
  await copyFile(path.join(repository, 'scripts/fix-node-pty.js'), path.join(source, 'scripts/fix-node-pty.js'));
  await writeFile(path.join(source, patchDirectory, 'manifest.test.mjs'), 'must not ship');
  await writeFile(path.join(source, patchDirectory, 'lifecycle.bun.test.ts'), 'must not ship');
  await writeFile(path.join(source, 'dist-server', 'index.js.map'), '{}');
  if (readme) await writeFile(path.join(source, patchDirectory, 'README.md'), 'app-owned patch evidence');
  await assertOutOfTree(stage, 'fixture stage');
  return { source, stage, manifest, applier };
}

test('root npm ci preserves node-pty repair and runs the canonical SDK applier without ancestry lookup', () => {
  assert.equal(sourcePackage.scripts.postinstall, 'node scripts/fix-node-pty.js && node scripts/apply-sdk-lifecycle-patch.mjs');
  assert.equal(sourcePackage.scripts['apply:sdk-patch'], 'node scripts/apply-sdk-lifecycle-patch.mjs');
  assert.equal(sourcePackage.scripts['check:sdk-patch'], 'node scripts/apply-sdk-lifecycle-patch.mjs --check');
  assert.ok(sourcePackage.files.includes(`${patchDirectory}/manifest.json`));
  assert.ok(sourcePackage.files.includes(`${patchDirectory}/README.md`));
  assert.deepEqual(sourcePackage.files.filter(input => input.startsWith('patches/')).sort(), [
    `${patchDirectory}/README.md`, `${patchDirectory}/manifest.json`,
  ]);
});

test('verify, npm test, direct e2e scripts and server builds reject an unapplied SDK before work', () => {
  for (const name of ['verify', 'pretest', 'test:e2e:gjc', 'test:e2e:browser', 'prebuild:server']) {
    assert.ok(sourcePackage.scripts[name].startsWith('npm run check:sdk-patch && '), name);
    assert.equal(sourcePackage.scripts[name].includes('npm run apply:sdk-patch'), false, `${name} must verify, not modify installed dependencies`);
  }
  for (const gate of ['audit', 'check:licenses', 'check:notices', 'typecheck', 'check:core', 'lint', 'check:identity', 'build']) {
    assert.ok(sourcePackage.scripts.verify.includes(`npm run ${gate}`), gate);
  }
  assert.ok(sourcePackage.scripts.verify.includes('npm test'));
});

test('server stage ships the exact patch manifest/applier and optional README, never patch tests', async t => {
  for (const readme of [true, false]) {
    const f = await fixture(t, { readme });
    await stageBundleFiles(f.stage, sourcePackage, f.source);
    assert.deepEqual(await readFile(path.join(f.stage, patchDirectory, 'manifest.json')), f.manifest);
    assert.deepEqual(await readFile(path.join(f.stage, 'scripts/apply-sdk-lifecycle-patch.mjs')), f.applier);
    assert.deepEqual((await readdir(path.join(f.stage, patchDirectory))).sort(), readme ? ['README.md', 'manifest.json'] : ['manifest.json']);
    await assert.rejects(stat(path.join(f.stage, 'dist-server/index.js.map')), { code: 'ENOENT' });
    const install = JSON.parse(await readFile(path.join(f.stage, 'package.json'), 'utf8'));
    assert.deepEqual(install.scripts, Object.fromEntries(['postinstall', 'apply:sdk-patch', 'check:sdk-patch'].map(name => [name, sourcePackage.scripts[name]])));
    assert.equal(install.scripts.prepare, undefined);
    assert.deepEqual(install.dependencies, sourcePackage.dependencies);
    await writeRuntimePackageJson(f.stage, sourcePackage);
    const runtime = JSON.parse(await readFile(path.join(f.stage, 'package.json'), 'utf8'));
    assert.deepEqual(runtime.scripts, { start: 'node scripts/gajae-app-runtime.mjs start', 'check:sdk-patch': sourcePackage.scripts['check:sdk-patch'] });
    assert.equal(runtime.engines.node, '>=22.22.2 <23');
    assert.deepEqual(await readFile(path.join(f.stage, patchDirectory, 'manifest.json')), f.manifest);
  }
});

test('server npm ci retains the root hook and runs check-only before accepting runtime versions', async t => {
  const f = await fixture(t); await stageBundleFiles(f.stage, sourcePackage, f.source);
  const calls = [];
  await installStageDependencies(f.stage, {
    run: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      if (command === 'npm') {
        const staged = JSON.parse(await readFile(path.join(options.cwd, 'package.json'), 'utf8'));
        assert.equal(staged.scripts.postinstall, sourcePackage.scripts.postinstall);
      }
    },
    verifyVersions: async directory => { calls.push({ versions: directory }); },
  });
  assert.deepEqual(calls, [
    { command: 'npm', args: ['ci', '--omit=dev'], cwd: f.stage },
    { command: process.execPath, args: ['scripts/apply-sdk-lifecycle-patch.mjs', '--check'], cwd: f.stage },
    { versions: f.stage },
  ]);
  await assert.rejects(stat(path.join(f.stage, 'node_modules')), { code: 'ENOENT' });
});

test('an unapplied or hash-invalid server SDK aborts staging instead of being accepted or repatched', async t => {
  const f = await fixture(t); await stageBundleFiles(f.stage, sourcePackage, f.source);
  for (const reason of ['SDK lifecycle patch has not been applied.', 'SDK lifecycle source digest mismatch.']) {
    const calls = [];
    await assert.rejects(installStageDependencies(f.stage, {
      run: async (_command, args) => { calls.push(args); if (args.includes('--check')) throw new Error(reason); },
      verifyVersions: async () => assert.fail('patch verification must succeed first'),
    }), error => error.message === reason);
    assert.deepEqual(calls, [['ci', '--omit=dev'], ['scripts/apply-sdk-lifecycle-patch.mjs', '--check']]);
  }
  await assert.rejects(stat(path.join(f.stage, 'node_modules')), { code: 'ENOENT' });
});

test('missing install hooks or patch evidence fail closed in a fresh stage', async t => {
  const f = await fixture(t);
  await assert.rejects(writeInstallPackageJson(f.stage, { ...sourcePackage, scripts: {} }), /Missing required SDK installation script/);
  await rm(path.join(f.source, patchDirectory, 'manifest.json'));
  await assert.rejects(stageBundleFiles(f.stage, sourcePackage, f.source), { code: 'ENOENT' });
});

test('a staged checker cannot use the checkout SDK, even when invoked from the checkout', async t => {
  const f = await fixture(t); await stageBundleFiles(f.stage, sourcePackage, f.source);
  // No dependency tree is created or modified. The copied checker must fail
  // against the stage's missing SDK, not resolve the checkout through cwd.
  const result = spawnSync(process.execPath, [path.join(f.stage, 'scripts/apply-sdk-lifecycle-patch.mjs'), '--check'], {
    cwd: repository, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(repository, 'node_modules') },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
  assert.ok(result.stderr.includes(path.join(f.stage, 'node_modules')));
  await assert.rejects(stat(path.join(f.stage, 'node_modules')), { code: 'ENOENT' });
});

test('the npm-style stage-relative checker executes from a fresh symlinked install cwd', async t => {
  const f = await fixture(t); await stageBundleFiles(f.stage, sourcePackage, f.source);
  const alias = path.join(f.source, 'install-alias');
  await symlink(f.stage, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, ['scripts/apply-sdk-lifecycle-patch.mjs', '--check'], {
    cwd: alias, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(repository, 'node_modules') },
  });
  assert.notEqual(result.status, 0, 'the stage-relative main guard must run, not silently succeed');
  assert.match(result.stderr, /ENOENT/);
  assert.ok(result.stderr.includes(path.join(f.stage, 'node_modules')));
  await assert.rejects(stat(path.join(f.stage, 'node_modules')), { code: 'ENOENT' });
});

test('both packaging smokes verify the staged patch out of tree without weakening existing native and exclusion checks', async () => {
  const desktop = await readFile(new URL('./build-desktop-server-payload.mjs', import.meta.url), 'utf8');
  const server = await readFile(new URL('./build-server-bundle.js', import.meta.url), 'utf8');
  assert.match(desktop, /withOutOfTreeCopy\(payloadDir[\s\S]*?\['scripts\/apply-sdk-lifecycle-patch\.mjs', '--check'\], \{ cwd: copyDir, env \}/);
  assert.match(server, /withOutOfTreeCopy\(stageDir[\s\S]*?\['scripts\/apply-sdk-lifecycle-patch\.mjs', '--check'\], \{ cwd: copyDir, env \}/);
  for (const source of [desktop, server]) {
    assert.match(source, /const BUN_VERSION = '1\.4\.0'/);
    assert.match(source, /'better-sqlite3', 'node-pty'/);
    assert.match(source, /removeExcludedDistributionPackages/);
    assert.match(source, /pty\.spawn/);
    assert.match(source, /worker\.initialize/);
    assert.match(source, /worker\.shutdown/);
  }
  assert.match(desktop, /NODE_VERSION = DESKTOP_NODE_VERSION/);
  assert.match(desktop, /desktop\.nodeSha256/);
  assert.match(desktop, /pruneForeignPrebuilds/);
  assert.match(server, /TARGET_NODE_VERSION = \[22, 22, 2\]/);
  assert.match(server, /TARGET_GLIBC_VERSION = \[2, 35, 0\]/);
  assert.match(server, /await auditGlibcRequirements\(stageDir\)/);
});
