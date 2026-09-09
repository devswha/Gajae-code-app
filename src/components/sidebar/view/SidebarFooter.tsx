import { Archive, Bug, RefreshCw, Settings } from 'lucide-react';
import type { TFunction } from 'i18next';

import SidebarDesktopUpdate from './SidebarDesktopUpdate';

const GITHUB_ISSUES_URL = 'https://github.com/devswha/gajae-code-app/issues/new';
const GITHUB_REPO_URL = 'https://github.com/devswha/gajae-code-app';
const DISCORD_INVITE_URL = 'https://discord.gg/dskZax5JPh';

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

type SidebarFooterProps = {
  currentVersion: string;
  onOpenArchive: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onShowSettings: () => void;
  t: TFunction;
};

export default function SidebarFooter({
  currentVersion,
  onOpenArchive,
  onRefresh,
  isRefreshing,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  const utilityClassName = 'flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-hidden transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring';

  return (
    <footer className="shrink-0 px-2 pb-2" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))' }}>
      <div className="mb-1 h-px bg-border/50" />
      <SidebarDesktopUpdate />
      <button
        type="button"
        className="flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-muted-foreground outline-hidden transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onShowSettings}
      >
        <Settings className="size-4" aria-hidden />
        <span>{t('actions.settings')}</span>
      </button>

      <div className="flex items-center justify-between px-1 pt-0.5">
        <div className="flex items-center gap-0.5">
          <button className={utilityClassName} onClick={onOpenArchive} aria-label={t('archived.openArchive', 'Open archive')} title={t('archived.openArchive', 'Open archive')}>
            <Archive className="size-4" />
          </button>
          <button className={utilityClassName} onClick={onRefresh} disabled={isRefreshing} aria-label={t('tooltips.refresh')} title={t('tooltips.refresh')}>
            <RefreshCw className={`size-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          <a className={utilityClassName} href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer" aria-label={t('actions.reportIssue')} title={t('actions.reportIssue')}>
            <Bug className="size-4" />
          </a>
          <a className={utilityClassName} href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer" aria-label={t('actions.joinCommunity')} title={t('actions.joinCommunity')}>
            <DiscordIcon className="size-4" />
          </a>
        </div>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded px-1 text-[10px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
          title={`Gajae Code App v${currentVersion}`}
        >
          v{currentVersion}
        </a>
      </div>
    </footer>
  );
}
