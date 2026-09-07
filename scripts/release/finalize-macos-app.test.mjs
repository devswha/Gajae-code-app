import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { finalizeMacosApp } from './finalize-macos-app.mjs';
import { readAppRuntimeManifests, rebuildSignedMacosDesktop } from './rebuild-signed-macos-desktop.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const native = text => Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from(text)]);
const target = 'aarch64-apple-darwin';

async function fixture(t, { externalTarget = false } = {}) {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'gajae-signed-rebuild-test-')));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const rootDir = externalTarget ? join(fixtureRoot, 'source') : fixtureRoot;
  const appPath = join(rootDir, 'candidate/Gajae Code App.app');
  const payload = join(appPath, 'Contents/Resources/resources/server-payload');
  const desktop = join(appPath, 'Contents/MacOS/gajae-app-desktop');
  const targetDir = join(fixtureRoot, 'private cargo output');
  const rebuiltDesktop = join(targetDir, target, 'release/gajae-app-desktop');
  const addon = join(payload, 'node_modules/native/addon.node');
  const manifest = { schemaVersion: 1, platforms: { 'darwin-arm64': {
    files: [{ package: 'native', path: 'addon.node', sha256: hash(native('installed native')) }],
  } } };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifests = ['server', 'dist-server/server'].map(location => join(payload, location, 'gjc-runtime-manifest.json'));
  const sourceManifests = ['server', 'src-tauri/resources/server-payload/server', 'src-tauri/resources/server-payload/dist-server/server']
    .map(location => join(rootDir, location, 'gjc-runtime-manifest.json'));
  const files = [
    [addon, native('installed native')], [desktop, native('old shell')],
    [join(appPath, 'Contents/MacOS/gajae-app-server'), native('server')],
    [join(rootDir, 'src-tauri/entitlements.plist'), '<plist/>'],
    [join(rootDir, 'src-tauri/Cargo.toml'), '[package]\nname="fixture"\nversion="0.2.4"\n'],
    ...[...manifests, ...sourceManifests].map(path => [path, manifestBytes]),
  ];
  for (const [path, bytes] of files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o755 });
  }
  await mkdir(dirname(rebuiltDesktop), { recursive: true });
  const inheritedEnv = {
    CARGO_TARGET_DIR: externalTarget ? targetDir : '../private cargo output',
    RUSTUP_TOOLCHAIN: '1.85.1', MACOSX_DEPLOYMENT_TARGET: '13.0',
    GJC_UPDATE_MODE: 'qa', GJC_UPDATE_QA_ROOT: '/fixture/private-qa',
    GJC_UPDATE_PUBKEY: 'fixture-public-key', GJC_UPDATE_FEED_ORIGIN: 'https://fixture.invalid',
    TAURI_CONFIG: '{"version":"0.2.4"}', RUSTFLAGS: '-C target-cpu=apple-m1',
    GJC_SIGNED_RUNTIME_MANIFEST_SHA256: 'stale override',
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Fixture (AB12345678)',
  };
  const state = { rootDir, appPath, payload, desktop, addon, manifests, sourceManifests, manifestBytes,
    inheritedEnv, targetDir, rebuiltDesktop, calls: [], rebuiltBytes: native('rebuilt shell') };
  state.resolveTargetDirectory = async (root, env) => {
    state.calls.push({ command: 'metadata', env });
    assert.equal(root, rootDir);
    assert.equal(env.CARGO_TARGET_DIR, inheritedEnv.CARGO_TARGET_DIR);
    assert.equal(env.RUSTUP_TOOLCHAIN, '1.85.1');
    return state.invalidTarget ?? targetDir;
  };
  state.execute = async (command, args, options) => {
    state.calls.push({ command, args, options });
    if (command === 'security') return inheritedEnv.APPLE_SIGNING_IDENTITY;
    if (command === 'cargo') {
      assert.deepEqual(args, ['build', '--manifest-path', join(rootDir, 'src-tauri/Cargo.toml'),
        '--locked', '--release', '--target', target, '--features', 'tauri/custom-protocol']);
      assert.equal(options.cwd, join(rootDir, 'src-tauri'));
      const { bytes } = await readAppRuntimeManifests(appPath);
      assert.ok(bytes[0].equals(bytes[1]));
      assert.deepEqual(options.env, { ...inheritedEnv, GJC_SIGNED_RUNTIME_MANIFEST_SHA256: hash(bytes[0]) });
      state.atBuild?.(JSON.parse(bytes[0]));
      if (state.failBuild) throw new Error('fixture rebuild failure');
      if (!state.skipOutput) await writeFile(rebuiltDesktop, state.rebuiltBytes, { mode: 0o755 });
      await state.afterBuild?.();
      return '';
    }
    if (command === 'lipo') {
      if (state.failArchitecture) throw new Error('fixture wrong architecture');
      return '';
    }
    assert.equal(command, 'codesign', 'No real commands, signing or network is allowed in this suite.');
    if (args.includes('--sign') && args.at(-1) === addon) await writeFile(addon, native('signed native'));
    if (args.includes('--sign') && args.at(-1) === appPath) {
      assert.deepEqual(await readFile(desktop), state.rebuiltBytes, 'outer signature must seal the rebuilt shell');
    }
    if (args[0] === '-d') return ['allow-jit', 'allow-unsigned-executable-memory', 'disable-library-validation']
      .map(name => `<key>com.apple.security.cs.${name}</key>`).join('');
    return '';
  };
  state.finalize = () => finalizeMacosApp({ ...state, sourceRoot: rootDir, platform: 'darwin', arch: 'arm64' });
  state.rebuild = () => rebuildSignedMacosDesktop(state, state);
  return state;
}

