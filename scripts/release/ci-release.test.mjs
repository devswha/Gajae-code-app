import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PACKAGE_NAME, REPOSITORY_SLUG } from '../../shared/productIdentity.js';

import {
  assetNames,
  buildDesktopUpdateManifest,
} from './updater-artifacts.mjs';
import { processCiRelease } from './ci-release.mjs';

const productVersion = '2.0.0-beta.10';
const tag = `v${productVersion}`;
const commit = 'a'.repeat(40);
const teamId = 'AB12345678';
const signature = Buffer.from('official updater signature fixture').toString('base64');
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('CI CLI executes through a symlinked checkout and imports inertly without argv1', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gajae-ci-entry-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  await symlink(fileURLToPath(new URL('../../', import.meta.url)), checkout, 'junction');
  const invoked = spawnSync(process.execPath, [join(checkout, 'scripts/release/ci-release.mjs')], { encoding: 'utf8' });
  assert.equal(invoked.status, 2);
  assert.match(invoked.stderr, /Usage:/);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
    `delete process.argv[1]; await import(${JSON.stringify(new URL('./ci-release.mjs', import.meta.url).href)}); console.log('imported');`],
  { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), 'imported');
});

async function fixture(t, {
  mutateSource,
  mutateManifest,
  extraAsset,
  omitAsset,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gajae-ci-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: PACKAGE_NAME,
    version: productVersion,
    desktopVersion: '0.2.4',
  }));
  await mkdir(join(root, 'src-tauri'));
  await writeFile(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({
    bundle: { macOS: { minimumSystemVersion: '13.0' } },
  }));
  if (mutateSource) await mutateSource(root);

  const assetsDirectory = join(root, 'assets');
  await mkdir(assetsDirectory);
  const names = assetNames({ productVersion, tag });
  const bodies = new Map([
    [names.macos.dmg, Buffer.from('final stapled DMG bytes')],
    [names.macos.archive, Buffer.from('signed updater archive bytes')],
    [names.server.archive, Buffer.from('server archive bytes')],
    [names.macos.archiveSignature, Buffer.from(`${signature}\n`)],
  ]);
  const manifest = structuredClone(buildDesktopUpdateManifest({
    productVersion,
    desktopVersion: '0.2.4',
    notes: 'Initial reviewed notes',
    pubDate: '2026-09-06T00:00:00Z',
    minimumSystemVersion: '13.0',
    commit,
    signature,
  }));
  if (mutateManifest) mutateManifest(manifest);
  bodies.set(names.macos.manifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  for (const [name, payloadName] of [
    [names.macos.dmgChecksum, names.macos.dmg],
    [names.macos.archiveChecksum, names.macos.archive],
    [names.server.checksum, names.server.archive],
  ]) {
    bodies.set(name, Buffer.from(`${sha256(bodies.get(payloadName))}  ${payloadName}\n`));
  }
  if (omitAsset) bodies.delete(omitAsset(names));
  if (extraAsset) bodies.set(extraAsset, Buffer.from('unexpected'));
  for (const [name, body] of bodies) await writeFile(join(assetsDirectory, name), body);
  const publicKeyFile = join(root, 'updater.pub');
  await writeFile(publicKeyFile, Buffer.from('official public key fixture').toString('base64'));
  return { root, assetsDirectory, publicKeyFile, names, bodies };
}

