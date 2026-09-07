#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { chmod, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { PACKAGE_NAME, REPOSITORY_SLUG, SERVER_PACKAGE_NAME } from '../../shared/productIdentity.js';

import { releaseCommand } from './local-release-command.mjs';
import { assertManualBuildInfo, verifyMacosRelease } from './local-release-macos.mjs';
import { assertChecksum, releaseSnapshot } from './local-release.mjs';
import { assertOutOfTree } from './out-of-tree.mjs';
import { assetNames, UPDATER_ASSET_LIMITS, validateDesktopVersionFloor, validUtcDate } from './updater-artifacts.mjs';
import { collectPublishedDesktopHistory, resolveReleaseTag } from './updater-history.mjs';
import { readUpdaterSidecar } from './updater-signature.mjs';

const demand = (condition, message) => { if (!condition) throw new Error(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const numericId = value => Number.isSafeInteger(value) && value > 0;
const SHA256 = /^[a-f0-9]{64}$/;
const optionNames = ['repo', 'draft-id', 'tag', 'commit', 'team-id'];
const metadataLimit = 64 * 1024;

/** Separate allowlist: no updater key, archive, signature, manifest or arbitrary extras. */
export function manualReleaseOptions(values) {
  demand(record(values) && Object.keys(values).every(key => [...optionNames, 'asset', 'publish'].includes(key)),
    'Only explicit manual release options are accepted.');
  demand(values.repo === REPOSITORY_SLUG, 'Explicit canonical --repo is required.');
  demand(typeof values.tag === 'string' && /^v\d+\.\d+\.\d+(?:-beta(?:\.[A-Za-z0-9-]+)*)?$/.test(values.tag),
    'Explicit canonical beta or stable --tag is required.');
  demand(typeof values.commit === 'string' && /^[a-f0-9]{40}$/.test(values.commit),
    'Explicit full lowercase 40-character --commit is required.');
  demand(/^[1-9][0-9]*$/.test(String(values['draft-id'])) && numericId(Number(values['draft-id'])),
    'Explicit numeric --draft-id is required.');
  demand(typeof values['team-id'] === 'string' && /^[A-Z0-9]{10}$/.test(values['team-id']),
    'Explicit 10-character --team-id is required.');
  demand(values.publish === undefined || typeof values.publish === 'boolean', '--publish must be boolean.');
  const version = values.tag.slice(1);
  const names = assetNames({ productVersion: version, tag: values.tag });
  const allowed = [names.macos.dmg, names.server.archive, ...names.optionalPayloads];
  demand(Array.isArray(values.asset) && values.asset.length >= 2 && values.asset.length <= allowed.length,
    'Pin the canonical DMG and Linux Node22 server archive; at most two exact Linux desktop payloads are optional.');
  const pins = new Map();
  for (const entry of values.asset) {
    demand(typeof entry === 'string', 'Each --asset must be a payload basename=SHA256.');
    const [name, hash, ...extra] = entry.split('=');
    demand(extra.length === 0 && allowed.includes(name) && SHA256.test(hash ?? '') && !pins.has(name),
      'Each --asset must uniquely pin an allowed manual payload to a lowercase SHA-256.');
    pins.set(name, hash);
  }
  demand(pins.has(names.macos.dmg) && pins.has(names.server.archive), 'Pin both canonical manual payloads.');
  return { repo: values.repo, tag: values.tag, commit: values.commit, draftId: Number(values['draft-id']),
    teamId: values['team-id'], publish: values.publish === true, version, pins, names };
}

export function validateManualDraft(release, options) {
  demand(record(release) && release.id === options.draftId && release.draft === true && release.published_at === null,
    'Expected the exact existing unpublished draft ID; published releases are never edited.');
  demand(release.tag_name === options.tag && release.target_commitish === options.commit,
    'Draft tag/target must match the exact supplied tag and full commit, not a branch.');
  demand(release.prerelease === options.version.includes('-'), 'Draft prerelease status does not match the version tag.');
  const expected = new Set([...options.pins.keys()].flatMap(name => [name, `${name}.sha256`]));
  demand(Array.isArray(release.assets) && release.assets.length === expected.size,
    'Manual release assets must have the exact expected cardinality.');
  const ids = new Set();
  for (const asset of release.assets) {
    demand(record(asset) && expected.has(asset.name), 'Unlisted or duplicate manual release asset.');
    demand(numericId(asset.id) && !ids.has(asset.id), 'Asset IDs must be unique positive numeric IDs.');
    ids.add(asset.id);
    expected.delete(asset.name);
    const limit = asset.name.endsWith('.sha256') ? UPDATER_ASSET_LIMITS.maxChecksumBytes
      : asset.name === options.names.macos.dmg ? UPDATER_ASSET_LIMITS.maxDmgBytes : UPDATER_ASSET_LIMITS.maxPayloadBytes;
    demand(numericId(asset.size) && asset.size <= limit, 'Asset size is invalid or exceeds its release limit.');
    demand(asset.state === 'uploaded', 'Asset must be fully uploaded.');
    if (asset.digest !== undefined && asset.digest !== null) {
      demand(typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(asset.digest), 'Invalid GitHub asset digest.');
      if (options.pins.has(asset.name)) demand(asset.digest === `sha256:${options.pins.get(asset.name)}`,
        'Asset disagrees with its independent pin.');
    }
    if (asset.updated_at !== undefined && asset.updated_at !== null) validUtcDate(asset.updated_at, 'Asset updated_at');
    if (asset.label !== undefined && asset.label !== null) demand(typeof asset.label === 'string'
      && Buffer.byteLength(asset.label) <= 256 && !/[\u0000-\u001f\u007f]/u.test(asset.label), 'Invalid asset label.');
  }
  demand(expected.size === 0, 'Missing manual release asset.');
}

async function fileHash(path, expectedSize, limit = expectedSize) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const start = await fd.stat();
    demand(start.isFile() && start.nlink === 1 && start.size > 0 && start.size <= limit
      && (expectedSize === undefined || start.size === expectedSize), 'Downloaded asset size/type differs from draft metadata.');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of fd.createReadStream({ autoClose: false })) {
      size += chunk.length;
      demand(size <= limit, 'Downloaded asset exceeded its streaming byte limit.');
      hash.update(chunk);
    }
    const end = await fd.stat();
    demand(size === start.size && end.size === start.size && end.mtimeMs === start.mtimeMs
      && end.ctimeMs === start.ctimeMs, 'Downloaded asset changed while hashing.');
    return hash.digest('hex');
  } finally { await fd.close(); }
}

