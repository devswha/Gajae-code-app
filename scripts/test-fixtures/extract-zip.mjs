import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { applyExtractZipPatch } from '../apply-extract-zip-patch.mjs';

export const repository = path.resolve(import.meta.dirname, '../..');
export const patchDirectory = 'patches/extract-zip-symlink-leaf';
export const helper = 'scripts/apply-extract-zip-patch.mjs';
export const manifest = JSON.parse(await fs.readFile(path.join(repository, patchDirectory, 'manifest.json'), 'utf8'));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function extractZipFixture(t, { patched = false, runtime = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gajae-extract-zip-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'node_modules/extract-zip');
  await fs.mkdir(packageRoot, { recursive: true });
  if (runtime) {
    const copied = new Set();
    async function copyPackage(name, from) {
      if (copied.has(name)) return;
      copied.add(name);
      const source = path.dirname(from.resolve(name + '/package.json'));
      await fs.cp(source, path.join(root, 'node_modules', name), { recursive: true });
      const metadata = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
      for (const dependency of Object.keys(metadata.dependencies ?? {})) {
        await copyPackage(dependency, createRequire(path.join(source, 'package.json')));
      }
    }
    await copyPackage('extract-zip', createRequire(path.join(repository, 'package.json')));
  }
  await fs.copyFile(path.join(repository, 'node_modules/extract-zip/package.json'), path.join(packageRoot, 'package.json'));
  let original = await fs.readFile(path.join(repository, 'node_modules/extract-zip/index.js'), 'utf8');
  if (hash(original) === manifest.afterSha256) original = original.replace(manifest.replacement.after, manifest.replacement.before);
  assert.equal(hash(original), manifest.beforeSha256, 'fixture must derive from exact upstream bytes');
  const filename = path.join(packageRoot, 'index.js');
  await fs.writeFile(filename, original, { mode: 0o644 });
  for (const relative of [helper, patchDirectory + '/manifest.json']) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.copyFile(path.join(repository, relative), path.join(root, relative));
  }
  if (patched) await applyExtractZipPatch(root);
  return { root, packageRoot, filename, original };
}

// Stored ZIP entries with Unix modes: real duplicate names/symlinks, no ZIP
// dependency, shell utility or mocked extractor/filesystem.
export function zip(entries) {
  const local = []; const central = []; let offset = 0;
  for (const { name, data = '', mode = 0o100644 } of entries) {
    const filename = Buffer.from(name); const bytes = Buffer.from(data);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(filename.length, 28); record.writeUInt32LE((mode << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