function makeRunner(state) {
  return async (program, args, options = {}) => {
    state.calls.push({ program, args: [...args], options: { ...options } });
    if (program === 'git') {
      assert.deepEqual(args.slice(-2), ['rev-parse', 'HEAD']);
      return { stdout: `${state.checkoutHead ?? commit}\n`, stderr: '' };
    }
    assert.equal(program, 'gh');
    assert.equal(args[0], 'api');
    assert.equal(Number.isSafeInteger(options.timeout), true);
    assert.equal(args.includes('--clobber'), false);
    const endpoint = args[3] ?? '';
    if (endpoint.startsWith(`repos/${REPOSITORY_SLUG}/git/matching-refs/tags/`)) {
      const encodedTag = endpoint.slice(`repos/${REPOSITORY_SLUG}/git/matching-refs/tags/`.length);
      const releaseTag = decodeURIComponent(encodedTag);
      const object = state.tagRefs?.get(releaseTag);
      return {
        stdout: JSON.stringify(object === undefined
          ? [[]]
          : [[{ ref: `refs/tags/${releaseTag}`, object }]]),
        stderr: '',
      };
    }
    if (endpoint.startsWith(`repos/${REPOSITORY_SLUG}/releases?`)) {
      const page = Number(new URLSearchParams(endpoint.slice(endpoint.indexOf('?') + 1)).get('page'));
      return {
        stdout: JSON.stringify(state.existingPages?.[page - 1] ?? (page === 1 ? state.existing ?? [] : [])),
        stderr: '',
      };
    }
    if (endpoint === `repos/${REPOSITORY_SLUG}/releases`) {
      state.createCount += 1;
      if (state.createError) throw new Error('transport fixture failure');
      return {
        stdout: JSON.stringify(state.created ?? {
          id: 700,
          tag_name: tag,
          target_commitish: commit,
          draft: true,
          assets: [],
          body: 'Generated notes from GitHub',
        }),
        stderr: '',
      };
    }
    if (args[3]?.startsWith('https://uploads.github.com/')) {
      state.uploadCount += 1;
      if (state.uploadErrorAt === state.uploadCount) throw new Error('upload transport fixture failure');
      if (state.mutateOriginalBeforeUpload && state.uploadCount === 1) {
        await state.mutateOriginalBeforeUpload();
      }
      const name = new URL(args[3]).searchParams.get('name');
      const input = args[args.indexOf('--input') + 1];
      const bytes = await readFile(input);
      state.uploadedBodies?.set(name, bytes);
      const id = state.uploadIds?.[state.uploadCount - 1] ?? 1000 + state.uploadCount;
      return {
        stdout: JSON.stringify({
          id,
          name,
          size: bytes.length,
          state: 'uploaded',
          digest: `sha256:${state.uploadDigests?.[state.uploadCount - 1] ?? sha256(bytes)}`,
        }),
        stderr: '',
      };
    }
    assert.fail(`Unexpected gh endpoint ${endpoint}`);
  };
}

function dependencies(fixtureState, overrides = {}) {
  return {
    run: makeRunner(fixtureState),
    platform: 'darwin',
    arch: 'arm64',
    verifySignature: async ({ expectedSha256, publicKey, root }, { run }) => {
      assert.equal(expectedSha256, sha256(fixtureState.bodies.get(fixtureState.names.macos.archive)));
      assert.equal(publicKey, Buffer.from('official public key fixture').toString('base64'));
      assert.ok(root);
      assert.equal(typeof run, 'function');
    },
    collectHistory: async () => {
      return { priorPublished: [], historyComplete: true };
    },
    processLocalRelease: async options => {
      fixtureState.verifyOptions = options;
      return { status: options.publish ? 'published' : 'verified-draft',
        repo: options.repo, tag: options.tag, commit: options.commit, draftId: options.draftId };
    },
    ...overrides,
  };
}

function input(state, overrides = {}) {
  return {
    repo: REPOSITORY_SLUG,
    tag,
    commit,
    teamId,
    assetsDirectory: state.assetsDirectory,
    publicKeyFile: state.publicKeyFile,
    checkoutRoot: state.root,
    ...overrides,
  };
}

test('creates one empty draft, replaces only manifest notes, uploads exactly eight assets once, and stays draft-only by default', async t => {
  const state = await fixture(t);
  const events = [];
  const runState = {
    names: state.names,
    bodies: state.bodies,
    calls: [],
    uploadedBodies: new Map(),
    createCount: 0,
    uploadCount: 0,
    existing: [],
    mutateOriginalBeforeUpload: async () => {
      await writeFile(join(state.assetsDirectory, state.names.macos.archive), 'mutated original archive');
    },
  };
  const deps = dependencies(runState, {
    processLocalRelease: async options => {
      events.push('verify-release');
      runState.verifyOptions = options;
      return { status: 'verified-draft', repo: options.repo, tag: options.tag,
        commit: options.commit, draftId: options.draftId };
    },
  });
  const result = await processCiRelease(input(state), deps);
  assert.deepEqual(result, {
    status: 'verified-draft',
    repo: REPOSITORY_SLUG,
    tag,
    commit,
    draftId: 700,
    uploadedCount: 8,
  });
  assert.equal(runState.createCount, 1);
  assert.equal(runState.uploadCount, 8);
  assert.deepEqual(events, ['verify-release']);
  assert.equal(runState.verifyOptions.publish, false);
  assert.deepEqual([...runState.verifyOptions.pins.keys()], [
    state.names.macos.dmg,
    state.names.macos.archive,
    state.names.server.archive,
  ]);
  assert.equal(runState.calls.some(call => call.args.includes('--method') && call.args.includes('PATCH')), false);
  assert.equal(runState.calls.filter(call => call.args[3]?.startsWith('https://uploads.github.com/')).length, 8);
  const tagIndex = runState.calls.findIndex(call => call.args[3]?.includes('/git/matching-refs/tags/'));
  const createIndex = runState.calls.findIndex(call => call.args[3] === `repos/${REPOSITORY_SLUG}/releases`
    && call.args.includes('POST'));
  assert.ok(tagIndex >= 0 && tagIndex < createIndex);
  for (const call of runState.calls.filter(item => item.args[3]?.startsWith('https://uploads.github.com/'))) {
    assert.equal(call.args[call.args.indexOf('--input') + 1].startsWith(state.assetsDirectory), false);
  }
  const manifest = JSON.parse(runState.uploadedBodies.get(state.names.macos.manifest).toString('utf8'));
  assert.equal(manifest.notes, 'Generated notes from GitHub');
  assert.equal(manifest.platforms['darwin-aarch64'].signature, signature);
  assert.deepEqual(await readFile(join(state.assetsDirectory, state.names.macos.archive)),
    Buffer.from('mutated original archive'));
  assert.deepEqual(runState.uploadedBodies.get(state.names.macos.archive),
    state.bodies.get(state.names.macos.archive));
});