test('finalizer signs natives, restamps both manifests, rebuilds/copies shell, then seals app without restamping again', async t => {
  const f = await fixture(t);
  const originalEnv = { ...f.inheritedEnv };
  f.atBuild = manifest => assert.equal(manifest.platforms['darwin-arm64'].files[0].sha256, hash(native('signed native')));
  const result = await f.finalize();
  const bytes = await readFile(f.manifests[0]);
  assert.deepEqual(bytes, await readFile(f.manifests[1]));
  assert.equal(result.payloadRuntimeManifestSha256, hash(bytes));
  assert.notEqual(result.payloadRuntimeManifestSha256, hash(f.manifestBytes));
  assert.deepEqual(await readFile(f.desktop), f.rebuiltBytes);
  assert.ok((await stat(f.desktop)).mode & 0o111);
  for (const path of f.sourceManifests) assert.deepEqual(await readFile(path), f.manifestBytes);
  assert.deepEqual(f.inheritedEnv, originalEnv);
  const stages = f.calls.filter(call => call.command === 'metadata' || call.command === 'cargo'
    || (call.command === 'codesign' && call.args.includes('--sign')))
    .map(call => call.command === 'codesign' ? call.args.at(-1) : call.command);
  assert.deepEqual(stages, [f.addon, join(f.appPath, 'Contents/MacOS/gajae-app-server'), 'metadata', 'cargo', f.appPath]);
  assert.equal(f.calls.filter(call => call.command === 'codesign' && call.args.includes('--sign') && call.args.at(-1) === f.addon).length, 1);
});

test('rebuild failure leaves the existing app executable untouched and never signs the outer app', async t => {
  const f = await fixture(t);
  f.failBuild = true;
  await writeFile(f.rebuiltDesktop, native('stale cached output'), { mode: 0o755 });
  await assert.rejects(f.finalize(), /fixture rebuild failure/);
  assert.deepEqual(await readFile(f.desktop), native('old shell'));
  assert.ok(!f.calls.some(call => call.command === 'codesign' && call.args.includes('--sign') && call.args.at(-1) === f.appPath));
});

test('native provenance failure prevents signing, rebuilding and restamping', async t => {
  const f = await fixture(t);
  await writeFile(f.addon, native('foreign bytes'));
  await assert.rejects(f.finalize(), /does not match its installed bytes/);
  assert.ok(f.calls.every(call => call.command === 'security'));
  for (const path of [...f.manifests, ...f.sourceManifests]) assert.deepEqual(await readFile(path), f.manifestBytes);
});

