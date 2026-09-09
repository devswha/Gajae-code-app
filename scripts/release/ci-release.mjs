#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import semver from 'semver';

import { PACKAGE_NAME, REPOSITORY_SLUG } from '../../shared/productIdentity.js';

import {
  MACOS_UPDATE_TARGET,
  assetNames,
  buildDesktopUpdateManifest,
  strictVersion,
  UPDATER_ASSET_LIMITS,
  validateDesktopUpdateManifest,
  validateDesktopVersionFloor,
} from './updater-artifacts.mjs';
import { collectPublishedDesktopHistory, resolveReleaseTag } from './updater-history.mjs';
import { assertChecksum, processLocalRelease as sharedProcessLocalRelease } from './local-release.mjs';
import { releaseCommand } from './local-release-command.mjs';
import { readUpdaterSidecar, verifyUpdaterSignature } from './updater-signature.mjs';

const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const OVERALL_TIMEOUT_MS = 30 * 60_000;
const API_OUTPUT_LIMIT = 8 * 1024 * 1024;
const COMMIT = /^[a-f0-9]{40}$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const PATH_CONTROL = /[\u0000-\u001f\u007f]/u;

function demand(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value, label, maxBytes) {
  demand(typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes && !CONTROL.test(value),
  `${label} is missing or oversized.`);
  return value;
}

function positiveId(value, label) {
  demand(Number.isSafeInteger(value) && value > 0, `${label} must be a positive numeric ID.`);
  return value;
}

function safePath(value, label) {
  demand(typeof value === 'string' && value.length > 0 && !PATH_CONTROL.test(value),
    `${label} is missing or malformed.`);
  return resolve(value);
}

function productVersionFromTag(tag) {
  demand(typeof tag === 'string' && tag.startsWith('v') && tag.length > 1,
    'Explicit canonical release tag is required.');
  const productVersion = strictVersion(tag.slice(1), 'Product version');
  const prerelease = semver.prerelease(productVersion);
  demand(prerelease === null || prerelease[0] === 'beta',
    'Only beta and stable product channels are supported.');
  demand(`v${productVersion}` === tag, 'Release tag must exactly match the product version.');
  return productVersion;
}

function validateOptions({
  repo,
  tag,
  commit,
  teamId,
  assetsDirectory,
  publicKeyFile,
  publish = false,
  checkoutRoot = process.cwd(),
} = {}) {
  demand(repo === REPOSITORY_SLUG, `Release repository is restricted to ${REPOSITORY_SLUG}.`);
  const productVersion = productVersionFromTag(tag);
  demand(COMMIT.test(commit ?? ''), 'Explicit full lowercase 40-character commit is required.');
  demand(TEAM_ID.test(teamId ?? ''), 'Explicit 10-character team ID is required.');
  demand(typeof publish === 'boolean', 'Publish must be boolean.');
  const assetsDir = safePath(assetsDirectory, 'Assets directory');
  const keyPath = safePath(publicKeyFile, 'Updater public-key file');
  const checkoutDir = safePath(checkoutRoot, 'Checkout directory');
  demand(keyPath !== assetsDir && !keyPath.startsWith(`${assetsDir}/`),
    'Updater public-key file must be outside the assets directory.');
  const names = assetNames({ productVersion, tag });
  return {
    repo,
    tag,
    commit,
    teamId,
    assetsDirectory: assetsDir,
    publicKeyFile: keyPath,
    checkoutRoot: checkoutDir,
    publish,
    productVersion,
    names,
  };
}

async function openRegularFile(path, label) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error(`${label} must be a readable regular file.`);
  }
  try {
    const metadata = await file.stat();
    demand(metadata.isFile(), `${label} must be a regular file.`);
    return { file, size: metadata.size };
  } catch (error) {
    await file.close().catch(() => {});
    throw error;
  }
}

async function hashFile(path, maxBytes, label) {
  const { file, size } = await openRegularFile(path, label);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    demand(size > 0 && size <= maxBytes, `${label} is empty or oversized.`);
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      demand(bytes <= maxBytes, `${label} exceeded its size limit.`);
      hash.update(chunk);
    }
  } finally {
    await file.close();
  }
  demand(bytes === size && bytes > 0, `${label} changed while reading.`);
  return { size: bytes, hash: hash.digest('hex') };
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function fileLimit(name, names) {
  if (name === names.macos.dmg) return UPDATER_ASSET_LIMITS.maxDmgBytes;
  if (name === names.macos.archive) return UPDATER_ASSET_LIMITS.maxArchiveBytes;
  if (name === names.server.archive) return UPDATER_ASSET_LIMITS.maxPayloadBytes;
  if (name.endsWith('.sha256')) return UPDATER_ASSET_LIMITS.maxChecksumBytes;
  if (name.endsWith('.sig')) return UPDATER_ASSET_LIMITS.maxSignatureBytes;
  if (name === names.macos.manifest) return UPDATER_ASSET_LIMITS.maxManifestBytes;
  throw new Error(`Unrecognized release asset: ${name}`);
}

