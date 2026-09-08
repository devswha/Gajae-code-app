#!/usr/bin/env node
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { applySdkLifecyclePatch } from './apply-sdk-lifecycle-patch.mjs';

const execFile = promisify(execFileCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const bunPath = path.join(rootDir, 'dist-native', process.platform === 'win32' ? 'bun.exe' : 'bun');
const manifestPath = path.join(rootDir, 'server', 'gjc-runtime-manifest.json');
const resolverFrom = path.join(rootDir, 'server');
const argv = process.argv.slice(2);
const update = argv.includes('--update');
// Runtime v2 supports Linux x64 and macOS arm64 only; Windows remains intentionally frozen out.
const SUPPORTED_PLATFORMS = new Set(['linux-x64', 'darwin-arm64']);

/**
 * Fill the closure for a platform this machine is not.
 *
 * A natives bump changes every platform's hashes at once, and the manifest is
 * verified on all of them, so without this the pin can only be completed by
 * running the same command again on a second machine. The foreign closure is
 * hashed from the published tarball of the very package a real install would
 * unpack, at the exact version installed here.
 */
const allPlatforms = argv.includes('--all-platforms');
const requestedPlatforms = argv
  .filter((argument) => argument.startsWith('--platform='))
  .map((argument) => argument.slice('--platform='.length));

if (argv.some((argument) => argument !== '--update' && argument !== '--all-platforms' && !argument.startsWith('--platform='))) {
  throw new Error('Usage: node scripts/fill-runtime-manifest.mjs [--update] [--all-platforms] [--platform=<os-arch>]');
}
for (const platform of requestedPlatforms) {
  if (!SUPPORTED_PLATFORMS.has(platform)) throw new Error(`Unsupported platform: ${platform}`);
}
if ((allPlatforms || requestedPlatforms.length > 0) && !update) {
  throw new Error('Filling another platform only makes sense with --update.');
}

async function packageRoot(entrypoint, expectedName) {
  let directory = path.dirname(entrypoint);
  while (directory !== path.dirname(directory)) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name === expectedName) return directory;
    } catch {
      // Continue towards the resolved package root.
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Could not locate ${expectedName} package root.`);
}

async function nativesEntrypoint() {
  const source = `console.log(Bun.resolveSync('@gajae-code/natives', ${JSON.stringify(resolverFrom)}));`;
  const { stdout } = await execFile(bunPath, ['--eval', source], { cwd: rootDir });
  const entrypoint = stdout.trim();
  if (!path.isAbsolute(entrypoint) || entrypoint.includes('\n')) {
    throw new Error('Bun did not resolve @gajae-code/natives to an absolute entrypoint path.');
  }
  return entrypoint;
}

async function sha256(pathname) {
  return crypto.createHash('sha256').update(await fs.readFile(pathname)).digest('hex');
}

async function closureFiles(packageName, packageRoot, filenames) {
  return Promise.all(filenames.sort().map(async (filename) => ({
    package: packageName,
    path: filename,
    sha256: await sha256(path.join(packageRoot, filename)),
  })));
}

/**
 * Unpacks a platform's natives package from the registry into a temp directory
 * and returns its root. Used only for a platform this machine cannot install.
 */
async function fetchPlatformRoot(platform, version) {
  const platformPackage = `@gajae-code/natives-${platform}`;
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-natives-${platform}-`));
  const { stdout } = await execFile('npm', [
    'pack', `${platformPackage}@${version}`, '--pack-destination', destination, '--silent',
  ], { cwd: rootDir });
  const tarball = stdout.trim().split('\n').pop();
  if (!tarball) throw new Error(`npm pack produced no tarball for ${platformPackage}@${version}.`);
  await execFile('tar', ['-xzf', path.join(destination, tarball), '-C', destination]);
  return path.join(destination, 'package');
}

