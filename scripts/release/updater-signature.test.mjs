import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { UPDATER_ASSET_LIMITS } from './updater-artifacts.mjs';
import { readUpdaterSidecar, verifyUpdaterSignature } from './updater-signature.mjs';

const encoded = text => Buffer.from(text).toString('base64');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gajae-updater-signature-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archivePath = join(root, 'source.app.tar.gz');
  const bytes = Buffer.alloc(150_000, 0x61);
  await writeFile(archivePath, bytes);
  return { root, archivePath, bytes, expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    publicKey: encoded('public-key syntax fixture; CLI validates crypto'), signature: encoded('signature syntax fixture; CLI validates crypto') };
}

test('verification binds the hash and returned private snapshot, not a mutable source path', async t => {
  const input = await fixture(t);
  let invocation;
  const result = await verifyUpdaterSignature(input, { run: async (program, args) => {
    invocation = { program, args };
    assert.equal(program, 'minisign');
    assert.deepEqual(args.slice(0, 3), ['-V', '-H', '-m']);
    assert.notEqual(args[3], input.archivePath);
    assert.equal((await stat(args[3])).mode & 0o777, 0o600);
    assert.equal((await stat(args[5])).mode & 0o777, 0o600);
    assert.equal((await stat(args[7])).mode & 0o777, 0o600);
    assert.equal(await readFile(args[5], 'utf8'), Buffer.from(input.publicKey, 'base64').toString());
    assert.equal(await readFile(args[7], 'utf8'), Buffer.from(input.signature, 'base64').toString());
    await writeFile(input.archivePath, 'source changed after snapshot');
    assert.deepEqual(await readFile(args[3]), input.bytes);
    return { stdout: '', stderr: '' };
  } });
  assert.equal(result.archivePath, invocation.args[3]);
  assert.equal(result.sha256, input.expectedSha256);
  assert.equal(result.size, input.bytes.length);
  assert.deepEqual(await readFile(result.archivePath), input.bytes);
});

test('hash disagreement and failed verifier remove only their private work directory', async t => {
  const input = await fixture(t);
  let calls = 0;
  const run = async () => { calls++; throw new Error('verifier rejected the signature'); };
  await assert.rejects(verifyUpdaterSignature({ ...input, expectedSha256: '0'.repeat(64) }, { run }), /pinned SHA-256/);
  assert.equal(calls, 0);
  await assert.rejects(verifyUpdaterSignature(input, { run }), /verifier rejected/);
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(input.root), ['source.app.tar.gz']);
  assert.deepEqual(await readFile(input.archivePath), input.bytes);
});

test('malformed, oversized and invalid UTF-8 sidecars are rejected before invoking a verifier', async t => {
  const input = await fixture(t);
  const run = async () => assert.fail('invalid sidecar reached the verifier');
  for (const value of ['%%%=', '', 'Zg', 'Zm9v!', 'A'.repeat(UPDATER_ASSET_LIMITS.maxSignatureBytes + 1), '/w==', null]) {
    for (const field of ['publicKey', 'signature']) {
      await assert.rejects(verifyUpdaterSignature({ ...input, [field]: value }, { run }), /base64|UTF-8/);
    }
  }
  await assert.rejects(verifyUpdaterSignature({ ...input, expectedSha256: undefined }, { run }), /pinned archive SHA-256/);
  assert.deepEqual(await readdir(input.root), ['source.app.tar.gz']);
});

test('symlink, empty and oversized source archives never reach cryptographic verification', async t => {
  const input = await fixture(t);
  const link = join(input.root, 'link.app.tar.gz');
  await symlink(input.archivePath, link);
  const run = async () => assert.fail('invalid archive reached the verifier');
  await assert.rejects(verifyUpdaterSignature({ ...input, archivePath: link }, { run }));
  await writeFile(input.archivePath, '');
  await assert.rejects(verifyUpdaterSignature(input, { run }), /nonempty regular file/);
  const handle = await open(input.archivePath, 'w');
  try { await handle.truncate(UPDATER_ASSET_LIMITS.maxArchiveBytes + 1); } finally { await handle.close(); }
  await assert.rejects(verifyUpdaterSignature(input, { run }), /archive size limit/);
  assert.ok(!(await readdir(input.root)).some(name => name.startsWith('updater-signature-')));
});

test('sidecar reads enforce exact byte bounds, regular files and fatal UTF-8', async t => {
  const { root } = await fixture(t);
  const sidecar = join(root, 'sidecar');
  await writeFile(sidecar, '한');
  assert.equal(await readUpdaterSidecar(sidecar, 3), '한');
  await assert.rejects(readUpdaterSidecar(sidecar, 2), /bounded regular/);
  await writeFile(sidecar, Buffer.from([0xff]));
  await assert.rejects(readUpdaterSidecar(sidecar, 3), /encoded data/);
  await writeFile(sidecar, '');
  await assert.rejects(readUpdaterSidecar(sidecar, 3), /nonempty/);
  const link = join(root, 'sidecar-link');
  await symlink(sidecar, link);
  await assert.rejects(readUpdaterSidecar(link, 3));
  await assert.rejects(readUpdaterSidecar(root, 3), /regular/);
  await assert.rejects(readUpdaterSidecar(sidecar, Infinity), /budget/);
});

test('FIFO inputs fail without blocking a filesystem worker', { skip: process.platform === 'win32' }, async t => {
  const input = await fixture(t);
  const fifo = join(input.root, 'fifo');
  assert.equal(spawnSync('mkfifo', [fifo], { timeout: 1000 }).status, 0);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readUpdaterSidecar, verifyUpdaterSignature } from ${JSON.stringify(new URL('./updater-signature.mjs', import.meta.url).href)};
    await assert.rejects(readUpdaterSidecar(process.env.FIFO, 64), /regular/);
    await assert.rejects(verifyUpdaterSignature({
      archivePath: process.env.FIFO, root: process.env.ROOT,
      publicKey: 'Zm9v', signature: 'Zm9v', expectedSha256: '0'.repeat(64)
    }), /regular/);
  `], { env: { ...process.env, FIFO: fifo, ROOT: input.root }, encoding: 'utf8', timeout: 2000 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
});
