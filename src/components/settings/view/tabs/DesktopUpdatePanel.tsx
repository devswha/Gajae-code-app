import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import type { useDesktopUpdate } from '../../../../hooks/useDesktopUpdate';
import { Button } from '../../../../shared/view/ui/Button';

type Props = { update: ReturnType<typeof useDesktopUpdate> };

const REASON_KEYS: Record<string, string> = {
  discovery_failed: 'desktopUpdate.reasons.discoveryFailed',
  cache_invalid: 'desktopUpdate.reasons.cacheInvalid',
  preparation_cancelled: 'desktopUpdate.reasons.preparationCancelled',
  preferences_not_persisted: 'desktopUpdate.reasons.preferencesNotPersisted',
  discovery_rate_limited: 'desktopUpdate.reasons.discoveryRateLimited',
};

export function desktopUpdateControls(update: Props['update']) {
  const { snapshot, bridgeActive, connected, pending, awaitingOperation, updating } = update;
  const locked = !bridgeActive || !connected || pending !== null || awaitingOperation || updating;
  const busy = Boolean(snapshot && ['checking', 'downloading', 'verifying', 'applying', 'restarting'].includes(snapshot.phase));
  const statusOnly = Boolean(snapshot && ['disabled', 'recovery'].includes(snapshot.phase));
  const canUpdate = Boolean(snapshot?.targetId && snapshot.installationAvailable && ['available', 'ready'].includes(snapshot.phase));
  return { locked, busy, statusOnly, canUpdate };
}

/** One button, two meanings: download while `available`, restart while `ready`. */
export function desktopUpdateAction(update: Props['update']) {
  const { snapshot, updating } = update;
  const ready = snapshot?.phase === 'ready';
  const version = snapshot?.targetProductVersion || snapshot?.targetDesktopVersion || '';
  return {
    ready,
    version,
    labelKey: ready
      ? (updating ? 'desktopUpdate.restarting' : 'desktopUpdate.restartToInstall')
      : (updating ? 'desktopUpdate.updating' : 'desktopUpdate.update'),
    helpKey: ready ? 'desktopUpdate.readyHelp' : 'desktopUpdate.manualHelp',
  };
}

export function DesktopUpdateStatus({ update }: Props) {
  const { t } = useTranslation('settings');
  const { snapshot, connected, pending, error, awaitingOperation, updating, updateError } = update;
  const reason = snapshot?.reason;
  const reasonKey = reason && Object.prototype.hasOwnProperty.call(REASON_KEYS, reason) ? REASON_KEYS[reason] : null;
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="space-y-1 [overflow-wrap:anywhere]">
      {snapshot ? <>
        {!connected && <p className="text-muted-foreground">{t('desktopUpdate.lastConfirmed')}</p>}
        <p className="font-medium text-foreground">{t(`desktopUpdate.phases.${snapshot.phase}`)}</p>
        {reason && <p dir="auto" className="whitespace-pre-wrap text-muted-foreground">{reasonKey ? t(reasonKey) : reason}</p>}
        {snapshot.discoveryIncomplete && <p className="text-muted-foreground">{t('desktopUpdate.incomplete')}</p>}
        {snapshot.phase === 'deferred' && <p className="text-muted-foreground">{t('desktopUpdate.deferredHelp')}</p>}
        {snapshot.phase === 'recovery' && <p className="text-muted-foreground">{t('desktopUpdate.recoveryHelp')}</p>}
      </> : <p className="text-muted-foreground">{t(error ? 'desktopUpdate.unconfirmed' : 'desktopUpdate.connecting')}</p>}
      {error && <p className="text-destructive">{t(`desktopUpdate.errors.${error}`)}</p>}
      {updateError && <p className={updateError === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{t(`desktopUpdate.updateErrors.${updateError}`)}</p>}
      {pending === 'setAutomatic' && <p className="text-muted-foreground">{t('desktopUpdate.confirmingSetting')}</p>}
      {awaitingOperation
        ? <p className="text-muted-foreground">{t('desktopUpdate.awaitingOperation')}</p>
        : pending === 'restart'
          ? <p className="text-muted-foreground">{t('desktopUpdate.confirmingRestart')}</p>
          : updating && <p className="text-muted-foreground">{t('desktopUpdate.updating')}</p>}
    </div>
  );
}