test('explicit publish passes publish authorization only to the shared verifier', async t => {
  const state = await fixture(t);
  const runState = { names: state.names, bodies: state.bodies, calls: [], createCount: 0, uploadCount: 0, existing: [] };
  const deps = dependencies(runState);
  const result = await processCiRelease(input(state, { publish: true }), deps);
  assert.equal(result.status, 'published');
  assert.equal(runState.verifyOptions.publish, true);
  assert.equal(runState.calls.some(call => call.args.includes('--method') && call.args.includes('PATCH')), false);
});

test('accepts a matching existing tag but rejects mismatched checkout or tag commits before writing', async t => {
  const state = await fixture(t);
  const matching = { names: state.names, bodies: state.bodies, calls: [], createCount: 0, uploadCount: 0,
    tagRefs: new Map([[tag, { type: 'commit', sha: commit }]]) };
  assert.equal((await processCiRelease(input(state), dependencies(matching))).status, 'verified-draft');
  for (const mismatch of [
    { checkoutHead: 'b'.repeat(40) },
    { tagRefs: new Map([[tag, { type: 'commit', sha: 'b'.repeat(40) }]]) },
  ]) {
    const runState = { names: state.names, bodies: state.bodies, calls: [], createCount: 0, uploadCount: 0, ...mismatch };
    await assert.rejects(processCiRelease(input(state), dependencies(runState)), /commit|HEAD/i);
    assert.equal(runState.createCount, 0);
    assert.equal(runState.uploadCount, 0);
  }
});

test('rejects unsupported platform or architecture before any GitHub operation', async t => {
  const state = await fixture(t);
  for (const overrides of [{ platform: 'linux' }, { arch: 'x64' }]) {
    const runState = { names: state.names, bodies: state.bodies, calls: [], createCount: 0, uploadCount: 0 };
    await assert.rejects(processCiRelease(input(state), dependencies(runState, overrides)), /macOS arm64/i);
    assert.equal(runState.calls.length, 0);
  }
});

test('rejects extras, partial assets, missing key/signature/hash, and metadata drift before any GitHub write', async t => {
  const cases = [
    { fixture: { extraAsset: 'unexpected.txt' }, expected: /exactly eight|unexpected/i },
    { fixture: { omitAsset: names => names.server.checksum }, expected: /exactly eight|Missing/i },
    { fixture: { mutateManifest: manifest => { manifest.build.commit = 'b'.repeat(40); } }, expected: /commit|match/i },
    { fixture: { mutateSource: async root => {
      const packagePath = join(root, 'package.json');
      const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
      packageJson.version = '2.0.0-beta.9';
      await writeFile(packagePath, JSON.stringify(packageJson));
    } }, expected: /product version|tag/i },
  ];
  for (const { fixture: fixtureOptions, expected } of cases) {
    const state = await fixture(t, fixtureOptions);
    const runState = { names: state.names, bodies: state.bodies, calls: [], createCount: 0, uploadCount: 0 };
    await assert.rejects(processCiRelease(input(state), dependencies(runState)), expected);
    assert.equal(runState.createCount, 0);
    assert.equal(runState.uploadCount, 0);
  }
  const state = await fixture(t);
  await rm(state.publicKeyFile);
  const runState = { names: state.names, bodies: state.bodies, calls: [], createCount: 0, uploadCount: 0 };
  await assert.rejects(processCiRelease(input(state), dependencies(runState)), { code: 'ENOENT' });
  assert.equal(runState.createCount, 0);
});

