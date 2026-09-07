import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertDeveloperSignature,
  assertNotarizedAssessment,
  parseVtoolBuildMinimums,
  verifyMacosApp,
  verifyMacosDeploymentFloor,
  verifyMacosRelease,
} from './local-release-macos.mjs';
import { createUpdaterArchive, inventoryApp } from './updater-archive.mjs';

const teamId = 'AB12345678';
const signature = `Authority=Developer ID Application: Fixture (${teamId})\nTeamIdentifier=${teamId}\nCodeDirectory v=20500 size=400 flags=0x10000(runtime) hashes=12\n`;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gajae-macos-validation-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dmg = join(root, 'original.dmg');
  await writeFile(dmg, 'original immutable image fixture');
  const input = {
    dmg,
    root,
    version: '2.0.0-beta.99',
    desktopVersion: '0.2.2',
    minimumSystemVersion: '13.0',
    updaterArchivePath: join(root, 'verified.app.tar.gz'),
    teamId,
  };
  const state = { input, calls: [], packageVersion: input.version, desktopVersion: input.desktopVersion };
  state.run = async (program, args) => {
    state.calls.push({ program, args });
    if (state.fail?.(program, args)) throw new Error('Simulated acceptance failure');
    if (program === 'hdiutil' && args[0] === 'attach') {
      const app = join(root, 'mount/Gajae Code App.app');
      const payload = join(app, 'Contents/Resources/resources/server-payload');
      await mkdir(payload, { recursive: true });
      await writeFile(join(payload, 'package.json'), JSON.stringify({ name: 'gajae-app', version: state.packageVersion }));
      await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
      await mkdir(join(payload, 'dist-native'), { recursive: true });
      await writeFile(join(payload, 'dist-native/libfixture.dylib'), 'Mach-O dylib fixture');
      await writeFile(join(payload, 'dist-native/libfixture.so'), 'Mach-O shared-object fixture');
      await mkdir(join(payload, 'node_modules/test-addon'), { recursive: true });
      await writeFile(join(payload, 'node_modules/test-addon/addon.node'), 'Mach-O native module fixture');
      for (const path of [
        'Contents/MacOS/gajae-app-desktop',
        'Contents/MacOS/gajae-app-server',
        'Contents/Resources/resources/server-payload/dist-native/bun',
        'Contents/Resources/resources/server-payload/dist-native/gajae-core',
      ]) {
        const file = join(app, path);
        await mkdir(join(file, '..'), { recursive: true });
        await writeFile(file, 'Mach-O fixture');
      }
    }
    if (program === 'ditto') {
      await cp(args[0], args[1], { recursive: true });
      if (!state.archiveReady && !state.skipArchive) {
        await createUpdaterArchive({ appPath: args[1], archivePath: input.updaterArchivePath });
        state.archiveReady = true;
      }
    }
    if (program === 'codesign' && args[0] === '--display') return { stdout: '', stderr: state.signature ?? signature };
    if (program === 'spctl') return { stdout: '', stderr: `${args.at(-1)}: accepted\nsource=Notarized Developer ID\n` };
    if (program === 'xcrun' && args[0] === 'vtool') {
      if (state.vtoolOutput !== undefined) return { stdout: state.vtoolOutput, stderr: '' };
      const minimum = state.vtoolMinimumByPath?.get(args.at(-1)) ?? state.vtoolMinimum ?? '13.0';
      return {
        stdout: `${args.at(-1)}:\nLoad command 1\n cmd LC_BUILD_VERSION\n platform MACOS\n minos ${minimum}\n sdk 26.5\n`,
        stderr: '',
      };
    }
    if (program === '/usr/libexec/PlistBuddy') {
      const command = args[1];
      const output = command.includes('CFBundleIdentifier')
        ? 'app.gajae.desktop\n'
        : command.includes('LSMinimumSystemVersion')
          ? `${state.appMinimumSystemVersion ?? input.minimumSystemVersion}\n`
          : `${state.desktopVersion}\n`;
      return { stdout: output, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  state.execute = () => verifyMacosRelease(input, { run: state.run });
  return state;
}

test('only an explicit Developer ID team and hardened app signature are accepted', () => {
  assertDeveloperSignature(signature, teamId, { hardened: true });
  for (const output of ['Signature=adhoc\nTeamIdentifier=not set', signature.replace(teamId, 'OTHERTEAM1').replace(`TeamIdentifier=${teamId}`, 'TeamIdentifier=OTHERTEAM1'),
    signature.replace('Developer ID Application:', 'Apple Development:')]) {
    assert.throws(() => assertDeveloperSignature(output, teamId));
  }
  assert.throws(() => assertDeveloperSignature(signature.replace('(runtime)', '(none)'), teamId, { hardened: true }), /hardened/);
  assert.throws(() => assertNotarizedAssessment('app: accepted\nsource=Developer ID\n'), /Gatekeeper/);
  assert.throws(() => assertNotarizedAssessment('app: rejected\nsource=Notarized Developer ID\n'), /Gatekeeper/);
});

test('verifyMacosApp performs read-only finalized-app checks without copying or quarantine', async t => {
  const state = await fixture(t);
  const app = join(state.input.root, 'mount/Gajae Code App.app');
  await state.run('hdiutil', ['attach', state.input.dmg, '-nobrowse', '-readonly', '-mountpoint', join(state.input.root, 'mount')]);
  await verifyMacosApp({
    app,
    teamId,
    version: state.input.version,
    desktopVersion: state.input.desktopVersion,
    minimumSystemVersion: state.input.minimumSystemVersion,
  }, { run: state.run });
  assert.ok(state.calls.some(call => call.program === 'codesign' && call.args.at(-1) === app));
  assert.ok(state.calls.some(call => call.program === 'xcrun' && call.args.at(-1) === app));
  assert.ok(state.calls.some(call => call.program === 'spctl' && call.args.at(-1) === app));
  assert.ok(!state.calls.some(call => call.program === 'ditto' || call.program === 'xattr'));
});

test('deployment floor rejects metadata 11 when Bun is stamped for macOS 13', async t => {
  const state = await fixture(t);
  const app = join(state.input.root, 'mount/Gajae Code App.app');
  await state.run('hdiutil', ['attach', state.input.dmg, '-nobrowse', '-readonly', '-mountpoint', join(state.input.root, 'mount')]);
  const inventory = await inventoryApp(app);
  state.appMinimumSystemVersion = '11.0';
  state.vtoolMinimum = '11.0';
  state.vtoolMinimumByPath = new Map([[
    join(app, 'Contents/Resources/resources/server-payload/dist-native/bun'),
    '13.0',
  ]]);
  await assert.rejects(() => verifyMacosApp({
    app, teamId, version: state.input.version, desktopVersion: state.input.desktopVersion,
    minimumSystemVersion: '11.0', inventory,
  }, { run: state.run }), /Bun|requires macOS 13\.0|above declared/);
});

test('deployment floor accepts matching macOS 13 evidence and rejects malformed vtool output', async t => {
  const state = await fixture(t);
  const app = join(state.input.root, 'mount/Gajae Code App.app');
  await state.run('hdiutil', ['attach', state.input.dmg, '-nobrowse', '-readonly', '-mountpoint', join(state.input.root, 'mount')]);
  const inventory = await inventoryApp(app);
  const valid = await verifyMacosDeploymentFloor({
    app, minimumSystemVersion: '13.0', inventory,
  }, { run: state.run });
  assert.equal(valid.maximumStampedMinimumSystemVersion, '13.0');
  state.vtoolOutput = 'not vtool output';
  await assert.rejects(() => verifyMacosDeploymentFloor({
    app, minimumSystemVersion: '13.0', inventory,
  }, { run: state.run }), /LC_BUILD_VERSION|vtool output/);
});

test('vtool parser rejects unsupported or malformed deployment stamps', () => {
  assert.deepEqual(parseVtoolBuildMinimums(
    'x:\nLoad command 1\n cmd LC_BUILD_VERSION\n platform MACOS\n minos 13.0\n',
  ), ['13.0']);
  assert.throws(() => parseVtoolBuildMinimums(
    'x:\nLoad command 1\n cmd LC_BUILD_VERSION\n platform IOS\n minos 13.0\n',
  ), /unsupported/);
  assert.throws(() => parseVtoolBuildMinimums(
    'x:\nLoad command 1\n cmd LC_BUILD_VERSION\n platform MACOS\n',
  ), /missing|LC_BUILD_VERSION/);
  assert.throws(() => parseVtoolBuildMinimums(
    'x:\nLoad command 1\n cmd LC_BUILD_VERSION\n platform MACOS\n minos 13.0\n'
      + 'Load command 2\n cmd LC_VERSION_MIN_MACOSX\n version 11.0\n',
  ), /unsupported|LC_VERSION_MIN_MACOSX/);
});

test('deployment floor includes dylib and shared-object runtime modules', async t => {
  const state = await fixture(t);
  const app = join(state.input.root, 'mount/Gajae Code App.app');
  await state.run('hdiutil', ['attach', state.input.dmg, '-nobrowse', '-readonly', '-mountpoint', join(state.input.root, 'mount')]);
  const inventory = await inventoryApp(app);
  const dylib = join(app, 'Contents/Resources/resources/server-payload/dist-native/libfixture.dylib');
  state.vtoolMinimumByPath = new Map([[dylib, '14.0']]);
  await assert.rejects(() => verifyMacosDeploymentFloor({
    app, minimumSystemVersion: '13.0', inventory,
  }, { run: state.run }), /libfixture\.dylib|requires macOS 14\.0/);
});

test('deployment floor rejects vtool diagnostics and malformed command results', async t => {
  const state = await fixture(t);
  const app = join(state.input.root, 'mount/Gajae Code App.app');
  await state.run('hdiutil', ['attach', state.input.dmg, '-nobrowse', '-readonly', '-mountpoint', join(state.input.root, 'mount')]);
  const inventory = await inventoryApp(app);
  state.vtoolStderr = 'warning';
  await assert.rejects(() => verifyMacosDeploymentFloor({
    app, minimumSystemVersion: '13.0', inventory,
  }, { run: async (program, args, options) => {
    const result = await state.run(program, args, options);
    if (program === 'xcrun' && args[0] === 'vtool') result.stderr = state.vtoolStderr;
    return result;
  } }), /stderr|diagnostics/);
  await assert.rejects(() => verifyMacosDeploymentFloor({
    app, minimumSystemVersion: '13.0', inventory,
  }, { run: async (program, args) => {
    if (program === 'xcrun' && args[0] === 'vtool') return { stdout: 13, stderr: '' };
    return state.run(program, args);
  } }), /invalid shape/);
});

test('DMG, mounted app, quarantined copy and extracted updater app all undergo validation', async t => {
  const state = await fixture(t);
  const result = await state.execute();
  const targets = [state.input.dmg, join(state.input.root, 'mount/Gajae Code App.app'), join(state.input.root, 'copy/Gajae Code App.app'), result.extractedApp];
  for (const target of targets) {
    assert.ok(state.calls.some(call => call.program === 'codesign' && call.args[0] === '--verify' && call.args.at(-1) === target));
    assert.ok(state.calls.some(call => call.program === 'xcrun' && call.args[0] === 'stapler' && call.args[1] === 'validate' && call.args.at(-1) === target));
    assert.ok(state.calls.some(call => call.program === 'spctl' && call.args.at(-1) === target));
  }
  const quarantine = state.calls.filter(call => call.program === 'xattr');
  assert.equal(quarantine.length, 1);
  assert.equal(quarantine[0].args.at(-1), targets[2]);
  assert.equal(state.calls.filter(call => call.program === 'lipo').length, 6);
  assert.equal(result.archive.inventory.entries.length, result.inventory.entries.length);
  assert.deepEqual(state.calls.at(-1), { program: 'hdiutil', args: ['detach', join(state.input.root, 'mount')] });
  assert.equal(await readFile(state.input.dmg, 'utf8'), 'original immutable image fixture');
  assert.ok(!state.calls.some(call => call.args.includes('--sign') || call.args.includes('staple') || call.args.includes('submit')));
});

test('a bad DMG signature blocks before mounting', async t => {
  const state = await fixture(t);
  state.signature = 'Signature=adhoc\nTeamIdentifier=not set\n';
  await assert.rejects(state.execute(), /Developer ID/);
  assert.ok(!state.calls.some(call => call.program === 'hdiutil' && call.args[0] === 'attach'));
});

test('a missing updater archive is a hard failure rather than DMG-only verification', async t => {
  const state = await fixture(t);
  state.skipArchive = true;
  await assert.rejects(state.execute(), /archive|ENOENT|regular file/i);
  assert.equal(state.calls.at(-1).args[0], 'detach');
  assert.ok(!state.calls.some(call => call.program === 'codesign' && call.args.at(-1).includes('.updater-extract-')));
});

test('app payload and desktop versions are independently checked against the pinned source', async t => {
  for (const field of ['packageVersion', 'desktopVersion']) {
    const state = await fixture(t);
    state[field] = '1.0.0';
    await assert.rejects(state.execute(), /version|Version/);
    assert.equal(state.calls.at(-1).args[0], 'detach');
  }
});

test('the pinned minimum system version is required on both DMG and updater apps', async t => {
  const state = await fixture(t);
  state.appMinimumSystemVersion = '14.0';
  await assert.rejects(state.execute(), /minimumSystemVersion|LSMinimumSystemVersion/);
  assert.equal(state.calls.at(-1).args[0], 'detach');
});

test('copy-only signature rejection, absent staples and architecture errors all detach the image', async t => {
  for (const fail of [
    (program, args) => program === 'codesign' && args[0] === '--verify' && args.at(-1).includes('/copy/'),
    (program, args) => program === 'xcrun' && args.at(-1).includes('/copy/'),
    program => program === 'lipo',
  ]) {
    const state = await fixture(t);
    state.fail = fail;
    await assert.rejects(state.execute(), /acceptance failure/);
    assert.equal(state.calls.at(-1).args[0], 'detach');
  }
});

test('failed detachment preserves the temporary directory instead of risking deletion through a mount', async t => {
  const state = await fixture(t);
  state.fail = (program, args) => program === 'hdiutil' && args[0] === 'detach';
  await assert.rejects(state.execute(), error => error.preserveDirectory === true && error.message.includes(state.input.root));
});