/** Verify only by default; the sole optional mutation publishes the verified numeric draft ID. */
export async function processManualRelease(input, {
  run = releaseCommand, verifyMac = verifyMacosRelease, collectHistory = collectPublishedDesktopHistory,
  platform = process.platform, arch = process.arch,
} = {}) {
  demand(platform === 'darwin' && arch === 'arm64', 'Manual signed release verification requires macOS arm64.');
  // Revalidate and detach caller-owned mutable pins before any I/O.
  const options = manualReleaseOptions({ repo: input.repo, tag: input.tag, commit: input.commit,
    'draft-id': input.draftId, 'team-id': input.teamId, publish: input.publish,
    asset: [...input.pins].map(([name, hash]) => `${name}=${hash}`) });
  const endpoint = path => `repos/${options.repo}/${path}`;
  const api = async (path, args = []) => {
    const result = await run('gh', ['api', '--hostname', 'github.com', endpoint(path), ...args]);
    demand(typeof result?.stdout === 'string' && Buffer.byteLength(result.stdout) <= 8 * 1024 * 1024,
      'GitHub API response is missing or oversized.');
    try { return JSON.parse(result.stdout); } catch { throw new Error('GitHub API response must be valid JSON.'); }
  };
  const readDraft = async () => {
    const release = await api(`releases/${options.draftId}`);
    demand(record(release), 'Unexpected release response.');
    const pages = await api(`releases/${options.draftId}/assets`, ['--paginate', '--slurp']);
    demand(Array.isArray(pages) && pages.every(Array.isArray), 'Unexpected release asset response.');
    release.assets = pages.flat();
    validateManualDraft(release, options);
    return release;
  };
  const before = await readDraft();
  const snapshot = releaseSnapshot(before);
  const readTag = () => resolveReleaseTag({ tag: options.tag, expectedCommit: options.commit, allowAbsent: true }, api);
  const tagSnapshot = JSON.stringify(await readTag());
  demand((await api(`git/commits/${options.commit}`))?.sha === options.commit, 'The supplied commit is not a remote Git commit.');
  const sourceFile = path => api(`contents/${path}?ref=${options.commit}`, ['--header', 'Accept: application/vnd.github.raw+json']);
  const source = await sourceFile('package.json');
  demand(record(source) && source.name === PACKAGE_NAME && source.version === options.version
    && typeof source.desktopVersion === 'string', 'Pinned commit package/version does not match the release tag.');
  const config = await sourceFile('src-tauri/tauri.conf.json');
  const minimumSystemVersion = config?.bundle?.macOS?.minimumSystemVersion;
  demand(typeof minimumSystemVersion === 'string', 'Pinned commit must declare the minimum macOS version.');
  const checkHistory = async () => {
    const history = await collectHistory({ repo: options.repo }, { run });
    const floor = validateDesktopVersionFloor({ candidateDesktopVersion: source.desktopVersion,
      priorPublished: history.priorPublished, historyComplete: history.historyComplete });
    return { floor: floor.floor, snapshot: JSON.stringify([...history.priorPublished].sort((a, b) => a.id - b.id)) };
  };
  const history = await checkHistory();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gajae-manual-release-')));
  let preserveDirectory = false;
  let publicationRequested = false;
  try {
    await assertOutOfTree(root, 'Manual release verification');
    const runtimeManifestPath = join(root, 'source-runtime-manifest.json');
    await run('gh', ['api', '--hostname', 'github.com', endpoint(`contents/server/gjc-runtime-manifest.json?ref=${options.commit}`),
      '--header', 'Accept: application/vnd.github.raw+json'], { output: runtimeManifestPath, maxOutputBytes: metadataLimit });
    demand(record(JSON.parse(await readUpdaterSidecar(runtimeManifestPath, metadataLimit))), 'Pinned runtime manifest must be a JSON object.');
    const runtimeManifestSha256 = await fileHash(runtimeManifestPath, undefined, metadataLimit);
    const hashes = {};
    for (const asset of before.assets) {
      const output = join(root, asset.name);
      await run('gh', ['api', '--hostname', 'github.com', endpoint(`releases/assets/${asset.id}`),
        '--header', 'Accept: application/octet-stream'], { output, timeout: 600_000, maxOutputBytes: asset.size });
      const hash = await fileHash(output, asset.size);
      if (asset.digest) demand(asset.digest === `sha256:${hash}`, 'Downloaded asset differs from its GitHub digest.');
      if (options.pins.has(asset.name)) demand(options.pins.get(asset.name) === hash,
        'Downloaded payload differs from its independent pin.');
      await chmod(output, 0o400);
      hashes[asset.name] = hash;
    }
    for (const [name, hash] of options.pins) assertChecksum(
      await readUpdaterSidecar(join(root, `${name}.sha256`), UPDATER_ASSET_LIMITS.maxChecksumBytes), name, hash);
    const archive = join(root, options.names.server.archive);
    const members = (await run('tar', ['-tzf', archive])).stdout.split('\n').filter(name => name === 'package.json' || name === './package.json');
    demand(members.length === 1, 'Server archive must have exactly one root package.json.');
    const server = JSON.parse((await run('tar', ['-xOzf', archive, '--', members[0]])).stdout);
    demand(server.name === SERVER_PACKAGE_NAME && server.version === options.version, 'Server archive package/version does not match the release tag.');
    const verified = await verifyMac({ dmg: join(root, options.names.macos.dmg), root, teamId: options.teamId,
      version: options.version, desktopVersion: source.desktopVersion, minimumSystemVersion,
      manualDisabled: true, runtimeManifestSha256 }, { run });
    // The Mac helper's positive diagnostic is mandatory, never inferred from
    // absent updater assets or a verifier that merely returns successfully.
    const buildInfo = assertManualBuildInfo(JSON.stringify(verified?.buildInfo),
      { version: options.version, desktopVersion: source.desktopVersion, runtimeManifestSha256,
        payloadRuntimeManifestSha256: verified?.payloadRuntimeManifestSha256 });
    for (const asset of before.assets) demand(await fileHash(join(root, asset.name), asset.size) === hashes[asset.name],
      'Private asset snapshot changed during verification.');
    demand((await checkHistory()).snapshot === history.snapshot, 'Published desktop-version history changed during verification; publication refused.');
    demand(releaseSnapshot(await readDraft()) === snapshot, 'Draft metadata or assets changed during verification; publication refused.');
    demand(JSON.stringify(await readTag()) === tagSnapshot, 'Tag changed during verification; publication refused.');
    if (options.publish) {
      let published;
      try {
        publicationRequested = true;
        published = await api(`releases/${options.draftId}`, ['--method', 'PATCH', '--field', 'draft=false']);
      } catch {
        throw new Error('Publication request failed; its outcome may be unknown. Inspect the exact release ID before any retry. No automatic retry or rollback is performed.');
      }
      demand(record(published) && published.id === options.draftId && published.draft === false
        && typeof published.published_at === 'string' && Array.isArray(published.assets)
        && releaseSnapshot(published) === snapshot,
      'Publication response is unexpected; inspect the exact release ID and assets. No automatic rollback is performed.');
      validUtcDate(published.published_at, 'Publication timestamp');
    }
    return { status: options.publish ? 'published' : 'verified-draft', mode: 'manual-disabled',
      repo: options.repo, draftId: options.draftId, tag: options.tag, commit: options.commit, teamId: options.teamId,
      hashes, buildInfo, desktopVersionFloor: history.floor,
      limits: ['Independent pins identify accepted builds, not reproducible-build provenance.',
        'Manual installation only. Runtime, data-survival, GUI and Linux acceptance remain separate prerequisites.',
        'Optional Linux desktop assets receive hash/sidecar verification only.',
        'A single publisher is required: final rechecks and publication are not atomic.'] };
  } catch (error) {
    preserveDirectory = error.preserveDirectory === true;
    if (publicationRequested) error.publicationMayHaveOccurred = true;
    throw error;
  } finally {
    if (!preserveDirectory) await rm(root, { recursive: true, force: true }).catch(() => {
      throw Object.assign(new Error(`Temporary cleanup failed; inspect ${root} and the release ID.`),
        { publicationMayHaveOccurred: publicationRequested });
    });
  }
}

