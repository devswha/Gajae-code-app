import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { extractZipFixture } from '../test-fixtures/extract-zip.mjs';

import { extractZipPatchSmoke } from './smoke-packaged-server.mjs';

test('out-of-tree packaged checker accepts only actual patched payload bytes', async t => {
  for (const state of ['patched', 'unpatched', 'tampered', 'missing']) await t.test(state, async t => {
    const f = await extractZipFixture(t, { patched: state !== 'unpatched' });
    if (state === 'tampered') await writeFile(f.filename, 'modified');
    if (state === 'missing') await rm(path.join(f.root, 'scripts/apply-extract-zip-patch.mjs'));
    const check = extractZipPatchSmoke({ command: process.execPath, cwd: f.root, env: process.env });
    if (state === 'patched') await check;
    else await assert.rejects(check, /Packaged extract-zip patch check failed/);
  });
});
