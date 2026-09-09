import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';

import {
  GJC_GOAL_RUN_LIMIT_MS, GJC_GOAL_TURN_LIMIT, normalizeGjcGoalState, parseGjcGoalCommand,
  type GjcGoalCommand, type GjcGoalOperation, type GjcGoalSnapshot, type GjcGoalState, type GjcGoalScope,
} from '../shared/gjc-goal.js';

export type { GjcGoalScope } from '../shared/gjc-goal.js';
type GoalSession = {
  getGoalModeState(): unknown;
  setGoalModeState(state: GjcGoalState | undefined): void;
  operateGoal(operation: GjcGoalOperation, objective?: string): Promise<unknown>;
  abort(): Promise<void>;
};
type GoalManager = {
  getCwd(): string;
  getBranch(): Array<{ type: string; customType?: string; data?: unknown; mode?: string }>;
  appendCustomEntry(type: string, data: unknown): unknown;
  ensureOnDisk?(): Promise<void>;
  flush?(): Promise<void>;
};
const OWNER_ENTRY = 'gajae-goal-owner-v1';
export const GJC_GOAL_MODEL_OPERATIONS = ['create', 'get', 'pause', 'resume', 'complete'] as const;

export function readPersistedGjcGoal(manager: Pick<GoalManager, 'getBranch'>): { state?: GjcGoalState; scope?: GjcGoalScope } {
  let state: GjcGoalState | undefined;
  let scope: GjcGoalScope | undefined;
  for (const entry of manager.getBranch()) {
    if (entry.type === 'custom' && entry.customType === OWNER_ENTRY) scope = entry.data as GjcGoalScope;
    if (entry.type !== 'mode_change') continue;
    if (entry.mode !== 'goal' && entry.mode !== 'goal_paused') { state = undefined; continue; }
    const goal = (entry.data as { goal?: unknown } | undefined)?.goal;
    state = normalizeGjcGoalState({ enabled: entry.mode === 'goal', mode: 'active', goal });
    if (state?.goal.status === 'complete') state = { ...state, enabled: false, mode: 'exiting' };
  }
  return { state, scope };
}

export function ownsGjcGoal(scope: GjcGoalScope | undefined, expected: GjcGoalScope): boolean {
  return matchesGjcGoalOwner(scope, expected) && scope!.cwd === expected.cwd;
}

export function matchesGjcGoalOwner(scope: GjcGoalScope | undefined, expected: GjcGoalScope): boolean {
  return Boolean(scope && scope.appSessionId === expected.appSessionId && scope.owner === expected.owner
    && (scope.projectPath ?? scope.cwd) === (expected.projectPath ?? expected.cwd));
}

/** Public SDK lifecycle calls only. No transcript edits or synthetic completion. */
export class GjcGoalSession {
  private pending = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private turns = 0;
  private budgetStartedAt?: number;
  private stopping = false;
  private disposed = false;
  private stopPromise?: Promise<void>;
  private admittedActivation = false;
  private activeGoalId?: string;
  private observedGoalId?: string;

  constructor(
    private readonly session: GoalSession,
    private readonly manager: GoalManager,
    private readonly scope: GjcGoalScope,
    private readonly runId: string,
    private readonly publish: (snapshot: GjcGoalSnapshot) => void,
    private readonly stopRun: () => Promise<unknown>,
    private readonly modelOperations: readonly GjcGoalOperation[] = GJC_GOAL_MODEL_OPERATIONS,
  ) {}

  async restore(): Promise<void> {
    if (await realpath(this.manager.getCwd()) !== this.scope.cwd) throw new Error('Goal project does not match the session.');
    const persisted = readPersistedGjcGoal(this.manager);
    if ((persisted.state || persisted.scope) && !ownsGjcGoal(persisted.scope, this.scope)) throw new Error('This goal belongs to another session owner.');
    this.session.setGoalModeState(persisted.state);
    this.observedGoalId = persisted.state?.goal.id;
    // A fresh worker never revives a previously active goal by merely opening
    // the transcript or sending an unrelated message. Resume is explicit.
    if (persisted.state?.goal.status === 'active') { await this.session.operateGoal('pause'); await this.persist(); }
    this.publish(this.snapshot());
  }

