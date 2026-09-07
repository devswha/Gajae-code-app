import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { basename, join } from 'node:path';

import semver from 'semver';

import { DESKTOP_APP_ID, PACKAGE_NAME, PRODUCT_NAME, PRODUCT_TOKEN } from '../../shared/productIdentity.js';

import { releaseCommand } from './local-release-command.mjs';
import {
  compareAppInventories,
  cleanupUpdaterExtraction,
  extractUpdaterArchive,
  inventoryApp,
} from './updater-archive.mjs';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const MAX_PACKAGE_BYTES = 64 * 1024;
const MAX_VTOOL_OUTPUT_BYTES = 64 * 1024;
const MACOS_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const REQUIRED_MACHO_PATHS = Object.freeze([
  `Contents/MacOS/${PRODUCT_TOKEN}-desktop`,
  `Contents/MacOS/${PRODUCT_TOKEN}-server`,
  'Contents/Resources/resources/server-payload/dist-native/bun',
  'Contents/Resources/resources/server-payload/dist-native/gajae-core',
]);

function strictMacosVersion(value, label) {
  requireValue(typeof value === 'string' && MACOS_VERSION.test(value)
    && value.split('.').every(part => Number(part) <= 999), `${label} must be a bounded macOS version.`);
  const normalized = value.split('.').length === 2 ? `${value}.0` : value;
  const parsed = semver.parse(normalized);
  requireValue(parsed?.version === normalized, `${label} is malformed.`);
  return { text: value, parsed };
}

function nativeMachOPaths(app, inventory) {
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
export function parseVtoolBuildMinimums(output, label = 'Mach-O') {
  requireValue(typeof output === 'string' && Buffer.byteLength(output, 'utf8') > 0
    && Buffer.byteLength(output, 'utf8') <= MAX_VTOOL_OUTPUT_BYTES,
  `${label} vtool output is missing or oversized.`);
  const lines = output.split(/\r?\n/);
  const commands = [];
  let current;
  for (const line of lines) {
    if (/^\s*cmd(?:\s|$)/.test(line)) {
      const command = /^\s*cmd\s+([A-Za-z0-9_]+)\s*$/.exec(line);
      requireValue(command, `${label} has a malformed load-command line.`);
      if (current) commands.push(current);
      current = { name: command[1], platform: undefined, minos: undefined };
      continue;
    }
    if (!current) continue;
    const platform = /^\s*platform\s+([A-Za-z0-9_]+)\s*$/.exec(line);
    if (platform) {
      requireValue(current.platform === undefined, `${label} has duplicate vtool platform evidence.`);
      current.platform = platform[1];
      continue;
    }
    const minos = /^\s*minos\s+([0-9]+(?:\.[0-9]+){1,2})\s*$/.exec(line);
    if (minos) {
      requireValue(current.minos === undefined, `${label} has duplicate vtool minimum evidence.`);
      current.minos = minos[1];
    }
  }
  if (current) commands.push(current);
  requireValue(commands.length > 0, `${label} has no LC_BUILD_VERSION evidence.`);
  requireValue(commands.every(command => command.name === 'LC_BUILD_VERSION'),
    `${label} contains an unsupported load command; only LC_BUILD_VERSION is accepted.`);
  const minimums = [];
  for (const stamp of commands) {
    requireValue(stamp.platform === 'MACOS' && stamp.minos !== undefined,
      `${label} has missing or unsupported LC_BUILD_VERSION evidence.`);
    strictMacosVersion(stamp.minos, `${label} minos`);
    minimums.push(stamp.minos);
  }
  return Object.freeze(minimums);
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
  const paths = nativeMachOPaths(app, inventory);
  const stamps = [];
  for (const item of paths) {
    const result = await run('xcrun', ['vtool', '-show-build', item.absolute], {
      maxOutputBytes: MAX_VTOOL_OUTPUT_BYTES,
    });
    requireValue(result !== null && typeof result === 'object' && !Array.isArray(result)
      && typeof result.stdout === 'string' && typeof result.stderr === 'string',
    `${item.path} vtool result has an invalid shape.`);
    requireValue(result.stderr === '', `${item.path} vtool wrote diagnostics to stderr.`);
    const output = result.stdout;
    const minimums = parseVtoolBuildMinimums(output, item.path);
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
}, { run = releaseCommand } = {}) {
  requireValue(typeof updaterArchivePath === 'string' && updaterArchivePath.length > 0,
    'A verified updaterArchivePath is required for macOS release verification.');
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
    extracted = await extractUpdaterArchive({ archivePath: updaterArchivePath, root });
    compareAppInventories(copiedInventory, extracted.inventory);
    for (const app of [mountedApp, copiedApp, extracted.appPath]) {
      const appInventory = app === copiedApp ? copiedInventory
        : app === extracted.appPath ? extracted.inventory : undefined;
      await verifyMacosApp({
        app, teamId, version, desktopVersion, minimumSystemVersion, inventory: appInventory,
      }, { run });
    }
    verificationResult = { copiedApp, extractedApp: extracted.appPath, inventory: copiedInventory, archive: extracted.archive };
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
