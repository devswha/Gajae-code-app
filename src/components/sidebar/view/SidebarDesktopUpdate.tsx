import { Download, LoaderCircle, X } from 'lucide-react';
import { useId, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { useDesktopUpdate } from '../../../hooks/useDesktopUpdate';
import { Button } from '../../../shared/view/ui/Button';
import { DesktopUpdateProgress, DesktopUpdateStatus, desktopUpdateAction, desktopUpdateControls } from '../../settings/view/tabs/DesktopUpdatePanel';

// A notice dismissal lasts only for this page and this exact native target.
// It survives sidebar mode swaps, but never disables checks or hides a new target.
const dismissedTargets = new Set<string>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function dismiss(targetId: string) {
  dismissedTargets.add(targetId);
  for (const listener of listeners) listener();
}

type Props = { collapsed?: boolean; onExpand?: () => void };

export default function SidebarDesktopUpdate({ collapsed = false, onExpand }: Props) {
  const update = useDesktopUpdate();
  const { snapshot, bridgeActive } = update;
  const targetId = snapshot?.targetId;
  const dismissed = useSyncExternalStore(subscribe, () => Boolean(targetId && dismissedTargets.has(targetId)), () => false);

  // Only validated snapshots from the native client can introduce a notice.
  // Retained disconnected snapshots may remain visible, with mutations locked.
  if (!bridgeActive || !snapshot || !targetId || dismissed || ['disabled', 'idle'].includes(snapshot.phase)) return null;

  return <SidebarDesktopUpdateNotice update={update} targetId={targetId} collapsed={collapsed} onExpand={onExpand} />;
}

// Hidden/web/static footers do not need an i18next provider just to render nothing.
function SidebarDesktopUpdateNotice({ update, targetId, collapsed, onExpand }: Props & {
  update: ReturnType<typeof useDesktopUpdate>; targetId: string;
}) {
  const { t } = useTranslation('settings');
  const id = useId();
  const { snapshot, error, updating } = update;
  const { locked, busy, statusOnly, canUpdate } = desktopUpdateControls(update);
  const action = desktopUpdateAction(update);
  if (!snapshot) return null;

  const version = snapshot.targetProductVersion || snapshot.targetDesktopVersion;
  const versionLabel = version ? t('desktopUpdate.targetVersion', { version }) : t('desktopUpdate.unknownVersion');
  const phaseLabel = t(`desktopUpdate.phases.${snapshot.phase}`);
  const showRetry = !statusOnly && ['error', 'deferred'].includes(snapshot.phase);

  if (collapsed) {
    const label = t('desktopUpdate.showDetails', { version: versionLabel, status: phaseLabel });
    return <div data-sidebar-update="collapsed">
      <Button type="button" variant="ghost" size="icon" className="size-8 text-primary" onClick={onExpand}
        aria-label={label} title={label} aria-describedby={`${id}-status`}>
        {busy || updating ? <LoaderCircle aria-hidden className="motion-safe:animate-spin" /> : <Download aria-hidden />}
      </Button>
      <div id={`${id}-status`} className="sr-only"><DesktopUpdateStatus update={update} /></div>
    </div>;
  }

  return <section data-sidebar-update="expanded" aria-labelledby={`${id}-title`}
    className="mb-1.5 min-w-0 space-y-2 rounded-lg border border-border bg-card px-3 py-2.5 text-xs text-card-foreground">
    <div className="flex items-start gap-2">
      <Download className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <h3 id={`${id}-title`} className="min-w-0 flex-1 self-center font-semibold [overflow-wrap:anywhere]">{versionLabel}</h3>
      <Button type="button" size="icon" variant="ghost" className="-mt-1 -mr-1 size-7 shrink-0 text-muted-foreground"
        aria-label={t('desktopUpdate.dismiss')} title={t('desktopUpdate.dismiss')} onClick={() => dismiss(targetId)}>
        <X aria-hidden />
      </Button>
    </div>
    <DesktopUpdateStatus update={update} />
    <DesktopUpdateProgress update={update} />
    {!snapshot.installationAvailable && <p className="text-muted-foreground">{t('desktopUpdate.preparationOnly')}</p>}
    {canUpdate && <>
      <p id={`${id}-manual`} className="text-muted-foreground">{t(action.helpKey, { version: action.version })}</p>
      <Button type="button" size="sm" className="h-auto min-h-9 w-full whitespace-normal" disabled={locked}
        aria-describedby={`${id}-manual`} onClick={() => { void update.update(); }}>
        {t(action.labelKey)}
      </Button>
    </>}
    {(error || statusOnly || showRetry) && <Button type="button" size="sm" variant="outline"
      className="h-auto min-h-9 w-full whitespace-normal" disabled={error || statusOnly ? update.pending !== null : locked || busy}
      onClick={() => { void (error || statusOnly ? update.refresh() : update.check()); }}>
      {t(error || statusOnly ? 'desktopUpdate.refresh' : 'desktopUpdate.retry')}
    </Button>}
  </section>;
}