test('requires complete history floor proof and refuses existing public or draft tags', async t => {
  const state = await fixture(t);
  const noProof = { names: state.names, bodies: state.bodies, calls: [], createCount: 0, uploadCount: 0 };
  await assert.rejects(processCiRelease(input(state), dependencies(noProof, {
    collectHistory: async () => ({ priorPublished: [], historyComplete: false }),
  })), /complete/i);
  assert.equal(noProof.createCount, 0);

  for (const existing of [
    [{ id: 1, tag_name: tag, draft: false }],
    [{ id: 2, tag_name: tag, draft: true }],
  ]) {
    const current = await fixture(t);
    const runState = {
      names: current.names,
      bodies: current.bodies,
      calls: [],
      createCount: 0,
      uploadCount: 0,
      existing,
    };
    await assert.rejects(processCiRelease(input(current), dependencies(runState)), /already exists/i);
    assert.equal(runState.createCount, 0);
    assert.equal(runState.uploadCount, 0);
  }
});

test('fails immediately on repeated existing-release IDs or pages', async t => {
  const state = await fixture(t);
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    tag_name: `v1.0.0-beta.${index + 1}`,
  }));
  const runState = {
    names: state.names,
    bodies: state.bodies,
    calls: [],
    createCount: 0,
    uploadCount: 0,
    existingPages: [firstPage, firstPage],
  };
  await assert.rejects(processCiRelease(input(state), dependencies(runState)), /duplicate|repeated/i);
  assert.equal(runState.createCount, 0);
  assert.equal(runState.uploadCount, 0);
});

test('preserves numeric draft ID on create/upload uncertainty and never retries', async t => {
  const state = await fixture(t);
  const createFailure = { names: state.names, bodies: state.bodies, calls: [], createCount: 0, uploadCount: 0, createError: true };
  const createDeps = dependencies(createFailure);
  await assert.rejects(processCiRelease(input(state), createDeps), /Draft creation|failed/i);
  assert.equal(createFailure.createCount, 1);
  assert.equal(createFailure.uploadCount, 0);

  const missingId = await fixture(t);
  const missingIdState = {
    names: missingId.names,
    bodies: missingId.bodies,
    calls: [],
    createCount: 0,
    uploadCount: 0,
    existing: [],
    created: {
      tag_name: tag,
      target_commitish: commit,
      draft: true,
      assets: [],
      body: 'Generated notes from GitHub',
    },
  };
  await assert.rejects(processCiRelease(input(missingId), dependencies(missingIdState)), error => {
    assert.equal(error.outcomeStatus, 'draft-creation-outcome-unknown');
    assert.equal(error.draftId, undefined);
    return true;
  });
  assert.equal(missingIdState.createCount, 1);
  assert.equal(missingIdState.uploadCount, 0);

  const interrupted = await fixture(t);
  const uploadFailure = {
    names: interrupted.names,
    bodies: interrupted.bodies,
    calls: [],
    createCount: 0,
    uploadCount: 0,
    existing: [],
    uploadErrorAt: 2,
  };
  await assert.rejects(processCiRelease(input(interrupted), dependencies(uploadFailure)), error => {
    assert.equal(error.draftId, 700);
    return true;
  });
  assert.equal(uploadFailure.uploadCount, 2);
  assert.equal(uploadFailure.calls.filter(call => call.args[3]?.startsWith('https://uploads.github.com/')).length, 2);
});

