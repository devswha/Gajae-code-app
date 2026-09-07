import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertDeveloperSignature,
  assertNotarizedAssessment,
  assertManualBuildInfo,
  parseVtoolBuildMinimums,
  verifyMacosApp,
  verifyMacosDeploymentFloor,
  verifyMacosRelease,
} from './local-release-macos.mjs';
import { createUpdaterArchive, inventoryApp } from './updater-archive.mjs';

const teamId = 'AB12345678';
const signature = `Authority=Developer ID Application: Fixture (${teamId})\nTeamIdentifier=${teamId}\nCodeDirectory v=20500 size=400 flags=0x10000(runtime) hashes=12\n`;
const payloadModules = 'Contents/Resources/resources/server-payload/node_modules';
const simulatorResource = `${payloadModules}/bare-fs/prebuilds/ios-arm64-simulator/bare-fs.bare`;

function vtoolStamp(platform, minimum = '14.0', header = 'x:') {
  return `${header}\nLoad command 9\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform ${platform}\n    minos ${minimum}\n      sdk 17.5\n   ntools 1\n     tool LD\n  version 1053.12\n`;
}

async function addMachO(state, app, relativePath, output) {
  const path = join(app, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, Buffer.from('cffaedfe00000000', 'hex'), { mode: 0o600 });
  state.vtoolOutputByPath ??= new Map();
  state.vtoolOutputByPath.set(path, output);
  return path;
}

