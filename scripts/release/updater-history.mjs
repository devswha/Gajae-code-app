import semver from 'semver';

import { PACKAGE_NAME, REPOSITORY_SLUG } from '../../shared/productIdentity.js';

import { releaseCommand } from './local-release-command.mjs';
import { strictVersion, validUtcDate } from './updater-artifacts.mjs';

const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMMIT = /^[a-f0-9]{40}$/;
const TAG_SHA = COMMIT;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function demand(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalProductTag(tag) {
  demand(typeof tag === 'string' && tag.length > 1 && tag.startsWith('v') && !CONTROL.test(tag),
    'Published release tag is missing or malformed.');
  const productVersion = strictVersion(tag.slice(1), 'Published productVersion');
  const prerelease = semver.prerelease(productVersion);
  demand(prerelease === null || prerelease[0] === 'beta',
    'Only beta and stable product release tags are supported.');
  demand(`v${productVersion}` === tag, 'Published release tag is not canonical.');
  return productVersion;
}

function encodeTag(tag) {
  demand(typeof tag === 'string' && tag.length > 0 && tag.length <= 256 && !CONTROL.test(tag),
    'Release tag is missing or malformed.');
  try {
    return encodeURIComponent(tag);
  } catch {
    throw new Error('Release tag cannot be URL-encoded.');
  }
}

function matchingRefPages(value) {
  demand(Array.isArray(value) && value.every(Array.isArray), 'Unexpected tag reference response.');
  const refs = value.flat();
  const seenRefs = new Set();
  for (const ref of refs) {
    demand(isRecord(ref), 'Tag reference records must be objects.');
    demand(typeof ref.ref === 'string' && ref.ref.length <= 512 && !CONTROL.test(ref.ref)
      && ref.ref.startsWith('refs/tags/'), 'Tag reference is malformed.');
    demand(!seenRefs.has(ref.ref), `Duplicate tag reference: ${ref.ref}`);
    seenRefs.add(ref.ref);
    demand(isRecord(ref.object), 'Tag reference object is missing.');
    demand(ref.object.type === 'commit' || ref.object.type === 'tag',
      'Tag reference object has an unexpected type.');
    demand(TAG_SHA.test(ref.object.sha ?? ''), 'Tag reference SHA must be a lowercase full commit or tag SHA.');
  }
  return refs;
}

function tagObject(response, label) {
  demand(isRecord(response) && isRecord(response.object), `${label} response is malformed.`);
  const object = response.object;
  demand(object.type === 'commit' || object.type === 'tag',
    `${label} must resolve through commit or tag objects.`);
  demand(TAG_SHA.test(object.sha ?? ''), `${label} SHA must be a lowercase full SHA.`);
  return object;
}

/**
 * Resolve one exact lightweight or annotated tag to its full commit.
 *
 * `api` is a read-only GitHub API function whose result is already parsed
 * JSON. Annotated tags are dereferenced through at most ten tag objects.
 * When supplied, expectedCommit must be a lowercase full SHA and the resolved
 * commit must match it; omitting it resolves the tag without trusting the
 * release listing's (possibly branch-named) target_commitish.
 */
export async function resolveReleaseTag({ tag, expectedCommit, allowAbsent = false } = {}, api) {
  demand(typeof api === 'function', 'A GitHub API function is required.');
  if (expectedCommit !== undefined) {
    demand(COMMIT.test(expectedCommit), 'Expected commit must be a lowercase full commit SHA.');
  }
  demand(typeof allowAbsent === 'boolean', 'allowAbsent must be boolean.');

  const pages = await api(`git/matching-refs/tags/${encodeTag(tag)}`, ['--paginate', '--slurp']);
  const refs = matchingRefPages(pages).filter(ref => ref.ref === `refs/tags/${tag}`);
  demand(refs.length <= 1, 'Ambiguous release tag reference.');
  if (refs.length === 0) {
    if (allowAbsent === true) return null;
    throw new Error('Release tag is missing.');
  }

  const initial = refs[0].object;
  const referenceSha = initial.sha;
  let object = initial;
  const seen = new Set();
  let depth = 0;
  while (object.type === 'tag') {
    demand(depth < 10, 'Annotated release tag exceeds the dereference depth limit.');
    demand(!seen.has(object.sha), 'Annotated release tag is cyclic.');
    seen.add(object.sha);
    object = tagObject(await api(`git/tags/${object.sha}`), 'Annotated release tag');
    depth += 1;
  }
  demand(object.type === 'commit'
    && (expectedCommit === undefined || object.sha === expectedCommit),
  expectedCommit === undefined
    ? 'Release tag does not resolve to a full commit.'
    : 'Release tag does not resolve to the expected commit.');
  return { commit: object.sha, referenceSha };
}

function checkClock(now) {
  const value = now();
  demand(typeof value === 'number' && Number.isFinite(value), 'Clock returned an invalid value.');
  return value;
}

function parseCommandResult(result) {
  demand(isRecord(result) && typeof result.stdout === 'string', 'GitHub API command returned an invalid result.');
  demand(result.stderr === undefined || typeof result.stderr === 'string',
    'GitHub API command returned an invalid diagnostic stream.');
  const outputBytes = Buffer.byteLength(result.stdout, 'utf8')
    + Buffer.byteLength(result.stderr ?? '', 'utf8');
  demand(outputBytes <= MAX_OUTPUT_BYTES,
    'GitHub API response exceeded the output limit.');
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('GitHub API response was not valid JSON.');
  }
}