const usage = `Usage: node scripts/release/manual-release.mjs --repo OWNER/REPO --draft-id ID
  --tag vVERSION --commit FULL_SHA --team-id TEAMID1234
  --asset CANONICAL_DMG=SHA256 --asset CANONICAL_LINUX_NODE22_SERVER=SHA256
  [--asset CANONICAL_LINUX_DEB_OR_APPIMAGE=SHA256] [--publish]

Default: verify an existing draft without changing it. --publish repeats all
checks then changes only draft=false on that exact numeric release ID.
Requires signed/notarized macOS arm64 binaries proven updater-disabled by
--desktop-build-info. No updater keys, archives, signatures or manifests.
See MANUAL-RELEASE.md. Never creates drafts, uploads assets, signs or installs.
`;

async function main() {
  let options;
  try {
    const { values, tokens } = parseArgs({ tokens: true, options: {
      ...Object.fromEntries(optionNames.map(name => [name, { type: 'string' }])),
      asset: { type: 'string', multiple: true }, publish: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    const seen = new Set();
    for (const token of tokens) {
      demand(token.kind === 'option' && (token.name === 'asset' || !seen.has(token.name)), 'Duplicate or positional CLI argument.');
      seen.add(token.name);
    }
    if (values.help) { process.stdout.write(usage); return; }
    options = manualReleaseOptions(values);
  } catch {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await processManualRelease(options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: error.publicationMayHaveOccurred ? 'publication-outcome-unknown' : 'blocked', error: error.message })}\n`);
    process.exitCode = 1;
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
}

if (isDirectInvocation()) await main();