async function deploymentFixture(t) {
  const state = await fixture(t);
  await state.run('hdiutil', ['attach']);
  const app = join(state.input.root, 'mount/Gajae Code App.app');
  return { state, app, verify: async () => verifyMacosDeploymentFloor({
    app, minimumSystemVersion: '13.0', inventory: await inventoryApp(app),
  }, { run: state.run }) };
}

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
  state.run = async (program, args, options) => {
    state.calls.push({ program, args, ...(options?.output ? { options } : {}) });
    if (state.fail?.(program, args)) throw new Error('Simulated acceptance failure');
    if (program === 'hdiutil' && args[0] === 'attach') {
      const app = join(root, 'mount/Gajae Code App.app');
      const payload = join(app, 'Contents/Resources/resources/server-payload');
      await mkdir(payload, { recursive: true });
      await writeFile(join(payload, 'package.json'), JSON.stringify({ name: 'gajae-app', version: state.packageVersion }));
      await mkdir(join(payload, 'server'), { recursive: true });
      await writeFile(join(payload, 'server/gjc-runtime-manifest.json'), '{"signed":"fixture"}\n');
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
      if (state.afterMount) await state.afterMount(app);
    }
    if (program === 'ditto') {
      await cp(args[0], args[1], { recursive: true });
      if (state.alterCopy) await state.alterCopy(args[1]);
      if (!state.archiveReady && !state.skipArchive) {
        await createUpdaterArchive({ appPath: args[1], archivePath: input.updaterArchivePath });
        state.archiveReady = true;
      }
    }
    if (args[0] === '--desktop-build-info') {
      assert.ok(program.includes('/copy/'));
      assert.equal(options.timeout, 10_000);
      assert.equal(options.maxOutputBytes, 4096);
      await writeFile(options.output, state.buildInfoText ?? JSON.stringify({
        schemaVersion: 1, packageName: 'gajae-app', productVersion: input.version,
        desktopVersion: input.desktopVersion, debug: false, updateMode: 'disabled',
        runtimeManifestSha256: input.runtimeManifestSha256,
        payloadRuntimeManifestSha256: createHash('sha256').update('{"signed":"fixture"}\n').digest('hex'),
        ...state.buildInfoOverrides,
      }), { flag: 'wx', mode: 0o600 });
      if (state.afterDiagnostic) await state.afterDiagnostic();
      return { stdout: '', stderr: state.buildInfoStderr ?? '' };
    }
    if (program === 'codesign' && args[0] === '--display') return { stdout: '', stderr: state.signature ?? signature };
    if (program === 'spctl') return { stdout: '', stderr: `${args.at(-1)}: accepted\nsource=Notarized Developer ID\n` };
    if (program === 'xcrun' && args[0] === 'vtool') {
      if (state.vtoolOutputByPath?.has(args.at(-1))) return { stdout: state.vtoolOutputByPath.get(args.at(-1)), stderr: '' };
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

test('only matching vendor iOS bare prebuilds are reported separately from qualified macOS stamps', async t => {
  const { state, app, verify } = await deploymentFixture(t);
  const expected = [];
  for (const arch of ['arm64', 'x64']) {
    for (const simulator of [false, true]) {
      const path = `${payloadModules}/bare-fs/prebuilds/ios-${arch}${simulator ? '-simulator' : ''}/bare-fs.bare`;
      const platform = simulator ? 'IOSSIMULATOR' : 'IOS';
      await addMachO(state, app, path, vtoolStamp(platform));
      expected.push({ path: `Gajae Code App.app/${path}`, platform, minimumSystemVersions: ['14.0'] });
    }
  }
  const result = await verify();
  assert.equal(result.nonMacResourceCount, 4);
  assert.deepEqual(result.nonMacResources, expected.sort((a, b) => a.path < b.path ? -1 : 1));
  assert.equal(result.maximumStampedMinimumSystemVersion, '13.0');
  assert.equal(result.stamps.length, 7);
  assert.ok(result.stamps.every(stamp => !stamp.path.endsWith('.bare') && stamp.minimumSystemVersion === '13.0'));
  assert.equal(state.calls.filter(call => call.args[0] === 'vtool').length, 11);
});

test('uniform universal slices count as one non-Mac resource; public parser remains strictly MACOS', async t => {
  const { state, app, verify } = await deploymentFixture(t);
  const output = vtoolStamp('IOSSIMULATOR', '14.0', 'x (architecture arm64):')
    + vtoolStamp('IOSSIMULATOR', '15.0', 'x (architecture x86_64):');
  await addMachO(state, app, simulatorResource, output);
  const result = await verify();
  assert.equal(result.nonMacResourceCount, 1);
  assert.deepEqual(result.nonMacResources[0].minimumSystemVersions, ['14.0', '15.0']);
  for (const platform of ['IOS', 'IOSSIMULATOR', 'TVOS', 'UNKNOWN']) {
    assert.throws(() => parseVtoolBuildMinimums(vtoolStamp(platform)), /unsupported/);
  }
  assert.throws(() => parseVtoolBuildMinimums(output, 'resource', { allowForeign: true }), /unsupported/);
  assert.deepEqual(parseVtoolBuildMinimums(vtoolStamp('MACOS', '12.0', 'x (architecture arm64):')
    + vtoolStamp('MACOS', '13.0', 'x (architecture x86_64):')), ['12.0', '13.0']);
});

test('foreign binaries outside the exact canonical resource path fail closed', async t => {
  for (const path of [
    'Contents/Resources/node_modules/bare-fs/prebuilds/ios-arm64-simulator/bare-fs.bare',
    'Contents/Resources/server-payload/node_modules/bare-fs/prebuilds/ios-arm64-simulator/bare-fs.bare',
    `${payloadModules}/other/prebuilds/ios-arm64-simulator/bare-fs.bare`,
    `${payloadModules}/@vendor/bare-fs/prebuilds/ios-arm64-simulator/bare-fs.bare`,
    `${payloadModules}/nested/node_modules/bare-fs/prebuilds/ios-arm64-simulator/bare-fs.bare`,
    `${payloadModules}/bare-fs/prebuilds/darwin-arm64/bare-fs.bare`,
    `${payloadModules}/bare-fs/prebuilds/ios-armv7-simulator/bare-fs.bare`,
    `${payloadModules}/bare-fs/prebuilds/ios-arm64-simulator/nested/bare-fs.bare`,
    `${payloadModules}/bare-fs/prebuilds/ios-arm64-simulator/bare-fs.node`,
    `${simulatorResource}.backup`,
    'Contents/Resources/unlisted-helper',
  ]) {
    await t.test(path, async t => {
      const { state, app, verify } = await deploymentFixture(t);
      await addMachO(state, app, path, vtoolStamp('IOSSIMULATOR'));
      await assert.rejects(verify(), /unsupported foreign platform/);
    });
  }
});

test('iOS paths never exempt MACOS binaries from the declared macOS 13 floor', async t => {
  const { state, app, verify } = await deploymentFixture(t);
  const path = await addMachO(state, app, simulatorResource, vtoolStamp('MACOS'));
  await assert.rejects(verify(), /bare-fs\.bare requires macOS 14\.0/);
  state.vtoolOutputByPath.set(path, vtoolStamp('MACOS', '13.0'));
  const result = await verify();
  assert.equal(result.nonMacResourceCount, 0);
  assert.deepEqual(result.nonMacResources, []);
  assert.ok(result.stamps.some(stamp => stamp.path.endsWith(simulatorResource)));
});

test('iOS resources reject unexpected, malformed, duplicate and mixed platform evidence', async t => {
  const valid = vtoolStamp('IOSSIMULATOR');
  for (const [name, output] of [
    ['device stamp in simulator folder', vtoolStamp('IOS')],
    ['unknown platform', vtoolStamp('UNKNOWN')],
    ['other foreign platform', vtoolStamp('TVOS')],
    ['missing platform', valid.replace(' platform IOSSIMULATOR\n', '')],
    ['missing minimum', valid.replace('    minos 14.0\n', '')],
    ['invalid minimum', valid.replace('minos 14.0', 'minos 14.0garbage')],
    ['unbounded minimum', valid.replace('minos 14.0', 'minos 1000.0')],
    ['noncanonical minimum', valid.replace('minos 14.0', 'minos 014.0')],
    ['duplicate platform', `${valid} platform IOSSIMULATOR\n`],
    ['duplicate minimum', `${valid} minos 14.0\n`],
    ['malformed extra platform', `${valid} platform MACOS garbage\n`],
    ['malformed extra minimum', `${valid} minos invalid\n`],
    ['orphan evidence', ` platform IOSSIMULATOR\n${valid}`],
    ['missing load-command boundary', valid.replace('Load command 9\n', '')],
    ['missing command', valid.replace('      cmd LC_BUILD_VERSION\n', '')],
    ['duplicate command', `${valid} cmd LC_BUILD_VERSION\n`],
    ['duplicate stamp in slice', `${valid}Load command 10\n cmd LC_BUILD_VERSION\n platform IOSSIMULATOR\n minos 14.0\n`],
    ['duplicate thin slice', valid + valid],
    ['duplicate architecture', vtoolStamp('IOSSIMULATOR', '14.0', 'x (architecture arm64):').repeat(2)],
    ['truncated second slice', `${vtoolStamp('IOSSIMULATOR', '14.0', 'x (architecture arm64):')}x (architecture x86_64):\n`],
    ['mixed iOS platforms', vtoolStamp('IOSSIMULATOR', '14.0', 'x (architecture arm64):')
      + vtoolStamp('IOS', '14.0', 'x (architecture x86_64):')],
    ['mixed Mac and iOS platforms', vtoolStamp('MACOS', '13.0', 'x (architecture arm64):')
      + vtoolStamp('IOSSIMULATOR', '14.0', 'x (architecture x86_64):')],
    ['unsupported legacy command', valid.replace('LC_BUILD_VERSION', 'LC_VERSION_MIN_IPHONEOS')],
    ['unexpected text', `${valid}not vtool output\n`],
  ]) {
    await t.test(name, async t => {
      const { state, app, verify } = await deploymentFixture(t);
      await addMachO(state, app, simulatorResource, output);
      await assert.rejects(verify(), /evidence|vtool|unsupported|bounded|mixed/);
    });
  }
  const { state, app, verify } = await deploymentFixture(t);
  await addMachO(state, app, simulatorResource.replace('-simulator', ''), valid);
  await assert.rejects(verify(), /unsupported foreign platform/);
});

test('required executables and runtime modules never qualify as non-Mac resources', async t => {
  for (const path of [
    'Contents/MacOS/gajae-app-desktop',
    'Contents/MacOS/gajae-app-server',
    'Contents/Resources/resources/server-payload/dist-native/bun',
    'Contents/Resources/resources/server-payload/dist-native/gajae-core',
    `${payloadModules}/test-addon/addon.node`,
    `${payloadModules}/@vscode/ripgrep/bin/rg`,
    `${payloadModules}/node-pty/build/Release/spawn-helper`,
  ]) {
    await t.test(path, async t => {
      const { state, app, verify } = await deploymentFixture(t);
      await addMachO(state, app, simulatorResource, vtoolStamp('IOSSIMULATOR'));
      await addMachO(state, app, path, vtoolStamp('IOS'));
      await assert.rejects(verify(), /unsupported foreign platform/);
    });
  }
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

async function manualFixture(t) {
  const state = await fixture(t);
  delete state.input.updaterArchivePath;
  state.input.manualDisabled = true;
  state.input.runtimeManifestSha256 = 'c'.repeat(64);
  state.skipArchive = true;
  return state;
}

test('explicit manual mode validates DMG and both apps before the bounded copied-binary diagnostic', async t => {
  const state = await manualFixture(t);
  const result = await state.execute();
  assert.equal(result.updateMode, 'disabled');
  assert.equal(result.buildInfo.updateMode, 'disabled');
  assert.equal(result.buildInfo.runtimeManifestSha256, state.input.runtimeManifestSha256);
  assert.equal(result.deployment.nonMacResourceCount, 0);
  assert.equal(result.deployment.maximumStampedMinimumSystemVersion, '13.0');
  assert.equal(result.extractedApp, undefined);
  assert.ok((await readFile(join(result.copiedApp, 'Contents/MacOS/gajae-app-desktop'))).length > 0);
  const diagnosticIndex = state.calls.findIndex(call => call.args.includes('--desktop-build-info'));
  assert.ok(diagnosticIndex > 0);
  for (const target of [state.input.dmg, join(state.input.root, 'mount/Gajae Code App.app'), result.copiedApp]) {
    for (const program of ['codesign', 'spctl', 'xcrun']) {
      assert.ok(state.calls.slice(0, diagnosticIndex).some(call => call.program === program && call.args.at(-1) === target));
    }
  }
  assert.equal(state.calls.filter(call => call.program === 'lipo').length, 4);
  assert.ok(state.calls.slice(0, diagnosticIndex).some(call => call.args[0] === 'vtool' && call.args.at(-1).includes('/copy/')));
  assert.equal(state.calls.filter(call => call.args[0] === '--desktop-build-info').length, 1);
  assert.equal(state.calls.at(-1).args[0], 'detach');
  assert.ok(!state.calls.some(call => call.args.some(arg => /--sign|--qa|--browser|\.app\.tar\.gz/.test(arg))));
});

test('manual release exposes inspected resource evidence from the validated copy', async t => {
  const state = await manualFixture(t);
  state.afterMount = async app => {
    const output = vtoolStamp('IOSSIMULATOR');
    await addMachO(state, app, simulatorResource, output);
    state.vtoolOutputByPath.set(join(state.input.root, 'copy/Gajae Code App.app', simulatorResource), output);
  };
  const result = await state.execute();
  assert.equal(result.deployment.nonMacResourceCount, 1);
  assert.deepEqual(result.deployment.nonMacResources, [{
    path: `Gajae Code App.app/${simulatorResource}`, platform: 'IOSSIMULATOR', minimumSystemVersions: ['14.0'],
  }]);
  assert.equal(result.deployment.maximumStampedMinimumSystemVersion, '13.0');
  const resourceChecks = state.calls.filter(call => call.args[0] === 'vtool' && call.args.at(-1).endsWith(simulatorResource));
  assert.equal(resourceChecks.length, 2);
});

test('manual flag is explicit, mutually exclusive with updater archives, and requires private root and source hash', async t => {
  for (const modify of [
    input => { delete input.manualDisabled; },
    input => { input.manualDisabled = 'true'; },
    input => { input.manualDisabled = false; },
    input => { input.updaterArchivePath = 'archive.tar.gz'; },
    input => { input.updaterArchivePath = null; },
    input => { delete input.runtimeManifestSha256; },
    input => { input.runtimeManifestSha256 = 'bad'; },
  ]) {
    const state = await manualFixture(t);
    modify(state.input);
    await assert.rejects(state.execute());
    assert.equal(state.calls.length, 0);
  }
  const state = await manualFixture(t);
  await chmod(state.input.root, 0o755);
  await assert.rejects(state.execute(), /owner-only/);
  assert.equal(state.calls.length, 0);
});

test('build info requires exact typed schema, disabled mode and every pinned compile-time identity', () => {
  const expected = { version: '2.0.0-beta.10', desktopVersion: '0.2.4', runtimeManifestSha256: 'c'.repeat(64), payloadRuntimeManifestSha256: 'e'.repeat(64) };
  const good = { schemaVersion: 1, packageName: 'gajae-app', productVersion: expected.version,
    desktopVersion: expected.desktopVersion, debug: false, updateMode: 'disabled', runtimeManifestSha256: expected.runtimeManifestSha256,
    payloadRuntimeManifestSha256: expected.payloadRuntimeManifestSha256 };
  assert.deepEqual(assertManualBuildInfo(JSON.stringify(good), expected), good);
  for (const [key, value] of [
    ['schemaVersion', '1'], ['schemaVersion', 2], ['packageName', 'other'], ['productVersion', '2.0.0-beta.9'],
    ['desktopVersion', '0.2.3'], ['debug', true], ['debug', 'false'], ['updateMode', 'enabled'],
    ['updateMode', 'qa'], ['runtimeManifestSha256', 'd'.repeat(64)], ['extra', true],
    ['payloadRuntimeManifestSha256', 'd'.repeat(64)],
  ]) assert.throws(() => assertManualBuildInfo(JSON.stringify({ ...good, [key]: value }), expected));
  for (const key of Object.keys(good)) {
    const missing = { ...good };
    delete missing[key];
    assert.throws(() => assertManualBuildInfo(JSON.stringify(missing), expected));
  }
  for (const text of ['null', '[]', '{}', 'not JSON', `${JSON.stringify(good)}\n{}`, ' '.repeat(4097),
    JSON.stringify(good).replace('"debug":false', '"debug":true,"debug":false')]) {
    assert.throws(() => assertManualBuildInfo(text, expected));
  }
});

test('manual signing, staple, Gatekeeper, architecture and loader failures never launch the diagnostic', async t => {
  for (const fail of [
    (program, args) => program === 'codesign' && args.at(-1).endsWith('.dmg'),
    (program, args) => program === 'codesign' && args.at(-1).includes('/copy/'),
    (program, args) => program === 'xcrun' && args[0] === 'stapler',
    program => program === 'spctl',
    program => program === 'lipo',
    (program, args) => program === 'xcrun' && args[0] === 'vtool',
  ]) {
    const state = await manualFixture(t);
    state.fail = fail;
    await assert.rejects(state.execute(), /acceptance failure/);
    assert.ok(!state.calls.some(call => call.args[0] === '--desktop-build-info'));
    if (state.calls.some(call => call.args[0] === 'attach')) assert.equal(state.calls.at(-1).args[0], 'detach');
  }
});

test('manual mode fails closed on diagnostic absence, malformed output, updater enabled and diagnostics', async t => {
  for (const change of [
    state => { state.buildInfoOverrides = { updateMode: 'enabled' }; },
    state => { state.buildInfoOverrides = { debug: true }; },
    state => { state.buildInfoText = '{}'; },
    state => { state.buildInfoText = ' '.repeat(4097); },
    state => { state.buildInfoStderr = 'unexpected diagnostics'; },
    state => { state.fail = (_, args) => args[0] === '--desktop-build-info'; },
  ]) {
    const state = await manualFixture(t);
    change(state);
    await assert.rejects(state.execute());
    assert.equal(state.calls.at(-1).args[0], 'detach');
  }
});

test('manual copied app must match the mounted app and remain unchanged after diagnostic', async t => {
  for (const after of [false, true]) {
    const state = await manualFixture(t);
    const mutate = copiedApp => writeFile(join(copiedApp, 'Contents/MacOS/gajae-app-server'), 'different signed bytes');
    if (after) state.afterDiagnostic = () => mutate(join(state.input.root, 'copy/Gajae Code App.app'));
    else state.alterCopy = mutate;
    await assert.rejects(state.execute(), /bytes differ/);
    assert.equal(state.calls.at(-1).args[0], 'detach');
    assert.equal(state.calls.some(call => call.args[0] === '--desktop-build-info'), after);
  }
});

test('deployment floor finds extensionless and fat Mach-O helpers by bytes, regardless of executable mode', async t => {
  for (const magic of ['cffaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']) {
    const state = await fixture(t);
    const app = join(state.input.root, 'mount/Gajae Code App.app');
    await state.run('hdiutil', ['attach']);
    const helper = join(app, 'Contents/Resources/unlisted-helper');
    await writeFile(helper, Buffer.from(`${magic}00000000`, 'hex'), { mode: 0o600 });
    state.vtoolMinimumByPath = new Map([[helper, '14.0']]);
    await assert.rejects(verifyMacosDeploymentFloor({ app, minimumSystemVersion: '13.0', inventory: await inventoryApp(app) },
      { run: state.run }), /unlisted-helper.*requires macOS 14\.0/);
  }
});

test('manual failed detachment retains the private copy and reports its directory', async t => {
  const state = await manualFixture(t);
  state.fail = (program, args) => program === 'hdiutil' && args[0] === 'detach';
  await assert.rejects(state.execute(), error => error.preserveDirectory === true && error.message.includes(state.input.root));
});
