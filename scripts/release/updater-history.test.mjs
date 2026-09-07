import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PACKAGE_NAME, REPOSITORY_SLUG } from '../../shared/productIdentity.js';

import { collectPublishedDesktopHistory, resolveReleaseTag } from './updater-history.mjs';

const commitFor = value => Number(value).toString(16).padStart(40, '0');
const timestampFor = value => new Date(Date.UTC(2026, 0, 1, Number(value) % 24, Number(value) % 60)).toISOString();

function releaseFor(value, overrides = {}) {
  const index = Number(value);
  const productVersion = overrides.productVersion ?? `2.0.0-beta.${index}`;
  return {
    id: overrides.id ?? index,
    tag_name: overrides.tag_name ?? `v${productVersion}`,
    target_commitish: overrides.target_commitish ?? commitFor(index),
    draft: overrides.draft ?? false,
    published_at: overrides.published_at ?? timestampFor(index),
    ...overrides,
  };
}

function fixtureRunner({ pages, tagRefs = new Map(), annotated = new Map(), packages = new Map() }) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    assert.equal(command, 'gh');
    assert.equal(args[0], 'api');
    assert.equal(Number.isFinite(options.timeout), true);
    assert.equal(args.includes('--method'), false);
    const endpoint = `repos/${REPOSITORY_SLUG}/`;
    assert.equal(args[3].startsWith(endpoint), true);
    const path = args[3].slice(endpoint.length);
    let response;
    if (path.startsWith('releases?')) {
      const page = Number(new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('page'));
      response = pages[page - 1] ?? [];
    } else if (path.startsWith('git/matching-refs/tags/')) {
      const tag = decodeURIComponent(path.slice('git/matching-refs/tags/'.length));
      const ref = tagRefs.get(tag);
      response = ref === undefined ? [[]] : [[{ ref: `refs/tags/${tag}`, object: ref }]];
    } else if (path.startsWith('git/tags/')) {
      const sha = path.slice('git/tags/'.length);
      response = { object: annotated.get(sha) };
    } else if (path.startsWith('contents/package.json?ref=')) {
      const sha = decodeURIComponent(path.slice('contents/package.json?ref='.length));
      response = packages.get(sha);
    } else {
      throw new Error(`Unexpected fixture endpoint: ${path}`);
    }
    return { stdout: JSON.stringify(response) };
  };
  return { run, calls };
}

function packagesFor(releases, desktopVersions = new Map()) {
  return new Map(releases.map(release => [
    release.target_commitish,
    {
      name: PACKAGE_NAME,
      version: release.tag_name.slice(1),
      desktopVersion: desktopVersions.get(release.id) ?? '0.2.3',
    },
  ]));
}

function refsFor(releases) {
  return new Map(releases.map(release => [
    release.tag_name,
    { type: 'commit', sha: release.target_commitish },
  ]));
}

test('collects every published page across the 100-release boundary and performs read-only pinned mappings', async () => {
  const releases = Array.from({ length: 101 }, (_, index) => releaseFor(index + 1));
  const { run, calls } = fixtureRunner({
    pages: [releases.slice(0, 100), releases.slice(100)],
    tagRefs: refsFor(releases),
    packages: packagesFor(releases, new Map([
      [1, '0.2.5'],
      [2, '0.2.4'],
      [3, '0.2.5'],
    ])),
  });
  const result = await collectPublishedDesktopHistory({ repo: REPOSITORY_SLUG }, { run, now: () => 0 });
  assert.equal(result.historyComplete, true);
  assert.equal(result.priorPublished.length, 101);
  assert.deepEqual(result.priorPublished.slice(0, 3).map(({ desktopVersion }) => desktopVersion),
    ['0.2.5', '0.2.4', '0.2.5']);
  assert.deepEqual(Object.keys(result.priorPublished[0]).sort(),
    ['commit', 'desktopVersion', 'id', 'productVersion', 'publishedAt', 'tag']);
  assert.equal(calls.filter(call => call.args[3].includes('/releases?')).length, 2);
  assert.equal(calls.some(call => call.args.includes('--method')), false);
});