function validatePublishedRecord(release, ids, tags) {
  demand(isRecord(release), 'Release page contains a malformed record.');
  // Only an explicitly true draft is ignored. Any other value is treated as
  // a published record and must satisfy the complete mapping contract.
  if (release.draft === true) return null;
  demand(release.draft === false, 'Release draft flag is malformed.');
  demand(Number.isSafeInteger(release.id) && release.id > 0,
    'Published release IDs must be positive safe integers.');
  demand(!ids.has(release.id), `Duplicate published release ID: ${release.id}`);
  ids.add(release.id);

  const tag = release.tag_name;
  const productVersion = canonicalProductTag(tag);
  demand(!tags.has(tag), `Duplicate published release tag: ${tag}`);
  tags.add(tag);
  if (release.prerelease !== undefined) {
    demand(typeof release.prerelease === 'boolean'
      && release.prerelease === (semver.prerelease(productVersion) !== null),
    'Published release prerelease status does not match its canonical tag.');
  }
  const publishedAt = validUtcDate(release.published_at, 'Published release timestamp');
  demand(typeof release.target_commitish === 'string' && release.target_commitish.length > 0
    && release.target_commitish.length <= 256 && !CONTROL.test(release.target_commitish),
  'Published release target is malformed.');
  return {
    id: release.id,
    tag,
    productVersion,
    publishedAt,
  };
}

function validatePinnedPackage(packageJson, productVersion) {
  demand(isRecord(packageJson), 'Pinned package.json response must be an object.');
  demand(packageJson.name === PACKAGE_NAME, 'Pinned package.json has an unexpected package name.');
  const packageVersion = strictVersion(packageJson.version, 'Pinned package version');
  demand(packageVersion === productVersion, 'Pinned package version does not match its release tag.');
  return strictVersion(packageJson.desktopVersion, 'Pinned desktopVersion');
}

/**
 * Collect and map every published desktop release in the product repository.
 *
 * The release list is exhausted before any completeness result is returned.
 * Each published tag is resolved to a full commit and its package.json is
 * read at that commit; no baseline or chronology shortcut is used.
 */
export async function collectPublishedDesktopHistory({ repo } = {}, {
  run = releaseCommand,
  now = Date.now,
} = {}) {
  demand(repo === REPOSITORY_SLUG, `Release history is restricted to ${REPOSITORY_SLUG}.`);
  demand(typeof run === 'function', 'A release command function is required.');
  demand(typeof now === 'function', 'A clock function is required.');

  const startedAt = checkClock(now);
  const overallDeadline = startedAt + OVERALL_TIMEOUT_MS;
  demand(Number.isFinite(overallDeadline), 'Overall history deadline is invalid.');
  const endpoint = path => `repos/${repo}/${path}`;

  const api = async (path, args = []) => {
    const requestStartedAt = checkClock(now);
    if (requestStartedAt >= overallDeadline) throw new Error('Release history overall deadline expired.');
    const requestDeadline = Math.min(overallDeadline, requestStartedAt + REQUEST_TIMEOUT_MS);
    const timeout = Math.max(1, Math.floor(requestDeadline - requestStartedAt));
    let result;
    try {
      result = await run('gh', ['api', '--hostname', 'github.com', endpoint(path), ...args], {
        timeout,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    } catch {
      const failedAt = checkClock(now);
      if (failedAt >= overallDeadline) throw new Error('Release history overall deadline expired.');
      if (failedAt >= requestDeadline) throw new Error('GitHub API request deadline expired.');
      throw new Error('GitHub API request failed.');
    }
    const requestFinishedAt = checkClock(now);
    if (requestFinishedAt >= overallDeadline) throw new Error('Release history overall deadline expired.');
    if (requestFinishedAt >= requestDeadline) throw new Error('GitHub API request deadline expired.');
    return parseCommandResult(result);
  };

  const records = [];
  const ids = new Set();
  const tags = new Set();
  for (let page = 1; ; page += 1) {
    const releases = await api(`releases?per_page=${PAGE_SIZE}&page=${page}`);
    demand(Array.isArray(releases), 'Release history page must be an array.');
    demand(releases.length <= PAGE_SIZE, 'Release history page exceeds the requested page size.');
    for (const release of releases) {
      const record = validatePublishedRecord(release, ids, tags);
      if (record !== null) records.push(record);
    }
    if (releases.length < PAGE_SIZE) break;
  }

  const priorPublished = [];
  for (const release of records) {
    const resolved = await resolveReleaseTag({
      tag: release.tag,
    }, api);
    demand(isRecord(resolved) && COMMIT.test(resolved.commit),
      'Published release tag mapping is missing or invalid.');
    const packageJson = await api(
      `contents/package.json?ref=${encodeURIComponent(resolved.commit)}`,
      ['--header', 'Accept: application/vnd.github.raw+json'],
    );
    const desktopVersion = validatePinnedPackage(packageJson, release.productVersion);
    priorPublished.push({
      id: release.id,
      tag: release.tag,
      productVersion: release.productVersion,
      desktopVersion,
      commit: resolved.commit,
      publishedAt: release.publishedAt,
    });
  }
  demand(checkClock(now) < overallDeadline, 'Release history overall deadline expired.');
  return { priorPublished, historyComplete: true };
}