export function DesktopUpdateProgress({ update }: Props) {
  const { t, i18n } = useTranslation('settings');
  const { snapshot } = update;
  const numbers = new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language || 'en');
  const downloaded = snapshot?.downloadedBytes;
  const total = snapshot?.totalBytes;
  const determinate = downloaded != null && total != null && total > 0;
  if (snapshot?.phase === 'verifying') return <progress aria-label={t('desktopUpdate.phases.verifying')} className="h-2 w-full accent-primary" />;
  if (snapshot?.phase !== 'downloading') return null;
  return <div className="space-y-1">
    <progress
      aria-label={t('desktopUpdate.progress')}
      value={determinate ? downloaded : undefined}
      max={determinate ? total : undefined}
      className="h-2 w-full accent-primary"
    />
    <p className="text-xs text-muted-foreground">
      {determinate
        ? t('desktopUpdate.knownProgress', { downloaded: numbers.format(downloaded), total: numbers.format(total) })
        : downloaded != null && total === null
          ? t('desktopUpdate.unknownTotal', { downloaded: numbers.format(downloaded) })
          : t('desktopUpdate.unknownProgress')}
    </p>
  </div>;
}

export default function DesktopUpdatePanel({ update }: Props) {
  const { t } = useTranslation('settings');
  const id = useId();
  const { snapshot, error } = update;
  const { locked, busy, statusOnly, canUpdate } = desktopUpdateControls(update);
  const action = desktopUpdateAction(update);

  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-4 rounded-lg border border-border bg-card p-4">
      <h3 id={`${id}-title`} className="text-base font-medium text-foreground">{t('desktopUpdate.title')}</h3>
      <div className="text-sm"><DesktopUpdateStatus update={update} /></div>

      {snapshot && <>
        <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <dt className="text-muted-foreground">{t('desktopUpdate.productVersion')}</dt>
          <dd className="[overflow-wrap:anywhere] text-foreground">{snapshot.productVersion}</dd>
          <dt className="text-muted-foreground">{t('desktopUpdate.desktopVersion')}</dt>
          <dd className="[overflow-wrap:anywhere] text-foreground">{snapshot.desktopVersion}</dd>
          {snapshot.targetProductVersion !== null && <>
            <dt className="text-muted-foreground">{t('desktopUpdate.targetProductVersion')}</dt>
            <dd className="[overflow-wrap:anywhere] text-foreground">{snapshot.targetProductVersion}</dd>
          </>}
          {snapshot.targetDesktopVersion !== null && <>
            <dt className="text-muted-foreground">{t('desktopUpdate.targetDesktopVersion')}</dt>
            <dd className="[overflow-wrap:anywhere] text-foreground">{snapshot.targetDesktopVersion}</dd>
          </>}
        </dl>
        {!snapshot.installationAvailable && <p className="text-sm text-muted-foreground">{t('desktopUpdate.preparationOnly')}</p>}
        <DesktopUpdateProgress update={update} />
        <div className="space-y-1">
          <label className="flex min-h-11 items-center gap-3 text-sm text-foreground">
            <input
              type="checkbox"
              checked={snapshot.automatic}
              disabled={locked || busy || statusOnly}
              aria-describedby={`${id}-automatic`}
              className="h-4 w-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onChange={(event) => { void update.setAutomatic(event.target.checked); }}
            />
            {t('desktopUpdate.automatic')}
          </label>
          <p id={`${id}-automatic`} className="text-xs text-muted-foreground">{t('desktopUpdate.automaticHelp')}</p>
        </div>
      </>}

      <div className="flex flex-wrap gap-2">
        {snapshot && <Button type="button" variant="outline" className="h-auto min-h-11 whitespace-normal" disabled={locked || busy || statusOnly} onClick={() => { void update.check(); }}>
          {t('desktopUpdate.check')}
        </Button>}
        {(error || snapshot?.phase === 'error' || statusOnly) && <Button
          type="button" variant="outline" className="h-auto min-h-11 whitespace-normal"
          disabled={error || statusOnly ? update.pending !== null : locked || busy}
          onClick={() => { void (error || statusOnly ? update.refresh() : update.check()); }}
        >{t(error || statusOnly ? 'desktopUpdate.refresh' : 'desktopUpdate.retry')}</Button>}
        {canUpdate && <Button
          type="button" className="h-auto min-h-11 whitespace-normal" disabled={locked}
          aria-describedby={`${id}-manual ${id}-restart`} onClick={() => { void update.update(); }}
        >{t(action.labelKey)}</Button>}
      </div>
      <p id={`${id}-manual`} className="text-sm text-muted-foreground">{t(action.helpKey, { version: action.version })}</p>
      {canUpdate && <p id={`${id}-restart`} className="text-sm text-muted-foreground">{t('desktopUpdate.osPrompt')}</p>}
      {snapshot?.notes && <div className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">{t('desktopUpdate.notes')}</h4>
        <div role="region" aria-label={t('desktopUpdate.notes')} tabIndex={0} dir="auto" className="max-h-48 overflow-y-auto rounded-md bg-muted/40 p-3 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          {snapshot.notes}
        </div>
      </div>}
    </section>
  );
}
