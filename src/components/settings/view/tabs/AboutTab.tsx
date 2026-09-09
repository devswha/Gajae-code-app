import { ExternalLink, MessageSquare, Star } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  BRAND_NAME,
  DOCUMENTATION_URL,
  GAJAE_APP_WORDMARK_FONT_FAMILY,
  GITHUB_REPOSITORY_NAME,
  GITHUB_REPOSITORY_OWNER,
  GITHUB_REPOSITORY_URL,
  LICENSE_URL,
  RELEASES_URL,
} from '../../../../constants/branding';
import { useDesktopUpdate } from '../../../../hooks/useDesktopUpdate';
import { useVersionCheck } from '../../../../hooks/useVersionCheck';

import DesktopUpdatePanel from './DesktopUpdatePanel';

const GITHUB_MARK = 'M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d={GITHUB_MARK} />
    </svg>
  );
}

type ExternalAnchorProps = { children: ReactNode; className: string; href: string };

function ExternalAnchor({ children, className, href }: ExternalAnchorProps) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>;
}

export default function AboutTab() {
  const { t } = useTranslation('settings');
  const desktopUpdate = useDesktopUpdate();
  const { updateAvailable, latestVersion, currentVersion, releaseInfo } = useVersionCheck(
    GITHUB_REPOSITORY_OWNER,
    GITHUB_REPOSITORY_NAME,
    !desktopUpdate.bridgeActive,
  );
  const releasesUrl = releaseInfo?.htmlUrl || RELEASES_URL;
  const displayedVersion = desktopUpdate.bridgeActive ? desktopUpdate.snapshot?.productVersion : currentVersion;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/90 shadow-xs">
          <MessageSquare className="h-5 w-5 text-primary-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="text-base font-semibold text-foreground"
              style={{ fontFamily: GAJAE_APP_WORDMARK_FONT_FAMILY }}
            >
              {BRAND_NAME}
            </span>
            <ExternalAnchor
              href={releasesUrl}
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium [overflow-wrap:anywhere] text-muted-foreground transition-colors hover:text-foreground"
            >
              {displayedVersion ? `v${displayedVersion}` : t('desktopUpdate.unknownVersion')}
            </ExternalAnchor>
            {updateAvailable && latestVersion && (
              <ExternalAnchor
                href={releasesUrl}
                className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20"
              >
                {t('about.updateAvailable', { version: latestVersion })}
                <ExternalLink className="h-2.5 w-2.5" />
              </ExternalAnchor>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Open-source AI coding assistant interface
          </p>
        </div>
      </div>

      {desktopUpdate.bridgeActive && <DesktopUpdatePanel update={desktopUpdate} />}

      <ExternalAnchor
        href={GITHUB_REPOSITORY_URL}
        className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <GitHubIcon className="h-4 w-4" />
        <Star className="h-3.5 w-3.5" />
        <span>Star on GitHub</span>
      </ExternalAnchor>

      <div className="flex flex-wrap gap-4 text-sm">
        <ExternalAnchor
          href={GITHUB_REPOSITORY_URL}
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <GitHubIcon className="h-4 w-4" />
          GitHub
        </ExternalAnchor>
        <ExternalAnchor
          href={DOCUMENTATION_URL}
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Docs
        </ExternalAnchor>
        <ExternalAnchor
          href={LICENSE_URL}
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          License
        </ExternalAnchor>
      </div>

      <div className="border-t border-border/50 pt-4">
        <ExternalAnchor
          href={LICENSE_URL}
          className="text-xs text-muted-foreground/60 transition-colors hover:text-muted-foreground"
        >
          Licensed under MIT
        </ExternalAnchor>
      </div>
    </div>
  );
}