async function platformClosure(nativesRoot, platform, foreignRoot) {
  const platformPackage = `@gajae-code/natives-${platform}`;
  const platformRoot = foreignRoot ?? path.join(path.dirname(nativesRoot), `natives-${platform}`);
  const metadata = JSON.parse(await fs.readFile(path.join(platformRoot, 'package.json'), 'utf8'));
  if (metadata.name !== platformPackage) throw new Error(`Invalid platform package at ${platformRoot}.`);

  const loaderFiles = (await fs.readdir(path.join(nativesRoot, 'native')))
    .filter((filename) => filename.endsWith('.js'))
    .map((filename) => path.join('native', filename));
  const addonFiles = (await fs.readdir(path.join(platformRoot, 'native')))
    .filter((filename) => filename.endsWith('.node'))
    .map((filename) => path.join('native', filename));
  if (addonFiles.length === 0) throw new Error(`${platformPackage} has no native addons.`);

  const files = [
    ...await closureFiles('@gajae-code/natives', nativesRoot, loaderFiles),
    ...await closureFiles(platformPackage, platformRoot, addonFiles),
  ];
  return { files: files.sort((left, right) => `${left.package}/${left.path}`.localeCompare(`${right.package}/${right.path}`)) };
}

const manifestText = await fs.readFile(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);
const sdkPatch = JSON.parse(await fs.readFile(path.join(rootDir, 'patches/gjc-sdk-lifecycle/manifest.json'), 'utf8'));
await applySdkLifecyclePatch(rootDir, sdkPatch, { checkOnly: true });
const sdkLifecycle = {
  id: sdkPatch.id,
  packages: sdkPatch.packages,
  files: sdkPatch.files.map(({ package: name, path: filename, afterSha256 }) => ({ package: name, path: filename, sha256: afterSha256 })),
};
const nativesRoot = await packageRoot(await nativesEntrypoint(), '@gajae-code/natives');
const currentPlatform = `${process.platform}-${process.arch}`;
if (!SUPPORTED_PLATFORMS.has(currentPlatform)) {
  throw new Error(`GJC runtime manifest does not support ${currentPlatform}.`);
}
const actualCurrentClosure = await platformClosure(nativesRoot, currentPlatform);

if (!update) {
  if (manifest.schemaVersion !== 2 || JSON.stringify(manifest.sdkLifecycle) !== JSON.stringify(sdkLifecycle)
    || JSON.stringify(manifest.platforms?.[currentPlatform]) !== JSON.stringify(actualCurrentClosure)) {
    console.error(`GJC runtime manifest closure does not match ${currentPlatform}; run npm run fill:runtime-manifest -- --update.`);
    process.exitCode = 1;
  } else {
    console.log(`Verified GJC runtime manifest closure: ${currentPlatform}`);
  }
} else {
  manifest.schemaVersion = 2;
  manifest.sdkLifecycle = sdkLifecycle;
  manifest.platforms ??= {};
  manifest.platforms[currentPlatform] = actualCurrentClosure;

  const nativesVersion = JSON.parse(await fs.readFile(path.join(nativesRoot, 'package.json'), 'utf8')).version;
  // The worker refuses to initialize when these disagree with what is actually
  // installed, so they are written from the install rather than left to a hand
  // edit that a bump can silently forget.
  // The SDK's exports map hides package.json, so the version is read from the
  // installed tree rather than through a resolver.
  const sdkManifestPath = path.join(rootDir, 'node_modules', '@gajae-code', 'coding-agent', 'package.json');
  manifest.gjcSdk = JSON.parse(await fs.readFile(sdkManifestPath, 'utf8')).version;
  manifest.natives = nativesVersion;
  const foreignPlatforms = new Set(allPlatforms
    ? [...SUPPORTED_PLATFORMS].filter((platform) => platform !== currentPlatform)
    : requestedPlatforms.filter((platform) => platform !== currentPlatform));
  for (const platform of foreignPlatforms) {
    const foreignRoot = await fetchPlatformRoot(platform, nativesVersion);
    manifest.platforms[platform] = await platformClosure(nativesRoot, platform, foreignRoot);
    console.log(`Filled ${platform} closure from ${`@gajae-code/natives-${platform}`}@${nativesVersion}.`);
  }
  for (const platform of SUPPORTED_PLATFORMS) {
    manifest.platforms[platform] ??= { files: [] };
  }
  for (const platform of Object.keys(manifest.platforms)) {
    if (!SUPPORTED_PLATFORMS.has(platform)) delete manifest.platforms[platform];
  }
  delete manifest.nativesSha256;
  const updatedText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (updatedText !== manifestText) await fs.writeFile(manifestPath, updatedText);
  console.log(`${updatedText === manifestText ? 'Verified' : 'Updated'} GJC runtime manifest closure: ${currentPlatform}`);
}
