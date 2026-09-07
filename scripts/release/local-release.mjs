#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ARTIFACT_PREFIX, PACKAGE_NAME, REPOSITORY_SLUG, SERVER_PACKAGE_NAME } from '../../shared/productIdentity.js';

import { releaseCommand } from './local-release-command.mjs';
import { verifyMacosRelease } from './local-release-macos.mjs';
import { assertOutOfTree } from './out-of-tree.mjs';
import { assetNames, UPDATER_ASSET_LIMITS, validateDesktopUpdateManifest, validateDesktopVersionFloor, validateReleaseAssets } from './updater-artifacts.mjs';
import { collectPublishedDesktopHistory, resolveReleaseTag } from './updater-history.mjs';
import { readUpdaterSidecar, verifyUpdaterSignature } from './updater-signature.mjs';

const demand = (condition, message) => { if (!condition) throw new Error(message); };
const positiveId = value => /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const sha256Pattern = /^[a-f0-9]{64}$/;

export function releaseOptions(values) {
  demand(values.repo === REPOSITORY_SLUG, 'Explicit canonical --repo is required.');
  demand(/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(values.tag ?? ''), 'Explicit version --tag is required.');
  demand(/^[a-f0-9]{40}$/.test(values.commit ?? ''), 'Explicit full lowercase 40-character --commit is required.');
  demand(positiveId(values['draft-id']), 'Explicit numeric --draft-id is required.');
  demand(/^[A-Z0-9]{10}$/.test(values['team-id'] ?? ''), 'Explicit 10-character --team-id is required.');
  demand(typeof values['updater-public-key-file'] === 'string' && values['updater-public-key-file'].length > 0,
    'Explicit --updater-public-key-file is required; never supply a private key.');
  const mode = values.mode ?? 'local';
  demand(mode === 'local' || mode === 'ci', 'Release mode must be local or ci.');
  const version = values.tag.slice(1);
  const names = assetNames({ productVersion: version, tag: values.tag });
  const pins = new Map();
  for (const entry of values.asset ?? []) {
    const [name, hash, extra] = entry.split('=');
    demand(!extra && /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(name)
      && name.startsWith(ARTIFACT_PREFIX) && name.includes(`-${version}-`) && !name.endsWith('.sha256') && !name.endsWith('.sig')
      && sha256Pattern.test(hash ?? '') && !pins.has(name), 'Each --asset must pin a unique versioned payload basename to a lowercase SHA-256.');
    pins.set(name, hash);
  }
  const dmgName = names.macos.dmg;
  const serverName = names.server.archive;
  demand(names.canonicalPayloads.every(name => pins.has(name)) && pins.size <= 16,
    'Pin the canonical DMG, updater archive and server archive (at most 16 payloads).');
  demand(mode !== 'ci' || pins.size === names.canonicalPayloads.length, 'CI permits only the three canonical payload pins.');
  return { repo: values.repo, tag: values.tag, commit: values.commit, draftId: Number(values['draft-id']),
    teamId: values['team-id'], publish: values.publish === true, version, pins, dmgName, serverName,
    names, mode, publicKeyFile: values['updater-public-key-file'] };
}

export function validateDraft(release, options) {
  demand(release.id === options.draftId && release.draft === true && release.published_at === null, 'Expected the exact existing unpublished draft ID; published releases are never edited.');
  demand(release.tag_name === options.tag && release.target_commitish === options.commit, 'Draft tag/target must match the exact supplied tag and full commit, not a branch.');
  demand(release.prerelease === options.version.includes('-'), 'Draft prerelease status does not match the version tag.');
  validateReleaseAssets({ assets: release.assets, productVersion: options.version,
    tag: options.tag, mode: options.mode, pins: options.pins });
}

export function releaseSnapshot(release) {
  return JSON.stringify({ id: release.id, tag: release.tag_name, commit: release.target_commitish,
    name: release.name, body: release.body, prerelease: release.prerelease,
    assets: release.assets.map(({ id, name, label, size, state, digest, updated_at }) =>
      ({ id, name, label, size, state, digest, updated_at })).sort((a, b) => a.id - b.id) });
}

