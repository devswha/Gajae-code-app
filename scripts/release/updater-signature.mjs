import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { releaseCommand } from './local-release-command.mjs';
import { UPDATER_ASSET_LIMITS } from './updater-artifacts.mjs';

export async function readUpdaterSidecar(path, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > UPDATER_ASSET_LIMITS.maxManifestBytes) {
    throw new Error('Updater sidecar limit must fit the bounded metadata budget.');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > limit) {
      throw new Error('Expected a nonempty bounded regular sidecar file.');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > limit) throw new Error('Sidecar exceeded its streaming size limit.');
      chunks.push(chunk);
    }
    if (size === 0) throw new Error('Sidecar became empty while reading.');
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await file.close();
  }
}

function decodeTauriText(value, label) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > UPDATER_ASSET_LIMITS.maxSignatureBytes) {
    throw new Error(`${label} must be bounded Tauri base64 text.`);
  }
  const encoded = value.trim();
  const decoded = Buffer.from(encoded, 'base64');
  if (!encoded || decoded.toString('base64') !== encoded) {
    throw new Error(`${label} is not canonical base64.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    throw new Error(`${label} must contain UTF-8 Minisign text.`);
  }
}

async function snapshotArchive(source, destination) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    const metadata = await input.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > UPDATER_ASSET_LIMITS.maxArchiveBytes) {
      throw new Error('Updater archive must be a nonempty regular file within the archive size limit.');
    }
    output = await open(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > UPDATER_ASSET_LIMITS.maxArchiveBytes) throw new Error('Updater archive exceeded the streaming size limit.');
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    if (size === 0) throw new Error('Updater archive became empty while snapshotting.');
    await output.sync();
    return { sha256: hash.digest('hex'), size };
  } finally {
    await output?.close();
    await input.close();
  }
}

/**
 * Verify a private snapshot with the official Minisign CLI, not a format-only
 * check. Consumers must inspect/extract the returned archivePath, never the
 * mutable source. The caller owns root and its eventual cleanup. No app is
 * installed, no private signing key is accepted, and no signing occurs here.
 */
export async function verifyUpdaterSignature({ archivePath, signature, publicKey, root, expectedSha256 }, {
  run = releaseCommand,
  minisign = 'minisign',
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) throw new Error('An independently pinned archive SHA-256 is required.');
  const decodedKey = decodeTauriText(publicKey, 'Updater public key');
  const decodedSignature = decodeTauriText(signature, 'Updater signature');
  const work = await mkdtemp(join(root, 'updater-signature-'));
  try {
    const verifiedArchive = join(work, 'verified.app.tar.gz');
    const keyPath = join(work, 'updater.pub');
    const signaturePath = join(work, 'updater.minisig');
    const identity = await snapshotArchive(archivePath, verifiedArchive);
    if (identity.sha256 !== expectedSha256) throw new Error('Updater archive does not match its independently pinned SHA-256.');
    await writeFile(keyPath, decodedKey, { flag: 'wx', mode: 0o600 });
    await writeFile(signaturePath, decodedSignature, { flag: 'wx', mode: 0o600 });
    // -H forbids legacy unprehashed signatures. Missing CLI or any verification
    // failure throws through releaseCommand; there is no cryptographic fallback.
    await run(minisign, ['-V', '-H', '-m', verifiedArchive, '-p', keyPath, '-x', signaturePath]);
    return { archivePath: verifiedArchive, ...identity };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}
