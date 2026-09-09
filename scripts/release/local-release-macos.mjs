import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { basename, join } from 'node:path';

import semver from 'semver';

import { DESKTOP_APP_ID, PACKAGE_NAME, PRODUCT_NAME, PRODUCT_TOKEN } from '../../shared/productIdentity.js';

import { releaseCommand } from './local-release-command.mjs';
import { assertOutOfTree } from './out-of-tree.mjs';
import {
  compareAppInventories,
  cleanupUpdaterExtraction,
  extractUpdaterArchive,
  inventoryApp,
} from './updater-archive.mjs';
import { readUpdaterSidecar } from './updater-signature.mjs';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const MAX_PACKAGE_BYTES = 64 * 1024;
const MAX_VTOOL_OUTPUT_BYTES = 64 * 1024;
const MAX_BUILD_INFO_BYTES = 4096;
const MACHO_MAGICS = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe',
  'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const MACOS_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const REQUIRED_MACHO_PATHS = Object.freeze([
  `Contents/MacOS/${PRODUCT_TOKEN}-desktop`,
  `Contents/MacOS/${PRODUCT_TOKEN}-server`,
  'Contents/Resources/resources/server-payload/dist-native/bun',
  'Contents/Resources/resources/server-payload/dist-native/gajae-core',
]);
const PAYLOAD_MODULES_PREFIX = `${PRODUCT_NAME}.app/Contents/Resources/resources/server-payload/node_modules/`;
const IOS_BARE_PREBUILD = /^bare-[a-z0-9][a-z0-9._-]*\/prebuilds\/ios-(?:arm64|x64)(-simulator)?\/[^/]+\.bare$/;

function strictMacosVersion(value, label) {
  requireValue(typeof value === 'string' && MACOS_VERSION.test(value)
    && value.split('.').every(part => Number(part) <= 999), `${label} must be a bounded macOS version.`);
  const normalized = value.split('.').length === 2 ? `${value}.0` : value;
  const parsed = semver.parse(normalized);
  requireValue(parsed?.version === normalized, `${label} is malformed.`);
  return { text: value, parsed };
}

