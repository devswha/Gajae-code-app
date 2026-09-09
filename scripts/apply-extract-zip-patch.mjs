#!/usr/bin/env node
// One reviewed upstream backport, not a general-purpose patch mechanism.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_SHA256 = '8d9d8520a197257b51d640b00c3e172a7bea16dde1813bc07c05501460dabbdc';
const MAX_FILE_BYTES = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function readRegular(filename) {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.size > MAX_FILE_BYTES || await fs.realpath(filename) !== filename) {
    throw new Error('extract-zip patch requires a bounded regular file: ' + filename);
  }
  const bytes = await fs.readFile(filename);
  const after = await fs.lstat(filename);
  if (bytes.length > MAX_FILE_BYTES || before.dev !== after.dev || before.ino !== after.ino
    || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('extract-zip patch target changed during read.');
  return { bytes, metadata: before };
}

// No ancestor resolution or npm ls fallback. Inventory actual npm installation
// slots, including scopes, aliases and nested node_modules; links fail closed.
async function assertSingleInstallation(root) {
  const expected = path.join(root, 'node_modules', 'extract-zip');
  let count = 0;
  async function visit(modules, optional = false, depth = 0) {
    if (depth > 64) throw new Error('extract-zip dependency inventory exceeds depth bound.');
    let metadata;
    try { metadata = await fs.lstat(modules); } catch (error) {
      if (optional && error.code === 'ENOENT') return;
      throw error;
    }
    if (!metadata.isDirectory() || await fs.realpath(modules) !== modules) throw new Error('Linked dependency directory is not a canonical extract-zip installation: ' + modules);
    for (const entry of await fs.readdir(modules, { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.name === '.package-lock.json') continue;
      const directory = path.join(modules, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Linked dependency is not a canonical extract-zip installation: ' + directory);
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('@')) {
        await visit(directory, false, depth + 1);
        continue;
      }
      // Some distribution stubs have no package.json. Still inspect their
      // nested dependency slots; do not skip an unrecorded extract-zip.
      let installed;
      try { installed = JSON.parse((await readRegular(path.join(directory, 'package.json'))).bytes); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (entry.name === 'extract-zip' || installed?.name === 'extract-zip') {
        if (directory !== expected) throw new Error('Nested or aliased extract-zip installation is not covered: ' + directory);
        count += 1;
      }
      await visit(path.join(directory, 'node_modules'), true, depth + 1);
    }
  }
  await visit(path.join(root, 'node_modules'));
  if (count !== 1) throw new Error('Missing canonical extract-zip installation.');
}

async function readManifest(root) {
  const { bytes } = await readRegular(path.join(root, 'patches', 'extract-zip-symlink-leaf', 'manifest.json'));
  // Pin the *entire* canonical manifest, not caller-supplied digests or a
  // patch-ID marker. Changing the reviewed transform needs a source review.
  if (hash(bytes) !== MANIFEST_SHA256) throw new Error('Noncanonical extract-zip patch manifest.');
  return JSON.parse(bytes);
}

async function verifyPackage(root, manifest) {
  await assertSingleInstallation(root);
  const directory = path.join(root, 'node_modules', manifest.package);
  const { bytes } = await readRegular(path.join(directory, 'package.json'));
  const installed = JSON.parse(bytes);
  if (installed.name !== manifest.package || installed.version !== manifest.version) throw new Error('extract-zip patch version mismatch.');
  // Also pins resolution metadata (main/exports), not only a version string.
  if (hash(bytes) !== manifest.packageJsonSha256) throw new Error('extract-zip package metadata digest mismatch.');
  return path.join(directory, manifest.path);
}

export async function applyExtractZipPatch(installRoot, { checkOnly = false } = {}) {
  const root = await fs.realpath(installRoot);
  const manifest = await readManifest(root);
  const filename = await verifyPackage(root, manifest);
  const { bytes, metadata } = await readRegular(filename);
  const observed = hash(bytes);
  if (observed === manifest.afterSha256) return { id: manifest.id, applied: 0, verified: 1 };
  if (observed !== manifest.beforeSha256) throw new Error('extract-zip source digest mismatch; refusing unknown local modifications.');
  if (checkOnly) throw new Error('extract-zip patch has not been applied.');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const { before, after } = manifest.replacement;
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + 1) !== -1) throw new Error('extract-zip replacement must match exactly once.');
  const result = Buffer.from(source.slice(0, at) + after + source.slice(at + before.length));
  if (result.length > MAX_FILE_BYTES || hash(result) !== manifest.afterSha256) throw new Error('extract-zip patched digest mismatch.');
  const temporary = path.join(path.dirname(filename), '.gajae-extract-zip-patch-' + randomUUID());
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(result);
      await handle.chmod(metadata.mode & 0o777);
      await handle.sync();
    } finally { await handle.close(); }
    const current = await readRegular(filename);
    if (hash(current.bytes) !== manifest.beforeSha256 || current.metadata.dev !== metadata.dev || current.metadata.ino !== metadata.ino) {
      throw new Error('extract-zip source changed before replacement.');
    }
    await fs.rename(temporary, filename);
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(filename), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    await applyExtractZipPatch(root, { checkOnly: true });
    return { id: manifest.id, applied: 1, verified: 1 };
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(argument => argument !== '--check')) throw new Error('Usage: node scripts/apply-extract-zip-patch.mjs [--check]');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await applyExtractZipPatch(root, { checkOnly: args.includes('--check') });
  console.log('Verified extract-zip archive-only symlink-leaf patch (' + result.applied + ' applied).');
}

const entry = process.argv[1] ? await fs.realpath(path.resolve(process.argv[1])).catch(() => null) : null;
if (entry !== null && entry === await fs.realpath(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
