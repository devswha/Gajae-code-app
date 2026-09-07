import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { compareReleaseVersions, parseReleaseVersion } from '../../shared/releaseVersion.js';

import { fetchReleaseNotification } from './useVersionCheck';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag, name: `Release ${tag}`, body: 'Release notes',
    draft: false, prerelease: tag.includes('-'), published_at: '2026-09-07T00:00:00Z',
    ...extra,
  };
}

function page(releases: unknown, link?: string) {
  return new Response(JSON.stringify(releases), { headers: link ? { Link: link } : undefined });
}

const nextLink = '<https://api.github.com/repos/owner/repo/releases?per_page=100&page=2>; rel="next"';
const check = (current = '2.0.0-beta.9', signal = new AbortController().signal) => (
  fetchReleaseNotification('owner', 'repo', current, signal)
);

test('beta.9 discovers beta.10 from the releases list, with notification metadata only', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.github.com/repos/owner/repo/releases?per_page=100&page=1');
    assert.ok(init?.signal);
    return page([release('v2.0.0-beta.10', { html_url: 'https://untrusted.example/install' })]);
  };
  assert.deepEqual(await check(), {
    latestVersion: '2.0.0-beta.10', updateAvailable: true,
    releaseInfo: {
      title: 'Release v2.0.0-beta.10', body: 'Release notes',
      htmlUrl: 'https://github.com/owner/repo/releases/tag/v2.0.0-beta.10',
      publishedAt: '2026-09-07T00:00:00Z',
    },
  });
});

test('beta accepts stable; stable excludes beta and other prerelease channels', async () => {
  globalThis.fetch = async () => page([
    release('v3.0.0-beta.1'), release('v4.0.0-rc.1'),
    release('v5.0.0', { prerelease: true }), release('v6.0.0-beta.1', { prerelease: false }),
    release('v2.0.0-beta.10'), release('v2.0.0'),
  ]);
  assert.equal((await check('2.0.0'))?.latestVersion, '2.0.0');
  assert.equal((await check('2.0.0'))?.updateAvailable, false);
  assert.equal((await check())?.latestVersion, '3.0.0-beta.1');
  globalThis.fetch = async () => page([release('v2.0.0-beta.10'), release('v2.0.0')]);
  assert.equal((await check())?.latestVersion, '2.0.0');
  assert.equal((await check())?.updateAvailable, true);
  globalThis.fetch = async () => page([release('v2.0.1'), release('v2.1.0-beta.1')]);
  assert.equal((await check('2.0.0'))?.latestVersion, '2.0.1');
  assert.equal((await check('2.0.0'))?.updateAvailable, true);
});

test('maximum SemVer wins across out-of-order pages, not list order or publication date', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return urls.length === 1
      ? page([release('v2.0.0-beta.10'), release('v2.0.0-beta.2')], nextLink)
      : page([release('v2.0.0-beta.12', { published_at: '2020-01-01T00:00:00Z' }), release('v2.0.0-beta.9')]);
  };
  assert.equal((await check())?.latestVersion, '2.0.0-beta.12');
  assert.deepEqual(urls, [1, 2].map((n) => `https://api.github.com/repos/owner/repo/releases?per_page=100&page=${n}`));
});

test('drafts, malformed tags/records and unsupported channels are ignored', async () => {
  globalThis.fetch = async () => page([
    null, false, [], 'v9.0.0', {}, release('v9.0.0', { draft: true }),
    release('v8.0.0', { draft: undefined }), release('v7.0.0', { prerelease: undefined }),
    ...['v9.0', ' v9.0.0', 'v9.0.0 ', 'vv9.0.0', 'v09.0.0', 'v9.0.0-beta.01',
      'v9.0.0-beta1', 'v9.0.0-alpha.1', 'v9.0.0-rc.1', '=9.0.0', 'latest'].map((tag) => release(tag)),
    release('v2.0.0-beta.10', { name: null, body: null, published_at: null }),
  ]);
  const result = await check();
  assert.equal(result?.latestVersion, '2.0.0-beta.10');
  assert.equal(result?.releaseInfo.title, 'v2.0.0-beta.10');
  assert.equal(result?.releaseInfo.body, '');
  assert.equal(result?.releaseInfo.publishedAt, '');
});