test('propagates uncertain publication and rejects shared verifier status mismatches', async t => {
  const state = await fixture(t);
  const uncertain = { names: state.names, bodies: state.bodies, calls: [], createCount: 0, uploadCount: 0, existing: [] };
  await assert.rejects(processCiRelease(input(state, { publish: true }), dependencies(uncertain, {
    processLocalRelease: async () => {
      throw Object.assign(new Error('publication reply lost'), { publicationMayHaveOccurred: true });
    },
  })), error => {
    assert.equal(error.publicationMayHaveOccurred, true);
    assert.equal(error.outcomeStatus, 'publication-outcome-unknown');
    assert.equal(error.draftId, 700);
    return true;
  });
  assert.equal(uncertain.uploadCount, 8);

  const mismatch = await fixture(t);
  const mismatchState = { names: mismatch.names, bodies: mismatch.bodies, calls: [], createCount: 0, uploadCount: 0, existing: [] };
  await assert.rejects(processCiRelease(input(mismatch, { publish: true }), dependencies(mismatchState, {
    processLocalRelease: async () => ({ status: 'verified-draft', repo: REPOSITORY_SLUG, tag, commit, draftId: 700 }),
  })), error => {
    assert.equal(error.outcomeStatus, 'publication-outcome-unknown');
    return true;
  });
  assert.equal(mismatchState.uploadCount, 8);

  const unexpectedPublication = await fixture(t);
  const unexpectedState = {
    names: unexpectedPublication.names,
    bodies: unexpectedPublication.bodies,
    calls: [],
    createCount: 0,
    uploadCount: 0,
    existing: [],
  };
  await assert.rejects(processCiRelease(input(unexpectedPublication), dependencies(unexpectedState, {
    processLocalRelease: async () => ({ status: 'published' }),
  })), error => {
    assert.equal(error.outcomeStatus, 'publication-outcome-unknown');
    return true;
  });
});

test('mismatched publication receipt identities never imply the draft stayed unpublished', async t => {
  const state = await fixture(t);
  for (const mismatch of [
    { draftId: 701 }, { repo: 'other/repository' }, { commit: 'b'.repeat(40) }, { tag: 'v2.0.0-beta.9' },
  ]) {
    const runState = { names: state.names, bodies: state.bodies, calls: [], createCount: 0, uploadCount: 0 };
    await assert.rejects(processCiRelease(input(state, { publish: true }), dependencies(runState, {
      processLocalRelease: async () => ({ status: 'published', repo: REPOSITORY_SLUG, tag, commit, draftId: 700, ...mismatch }),
    })), error => {
      assert.equal(error.outcomeStatus, 'publication-outcome-unknown');
      assert.equal(error.draftId, 700);
      return true;
    });
    assert.equal(runState.createCount, 1);
    assert.equal(runState.uploadCount, 8);
  }
});

test('retains confirmed draft and publication responses when the deadline expires at completion', async t => {
  for (const finalPublication of [false, true]) {
    const state = await fixture(t);
    const runState = { names: state.names, bodies: state.bodies, calls: [], createCount: 0, uploadCount: 0 };
    const fixtureRun = makeRunner(runState);
    let clock = 0;
    let publicationCalls = 0;
    const deps = dependencies(runState, {
      now: () => clock,
      run: async (program, args, options) => {
        if (args.includes('PATCH')) {
          publicationCalls += 1;
          clock = Number.MAX_SAFE_INTEGER;
          return { stdout: JSON.stringify({ id: 700, draft: false }), stderr: '' };
        }
        const result = await fixtureRun(program, args, options);
        if (!finalPublication && runState.createCount === 1) clock = Number.MAX_SAFE_INTEGER;
        return result;
      },
      processLocalRelease: async (options, { run }) => {
        const response = await run('gh', ['api', '--hostname', 'github.com',
          `repos/${REPOSITORY_SLUG}/releases/700`, '--method', 'PATCH'], { timeout: 1 });
        assert.deepEqual(JSON.parse(response.stdout), { id: 700, draft: false });
        return { status: 'published', repo: options.repo, tag: options.tag,
          commit: options.commit, draftId: options.draftId };
      },
    });
    if (finalPublication) {
      assert.equal((await processCiRelease(input(state, { publish: true }), deps)).status, 'published');
      assert.equal(publicationCalls, 1);
    } else {
      await assert.rejects(processCiRelease(input(state), deps), error => {
        assert.equal(error.draftId, 700);
        assert.match(error.message, /deadline/);
        assert.equal(error.outcomeStatus, undefined);
        return true;
      });
      assert.equal(runState.uploadCount, 0);
    }
  }
});

test('rejects duplicate or inconsistent GitHub upload identities', async t => {
  const state = await fixture(t);
  const runState = {
    names: state.names,
    bodies: state.bodies,
    calls: [],
    createCount: 0,
    uploadCount: 0,
    existing: [],
    uploadIds: [77, 77],
  };
  await assert.rejects(processCiRelease(input(state), dependencies(runState)), /Duplicate uploaded asset ID/i);
  assert.equal(runState.uploadCount, 2);
});