async function inspectAssetDirectory({ assetsDirectory, names }) {
  let entries;
  try {
    entries = await readdir(assetsDirectory, { withFileTypes: true });
  } catch {
    throw new Error('Assets directory must be readable.');
  }
  const expected = new Set(names.ciAssets);
  demand(entries.length === expected.size, 'Assets directory must contain exactly eight release assets.');
  const paths = new Map();
  for (const entry of entries) {
    demand(entry.isFile() && SAFE_NAME.test(entry.name) && expected.has(entry.name),
      'Assets directory contains an unexpected or non-regular file.');
    demand(!paths.has(entry.name), `Duplicate release asset name: ${entry.name}`);
    paths.set(entry.name, join(assetsDirectory, entry.name));
  }
  for (const name of expected) demand(paths.has(name), `Missing release asset: ${name}`);

  const metadata = new Map();
  for (const name of names.ciAssets) {
    const path = paths.get(name);
    const identity = await hashFile(path, fileLimit(name, names), `Release asset ${name}`);
    metadata.set(name, { path, ...identity });
  }
  for (const [name, checksumName] of [
    [names.macos.dmg, names.macos.dmgChecksum],
    [names.macos.archive, names.macos.archiveChecksum],
    [names.server.archive, names.server.checksum],
  ]) {
    const checksum = await readUpdaterSidecar(metadata.get(checksumName).path,
      UPDATER_ASSET_LIMITS.maxChecksumBytes);
    assertChecksum(checksum, name, metadata.get(name).hash);
  }
  return metadata;
}

function assertAssetMetadataUnchanged(expected, actual, names) {
  for (const name of names.ciAssets) {
    const before = expected.get(name);
    const after = actual.get(name);
    demand(after?.size === before?.size && after?.hash === before?.hash,
      `Release asset ${name} changed during verification.`);
  }
}

async function readCheckoutSource(checkoutRoot) {
  const root = safePath(checkoutRoot, 'Checkout directory');
  const packageJson = parseJsonText(await readUpdaterSidecar(join(root, 'package.json'),
    UPDATER_ASSET_LIMITS.maxManifestBytes), 'Checkout package.json');
  const tauriConfig = parseJsonText(await readUpdaterSidecar(join(root, 'src-tauri/tauri.conf.json'),
    UPDATER_ASSET_LIMITS.maxManifestBytes), 'Checkout Tauri configuration');
  demand(isRecord(packageJson) && packageJson.name === PACKAGE_NAME,
    'Checkout package.json has an unexpected package name.');
  const productVersion = strictVersion(packageJson.version, 'Checkout product version');
  const desktopVersion = strictVersion(packageJson.desktopVersion, 'Checkout desktopVersion');
  const minimumSystemVersion = tauriConfig?.bundle?.macOS?.minimumSystemVersion;
  demand(typeof minimumSystemVersion === 'string' && minimumSystemVersion.length > 0,
    'Checkout must declare a macOS minimumSystemVersion.');
  return { root, productVersion, desktopVersion, minimumSystemVersion };
}

function parseApiResult(result, label) {
  demand(isRecord(result) && typeof result.stdout === 'string',
    `${label} command returned an invalid result.`);
  demand(result.stderr === undefined || typeof result.stderr === 'string',
    `${label} command returned an invalid diagnostic stream.`);
  const outputBytes = Buffer.byteLength(result.stdout, 'utf8')
    + Buffer.byteLength(result.stderr ?? '', 'utf8');
  demand(outputBytes <= API_OUTPUT_LIMIT, `${label} response exceeded the output limit.`);
  return parseJsonText(result.stdout, `${label} response`);
}

function attachDraftId(error, draftId) {
  if (draftId !== undefined && error && typeof error === 'object') {
    Object.defineProperty(error, 'draftId', { value: draftId, enumerable: true, configurable: true });
  }
  return error;
}