async function nativeMachOPaths(app, inventory) {
  requireValue(inventory !== null && typeof inventory === 'object' && !Array.isArray(inventory)
    && inventory.root === `${PRODUCT_NAME}.app` && Array.isArray(inventory.entries),
  `A canonical ${PRODUCT_NAME}.app inventory is required for Mach-O deployment verification.`);
  const entries = inventory.entries;
  const files = new Map(entries.filter(entry => entry?.type === 'file').map(entry => [entry.path, entry]));
  const required = REQUIRED_MACHO_PATHS.map(path => `${PRODUCT_NAME}.app/${path}`);
  for (const path of required) {
    requireValue(files.has(path), `Required bundled Mach-O is missing from the app inventory: ${path}.`);
  }
  const paths = new Set(required);
  for (const entry of entries) {
    const path = entry.path;
    // Names alone miss extensionless helpers and framework executables. Read
    // only four bytes from each inventoried regular file, never a symlink.
    if (entry.type === 'file' && !paths.has(path)) {
      requireValue(path.startsWith(`${PRODUCT_NAME}.app/`)
        && !path.split('/').some(part => part === '..' || part === '.' || part === ''),
      'Mach-O inventory path must remain inside the app.');
      const fd = await open(join(app, path.slice(`${PRODUCT_NAME}.app/`.length)),
        constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      try {
        requireValue((await fd.stat()).isFile(), 'Mach-O inventory member must remain a regular file.');
        const magic = Buffer.alloc(4);
        const { bytesRead } = await fd.read(magic, 0, 4, 0);
        if (bytesRead === 4 && MACHO_MAGICS.has(magic.toString('hex'))) paths.add(path);
      } finally {
        await fd.close();
      }
    }
    if (/\.(?:node|dylib|so)$/iu.test(path)
      || path.endsWith('/@vscode/ripgrep/bin/rg')
      || path.endsWith('/node-pty/build/Release/spawn-helper')) {
      requireValue(entry.type === 'file' || entry.type === 'symlink',
        `Native runtime module is not a regular file or internal symlink: ${path}.`);
      paths.add(path);
    }
  }
  return [...paths].sort().map(path => ({
    path,
    absolute: join(app, path.slice(`${PRODUCT_NAME}.app/`.length)),
  }));
}

/**
 * Parse one `xcrun vtool -show-build` result. vtool is the authority for
 * Mach-O load commands; this parser only validates its bounded textual output
 * and never interprets binary bytes itself.
 */
function parseVtoolBuildStamps(output, label) {
  requireValue(typeof output === 'string' && Buffer.byteLength(output, 'utf8') > 0
    && Buffer.byteLength(output, 'utf8') <= MAX_VTOOL_OUTPUT_BYTES,
  `${label} vtool output is missing or oversized.`);
  const lines = output.split(/\r?\n/);
  const stamps = [];
  const slices = new Set();
  let filename;
  let universal;
  let current;
  const finishSlice = () => {
    requireValue(current?.cmd === 'LC_BUILD_VERSION' && current.platform !== undefined && current.minos !== undefined,
      `${label} has missing or unsupported LC_BUILD_VERSION evidence.`);
    requireValue(['MACOS', 'IOS', 'IOSSIMULATOR'].includes(current.platform),
      `${label} has unsupported LC_BUILD_VERSION platform evidence.`);
    strictMacosVersion(current.minos, `${label} ${current.platform} minos`);
    stamps.push(Object.freeze({ platform: current.platform, minos: current.minos }));
  };
  for (const line of lines) {
    if (line.trim() === '') continue;
    const header = /^(\S.*?)(?: \(architecture ([A-Za-z0-9_]+)\))?:$/.exec(line);
    if (header) {
      if (filename !== undefined) finishSlice();
      const isUniversal = header[2] !== undefined;
      const slice = header[2] ?? 'thin';
      requireValue((filename === undefined || filename === header[1])
        && (universal === undefined || universal === isUniversal) && !slices.has(slice),
      `${label} has duplicate or inconsistent vtool slice evidence.`);
      filename = header[1];
      universal = isUniversal;
      slices.add(slice);
      current = undefined;
      continue;
    }
    if (/^Load command (?:0|[1-9]\d*)$/.test(line)) {
      requireValue(filename !== undefined && current === undefined,
        `${label} has duplicate or unsupported load-command evidence.`);
      current = {};
      continue;
    }
    const field = /^\s*(cmd|platform|minos|cmdsize|sdk|ntools)\s+(\S+)\s*$/.exec(line);
    if (field) {
      const [, key, value] = field;
      requireValue(current !== undefined && (key === 'cmd' || current.cmd === 'LC_BUILD_VERSION'),
        `${label} has misplaced LC_BUILD_VERSION evidence.`);
      requireValue(current[key] === undefined, `${label} has duplicate vtool ${key} evidence.`);
      if (key === 'cmd') requireValue(value === 'LC_BUILD_VERSION', `${label} contains an unsupported load command.`);
      else if (key === 'platform') requireValue(/^[A-Z][A-Z0-9_]*$/.test(value), `${label} has malformed platform evidence.`);
      else requireValue((key === 'cmdsize' || key === 'ntools' ? /^(0|[1-9]\d*)$/ : /^\d+(?:\.\d+){1,2}$/).test(value),
        `${label} has malformed vtool ${key} evidence.`);
      current[key] = value;
      continue;
    }
    // Linker/tool metadata is not deployment evidence, but malformed or
    // unrecognized lines must not hide an extra platform/minimum stamp.
    requireValue(current?.cmd === 'LC_BUILD_VERSION'
      && /^\s*(?:tool\s+[A-Za-z0-9_]+|version\s+\d+(?:\.\d+){1,2})\s*$/.test(line),
    `${label} has malformed vtool output or LC_BUILD_VERSION evidence.`);
  }
  finishSlice();
  requireValue(stamps.every(stamp => stamp.platform === stamps[0].platform),
    `${label} has mixed LC_BUILD_VERSION platforms.`);
  return Object.freeze(stamps);
}

/** Public parser remains strictly macOS; resource classification is internal. */
export function parseVtoolBuildMinimums(output, label = 'Mach-O') {
  const stamps = parseVtoolBuildStamps(output, label);
  requireValue(stamps.every(stamp => stamp.platform === 'MACOS'),
    `${label} has missing or unsupported LC_BUILD_VERSION evidence.`);
  return Object.freeze(stamps.map(stamp => stamp.minos));
}

/**
 * Require every bundled Mach-O's deployment stamp to be no newer than the
 * declared minimum system version. The inventory supplies a bounded list of
 * required executables/modules; vtool supplies the actual loader evidence.
 */
export async function verifyMacosDeploymentFloor({
  app,
  minimumSystemVersion,
  inventory,
}, { run = releaseCommand } = {}) {
  const declared = strictMacosVersion(minimumSystemVersion, 'minimumSystemVersion');
  const paths = await nativeMachOPaths(app, inventory);
  const stamps = [];
  const nonMacResources = [];
  for (const item of paths) {
    const result = await run('xcrun', ['vtool', '-show-build', item.absolute], {
      maxOutputBytes: MAX_VTOOL_OUTPUT_BYTES,
    });
    requireValue(result !== null && typeof result === 'object' && !Array.isArray(result)
      && typeof result.stdout === 'string' && typeof result.stderr === 'string',
    `${item.path} vtool result has an invalid shape.`);
    requireValue(result.stderr === '', `${item.path} vtool wrote diagnostics to stderr.`);
    const output = result.stdout;
    const buildStamps = parseVtoolBuildStamps(output, item.path);
    const platform = buildStamps[0].platform;
    if (platform !== 'MACOS') {
      const resource = item.path.startsWith(PAYLOAD_MODULES_PREFIX)
        ? IOS_BARE_PREBUILD.exec(item.path.slice(PAYLOAD_MODULES_PREFIX.length)) : null;
      requireValue(resource && platform === (resource[1] ? 'IOSSIMULATOR' : 'IOS'),
        `${item.path} has unsupported foreign platform ${platform} outside its matching iOS bare prebuild resource path.`);
      nonMacResources.push(Object.freeze({ path: item.path, platform,
        minimumSystemVersions: Object.freeze(buildStamps.map(stamp => stamp.minos)) }));
      continue;
    }
    const minimums = buildStamps.map(stamp => stamp.minos);
    for (const minimum of minimums) {
      const parsed = strictMacosVersion(minimum, `${item.path} minos`);
      requireValue(semver.lte(parsed.parsed, declared.parsed),
        `Bundled Mach-O ${item.path} requires macOS ${minimum} , above declared minimum ${minimumSystemVersion}.`);
      stamps.push({ path: item.path, minimumSystemVersion: minimum });
    }
  }
  return Object.freeze({
    declaredMinimumSystemVersion: declared.text,
    maximumStampedMinimumSystemVersion: stamps.reduce((max, item) => (
      semver.gt(strictMacosVersion(item.minimumSystemVersion, 'Mach-O minimum').parsed, strictMacosVersion(max, 'Mach-O maximum').parsed)
        ? item.minimumSystemVersion : max
    ), '0.0'),
    stamps: Object.freeze(stamps),
    nonMacResourceCount: nonMacResources.length,
    nonMacResources: Object.freeze(nonMacResources),
  });
}

async function readRegularJson(path) {
  const fd = await open(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = await fd.stat();
    requireValue(stat.isFile() && stat.size <= MAX_PACKAGE_BYTES, `App metadata must be a bounded regular file: ${path}.`);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of fd.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      requireValue(bytes <= MAX_PACKAGE_BYTES, `App metadata exceeds its size limit: ${path}.`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await fd.close().catch(() => {});
  }
}

export function assertDeveloperSignature(output, teamId, { hardened = false } = {}) {
  requireValue(!/^Signature=adhoc$/m.test(output)
    && /^Authority=Developer ID Application: .+$/m.test(output)
    && output.split(/\r?\n/).includes(`TeamIdentifier=${teamId}`), 'Expected a Developer ID Application signature from the specified team.');
  if (hardened) requireValue(/^.*flags=.+\bruntime\b.*$/m.test(output), 'App signature lacks hardened runtime.');
}

export function assertNotarizedAssessment(output) {
  requireValue(/: accepted\s*$/m.test(output) && /^source=Notarized Developer ID\s*$/m.test(output), 'Gatekeeper did not accept Notarized Developer ID.');
}

/** The signed executable must positively attest its compile-time disabled mode. */
export function assertManualBuildInfo(text, { version, desktopVersion, runtimeManifestSha256, payloadRuntimeManifestSha256 }) {
  requireValue(typeof runtimeManifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(runtimeManifestSha256),
    'The pinned source runtimeManifestSha256 is required for manual verification.');
  requireValue(typeof payloadRuntimeManifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(payloadRuntimeManifestSha256),
    'The verified signed payload runtime manifest SHA-256 is required.');
  requireValue(typeof text === 'string' && Buffer.byteLength(text) <= MAX_BUILD_INFO_BYTES,
    'Desktop build info is missing or oversized.');
  let info;
  try { info = JSON.parse(text); } catch { throw new Error('Desktop build info must be exactly one JSON object.'); }
  const expected = { schemaVersion: 1, packageName: PACKAGE_NAME, productVersion: version,
    desktopVersion, debug: false, updateMode: 'disabled', runtimeManifestSha256, payloadRuntimeManifestSha256 };
  requireValue(info !== null && typeof info === 'object' && !Array.isArray(info)
    && JSON.stringify(Object.keys(info).sort()) === JSON.stringify(Object.keys(expected).sort()),
  'Desktop build info must contain exactly the eight schema fields.');
  // This schema is flat and all accepted values are primitives. Count keys
  // in the original text as well so JSON.parse cannot hide duplicate fields.
  const keys = [...text.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)];
  requireValue(keys.length === Object.keys(expected).length, 'Desktop build info contains duplicate fields.');
  for (const [key, value] of Object.entries(expected)) {
    requireValue(info[key] === value, `Desktop build info ${key} does not match the pinned manual-disabled build.`);
  }
  return Object.freeze(info);
}

/**
 * Read-only checks for one finalized app bundle. The caller is responsible
 * for making any disposable copy or applying quarantine before invoking this
 * helper; it never signs, staples, mutates, or copies the app.
 */
export async function verifyMacosApp({
  app,
  teamId,
  version,
  desktopVersion,
  minimumSystemVersion,
  inventory,
}, { run = releaseCommand } = {}) {
  requireValue(typeof app === 'string' && app.length > 0, 'A macOS app path is required.');
  requireValue(basename(app) === `${PRODUCT_NAME}.app`, `App path must end in ${PRODUCT_NAME}.app.`);
  strictMacosVersion(minimumSystemVersion, 'minimumSystemVersion');
  const combined = async (program, args) => {
    const result = await run(program, args);
    return `${result.stdout}\n${result.stderr}`;
  };
  const appStat = await lstat(app);
  requireValue(appStat.isDirectory() && !appStat.isSymbolicLink(), 'The app must be a directory, not a symlink.');
  await run('codesign', ['--verify', '--deep', '--strict', app]);
  assertDeveloperSignature(await combined('codesign', ['--display', '--verbose=4', app]), teamId, { hardened: true });
  await run('xcrun', ['stapler', 'validate', app]);
  assertNotarizedAssessment(await combined('spctl', ['--assess', '--type', 'exec', '--verbose=2', app]));

  const plist = join(app, 'Contents/Info.plist');
  for (const [key, expected] of [
    ['CFBundleIdentifier', DESKTOP_APP_ID],
    ['CFBundleShortVersionString', desktopVersion],
    ['LSMinimumSystemVersion', minimumSystemVersion],
  ]) {
    const result = await run('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, plist]);
    requireValue(result.stdout.trim() === expected, `${app} ${key} does not match the pinned source commit.`);
  }
  const payload = JSON.parse(await readRegularJson(join(app, 'Contents/Resources/resources/server-payload/package.json')));
  requireValue(payload.name === PACKAGE_NAME && payload.version === version, `${app} payload version/name does not match the release tag.`);
  for (const executable of [`${PRODUCT_TOKEN}-desktop`, `${PRODUCT_TOKEN}-server`]) {
    await run('lipo', [join(app, 'Contents/MacOS', executable), '-verify_arch', 'arm64']);
  }
  const appInventory = inventory ?? await inventoryApp(app);
  const deployment = await verifyMacosDeploymentFloor({
    app,
    minimumSystemVersion,
    inventory: appInventory,
  }, { run });
  return Object.freeze({ app, inventory: appInventory, deployment });
}

export async function verifyMacosRelease({
  dmg,
  root,
  teamId,
  version,
  desktopVersion,
  updaterArchivePath,
  minimumSystemVersion,
  manualDisabled = false,
  runtimeManifestSha256,
}, { run = releaseCommand } = {}) {
  requireValue(typeof manualDisabled === 'boolean', 'manualDisabled must be an explicit boolean.');
  if (manualDisabled) {
    requireValue(updaterArchivePath === undefined, 'Manual-disabled verification forbids an updater archive.');
    requireValue(typeof runtimeManifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(runtimeManifestSha256),
      'The pinned source runtimeManifestSha256 is required for manual verification.');
    const rootStat = await lstat(root);
    requireValue(rootStat.isDirectory() && !rootStat.isSymbolicLink() && (rootStat.mode & 0o077) === 0
      && rootStat.uid === process.getuid(), 'Manual verification requires an owner-only private directory.');
    await assertOutOfTree(root, 'Manual release verification');
  } else {
    requireValue(typeof updaterArchivePath === 'string' && updaterArchivePath.length > 0,
      'A verified updaterArchivePath is required for macOS release verification.');
  }
  strictMacosVersion(minimumSystemVersion, 'minimumSystemVersion');
  await run('hdiutil', ['verify', dmg]);
  await run('codesign', ['--verify', '--strict', dmg]);
  const dmgSignature = await run('codesign', ['--display', '--verbose=4', dmg]);
  assertDeveloperSignature(`${dmgSignature.stdout}\n${dmgSignature.stderr}`, teamId);
  await run('xcrun', ['stapler', 'validate', dmg]);
  const dmgAssessment = await run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);
  assertNotarizedAssessment(`${dmgAssessment.stdout}\n${dmgAssessment.stderr}`);

  const mount = join(root, 'mount');
  const copyRoot = join(root, 'copy');
  await mkdir(mount, { mode: 0o700 });
  await mkdir(copyRoot, { mode: 0o700 });
  let verificationError;
  let verificationResult;
  let extracted;
  let copiedDeployment;
  try {
    await run('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mount]);
    const mountedApp = join(mount, `${PRODUCT_NAME}.app`);
    requireValue((await lstat(mountedApp)).isDirectory(), 'The mounted app must be a directory, not a symlink.');
    const copiedApp = join(copyRoot, `${PRODUCT_NAME}.app`);
    await run('ditto', [mountedApp, copiedApp]);
    // Only the disposable copy receives quarantine; release files stay intact.
    await run('xattr', ['-w', 'com.apple.quarantine', '0081;00000000;GajaeLocalRelease;', copiedApp]);
    // The inventory includes the payload's runtime manifest and every file it
    // names, so this equality binds runtime content without a second parser or
    // a mutable-manifest shortcut.
    const copiedInventory = await inventoryApp(copiedApp);
    if (manualDisabled) {
      compareAppInventories(copiedInventory, await inventoryApp(mountedApp));
    } else {
      extracted = await extractUpdaterArchive({ archivePath: updaterArchivePath, root });
      compareAppInventories(copiedInventory, extracted.inventory);
    }
    for (const app of [mountedApp, copiedApp, ...(extracted ? [extracted.appPath] : [])]) {
      const appInventory = app === copiedApp ? copiedInventory
        : app === extracted?.appPath ? extracted.inventory : undefined;
      const verifiedApp = await verifyMacosApp({
        app, teamId, version, desktopVersion, minimumSystemVersion, inventory: appInventory,
      }, { run });
      if (app === copiedApp) copiedDeployment = verifiedApp.deployment;
    }
    if (manualDisabled) {
      // No UI, browser IPC, QA mode or lifecycle initialization. This early
      // diagnostic is run only after *all* copied-app and Apple checks pass.
      const output = join(root, 'desktop-build-info.json');
      const result = await run(join(copiedApp, 'Contents/MacOS', `${PRODUCT_TOKEN}-desktop`),
        ['--desktop-build-info'], { output, timeout: 10_000, maxOutputBytes: MAX_BUILD_INFO_BYTES });
      requireValue(result?.stderr === '', 'Desktop build info wrote unexpected diagnostics.');
      const payloadManifest = await readUpdaterSidecar(join(copiedApp,
        'Contents/Resources/resources/server-payload/server/gjc-runtime-manifest.json'), MAX_PACKAGE_BYTES);
      const payloadRuntimeManifestSha256 = createHash('sha256').update(payloadManifest, 'utf8').digest('hex');
      const buildInfo = assertManualBuildInfo(await readUpdaterSidecar(output, MAX_BUILD_INFO_BYTES),
        { version, desktopVersion, runtimeManifestSha256, payloadRuntimeManifestSha256 });
      compareAppInventories(copiedInventory, await inventoryApp(copiedApp));
      verificationResult = { copiedApp, inventory: copiedInventory, deployment: copiedDeployment,
        buildInfo, payloadRuntimeManifestSha256, updateMode: 'disabled' };
    } else {
      verificationResult = { copiedApp, extractedApp: extracted.appPath, inventory: copiedInventory,
        deployment: copiedDeployment, archive: extracted.archive };
    }
  } catch (error) {
    verificationError = error;
  }
  try {
    await run('hdiutil', ['detach', mount]);
  } catch {
    // Never recursively remove a directory that might still be a mount.
    throw Object.assign(new Error(`Could not confirm image detachment; temporary directory retained: ${root}`), { preserveDirectory: true });
  }
  if (extracted) await cleanupUpdaterExtraction(extracted);
  if (verificationError) throw verificationError;
  return verificationResult;
}
