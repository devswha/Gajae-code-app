import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DESKTOP_PAYLOAD_INPUTS, finalizeDesktopPayloadMetadata, installDesktopPayloadDependencies, restrictRuntimeDependencies, stageDesktopPayloadFiles } from './build-desktop-server-payload.mjs';
import { assertOutOfTree } from './out-of-tree.mjs';

test('a rejected Node archive cleans the download, incomplete payload and sidecar on Linux and Mac', async t => {
  for (const [platform, arch, target] of [['linux', 'x64', 'x86_64-unknown-linux-gnu'], ['darwin', 'arm64', 'aarch64-apple-darwin']]) {
    await t.test(platform, async t => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'gajae-payload-cleanup-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      await mkdir(path.join(root, 'scripts/release'), { recursive: true });
      for (const file of ['build-desktop-server-payload.mjs', 'build-linux-server-payload.mjs', 'build-macos-server-payload.mjs', 'desktop-platforms.mjs', 'desktop-prebuilds.mjs', 'distribution-exclusions.mjs', 'out-of-tree.mjs', 'packaged-server-paths.mjs']) {
        await copyFile(new URL(file, import.meta.url), path.join(root, 'scripts/release', file));
      }
      for (const directory of ['dist', 'dist-server', 'shared', 'public', 'tmp', 'src-tauri/binaries']) await mkdir(path.join(root, directory), { recursive: true });
      for (const file of ['package.json', 'package-lock.json', 'server/gjc-runtime-manifest.json', 'scripts/fix-node-pty.js', 'scripts/gajae-app-runtime.mjs', 'scripts/apply-sdk-lifecycle-patch.mjs', 'patches/gjc-sdk-lifecycle/manifest.json', 'scripts/apply-extract-zip-patch.mjs', 'patches/extract-zip-symlink-leaf/manifest.json', 'dist-native/bun', 'dist-native/gajae-core', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), '{}');
      }
      const sidecar = path.join(root, 'src-tauri/binaries', `gajae-app-server-${target}`);
      await writeFile(sidecar, 'previous sidecar');
      const preload = path.join(root, 'download.cjs');
      await writeFile(preload, `
        Object.defineProperty(process, 'platform', { value: process.env.TEST_PLATFORM });
        Object.defineProperty(process, 'arch', { value: process.env.TEST_ARCH });
        process.report.getReport = () => ({ header: { glibcVersionRuntime: '2.35' } });
        global.fetch = async () => ({ ok: true, body: [Buffer.from('corrupted archive')] });
      `);
      const result = spawnSync(process.execPath, ['--require', preload, path.join(root, 'scripts/release/build-desktop-server-payload.mjs')], {
        env: { ...process.env, TMPDIR: path.join(root, 'tmp'), TEST_PLATFORM: platform, TEST_ARCH: arch }, encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Pinned Node archive failed SHA-256 verification/);
      await assert.rejects(stat(path.join(root, 'src-tauri/resources/server-payload')), { code: 'ENOENT' });
      await assert.rejects(stat(sidecar), { code: 'ENOENT' });
      assert.deepEqual(await readdir(path.join(root, 'tmp')), []);
      const wrapper = path.join(root, 'scripts/release', platform === 'linux' ? 'build-linux-server-payload.mjs' : 'build-macos-server-payload.mjs');
      const linked = path.join(root, 'payload-entry.mjs');
      await symlink(wrapper, linked);
      for (const entry of [wrapper, linked]) {
        const invoked = spawnSync(process.execPath, ['--require', preload, entry], {
          env: { ...process.env, TMPDIR: path.join(root, 'tmp'), TEST_PLATFORM: platform, TEST_ARCH: arch }, encoding: 'utf8',
        });
        assert.notEqual(invoked.status, 0, 'wrapper must execute its payload builder');
        assert.match(invoked.stderr, /Pinned Node archive failed SHA-256 verification/);
        await assert.rejects(stat(path.join(root, 'src-tauri/resources/server-payload')), { code: 'ENOENT' });
      }
    });
  }
});

async function fixture(t, { readme = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gajae-payload-install-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); const stage = path.join(root, 'stage');
  await mkdir(stage, { recursive: true });
  for (const input of DESKTOP_PAYLOAD_INPUTS) {
    const filename = path.join(source, input);
    if (['dist', 'dist-server', 'shared', 'public', 'dist-native'].includes(input)) await mkdir(filename, { recursive: true });
    else { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, '{}'); }
  }
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  await writeFile(path.join(source, 'package.json'), JSON.stringify(packageJson));
  await copyFile(new URL('../../package-lock.json', import.meta.url), path.join(source, 'package-lock.json'));
  const patch = 'patches/gjc-sdk-lifecycle';
  const manifest = await readFile(new URL(`../../${patch}/manifest.json`, import.meta.url));
  const applier = await readFile(new URL('../apply-sdk-lifecycle-patch.mjs', import.meta.url));
  await writeFile(path.join(source, patch, 'manifest.json'), manifest);
  await writeFile(path.join(source, 'scripts/apply-sdk-lifecycle-patch.mjs'), applier);
  for (const input of ['scripts/apply-extract-zip-patch.mjs', 'patches/extract-zip-symlink-leaf/manifest.json']) {
    await copyFile(new URL(`../../${input}`, import.meta.url), path.join(source, input));
  }
  await writeFile(path.join(source, patch, 'lifecycle.bun.test.ts'), 'must not ship');
  await writeFile(path.join(source, patch, 'manifest.test.mjs'), 'must not ship');
  if (readme) await writeFile(path.join(source, patch, 'README.md'), 'app-owned patch evidence');
  await assertOutOfTree(stage, 'fixture stage');
  return { source, stage, patch, manifest, applier, packageJson };
}