function outcomeError(status, message) {
  return Object.assign(new Error(message), { outcomeStatus: status });
}

function requireApiPath(path) {
  demand(typeof path === 'string' && path.length > 0 && !PATH_CONTROL.test(path),
    'GitHub API path is malformed.');
  return path;
}

function encodedAssetUrl(repo, draftId, name) {
  return `https://uploads.github.com/repos/${repo}/releases/${draftId}/assets?name=${encodeURIComponent(name)}`;
}

function prereleaseFor(productVersion) {
  return semver.prerelease(productVersion) !== null;
}

async function copyRegularFile(sourcePath, destinationPath, maxBytes, expected, label) {
  const { file, size } = await openRegularFile(sourcePath, label);
  if (size !== expected.size || size <= 0 || size > maxBytes) {
    await file.close().catch(() => {});
    throw new Error(`${label} changed after verification.`);
  }
  let output;
  try {
    output = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    await file.close().catch(() => {});
    throw error;
  }
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      demand(bytes <= maxBytes, `${label} exceeded its size limit.`);
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    await output.sync();
  } finally {
    await file.close();
    await output.close();
  }
  demand(bytes === expected.size && hash.digest('hex') === expected.hash,
    `${label} changed while staging.`);
}

async function stageWithGeneratedManifest({
  sourceMetadata,
  originalManifest,
  draftBody,
  source,
  options,
}) {
  const staging = await mkdtemp(join(tmpdir(), 'gajae-ci-release-'));
  try {
    const metadata = new Map();
    for (const name of options.names.ciAssets) {
      if (name === options.names.macos.manifest) continue;
      const expected = sourceMetadata.get(name);
      const path = join(staging, name);
      await copyRegularFile(expected.path, path, fileLimit(name, options.names),
        expected, `Release asset ${name}`);
      metadata.set(name, { path, size: expected.size, hash: expected.hash });
    }
    const originalIdentity = sourceMetadata.get(options.names.macos.manifest);
    const currentIdentity = await hashFile(originalIdentity.path,
      UPDATER_ASSET_LIMITS.maxManifestBytes, 'desktop-update.json');
    demand(currentIdentity.size === originalIdentity.size
      && currentIdentity.hash === originalIdentity.hash,
    'desktop-update.json changed after verification.');
    const generated = buildDesktopUpdateManifest({
      productVersion: source.productVersion,
      desktopVersion: source.desktopVersion,
      notes: draftBody,
      pubDate: originalManifest.pub_date,
      minimumSystemVersion: source.minimumSystemVersion,
      commit: options.commit,
      signature: originalManifest.platforms?.[MACOS_UPDATE_TARGET]?.signature,
      tag: options.tag,
    });
    demand(generated.platforms[MACOS_UPDATE_TARGET].url
      === originalManifest.platforms?.[MACOS_UPDATE_TARGET]?.url
      && generated.platforms[MACOS_UPDATE_TARGET].signature
      === originalManifest.platforms?.[MACOS_UPDATE_TARGET]?.signature,
    'Generated notes replacement changed updater archive identity or signature.');
    const generatedText = `${JSON.stringify(generated, null, 2)}\n`;
    boundedText(generatedText, 'Generated desktop-update.json', UPDATER_ASSET_LIMITS.maxManifestBytes);
    const manifestPath = join(staging, options.names.macos.manifest);
    await writeFile(manifestPath, generatedText, { flag: 'wx', mode: 0o600 });
    const manifestIdentity = await hashFile(manifestPath, UPDATER_ASSET_LIMITS.maxManifestBytes,
      'Generated desktop-update.json');
    metadata.set(options.names.macos.manifest, { path: manifestPath, ...manifestIdentity });
    return { staging, metadata };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Validate, stage and upload one complete CI release, then delegate all
 * remote-release verification to processLocalRelease.
 *
 * The draft is intentionally never deleted or retried. Once GitHub returns a
 * numeric draft ID, every later failure includes it so an operator can inspect
 * the preserved draft.
 */
export async function processCiRelease({
  repo,
  tag,
  commit,
  teamId,
  assetsDirectory,
  publicKeyFile,
  publish = false,
  checkoutRoot = process.cwd(),
} = {}, {
  run = releaseCommand,
  verifySignature = verifyUpdaterSignature,
  collectHistory = collectPublishedDesktopHistory,
  processLocalRelease = sharedProcessLocalRelease,
  now = Date.now,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const options = validateOptions({
    repo, tag, commit, teamId, assetsDirectory, publicKeyFile, publish, checkoutRoot,
  });
  demand(platform === 'darwin' && arch === 'arm64',
    'CI release requires macOS arm64.');
  demand(typeof run === 'function' && typeof verifySignature === 'function'
    && typeof collectHistory === 'function' && typeof processLocalRelease === 'function',
  'CI release dependencies are invalid.');
  demand(typeof now === 'function', 'Clock dependency is invalid.');
  const startedAt = now();
  demand(Number.isFinite(startedAt), 'Clock returned an invalid value.');
  const overallDeadline = startedAt + OVERALL_TIMEOUT_MS;
  demand(Number.isFinite(overallDeadline), 'Overall CI release deadline is invalid.');
  const boundedRun = async (program, args, extra = {}) => {
    const current = now();
    demand(Number.isFinite(current) && current < overallDeadline,
      'CI release overall deadline expired.');
    const requestedTimeout = Number.isSafeInteger(extra.timeout) && extra.timeout > 0
      ? extra.timeout
      : REQUEST_TIMEOUT_MS;
    const timeout = Math.max(1, Math.min(requestedTimeout, Math.floor(overallDeadline - current)));
    const requestDeadline = current + timeout;
    const commandOptions = { ...extra, timeout };
    if (commandOptions.maxOutputBytes === undefined) commandOptions.maxOutputBytes = API_OUTPUT_LIMIT;
    let result;
    try {
      result = await run(program, args, commandOptions);
    } catch {
      const failed = now();
      if (Number.isFinite(failed) && failed >= overallDeadline) {
        throw new Error('CI release overall deadline expired.');
      }
      if (Number.isFinite(failed) && failed >= requestDeadline) {
        throw new Error('CI release request deadline expired.');
      }
      throw new Error('CI release command failed; raw command output suppressed.');
    }
    // Keep confirmed write responses even at the deadline. The command timeout
    // bounds execution; the next command checks the remaining overall budget.
    return result;
  };
  const call = async (program, args, label, extra = {}) => {
    try {
      return await boundedRun(program, args, extra);
    } catch (error) {
      if (error.message.endsWith('deadline expired.')) throw error;
      throw new Error(`${label} failed; raw command output suppressed.`);
    }
  };
  const api = async (path, args = [], label = 'GitHub API request') => {
    const result = await call('gh', ['api', '--hostname', 'github.com', requireApiPath(`repos/${repo}/${path}`), ...args], label);
    return parseApiResult(result, label);
  };

  const source = await readCheckoutSource(options.checkoutRoot);
  demand(source.productVersion === options.productVersion,
    'Checkout product version does not match the explicit release tag.');
  let checkoutHead;
  try {
    checkoutHead = await boundedRun('git', ['-C', source.root, 'rev-parse', 'HEAD']);
  } catch {
    throw new Error('Checkout HEAD could not be verified.');
  }
  demand(isRecord(checkoutHead) && typeof checkoutHead.stdout === 'string'
    && checkoutHead.stdout.trim() === options.commit,
  'Checkout HEAD does not match the explicit release commit.');
  const sourceMetadata = await inspectAssetDirectory(options);
  const publicKey = await readUpdaterSidecar(options.publicKeyFile, UPDATER_ASSET_LIMITS.maxSignatureBytes);
  const manifestText = await readUpdaterSidecar(sourceMetadata.get(options.names.macos.manifest).path,
    UPDATER_ASSET_LIMITS.maxManifestBytes);
  const manifest = parseJsonText(manifestText, 'desktop-update.json');
  const signatureText = await readUpdaterSidecar(
    sourceMetadata.get(options.names.macos.archiveSignature).path,
    UPDATER_ASSET_LIMITS.maxSignatureBytes,
  );
  const signature = signatureText.trim();
  boundedText(signature, 'Updater signature', UPDATER_ASSET_LIMITS.maxSignatureBytes);
  validateDesktopUpdateManifest(manifest, {
    productVersion: source.productVersion,
    desktopVersion: source.desktopVersion,
    tag: options.tag,
    commit: options.commit,
    minimumSystemVersion: source.minimumSystemVersion,
    expectedSignature: signature,
  });
  demand(signature === manifest.platforms[MACOS_UPDATE_TARGET].signature,
    'Updater signature sidecar does not match desktop-update.json.');
  const archive = sourceMetadata.get(options.names.macos.archive);
  const signatureRoot = await mkdtemp(join(tmpdir(), 'gajae-ci-signature-'));
  try {
    await verifySignature({
      archivePath: archive.path,
      signature,
      publicKey,
      root: signatureRoot,
      expectedSha256: archive.hash,
    }, { run: boundedRun });
  } finally {
    await rm(signatureRoot, { recursive: true, force: true }).catch(() => {});
  }
  const history = await collectHistory({ repo }, { run: boundedRun, now });
  validateDesktopVersionFloor({
    candidateDesktopVersion: source.desktopVersion,
    priorPublished: history.priorPublished,
    historyComplete: history.historyComplete,
  });
  assertAssetMetadataUnchanged(sourceMetadata, await inspectAssetDirectory(options), options.names);

  let draftId;
  let staging;
  try {
    let existingPage = 1;
    const existingIds = new Set();
    const pageFingerprints = new Set();
    for (;;) {
      const releases = await api(`releases?per_page=${PAGE_SIZE}&page=${existingPage}`, [],
        'Existing release lookup');
      demand(Array.isArray(releases) && releases.length <= PAGE_SIZE,
        'Existing release lookup response must be a bounded array.');
      const pageFingerprint = JSON.stringify(releases.map(release => [
        release?.id,
        release?.tag_name,
      ]));
      demand(!pageFingerprints.has(pageFingerprint),
        'Existing release lookup returned a repeated page.');
      pageFingerprints.add(pageFingerprint);
      for (const release of releases) {
        demand(isRecord(release) && Number.isSafeInteger(release.id) && release.id > 0
          && !existingIds.has(release.id)
          && typeof release.tag_name === 'string'
          && release.tag_name.length > 0 && release.tag_name.length <= 256
          && !PATH_CONTROL.test(release.tag_name), 'Existing release lookup contains a malformed record.');
        existingIds.add(release.id);
        if (release.tag_name === options.tag) {
          throw new Error('A release with the explicit tag already exists.');
        }
      }
      if (releases.length < PAGE_SIZE) break;
      existingPage += 1;
    }

    await resolveReleaseTag({
      tag: options.tag,
      expectedCommit: options.commit,
      allowAbsent: true,
    }, api);

    let created;
    try {
      created = await api('releases', [
        '--method', 'POST',
        '--field', `tag_name=${options.tag}`,
        '--field', `target_commitish=${options.commit}`,
        '--field', 'draft=true',
        '--field', `prerelease=${prereleaseFor(options.productVersion)}`,
        '--field', 'generate_release_notes=true',
      ], 'Draft creation');
    } catch {
      throw outcomeError('draft-creation-outcome-unknown',
        'Draft creation outcome is unknown; inspect GitHub before any retry.');
    }
    if (!isRecord(created) || !Number.isSafeInteger(created.id) || created.id <= 0) {
      throw outcomeError('draft-creation-outcome-unknown',
        'Draft creation returned no trustworthy draft ID; inspect GitHub before any retry.');
    }
    draftId = created.id;
    if (created.draft !== true || created.tag_name !== options.tag
      || created.target_commitish !== options.commit || !Array.isArray(created.assets)
      || created.assets.length !== 0) {
      throw outcomeError('draft-creation-outcome-unknown',
        'Draft creation response does not prove an empty draft; inspect GitHub before any retry.');
    }
    const draftBody = boundedText(created.body, 'Generated draft notes', UPDATER_ASSET_LIMITS.maxManifestBytes);
    const staged = await stageWithGeneratedManifest({
      sourceMetadata,
      originalManifest: manifest,
      draftBody,
      source,
      options,
    });
    staging = staged.staging;
    const uploadedIds = new Set();
    for (const name of options.names.ciAssets) {
      const expected = staged.metadata.get(name);
      const response = await call('gh', [
        'api',
        '--hostname', 'uploads.github.com',
        encodedAssetUrl(options.repo, draftId, name),
        '--method', 'POST',
        '--input', expected.path,
        '--header', 'Content-Type: application/octet-stream',
      ], `Upload ${name}`, { timeout: TRANSFER_TIMEOUT_MS });
      const uploaded = parseApiResult(response, `Upload ${name}`);
      demand(isRecord(uploaded), `Upload ${name} response must be an object.`);
      positiveId(uploaded.id, `Uploaded ${name} ID`);
      demand(!uploadedIds.has(uploaded.id), `Duplicate uploaded asset ID: ${uploaded.id}`);
      uploadedIds.add(uploaded.id);
      demand(uploaded.name === name && uploaded.state === 'uploaded'
        && Number.isSafeInteger(uploaded.size) && uploaded.size === expected.size
        && typeof uploaded.digest === 'string' && uploaded.digest === `sha256:${expected.hash}`,
      `Upload ${name} response does not match the staged asset.`);
    }
    const pins = new Map([
      [options.names.macos.dmg, sourceMetadata.get(options.names.macos.dmg).hash],
      [options.names.macos.archive, sourceMetadata.get(options.names.macos.archive).hash],
      [options.names.server.archive, sourceMetadata.get(options.names.server.archive).hash],
    ]);
    demand(await readUpdaterSidecar(options.publicKeyFile, UPDATER_ASSET_LIMITS.maxSignatureBytes)
      === publicKey,
    'Updater public-key file changed during verification.');
    const verification = await processLocalRelease({
      repo: options.repo,
      tag: options.tag,
      commit: options.commit,
      draftId,
      teamId: options.teamId,
      publish: options.publish,
      version: options.productVersion,
      pins,
      dmgName: options.names.macos.dmg,
      serverName: options.names.server.archive,
      names: options.names,
      mode: 'ci',
      publicKeyFile: options.publicKeyFile,
    }, { run: boundedRun });
    const expectedStatus = options.publish ? 'published' : 'verified-draft';
    const receiptMatches = isRecord(verification) && verification.status === expectedStatus
      && verification.repo === options.repo && verification.tag === options.tag
      && verification.commit === options.commit && verification.draftId === draftId;
    if (!receiptMatches) {
      if (options.publish || verification?.status === 'published'
        || verification?.status === 'publication-outcome-unknown') {
        throw outcomeError('publication-outcome-unknown',
          'Shared publication receipt does not match; inspect the release before any retry.');
      }
      throw new Error('Shared release verifier receipt does not match the exact draft.');
    }
    return {
      status: verification.status,
      repo: options.repo,
      tag: options.tag,
      commit: options.commit,
      draftId,
      uploadedCount: uploadedIds.size,
    };
  } catch (error) {
    if (error && typeof error === 'object'
      && error.publicationMayHaveOccurred === true && error.outcomeStatus === undefined) {
      error.outcomeStatus = 'publication-outcome-unknown';
    }
    throw attachDraftId(error, draftId);
  } finally {
    if (staging !== undefined) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

const usage = `Usage: node scripts/release/ci-release.mjs
  --repo ${REPOSITORY_SLUG} --tag vVERSION --commit FULL_SHA --team-id TEAMID1234
  --assets-dir DIRECTORY --updater-public-key-file PUBLIC_KEY_FILE [--publish]

Creates one empty generated-notes draft, uploads exactly eight immutable assets
once, and delegates final verification/publication to local-release. Draft-only
is the default. No upload retry, replacement, deletion or rollback is performed.
`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      ...Object.fromEntries(['repo', 'tag', 'commit', 'team-id', 'assets-dir', 'updater-public-key-file']
        .map(name => [name, { type: 'string' }])),
      publish: { type: 'boolean' }, help: { type: 'boolean' },
    } }));
    if (values.help) {
      process.stdout.write(usage);
      return;
    }
    demand(values.repo === REPOSITORY_SLUG && values.tag && values.commit
      && values['team-id'] && values['assets-dir'] && values['updater-public-key-file'],
    'All explicit release arguments are required.');
  } catch {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  try {
    const result = await processCiRelease({
      repo: values.repo,
      tag: values.tag,
      commit: values.commit,
      teamId: values['team-id'],
      assetsDirectory: values['assets-dir'],
      publicKeyFile: values['updater-public-key-file'],
      publish: values.publish === true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const publicationUnknown = error?.publicationMayHaveOccurred === true
      || error?.outcomeStatus === 'publication-outcome-unknown';
    const result = {
      status: publicationUnknown
        ? 'publication-outcome-unknown'
        : error?.outcomeStatus
          ?? (error?.draftId === undefined ? 'blocked' : 'draft-preserved'),
      error: publicationUnknown
        ? 'Publication outcome is unknown; inspect the release before any retry.'
        : error?.outcomeStatus === 'draft-creation-outcome-unknown'
          ? 'Draft creation outcome is unknown; inspect GitHub before any retry.'
          : 'CI release failed; inspect the reported draft before any retry.',
      ...(error?.draftId === undefined ? {} : { draftId: error.draftId }),
    };
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) await main();