export function assertChecksum(text, name, hash) {
  const match = /^([a-f0-9]{64}) [ *]([^\r\n]+)\n?$/.exec(text);
  demand(match?.[1] === hash && match?.[2] === name, 'Checksum sidecar must contain exactly the pinned hash and payload basename.');
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function processLocalRelease(options, {
  run = releaseCommand, verifyMac = verifyMacosRelease, verifySignature = verifyUpdaterSignature,
  collectHistory = collectPublishedDesktopHistory, platform = process.platform, arch = process.arch,
} = {}) {
  demand(platform === 'darwin' && arch === 'arm64', 'Local signed release verification requires macOS arm64.');
  const publicKey = await readUpdaterSidecar(options.publicKeyFile, UPDATER_ASSET_LIMITS.maxSignatureBytes);
  const endpoint = path => `repos/${options.repo}/${path}`;
  const api = async (path, args = []) => JSON.parse((await run('gh', ['api', '--hostname', 'github.com', endpoint(path), ...args])).stdout);
  const readDraft = async () => {
    const release = await api(`releases/${options.draftId}`);
    // A separately paginated listing prevents ignoring unreviewed extra assets.
    const pages = await api(`releases/${options.draftId}/assets`, ['--paginate', '--slurp']);
    demand(Array.isArray(pages) && pages.every(Array.isArray), 'Unexpected release asset response.');
    release.assets = pages.flat();
    validateDraft(release, options);
    return release;
  };
  const before = await readDraft();
  const snapshot = releaseSnapshot(before);
  const readTag = () => resolveReleaseTag({ tag: options.tag, expectedCommit: options.commit, allowAbsent: true }, api);
  const tagSnapshot = JSON.stringify(await readTag());
  demand((await api(`git/commits/${options.commit}`)).sha === options.commit, 'The supplied commit is not a remote Git commit.');
  const source = JSON.parse((await run('gh', ['api', '--hostname', 'github.com',
    endpoint(`contents/package.json?ref=${options.commit}`), '--header', 'Accept: application/vnd.github.raw+json'])).stdout);
  demand(source.name === PACKAGE_NAME && source.version === options.version && typeof source.desktopVersion === 'string', 'Pinned commit package/version does not match the release tag.');
  const config = JSON.parse((await run('gh', ['api', '--hostname', 'github.com',
    endpoint(`contents/src-tauri/tauri.conf.json?ref=${options.commit}`), '--header', 'Accept: application/vnd.github.raw+json'])).stdout);
  const minimumSystemVersion = config.bundle?.macOS?.minimumSystemVersion;
  demand(typeof minimumSystemVersion === 'string', 'Pinned commit must declare the minimum macOS version.');
  const history = await collectHistory({ repo: options.repo }, { run });
  const floor = validateDesktopVersionFloor({ candidateDesktopVersion: source.desktopVersion,
    priorPublished: history.priorPublished, historyComplete: history.historyComplete });
  const historySnapshot = JSON.stringify([...history.priorPublished].sort((a, b) => a.id - b.id));

  const root = await realpath(await mkdtemp(join(tmpdir(), 'gajae-local-release-')));
  let preserveDirectory = false;
  let publicationRequested = false;
  try {
    await assertOutOfTree(root, 'Release verification');
    const hashes = {};
    for (const asset of before.assets) {
      const output = join(root, asset.name);
      // Asset IDs bind downloads to the inspected objects, not mutable names.
      await run('gh', ['api', '--hostname', 'github.com', endpoint(`releases/assets/${asset.id}`),
        '--header', 'Accept: application/octet-stream'], { output, timeout: 600_000, maxOutputBytes: asset.size });
      demand((await stat(output)).size === asset.size, 'Downloaded asset size differs from draft metadata.');
      const hash = await fileHash(output);
      if (asset.digest) demand(asset.digest === `sha256:${hash}`, 'Downloaded asset differs from its GitHub digest.');
      if (options.pins.has(asset.name)) demand(options.pins.get(asset.name) === hash, 'Downloaded payload differs from the independently supplied SHA-256.');
      hashes[asset.name] = hash;
    }
    for (const [name, hash] of options.pins) assertChecksum(await readFile(join(root, `${name}.sha256`), 'utf8'), name, hash);
    const signature = (await readUpdaterSidecar(join(root, options.names.macos.archiveSignature), UPDATER_ASSET_LIMITS.maxSignatureBytes)).trim();
    const manifest = JSON.parse(await readUpdaterSidecar(join(root, options.names.macos.manifest), UPDATER_ASSET_LIMITS.maxManifestBytes));
    validateDesktopUpdateManifest(manifest, { productVersion: options.version, desktopVersion: source.desktopVersion,
      tag: options.tag, commit: options.commit, minimumSystemVersion, expectedSignature: signature });
    const verified = await verifySignature({
      archivePath: join(root, options.names.macos.archive), signature, publicKey, root,
      expectedSha256: options.pins.get(options.names.macos.archive),
    }, { run });

    const archive = join(root, options.serverName);
    const members = (await run('tar', ['-tzf', archive])).stdout.split('\n').filter(name => name === 'package.json' || name === './package.json');
    demand(members.length === 1, 'Server archive must have exactly one root package.json.');
    const server = JSON.parse((await run('tar', ['-xOzf', archive, '--', members[0]])).stdout);
    demand(server.name === SERVER_PACKAGE_NAME && server.version === options.version, 'Server archive package/version does not match the release tag.');
    await verifyMac({ dmg: join(root, options.dmgName), root, teamId: options.teamId,
      version: options.version, desktopVersion: source.desktopVersion, minimumSystemVersion,
      updaterArchivePath: verified.archivePath }, { run });

    // Downloads/signature checks take time. Re-read every mutable release
    // input and the tag immediately before the sole optional write.
    const freshHistory = await collectHistory({ repo: options.repo }, { run });
    validateDesktopVersionFloor({ candidateDesktopVersion: source.desktopVersion,
      priorPublished: freshHistory.priorPublished, historyComplete: freshHistory.historyComplete });
    demand(JSON.stringify([...freshHistory.priorPublished].sort((a, b) => a.id - b.id)) === historySnapshot,
      'Published desktop-version history changed during verification; publication refused.');
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
      demand(published.id === options.draftId && published.draft === false
        && published.tag_name === options.tag && published.target_commitish === options.commit
        && releaseSnapshot(published) === snapshot,
      'Publication response is unexpected; inspect the exact release ID and assets. No automatic rollback is performed.');
    }
    return { status: options.publish ? 'published' : 'verified-draft', repo: options.repo, draftId: options.draftId,
      tag: options.tag, commit: options.commit, teamId: options.teamId, hashes, desktopVersionFloor: floor.floor,
      limits: ['Independent hashes bind the operator-selected builds to this release; this is not a reproducible-build attestation.',
        'Runtime/GUI/Linux acceptance remains a separate prerequisite. Additional payloads receive hash validation only.',
        'Keep a single publisher: the final recheck and publication request are separate operations, not an atomic guarantee.'] };
  } catch (error) {
    preserveDirectory = error.preserveDirectory === true;
    if (publicationRequested) error.publicationMayHaveOccurred = true;
    throw error;
  } finally {
    if (!preserveDirectory) await rm(root, { recursive: true, force: true }).catch(() => {
      throw Object.assign(new Error(`Temporary cleanup failed; inspect ${root} and the release ID.`), { publicationMayHaveOccurred: publicationRequested });
    });
  }
}

const usage = `Usage: node scripts/release/local-release.mjs --repo OWNER/REPO --draft-id ID
  --tag vVERSION --commit FULL_SHA --team-id TEAMID1234 --updater-public-key-file PUBLIC_KEY_FILE
  --asset PAYLOAD_BASENAME=SHA256 --asset OTHER_PAYLOAD_BASENAME=SHA256 [--publish]
  [--mode local|ci]

Default: verify an existing draft without changing it. --publish explicitly
repeats all checks then publishes that exact draft ID. Never uploads, overwrites,
deletes or creates release assets. Pin every payload; checksum sidecars are required.
See LOCAL-RELEASE.md. No credential export or hosted signing secrets are used.
`;

async function main() {
  let options;
  try {
    const { values } = parseArgs({ options: {
      ...Object.fromEntries(['repo', 'draft-id', 'tag', 'commit', 'team-id', 'updater-public-key-file', 'mode'].map(name => [name, { type: 'string' }])),
      asset: { type: 'string', multiple: true }, publish: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help) { process.stdout.write(usage); return; }
    options = releaseOptions(values);
  } catch {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await processLocalRelease(options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: error.publicationMayHaveOccurred ? 'publication-outcome-unknown' : 'blocked', error: error.message })}\n`);
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