test('combines stable and beta channels while preserving historical desktop-version order', async () => {
  const releases = [
    releaseFor(1, { productVersion: '2.0.0-beta.1' }),
    releaseFor(2, { productVersion: '2.0.0', target_commitish: 'main' }),
    releaseFor(3, { productVersion: '2.0.0-beta.2' }),
  ];
  const stableCommit = commitFor(22);
  const tagRefs = refsFor(releases);
  tagRefs.set(releases[1].tag_name, { type: 'commit', sha: stableCommit });
  const packages = packagesFor(releases, new Map([[1, '0.2.3'], [2, '0.2.1'], [3, '0.2.4']]));
  packages.delete('main');
  packages.set(stableCommit, {
    name: PACKAGE_NAME,
    version: releases[1].tag_name.slice(1),
    desktopVersion: '0.2.1',
  });
  const { run } = fixtureRunner({
    pages: [releases],
    tagRefs,
    packages,
  });
  const result = await collectPublishedDesktopHistory({ repo: REPOSITORY_SLUG }, { run, now: () => 0 });
  assert.deepEqual(result.priorPublished.map(({ productVersion, desktopVersion }) => [productVersion, desktopVersion]), [
    ['2.0.0-beta.1', '0.2.3'],
    ['2.0.0', '0.2.1'],
    ['2.0.0-beta.2', '0.2.4'],
  ]);
});

test('ignores only actual drafts and rejects malformed or repeated published records', async () => {
  const published = releaseFor(1);
  const draft = releaseFor(2, { draft: true, id: undefined, tag_name: undefined, target_commitish: undefined });
  const fixture = fixtureRunner({
    pages: [[draft, published]],
    tagRefs: refsFor([published]),
    packages: packagesFor([published]),
  });
  const result = await collectPublishedDesktopHistory({ repo: REPOSITORY_SLUG }, { run: fixture.run, now: () => 0 });
  assert.equal(result.priorPublished.length, 1);

  for (const page of [
    [releaseFor(1), releaseFor(1, { tag_name: 'v2.0.0-beta.2', target_commitish: commitFor(2) })],
    [releaseFor(1, { id: 0 })],
    [releaseFor(1, { tag_name: '2.0.0-beta.1' })],
    [releaseFor(1, { published_at: null })],
  ]) {
    const bad = fixtureRunner({ pages: [page] });
    await assert.rejects(collectPublishedDesktopHistory({ repo: REPOSITORY_SLUG }, { run: bad.run, now: () => 0 }));
  }
});

test('fails closed for missing tag, commit, package, and product mappings', async () => {
  const release = releaseFor(1);
  const missingTag = fixtureRunner({
    pages: [[release]],
    packages: packagesFor([release]),
  });
  await assert.rejects(collectPublishedDesktopHistory({ repo: REPOSITORY_SLUG }, { run: missingTag.run, now: () => 0 }), /tag/i);

  const wrongPackage = fixtureRunner({
    pages: [[release]],
    tagRefs: refsFor([release]),
    packages: new Map([[release.target_commitish, {
      name: PACKAGE_NAME,
      version: '2.0.0-beta.2',
      desktopVersion: '0.2.3',
    }]]),
  });
  await assert.rejects(collectPublishedDesktopHistory({ repo: REPOSITORY_SLUG }, { run: wrongPackage.run, now: () => 0 }), /match/i);

  const missingCommit = fixtureRunner({
    pages: [[release]],
    tagRefs: new Map([[release.tag_name, { type: 'tag', sha: commitFor(2) }]]),
  });
  await assert.rejects(collectPublishedDesktopHistory({ repo: REPOSITORY_SLUG }, { run: missingCommit.run, now: () => 0 }), /malformed|response|tag/i);

  const wrongName = fixtureRunner({
    pages: [[release]],
    tagRefs: refsFor([release]),
    packages: new Map([[release.target_commitish, {
      name: 'other-package',
      version: release.tag_name.slice(1),
      desktopVersion: '0.2.3',
    }]]),
  });
  await assert.rejects(collectPublishedDesktopHistory({ repo: REPOSITORY_SLUG }, { run: wrongName.run, now: () => 0 }), /package name/i);
});