test('SemVer parsing is strict, supports build metadata, and treats beta.10 numerically', () => {
  assert.deepEqual(parseReleaseVersion('v2.0.0-beta.10+build.4'), { version: '2.0.0-beta.10+build.4', channel: 'beta' });
  assert.deepEqual(parseReleaseVersion('2.0.0+build.4'), { version: '2.0.0+build.4', channel: 'stable' });
  assert.equal(compareReleaseVersions('2.0.0-beta.10', '2.0.0-beta.9'), 1);
  assert.equal(compareReleaseVersions('2.0.0-beta.10+one', '2.0.0-beta.10+two'), 0);
  for (const value of [null, 42, {}, '', '2.0', '2.0.0\n', '2.0.0-alpha.1', '9'.repeat(257)]) {
    assert.equal(parseReleaseVersion(value), null);
  }
});

test('same/older releases do not announce an update, and an empty channel stays unknown', async () => {
  for (const tag of ['v2.0.0-beta.10', 'v2.0.0-beta.9', 'v2.0.0-beta.10+other']) {
    globalThis.fetch = async () => page([release(tag)]);
    assert.equal((await check('2.0.0-beta.10'))?.updateAvailable, false);
  }
  globalThis.fetch = async () => page([release('v3.0.0-beta.1')]);
  assert.equal(await check('2.0.0'), null);
  globalThis.fetch = async () => page([]);
  assert.equal(await check(), null);
});

test('an invalid or unsupported installed version cannot choose an update channel', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return page([release('v9.0.0')]); };
  assert.equal(await check('invalid'), null);
  assert.equal(await check('2.0.0-rc.1'), null);
  assert.equal(calls, 0);
});

test('a full page without Link requires another page; provided URLs are never followed', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (urls.length === 1) return page(Array.from({ length: 100 }, () => release('v2.0.0-beta.10')));
    if (urls.length === 2) return page([release('v2.0.0-beta.11')], '<https://untrusted.example/>; rel="next"');
    return page([release('v2.0.0-beta.12')]);
  };
  assert.equal((await check())?.latestVersion, '2.0.0-beta.12');
  assert.deepEqual(urls, [1, 2, 3].map((n) => `https://api.github.com/repos/owner/repo/releases?per_page=100&page=${n}`));
});

test('bounded incomplete traversals return unknown, never a partial maximum as latest', async () => {
  for (const fullPage of [false, true]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return fullPage
        ? page(Array.from({ length: 100 }, () => release('v9.0.0')))
        : page([release('v9.0.0')], nextLink);
    };
    assert.equal(await check(), null);
    assert.equal(calls, 5);
  }
});

test('HTTP failures reject without treating an error body as release metadata', async () => {
  for (const status of [404, 429, 500]) {
    globalThis.fetch = async () => new Response(JSON.stringify([release('v9.0.0')]), { status });
    await assert.rejects(check(), new RegExp(`HTTP ${status}`));
  }
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(check(), /offline/);
});

test('malformed JSON, non-list and oversized list responses fail safely', async () => {
  globalThis.fetch = async () => new Response('{');
  await assert.rejects(check());
  for (const value of [{ tag_name: 'v9.0.0' }, null, Array.from({ length: 101 }, () => release('v9.0.0'))]) {
    globalThis.fetch = async () => page(value);
    await assert.rejects(check(), /malformed releases list/);
  }
});

test('a later page failure discards an otherwise eligible partial result', async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? page([release('v2.0.0-beta.10')], nextLink)
    : new Response('rate limited', { status: 429 });
  await assert.rejects(check(), /HTTP 429/);
  assert.equal(calls, 2);
});

test('pre-aborted requests never fetch, and late responses cannot continue a retired traversal', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return page([]); };
  await assert.rejects(check(undefined, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);

  const late = new AbortController();
  globalThis.fetch = async () => {
    calls += 1;
    late.abort(); // Simulate a transport resolving despite cancellation.
    return page([release('v9.0.0')], nextLink);
  };
  await assert.rejects(check(undefined, late.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('abort during JSON parsing prevents publication or another page read', async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const response = page([], nextLink);
    response.json = async () => { controller.abort(); return [release('v9.0.0')]; };
    return response;
  };
  await assert.rejects(check(undefined, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});
