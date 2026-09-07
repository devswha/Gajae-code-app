import { useTranslation } from 'react-i18next';

import { Button } from '../../../shared/view/ui/Button';
import { GJC_GOAL_RUN_LIMIT_MS, GJC_GOAL_TURN_LIMIT, type GjcGoalOperation, type GjcGoalSnapshot } from '../../../../shared/gjc-goal';

export type GoalControlsProps = {
  snapshot?: GjcGoalSnapshot;
  pending: boolean;
  connected: boolean;
  error?: string;
  control: (input: { operation: Exclude<GjcGoalOperation, 'get'>; objective?: string }) => Promise<unknown>;
  refresh: () => unknown;
};

export default function GoalControls({ snapshot, pending, connected, error, control, refresh }: GoalControlsProps) {
  const { t } = useTranslation('chat');
  const label = (key: string, fallback: string) => t(`goal.${key}`, { defaultValue: fallback });
  const goal = snapshot?.goal;
  if (!goal) return null;
  const paused = goal?.status === 'paused' || snapshot?.resumeRequired === true;
  const terminal = goal?.status === 'complete' || goal?.status === 'dropped';
  const disabled = pending || !connected || !snapshot?.canControl;
  const run = (operation: Exclude<GjcGoalOperation, 'get' | 'create'>) => { void control({ operation }).catch(() => {}); };
  const status = terminal ? goal?.status === 'complete' ? label('complete', 'Complete') : label('cancelled', 'Cancelled') : paused ? label('paused', 'Paused') : label('active', 'Active');
  return <section aria-label={label('region', 'Session goal')} className="border-b border-border bg-muted/30 px-4 py-2 text-xs">
    <div className="mx-auto flex max-w-217 flex-wrap items-center gap-2">
      <span role="status" className="font-semibold">{label('title', 'Goal')} · {status}</span>
      <span dir="auto" className="min-w-0 flex-1 text-sm break-words">{goal.objective}</span>
      <span className="text-muted-foreground">{t('goal.tokens', { value: goal.tokensUsed.toLocaleString(), defaultValue: `${goal.tokensUsed.toLocaleString()} tokens` })}</span>
      {!terminal && <>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => run(paused ? 'resume' : 'pause')}>{paused ? label('resume', 'Resume') : label('pause', 'Pause')}</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => run('drop')}>{label('cancel', 'Cancel goal')}</Button>
      </>}
      {!connected && <span>{label('reconnect', 'Reconnect to control goals.')}</span>}
      {snapshot && !snapshot.canControl && connected && <span className="text-muted-foreground">{label('unavailable', 'Goal controls are unavailable for this run or owner.')}</span>}
      {!terminal && <p className="w-full text-muted-foreground">{t('goal.guidance', { turns: GJC_GOAL_TURN_LIMIT, minutes: GJC_GOAL_RUN_LIMIT_MS / 60_000, defaultValue: `Each run pauses after ${GJC_GOAL_TURN_LIMIT} model steps or ${GJC_GOAL_RUN_LIMIT_MS / 60_000} minutes. Stop pauses the goal. Resume starts a new run when idle. Delegated tasks use the same model and permissions.` })}</p>}
      {error && <div role="alert" className="w-full text-destructive">{error} <Button size="sm" variant="ghost" onClick={() => refresh()}>{label('refresh', 'Refresh goal')}</Button></div>}
    </div>
  </section>;
}