test('resolveReleaseTag handles URL encoding, lightweight and absent tags', async () => {
  const expectedCommit = commitFor(1);
  const calls = [];
  const api = async (path, args) => {
    calls.push({ path, args });
    return [[{
      ref: 'refs/tags/v2.0.0-beta/1',
      object: { type: 'commit', sha: expectedCommit },
    }]];
  };
  assert.deepEqual(await resolveReleaseTag({
    tag: 'v2.0.0-beta/1',
    expectedCommit,
  }, api), { commit: expectedCommit, referenceSha: expectedCommit });
  assert.match(calls[0].path, /%2F/);
  assert.deepEqual(await resolveReleaseTag({
    tag: 'v2.0.0-beta/2',
    expectedCommit,
    allowAbsent: true,
  }, async () => [[]]), null);
  await assert.rejects(resolveReleaseTag({
    tag: 'v2.0.0-beta/2',
    expectedCommit,
  }, async () => [[]]), /missing/i);
});

test('resolveReleaseTag resolves annotated tags and rejects cycles and excessive depth', async () => {
  const expectedCommit = commitFor(99);
  const initialSha = commitFor(100);
  const chain = new Map();
  for (let index = 100; index < 110; index += 1) {
    chain.set(commitFor(index), index === 109
      ? { type: 'commit', sha: expectedCommit }
      : { type: 'tag', sha: commitFor(index + 1) });
  }
  const api = async path => path.startsWith('git/matching-refs/')
    ? [[{ ref: 'refs/tags/v2.0.0-beta.1', object: { type: 'tag', sha: initialSha } }]]
    : { object: chain.get(path.slice('git/tags/'.length)) };
  assert.deepEqual(await resolveReleaseTag({
    tag: 'v2.0.0-beta.1',
    expectedCommit,
  }, api), { commit: expectedCommit, referenceSha: initialSha });

  const cycleApi = async path => path.startsWith('git/matching-refs/')
    ? [[{ ref: 'refs/tags/v2.0.0-beta.1', object: { type: 'tag', sha: initialSha } }]]
    : { object: { type: 'tag', sha: initialSha } };
  await assert.rejects(resolveReleaseTag({
    tag: 'v2.0.0-beta.1',
    expectedCommit,
  }, cycleApi), /cyclic/i);

  const tooDeep = new Map();
  for (let index = 100; index < 111; index += 1) {
    tooDeep.set(commitFor(index), { type: 'tag', sha: commitFor(index + 1) });
  }
  const depthApi = async path => path.startsWith('git/matching-refs/')
    ? [[{ ref: 'refs/tags/v2.0.0-beta.1', object: { type: 'tag', sha: initialSha } }]]
    : { object: tooDeep.get(path.slice('git/tags/'.length)) };
  await assert.rejects(resolveReleaseTag({
    tag: 'v2.0.0-beta.1',
    expectedCommit,
  }, depthApi), /depth/i);
});

test('enforces per-request and overall deadlines before claiming complete history', async () => {
  let perRequestTime = 0;
  const perRequest = fixtureRunner({ pages: [[]] });
  const perRequestClock = () => {
    if (perRequestTime === 0) {
      perRequestTime += 1;
      return 0;
    }
    perRequestTime += 30_001;
    return perRequestTime;
  };
  await assert.rejects(
    collectPublishedDesktopHistory({ repo: REPOSITORY_SLUG }, { run: perRequest.run, now: perRequestClock }),
    /deadline/i,
  );

  const page = Array.from({ length: 100 }, (_, index) => releaseFor(index + 1, { draft: true }));
  const overall = fixtureRunner({ pages: [page, []] });
  let overallCalls = 0;
  await assert.rejects(
    collectPublishedDesktopHistory({ repo: REPOSITORY_SLUG }, {
      run: overall.run,
      now: () => overallCalls++ === 3 ? 300_000 : 0,
    }),
    /overall|deadline/i,
  );
});
