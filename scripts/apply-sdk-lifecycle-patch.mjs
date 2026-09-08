#!/usr/bin/env node
// Reproducible build-time dependency remediation, never an app installer.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PATCH_ID = 'gjc-sdk-lifecycle-v1';
const PACKAGES = new Set(['@gajae-code/coding-agent', '@gajae-code/agent-core']);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

function validateManifest(manifest) {
  if (!exact(manifest, ['schemaVersion', 'id', 'packages', 'files']) || manifest.schemaVersion !== 1 || manifest.id !== PATCH_ID
    || !plain(manifest.packages) || !Object.keys(manifest.packages).length
    || Object.entries(manifest.packages).some(([name, version]) => !PACKAGES.has(name) || !/^\d+\.\d+\.\d+$/u.test(version))
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 8) throw new Error('Invalid SDK lifecycle patch manifest.');
  const paths = new Set();
  for (const file of manifest.files) {
    if (!exact(file, ['package', 'path', 'beforeSha256', 'afterSha256', 'replacements'])
      || !Object.hasOwn(manifest.packages, file.package)
      || typeof file.path !== 'string' || !/^src\/[A-Za-z0-9._/-]+\.ts$/u.test(file.path)
      || file.path.split('/').some((part) => !part || part === '.' || part === '..')
      || !digest(file.beforeSha256) || !digest(file.afterSha256) || file.beforeSha256 === file.afterSha256
      || !Array.isArray(file.replacements) || !file.replacements.length || file.replacements.length > 64) throw new Error('Invalid SDK lifecycle patch file.');
    const key = `${file.package}/${file.path}`;
    if (paths.has(key)) throw new Error('Duplicate SDK lifecycle patch file.');
    paths.add(key);
    for (const replacement of file.replacements) {
      if (!exact(replacement, ['before', 'after']) || typeof replacement.before !== 'string' || !replacement.before
        || typeof replacement.after !== 'string' || replacement.before === replacement.after
        || Buffer.byteLength(replacement.before) > MAX_FILE_BYTES || Buffer.byteLength(replacement.after) > MAX_FILE_BYTES) throw new Error('Invalid SDK lifecycle replacement.');
    }
  }
}

async function readRegular(filename) {
  const metadata = await fs.lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_FILE_BYTES
    || await fs.realpath(filename) !== filename) throw new Error('SDK patch target is not a bounded regular file.');
  const bytes = await fs.readFile(filename);
  const after = await fs.lstat(filename);
  if (bytes.length > MAX_FILE_BYTES || after.dev !== metadata.dev || after.ino !== metadata.ino
    || after.mtimeMs !== metadata.mtimeMs || after.size !== metadata.size) throw new Error('SDK patch target changed during read.');
  return { bytes, metadata };
}

/** Validate ALL inputs before writing. Known post-hashes make retries idempotent;
 * an unknown version or local source change is an error, never patched over. */
export async function applySdkLifecyclePatch(installRoot, manifest, { checkOnly = false } = {}) {
  validateManifest(manifest);
  const root = await fs.realpath(installRoot);
  const planned = [];
  for (const [name, version] of Object.entries(manifest.packages)) {
    const filename = path.join(root, 'node_modules', name, 'package.json');
    const { bytes } = await readRegular(filename);
    const installed = JSON.parse(bytes.toString('utf8'));
    if (installed.name !== name || installed.version !== version) throw new Error(`SDK lifecycle patch version mismatch: ${name}.`);
  }
  for (const file of manifest.files) {
    const filename = path.join(root, 'node_modules', file.package, file.path);
    const { bytes, metadata } = await readRegular(filename);
    const observed = hash(bytes);
    if (observed === file.afterSha256) continue;
    if (observed !== file.beforeSha256) throw new Error(`SDK lifecycle source digest mismatch: ${file.package}/${file.path}.`);
    if (checkOnly) throw new Error('SDK lifecycle patch has not been applied.');
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const replacement of file.replacements) {
      const at = text.indexOf(replacement.before);
      if (at < 0 || text.indexOf(replacement.before, at + 1) !== -1) throw new Error('SDK lifecycle replacement must match exactly once.');
      text = text.slice(0, at) + replacement.after + text.slice(at + replacement.before.length);
    }
    const result = Buffer.from(text);
    if (result.length > MAX_FILE_BYTES || hash(result) !== file.afterSha256) throw new Error('SDK lifecycle patched digest mismatch.');
    planned.push({ filename, metadata, result, before: observed, after: file.afterSha256 });
  }

  const temporary = new Set();
  try {
    // Stage every result before replacing any original. A crash between renames
    // is repaired by the same exact before/after inventory on the next run.
    for (const file of planned) {
      file.temporary = path.join(path.dirname(file.filename), `.gajae-sdk-patch-${randomUUID()}`);
      const handle = await fs.open(file.temporary, 'wx', 0o600);
      temporary.add(file.temporary);
      try {
        await handle.writeFile(file.result);
        await handle.chmod(file.metadata.mode & 0o777);
        await handle.sync();
      } finally { await handle.close(); }
    }
    for (const file of planned) {
      const { bytes, metadata } = await readRegular(file.filename);
      if (hash(bytes) === file.after) continue; // Another identical applier won.
      if (hash(bytes) !== file.before || metadata.dev !== file.metadata.dev || metadata.ino !== file.metadata.ino) throw new Error('SDK lifecycle source changed before replacement.');
      await fs.rename(file.temporary, file.filename);
      temporary.delete(file.temporary);
      if (process.platform !== 'win32') {
        const directory = await fs.open(path.dirname(file.filename), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    }
    // A successful return attests to every final file, not just the files this
    // invocation happened to replace.
    for (const file of manifest.files) {
      const { bytes } = await readRegular(path.join(root, 'node_modules', file.package, file.path));
      if (hash(bytes) !== file.afterSha256) throw new Error('SDK lifecycle final verification failed.');
    }
    return { id: manifest.id, applied: planned.length, verified: manifest.files.length };
  } finally {
    for (const filename of temporary) await fs.unlink(filename).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((argument) => argument !== '--check')) throw new Error('Usage: node scripts/apply-sdk-lifecycle-patch.mjs [--check]');
  const root = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { bytes } = await readRegular(path.join(root, 'patches', 'gjc-sdk-lifecycle', 'manifest.json'));
  const result = await applySdkLifecyclePatch(root, JSON.parse(bytes.toString('utf8')), { checkOnly: args.includes('--check') });
  console.log(`Verified ${result.verified} SDK lifecycle patch files (${result.applied} applied).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