  snapshot(): GjcGoalSnapshot {
    const state = normalizeGjcGoalState(this.session.getGoalModeState());
    return { supported: true, goal: state?.goal ?? null, runId: this.runId, canControl: !this.disposed && !this.stopping, resumeRequired: state?.goal.status === 'active' && !state.enabled };
  }

  control(input: GjcGoalCommand, allowed: readonly GjcGoalOperation[] = ['create', 'pause', 'resume', 'complete', 'drop']): Promise<GjcGoalSnapshot> {
    const command = parseGjcGoalCommand(input);
    const operation = this.pending.then(async () => {
      if (this.disposed || this.stopping || !allowed.includes(command.operation)) throw new Error('Goal operation is not allowed.');
      if (await realpath(this.manager.getCwd()) !== this.scope.cwd) throw new Error('Goal project changed.');
      const owner = readPersistedGjcGoal(this.manager).scope;
      if (owner && !ownsGjcGoal(owner, this.scope)) throw new Error('Goal ownership changed.');
      if (this.disposed || this.stopping) throw new Error('The goal run is stopping.');
      const state = normalizeGjcGoalState(this.session.getGoalModeState());
      if ((state?.goal.id ?? null) !== command.goalId && !(command.operation === 'create' && state?.goal.status === 'complete')) throw new Error('The goal changed. Refresh before controlling it.');
      if (command.operation === 'resume' && state?.goal.status !== 'paused') throw new Error('Only paused goals can be resumed.');
      if (command.operation === 'create') this.manager.appendCustomEntry(OWNER_ENTRY, this.scope);
      this.admittedActivation = command.operation === 'create' || command.operation === 'resume';
      try { await this.session.operateGoal(command.operation, command.objective); }
      finally { this.admittedActivation = false; }
      await this.persist();
      this.activeGoalId = this.snapshot().goal?.status === 'active' ? this.snapshot().goal?.id : undefined;
      if (command.operation === 'create' || command.operation === 'resume') this.armLimit();
      else this.clearLimit();
      const snapshot = this.snapshot();
      this.publish(snapshot);
      return snapshot;
    });
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }

  onEvent(event: unknown): void {
    if (!event || typeof event !== 'object' || this.disposed || this.stopping) return;
    const type = (event as { type?: string }).type;
    if (type === 'goal_updated') {
      const state = normalizeGjcGoalState((event as { state?: unknown }).state);
      if (state?.enabled && state.goal.status === 'active') {
        if (!this.admittedActivation && state.goal.id !== this.activeGoalId) {
          try {
            // The SDK's pending-skill path bypasses GoalTool. It must pass
            // the same operation, owner and cwd policy before continuation.
            const operation = this.observedGoalId === state.goal.id ? 'resume' : 'create';
            const owner = readPersistedGjcGoal(this.manager).scope;
            if (!this.modelOperations.includes(operation) || (owner && !ownsGjcGoal(owner, this.scope))
              || realpathSync(this.manager.getCwd()) !== this.scope.cwd) throw new Error('Goal activation is not allowed.');
            if (!owner) this.manager.appendCustomEntry(OWNER_ENTRY, this.scope);
            this.armLimit();
            const persist = this.pending.then(() => this.persist());
            this.pending = persist.catch(() => { this.stopAtLimit(); });
          } catch {
            this.session.setGoalModeState({ ...state, enabled: false });
            this.stopAtLimit();
            return;
          }
        }
        this.activeGoalId = state.goal.id;
      } else this.activeGoalId = undefined;
      this.observedGoalId = state?.goal.id;
    }
    if (type === 'turn_end' && this.snapshot().goal?.status === 'active' && ++this.turns >= GJC_GOAL_TURN_LIMIT) this.stopAtLimit();
  }

