import { useEffect, useState } from 'react';

import { version } from '../../package.json';
import { compareReleaseVersions, parseReleaseVersion } from '../../shared/releaseVersion.js';
import type { ReleaseInfo } from '../types/sharedTypes';

const RELEASE_CHECK_DELAY = 5 * 60 * 1000;
const RELEASE_CHECK_TIMEOUT = 30 * 1000;
const RELEASE_PAGE_SIZE = 100;
const MAX_RELEASE_PAGES = 5;

type ReleaseNotification = {
  latestVersion: string;
  updateAvailable: boolean;
  releaseInfo: ReleaseInfo;
};

class ReleaseCheckError extends Error {
  readonly retryAt: number;

  constructor(response: Response) {
    super(`Version check failed: HTTP ${response.status}`);
    const retryAfter = response.status === 429 ? response.headers.get('Retry-After') : null;
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : NaN;
    const retryAt = Number.isFinite(seconds)
      ? Date.now() + seconds * 1000
      : Date.parse(retryAfter ?? '');
    this.retryAt = Number.isFinite(retryAt) ? retryAt : 0;
  }
}

/** Web notification metadata only. An incomplete traversal cannot name a latest release. */
export async function fetchReleaseNotification(
  owner: string,
  repo: string,
  currentVersion: string,
  signal: AbortSignal,
): Promise<ReleaseNotification | null> {
  signal.throwIfAborted();
  const current = parseReleaseVersion(currentVersion);
  if (!current) return null;
  const slug = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let latest: ReleaseNotification | null = null;

  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    signal.throwIfAborted();
    // Construct every URL ourselves: pagination metadata never supplies fetch authority.
    const response = await fetch(
      `https://api.github.com/repos/${slug}/releases?per_page=${RELEASE_PAGE_SIZE}&page=${page}`,
      { signal, headers: { Accept: 'application/vnd.github+json' } },
    );
    signal.throwIfAborted();
    if (!response.ok) throw new ReleaseCheckError(response);
    const releases: unknown = await response.json();
    signal.throwIfAborted();
    if (!Array.isArray(releases) || releases.length > RELEASE_PAGE_SIZE) {
      throw new Error('Version check failed: malformed releases list');
    }

    for (const release of releases) {
      if (!release || typeof release !== 'object' || release.draft !== false) continue;
      const candidate = parseReleaseVersion(release.tag_name);
      if (!candidate || release.prerelease !== (candidate.channel === 'beta')) continue;
      if (current.channel === 'stable' && candidate.channel !== 'stable') continue;
      if (latest && compareReleaseVersions(candidate.version, latest.latestVersion) <= 0) continue;
      latest = {
        latestVersion: candidate.version,
        updateAvailable: compareReleaseVersions(candidate.version, current.version) > 0,
        releaseInfo: {
          title: typeof release.name === 'string' && release.name ? release.name : release.tag_name,
          body: typeof release.body === 'string' ? release.body : '',
          htmlUrl: `https://github.com/${slug}/releases/tag/${encodeURIComponent(release.tag_name)}`,
          publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
        },
      };
    }

    const hasNext = /;\s*rel\s*=\s*"next"/i.test(response.headers.get('Link') ?? '');
    // A full page without an exposed Link header is not proof of completion.
    if (!hasNext && releases.length < RELEASE_PAGE_SIZE) return latest;
  }
  return null;
}

export const useVersionCheck = (owner: string, repo: string, enabled = true) => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null);

  useEffect(() => {
    let retired = false;
    let activeRequest: AbortController | null = null;
    let requestTimeout: number | undefined;
    let nextCheckAt = 0;
    const clearRelease = () => {
      setUpdateAvailable(false);
      setLatestVersion(null);
      setReleaseInfo(null);
    };

    const refreshRelease = async () => {
      if (retired || activeRequest || Date.now() < nextCheckAt) return;
      const controller = new AbortController();
      activeRequest = controller;
      requestTimeout = window.setTimeout(() => controller.abort(), RELEASE_CHECK_TIMEOUT);
      try {
        const release = await fetchReleaseNotification(owner, repo, version, controller.signal);
        if (retired) return;
        controller.signal.throwIfAborted();
        if (!release) {
          clearRelease();
          return;
        }
        setLatestVersion(release.latestVersion);
        setUpdateAvailable(release.updateAvailable);
        setReleaseInfo(release.releaseInfo);
      } catch (error) {
        if (retired) return;
        if (error instanceof ReleaseCheckError) nextCheckAt = error.retryAt;
        clearRelease();
      } finally {
        window.clearTimeout(requestTimeout);
        requestTimeout = undefined;
        activeRequest = null;
      }
    };

    clearRelease();
    if (!enabled) return;
    void refreshRelease();
    const timer = window.setInterval(refreshRelease, RELEASE_CHECK_DELAY);
    return () => {
      retired = true;
      window.clearInterval(timer);
      window.clearTimeout(requestTimeout);
      activeRequest?.abort();
    };
  }, [owner, repo, enabled]);

  return {
    updateAvailable: enabled && updateAvailable,
    latestVersion: enabled ? latestVersion : null,
    currentVersion: version,
    releaseInfo: enabled ? releaseInfo : null,
  };
};
