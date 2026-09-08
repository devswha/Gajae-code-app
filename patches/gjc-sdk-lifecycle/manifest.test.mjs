import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applySdkLifecyclePatch } from '../../scripts/apply-sdk-lifecycle-patch.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(await fs.readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
function replaceOnce(source, before, after) {
  const at = source.indexOf(before);
  assert.ok(before.length && at >= 0 && source.indexOf(before, at + 1) === -1, 'replacement must occur exactly once');
  return source.slice(0, at) + after + source.slice(at + before.length);
}
async function original(file) {
  let source = await fs.readFile(path.join(repository, 'node_modules', file.package, file.path), 'utf8');
  // Read-only support for the parent's eventual installed known-after state.
  if (sha(source) === file.afterSha256) {
    for (const edit of [...file.replacements].reverse()) source = replaceOnce(source, edit.after, edit.before);
  }
  assert.equal(sha(source), file.beforeSha256, 'fixture source must match the published version');
  return source;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'gjc-sdk-patch-replay-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, version] of Object.entries(manifest.packages)) {
    const dir = path.join(root, 'node_modules', name); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  }
  for (const file of manifest.files) {
    const filename = path.join(root, 'node_modules', file.package, file.path);
    await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, await original(file));
  }
  return root;
}

test('exact replace-once edits reproduce every full post-hash from published source', async () => {
  assert.deepEqual(Object.keys(manifest).sort(), ['files', 'id', 'packages', 'schemaVersion']);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.id, 'gjc-sdk-lifecycle-v1');
  assert.deepEqual(manifest.packages, { '@gajae-code/coding-agent': '0.16.4', '@gajae-code/agent-core': '0.16.4', '@gajae-code/ai': '0.16.4' });
  for (const file of manifest.files) {
    let source = await original(file);
    for (const edit of file.replacements) source = replaceOnce(source, edit.before, edit.after);
    assert.equal(sha(source), file.afterSha256);
    for (const edit of [...file.replacements].reverse()) source = replaceOnce(source, edit.after, edit.before);
    assert.equal(sha(source), file.beforeSha256, 'known-after fixtures can be reconstructed in memory without installed writes');
  }
});

test('parent applier checks unapplied source, applies all files, and accepts only known-after idempotence', async (t) => {
  const root = await fixture(t);
  await assert.rejects(applySdkLifecyclePatch(root, manifest, { checkOnly: true }), /not been applied/);
  assert.deepEqual(await applySdkLifecyclePatch(root, manifest), { id: manifest.id, applied: manifest.files.length, verified: manifest.files.length });
  assert.deepEqual(await applySdkLifecyclePatch(root, manifest), { id: manifest.id, applied: 0, verified: manifest.files.length });
  assert.deepEqual(await applySdkLifecyclePatch(root, manifest, { checkOnly: true }), { id: manifest.id, applied: 0, verified: manifest.files.length });
});

test('last-file tampering fails all-file prevalidation without partially patching earlier files', async (t) => {
  const root = await fixture(t);
  const last = manifest.files.at(-1); const first = manifest.files[0];
  await fs.appendFile(path.join(root, 'node_modules', last.package, last.path), '\n// unrelated source edit\n');
  await assert.rejects(applySdkLifecyclePatch(root, manifest), /digest mismatch/);
  assert.equal(sha(await fs.readFile(path.join(root, 'node_modules', first.package, first.path))), first.beforeSha256);
});

test('wrong package versions are rejected before any replacement', async (t) => {
  const root = await fixture(t);
  const name = '@gajae-code/agent-core';
  await fs.writeFile(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '0.16.6' }));
  await assert.rejects(applySdkLifecyclePatch(root, manifest), /version mismatch/);
  const first = manifest.files[0];
  assert.equal(sha(await fs.readFile(path.join(root, 'node_modules', first.package, first.path))), first.beforeSha256);
});