  private armLimit(): void {
    this.clearLimit();
    // This is a run budget, not a per-goal budget. Model/skill pause-resume
    // cycles and replacement goals cannot renew their own continuation lease.
    this.budgetStartedAt ??= Date.now();
    const remaining = GJC_GOAL_RUN_LIMIT_MS - (Date.now() - this.budgetStartedAt);
    if (this.turns >= GJC_GOAL_TURN_LIMIT || remaining <= 0) { this.stopAtLimit(); return; }
    this.timer = setTimeout(() => this.stopAtLimit(), remaining);
    this.timer.unref?.();
  }
  private clearLimit(): void { clearTimeout(this.timer); this.timer = undefined; }
  private stopAtLimit(): void { void this.stopRun().catch(() => {}); }
  private async persist(): Promise<void> {
    try {
      await this.manager.ensureOnDisk?.();
      await this.manager.flush?.();
    } catch (error) {
      // A goal without durable ownership/state must not schedule another turn.
      // Fence immediately; the asynchronous stop joins after this operation.
      const state = normalizeGjcGoalState(this.session.getGoalModeState());
      if (state?.enabled) this.session.setGoalModeState({ ...state, enabled: false });
      if (!this.stopping && !this.disposed) this.stopAtLimit();
      throw error;
    }
  }

  /** Preserve the original SDK GoalTool's ultragoal/provenance guards. */
  invokeTool<T>(operation: GjcGoalOperation, executeBuiltin: () => Promise<T>, allowed: readonly GjcGoalOperation[] = this.modelOperations): Promise<T> {
    const task = this.pending.then(async () => {
      if (this.disposed || this.stopping || !allowed.includes(operation)) throw new Error('Use the app goal controls for this operation.');
      const owner = readPersistedGjcGoal(this.manager).scope;
      if ((owner ? !ownsGjcGoal(owner, this.scope) : operation !== 'create' && operation !== 'get')
        || await realpath(this.manager.getCwd()) !== this.scope.cwd) throw new Error('Goal ownership or project changed.');
      if (this.disposed || this.stopping) throw new Error('The goal run is stopping.');
      if (operation === 'create' && !owner) this.manager.appendCustomEntry(OWNER_ENTRY, this.scope);
      this.admittedActivation = operation === 'create' || operation === 'resume';
      let result: T;
      try { result = await executeBuiltin(); }
      finally { this.admittedActivation = false; }
      await this.persist();
      if (operation === 'create' || operation === 'resume') this.armLimit();
      else if (this.snapshot().goal?.status !== 'active') this.clearLimit();
      this.publish(this.snapshot());
      return result;
    });
    this.pending = task.then(() => {}, () => {});
    return task;
  }

  /** Pause is durable before Stop settles; abort also fences queued SDK continuations. */
  fenceMutations(): void {
    this.stopping = true;
    this.clearLimit();
  }

  stop(): Promise<void> {
    return this.stopPromise ??= this.stopInner().catch((error) => {
      // Keep model mutations fenced, but let the user's Stop retry a failed
      // SDK abort or disk flush instead of retaining a rejected promise.
      this.stopPromise = undefined;
      this.publish(this.snapshot());
      throw error;
    });
  }

  private async stopInner(): Promise<void> {
    this.fenceMutations();
    // Calling abort now fences SDK prompt scheduling synchronously. Awaiting
    // pause first would leave a continuation window while accounting drains.
    const abort = this.session.abort();
    const pause = this.pending.then(async () => {
      if (normalizeGjcGoalState(this.session.getGoalModeState())?.goal.status === 'active') await this.session.operateGoal('pause');
    });
    const results = await Promise.allSettled([abort, pause]);
    // The pause may have succeeded even if the SDK abort failed. Preserve it
    // before reporting failure, and join both cleanup attempts before retry.
    await this.persist();
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    this.publish(this.snapshot());
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearLimit();
    await this.pending;
    await this.stopPromise;
  }
}