test('desktop stage copies only canonical patch inputs, retaining evidence without patch tests', async t => {
  for (const readme of [true, false]) {
    const f = await fixture(t, { readme });
    await stageDesktopPayloadFiles(f.source, f.stage);
    assert.deepEqual(await readFile(path.join(f.stage, f.patch, 'manifest.json')), f.manifest);
    assert.deepEqual(await readFile(path.join(f.stage, 'scripts/apply-sdk-lifecycle-patch.mjs')), f.applier);
    assert.deepEqual((await readdir(path.join(f.stage, f.patch))).sort(), readme ? ['README.md', 'manifest.json'] : ['manifest.json']);
    await restrictRuntimeDependencies(f.stage);
    const install = JSON.parse(await readFile(path.join(f.stage, 'package.json'), 'utf8'));
    assert.deepEqual(install.scripts, Object.fromEntries(['postinstall', 'apply:sdk-patch', 'check:sdk-patch', 'apply:extract-zip-patch', 'check:extract-zip-patch'].map(name => [name, f.packageJson.scripts[name]])));
    assert.equal(install.dependencies['@gajae-code/coding-agent'], f.packageJson.dependencies['@gajae-code/coding-agent']);
    assert.equal(install.devDependencies, undefined);
    assert.equal(install.optionalDependencies, undefined);
    assert.equal(install.scripts.prepare, undefined);
    await finalizeDesktopPayloadMetadata(f.stage);
    const runtime = JSON.parse(await readFile(path.join(f.stage, 'package.json'), 'utf8'));
    assert.deepEqual(runtime.scripts, { 'check:sdk-patch': f.packageJson.scripts['check:sdk-patch'], 'check:extract-zip-patch': f.packageJson.scripts['check:extract-zip-patch'] });
    for (const input of ['scripts/apply-extract-zip-patch.mjs', 'patches/extract-zip-symlink-leaf/manifest.json']) {
      assert.deepEqual(await readFile(path.join(f.stage, input)), await readFile(new URL(`../../${input}`, import.meta.url)));
    }
    await assert.rejects(stat(path.join(f.stage, 'scripts/fix-node-pty.js')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(f.stage, f.patch, 'manifest.json')), f.manifest);
  }
});

test('desktop npm ci uses the source postinstall then verifies before rebuilding the pinned native modules', async t => {
  const f = await fixture(t); await stageDesktopPayloadFiles(f.source, f.stage);
  const calls = []; const env = { PATH: '/fixture/pinned-node/bin:/usr/bin:/bin' };
  const node = '/fixture/pinned-node/bin/node'; const npm = '/fixture/pinned-node/lib/node_modules/npm/bin/npm-cli.js';
  await installDesktopPayloadDependencies(node, npm, env, f.stage, async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('ci')) {
      const staged = JSON.parse(await readFile(path.join(options.cwd, 'package.json'), 'utf8'));
      assert.equal(staged.scripts.postinstall, f.packageJson.scripts.postinstall);
      assert.equal(args.includes('--ignore-scripts'), false);
    }
  });
  assert.ok(calls.every(call => call.command === node && call.options.cwd === f.stage));
  assert.deepEqual(calls.map(call => call.args), [
    [npm, 'install', '--package-lock-only', '--ignore-scripts', '--omit=dev'],
    [npm, 'ci', '--omit=dev'],
    ['scripts/apply-sdk-lifecycle-patch.mjs', '--check'],
    ['scripts/apply-extract-zip-patch.mjs', '--check'],
    [npm, 'rebuild', '--omit=dev', '--build-from-source', 'better-sqlite3', 'node-pty'],
    [path.join(f.stage, 'scripts/fix-node-pty.js')],
  ]);
  assert.equal(calls[4].options.env.npm_config_build_from_source, 'true');
  await assert.rejects(stat(path.join(f.stage, 'node_modules')), { code: 'ENOENT' });
});

test('unverified ZIP patch stops desktop staging before native rebuilding', async t => {
  const f = await fixture(t); await stageDesktopPayloadFiles(f.source, f.stage);
  const calls = [];
  await assert.rejects(installDesktopPayloadDependencies('/fixture/node', '/fixture/npm', {}, f.stage, async (_command, args) => {
    calls.push(args);
    if (args[0] === 'scripts/apply-extract-zip-patch.mjs') throw new Error('ZIP patch missing');
  }), /ZIP patch missing/);
  assert.equal(calls.length, 4);
  assert.equal(calls.some(args => args.includes('rebuild')), false);
  await rm(path.join(f.source, 'patches/extract-zip-symlink-leaf/manifest.json'));
  await assert.rejects(stageDesktopPayloadFiles(f.source, f.stage), { code: 'ENOENT' });
});

test('an unapplied desktop SDK stops before native rebuilding instead of applying outside postinstall', async t => {
  const f = await fixture(t); await stageDesktopPayloadFiles(f.source, f.stage);
  const calls = [];
  await assert.rejects(installDesktopPayloadDependencies('/fixture/node', '/fixture/npm', {}, f.stage, async (_command, args) => {
    calls.push(args);
    if (args.includes('--check')) throw new Error('SDK lifecycle patch has not been applied.');
  }), /has not been applied/);
  assert.equal(calls.length, 3);
  assert.equal(calls.some(args => args.includes('rebuild')), false);
  await assert.rejects(stat(path.join(f.stage, 'node_modules')), { code: 'ENOENT' });
});
