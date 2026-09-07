import compare from 'semver/functions/compare.js';
import parse from 'semver/functions/parse.js';

/** @typedef {{ version: string, channel: 'beta' | 'stable' }} ReleaseVersion */

/**
 * Notification-only product versions, not desktop installation eligibility.
 * Accept canonical SemVer with an optional tag prefix; never coerce partial tags.
 * @param {unknown} tag
 * @returns {ReleaseVersion | null}
 */
export function parseReleaseVersion(tag) {
  if (typeof tag !== 'string' || tag.length > 256) return null;
  const version = tag.replace(/^v/, '');
  const parsed = parse(version);
  if (!parsed) return null;
  const canonical = parsed.version + (parsed.build.length ? `+${parsed.build.join('.')}` : '');
  if (canonical !== version) return null;
  if (parsed.prerelease.length === 0) return { version, channel: 'stable' };
  if (parsed.prerelease[0] === 'beta') return { version, channel: 'beta' };
  return null;
}

/**
 * Compare already validated product versions; build metadata has no precedence.
 * @param {string} first
 * @param {string} second
 * @returns {number}
 */
export function compareReleaseVersions(first, second) {
  return compare(first, second);
}