test('both manifests are mandatory, nonempty, bounded, and byte-identical before Cargo', async t => {
  for (const invalid of ['missing', 'empty', 'oversized', 'different']) {
    const f = await fixture(t);
    if (invalid === 'missing') await rm(f.manifests[1]);
    else await writeFile(f.manifests[1], invalid === 'empty' ? '' : invalid === 'oversized' ? Buffer.alloc(65537) : '{}\n');
    await assert.rejects(f.rebuild());
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await readFile(f.desktop), native('old shell'));
  }
});

test('linked manifests cannot rewrite source or payload outside the passed app', async t => {
  for (const kind of ['symlink', 'hardlink', 'parent-symlink']) {
    const f = await fixture(t);
    await rm(f.manifests[0]);
    if (kind === 'parent-symlink') {
      await rm(dirname(f.manifests[0]), { recursive: true });
      await symlink(dirname(f.sourceManifests[0]), dirname(f.manifests[0]));
    } else if (kind === 'symlink') await symlink(f.sourceManifests[0], f.manifests[0]);
    else await link(f.sourceManifests[0], f.manifests[0]);
    await assert.rejects(f.finalize(), /inside the passed app|regular app file/);
    assert.deepEqual(await readFile(f.sourceManifests[0]), f.manifestBytes);
    assert.ok(!f.calls.some(call => call.command === 'cargo' || call.command === 'codesign'));
  }
});

test('missing, empty, linked, nonexecutable and wrong-architecture rebuilds never replace the desktop', async t => {
  for (const invalid of ['missing', 'empty', 'symlink', 'nonexecutable', 'architecture']) {
    const f = await fixture(t);
    f.skipOutput = true;
    if (invalid === 'empty') await writeFile(f.rebuiltDesktop, '', { mode: 0o755 });
    if (invalid === 'symlink') await symlink(f.desktop, f.rebuiltDesktop);
    if (invalid === 'nonexecutable' || invalid === 'architecture') {
      await writeFile(f.rebuiltDesktop, f.rebuiltBytes, { mode: 0o755 });
      if (invalid === 'nonexecutable') await chmod(f.rebuiltDesktop, 0o600);
      else f.failArchitecture = true;
    }
    await assert.rejects(f.rebuild());
    assert.deepEqual(await readFile(f.desktop), native('old shell'));
  }
});

test('manifest drift during rebuild and linked copy destinations fail before copy', async t => {
  for (const change of ['manifest', 'desktop']) {
    const f = await fixture(t);
    f.afterBuild = async () => {
      if (change === 'manifest') await writeFile(f.manifests[0], '{}\n');
      else {
        await rm(f.desktop);
        await symlink(f.sourceManifests[0], f.desktop);
      }
    };
    await assert.rejects(f.rebuild(), /changed during|regular app file/);
    assert.deepEqual(await readFile(f.sourceManifests[0]), f.manifestBytes);
    if (change === 'manifest') assert.deepEqual(await readFile(f.desktop), native('old shell'));
  }
});

test('Cargo metadata is authoritative and must report an absolute target directory', async t => {
  const f = await fixture(t);
  f.invalidTarget = '../not-resolved';
  await assert.rejects(f.rebuild(), /must be absolute/);
  assert.deepEqual(f.calls.map(call => call.command), ['metadata']);
});

test('final signing preserves Rust 1.85.1 and uses the external absolute Cargo target', async t => {
  const f = await fixture(t, { externalTarget: true });
  assert.equal(dirname(f.targetDir), dirname(f.rootDir));
  const result = await f.finalize();
  const cargo = f.calls.find(call => call.command === 'cargo');
  assert.equal(cargo.options.env.RUSTUP_TOOLCHAIN, '1.85.1');
  assert.equal(cargo.options.env.CARGO_TARGET_DIR, f.targetDir);
  assert.deepEqual(await readFile(f.desktop), await readFile(f.rebuiltDesktop));
  assert.equal(result.payloadRuntimeManifestSha256, hash(await readFile(f.manifests[0])));
  for (const path of f.sourceManifests) assert.deepEqual(await readFile(path), f.manifestBytes);
});
