import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import { createAgentSession, discoverAuthStorage } from '@gajae-code/coding-agent/sdk/session';
import { ModelRegistry } from '@gajae-code/coding-agent/config/model-registry';
import { mergeModelProfiles, resolveProfileBindings } from '@gajae-code/coding-agent/config/model-profiles';
import { activateModelProfile } from '@gajae-code/coding-agent/config/model-profile-activation';
import { resolveModelRoleValue } from '@gajae-code/coding-agent/config/model-resolver';
import { Settings } from '@gajae-code/coding-agent/config/settings';
import { AuthStorage } from '@gajae-code/coding-agent/session/auth-storage';
import { SessionDisposalIncompleteError } from '@gajae-code/coding-agent/session/agent-session';
import { SessionManager } from '@gajae-code/coding-agent/session/session-manager';
import { executeAcpBuiltinSlashCommand } from '@gajae-code/coding-agent/slash-commands/acp-builtins';
import { initTheme, theme } from '@gajae-code/coding-agent/modes/theme/theme';
import { generateSessionTitle } from '@gajae-code/coding-agent/utils/title-generator';
import { getSupportedEfforts } from '@gajae-code/ai/model-thinking';

import { parseGjcGoalCommand, type GjcGoalCommand, type GjcGoalSnapshot } from '../shared/gjc-goal.js';

import { appendImagesInputTag } from './shared/image-attachments.js';
import { GjcBunOAuthController, type GjcBunOAuthControllerOptions, type GjcOAuthActivitySnapshot } from './gjc-bun-oauth-controller.js';
import { GJC_APP_BUILTIN_COMMAND_NAMES } from './gjc-command-surface.generated.js';
import type { GjcWorkerOAuthRuntime, GjcWorkerRuntime, GjcWorkerWriter } from './gjc-worker.js';
import type { GjcWorkerActivity } from './gjc-worker-protocol.js';
import { GjcBunAskController } from './gjc-bun-ask-controller.js';
import { GjcCleanupUnconfirmedError, isGjcCleanupUnconfirmedError } from './gjc-cleanup-error.js';
import { isVerifiedSdkPatch, type VerifiedSdkPatch } from './gjc-runtime-manifest.js';
import { GjcDelegationExecutor, GJC_APP_DELEGATION_TOOL_NAMES, serializeGjcDelegationAutomationTools } from './gjc-delegation-executor.js';
import { createGjcPermissionProvider, type GjcPermissionProvider } from './gjc-bun-permission-gate.js';
import { forwardPromptTerminal, forwardSdkEvent, normalizeBuiltinCommandStdout, type SdkRunState } from './gjc-bun-sdk-events.js';
import { parseGjcRunPermissions, type GjcRunPermissions } from './gjc-permission-policy.js';
import { GjcModelResolutionError } from './gjc-model-resolution.js';
import { resolveContainedExportCommand } from './gjc-export-path.js';
import { readSessionSnapshot } from './gjc-session-state.js';
import { GjcGoalSession, GJC_GOAL_MODEL_OPERATIONS, matchesGjcGoalOwner, readPersistedGjcGoal, type GjcGoalScope } from './gjc-goal-session.js';
import { installGjcGoalTool } from './gjc-goal-tool.js';
import { installGjcCliShim } from './gjc-cli-shim.js';
import {
  closeGjcAutomationSession,
  createGjcAutomationTools,
  takeGjcAutomationBridgeTransport,
  type GjcAutomationBridgeTransport,
} from './gjc-automation-tools.js';
type Model = ReturnType<ModelRegistry['getAll']>[number];

type ExactCredentialRef =
  | { kind: 'stored'; providerId?: string; credentialId?: number }
  | { kind: 'runtime-env'; envVar: string };
type AppBashPolicy = { allowedPrefixes: string[]; restrictionProfile?: 'workflow' | 'read-only' };
export type SdkRunConfig = {
  cwd: string;
  sessionRoot: string;
  credential: ExactCredentialRef;
  modelId: string;
  modelProfile?: string;
  effort?: 'default' | 'inherit' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  toolNames: string[];
  spawns: string;
  bashPolicy: AppBashPolicy;
  appSessionId?: string;
  goalUiVersion?: number;
  goalOwner?: string;
  goalCommand?: GjcGoalCommand;
  /** Image attachments the client sent with this message (`{path, name?, mimeType?}` descriptors). */
  images?: unknown;
  /**
   * The project's permission policy. Absent means the app did not decide, and
   * the runtime keeps its own default (guarded tools run unprompted); present
   * means the session is switched to `prompt` mode and this policy answers.
   */
  permissions?: GjcRunPermissions;
};

/**
 * Appended to every session's system prompt: facts about the environment the
 * model runs in that its training cannot know.
 */
const GAJAE_APP_ENV_NOTE = [
  'This session runs inside Gajae Code App, which hosts the Gajae Code runtime in-process.',
  "The bundled gjc shim on PATH is for bundled workflow skills' `gjc state <skill> ...` commands; for sign-in, models, and permissions, use the app's Settings and never edit ~/.gjc directly.",
].join(' ');

let warnedAboutGjcCliShim = false;

export type GjcAgentSessionFactory = typeof createAgentSession;
/** The runtime's title generator, narrowed to what the adapter supplies. */
export type GjcSessionTitleGenerator = (firstMessage: string, registry: ModelRegistry, settings: Settings, model: Model) => Promise<string | null>;
export type GjcBunSdkAdapterOptions = {
  /** Source-integrity receipt from bootstrap, never a complete ownership proof. */
  sdkPatch?: VerifiedSdkPatch;
  createSessionFactory?: GjcAgentSessionFactory;
  generateSessionTitle?: GjcSessionTitleGenerator;
  /** Shorter UI grace for embedders/tests; never extends the ten-second cap. */
  sessionTitleGraceMs?: number;
  settings?: Settings;
  loadSettings?: () => Promise<Settings>;
  executeBuiltinCommand?: typeof executeAcpBuiltinSlashCommand;
  oauth?: GjcBunOAuthControllerOptions;
  automationBridge?: GjcAutomationBridgeTransport;
  closeAutomationSession?: (appSessionId: string) => Promise<void>;
};

export type GjcSdkActivitySnapshot = Readonly<{
  generation: string;
  revision: number;
  starting: number;
  running: number;
  settling: number;
  background: number;
  operations: number;
  oauth: GjcOAuthActivitySnapshot;
  /** Coverage only, NOT idle: all counts, including nested OAuth, must be zero. */
  complete: boolean;
  unknown: readonly string[];
  registry: GjcRegistryActivity;
  credentials: GjcRegistryActivity;
  settings: GjcRegistryActivity;
}>;

type GjcRegistryActivity = {
  generation: string; complete: boolean; starting: number; queued: number;
  running: number; settling: number; unknown: readonly string[];
};
type GjcRegistryLifecycle = {
  getAppLifecycleActivity(): GjcRegistryActivity;
  setAppLifecycleAdmission(closed: boolean): void;
};

/** Public patched ownership seam only; never inspect SDK private state. */
function readSdkLifecycleOwner(owner: unknown, unavailableReason: string): GjcRegistryActivity {
  const unknown = { generation: unavailableReason, complete: false,
    starting: 0, queued: 0, running: 0, settling: 0, unknown: [unavailableReason] };
  try {
    const source = owner as Partial<Pick<GjcRegistryLifecycle, 'getAppLifecycleActivity'>> | undefined;
    if (typeof source?.getAppLifecycleActivity !== 'function') return unknown;
    const value = source.getAppLifecycleActivity();
    if (!value || Object.keys(value).length !== 7 || typeof value.generation !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.generation)
      || typeof value.complete !== 'boolean'
      || [value.starting, value.queued, value.running, value.settling].some((count) => !Number.isSafeInteger(count) || count < 0)
      || !Array.isArray(value.unknown) || value.unknown.length > 32
      || value.unknown.some((reason) => typeof reason !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(reason))) return unknown;
    return { ...value, unknown: [...value.unknown] };
  } catch { return unknown; }
}

type ActiveRun = {
  goals?: GjcGoalSession;
  goalScope?: GjcGoalScope;
  markAborted?: () => void;
  session: {
    prompt(message: string, options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
    abort(): Promise<void>;
    dispose(): Promise<void>;
    awaitDisposeCompletion?(): Promise<void>;
    subscribe(listener: (event: unknown) => void): () => void;
    /** True while a turn is in flight. Absent on runtimes that never stream. */
    readonly isStreaming?: boolean;
    setSdkPermissionMode?(mode: 'prompt' | 'allow' | 'deny'): void;
    setSdkPermissionProvider?(provider: GjcPermissionProvider | undefined): void;
  };
  sessionManager: SessionManager;
  unsubscribe: () => void;
  askController: GjcBunAskController;
  state: SdkRunState;
  abortState: 'idle' | 'aborting' | 'aborted';
  settling: boolean;
  appSessionId?: string;
  delegation?: GjcDelegationExecutor;
};

const FAILURE = 'GJC SDK configuration is invalid.';

/** Normal end-of-run cleanup, never invoked by restart observation/admission. */
async function disposeSdkSession(session: ActiveRun['session']): Promise<void> {
  try { await session.dispose(); }
  catch (error) {
    // SDK 0.16.4's public caller deadline does not end its teardown owner.
    // Join that exact session's retained promise while the adapter root stays
    // in settling. Real cleanup failures still poison the worker; an arbitrary
    // provider error with the same name is not permission to ignore failure.
    if (!(error instanceof SessionDisposalIncompleteError) || !session.awaitDisposeCompletion) throw error;
  }
  await session.awaitDisposeCompletion?.();
}
const MODEL_ID_EFFORT = /-(off|minimal|low|medium|high|xhigh|max)(?:-fast)?$/;
/**
 * How long a finished turn waits for its title before releasing the UI. The
 * title is a 30-token completion started with the turn, so it is normally
 * long done; a hung title request must not hold the turn's terminal frame.
 */
const SESSION_TITLE_GRACE_MS = 10_000;
/** The runtime's own opt-out, honoured so one environment silences both the TUI and the app. */
function sessionTitlesDisabled(): boolean {
  return Boolean(process.env.GJC_NO_TITLE || process.env.PI_NO_TITLE);
}
/**
 * The runtime picks the title model itself (its `default` role, else the
 * turn's model). No sticky-credential session id or metadata resolver is
 * passed: the app selects credentials per run, not per TUI session.
 */
const runtimeSessionTitle: GjcSessionTitleGenerator = (firstMessage, registry, settings, model) =>
  generateSessionTitle(firstMessage, registry, settings, undefined, model);
const RUNTIME_CREDENTIAL_ENV_VARS = new Set([
  'GJC_RUNTIME_API_KEY',
]);

export function applyGjcToolSettingsPolicy(settings: Settings): void {
  // Default closed. The adapter enables this only after admitting a capable,
  // owned app view with scoped controls, persistence and a continuation limit.
  settings.override('goal.enabled', false);

  // ast_edit only previews rewrites and queues hidden `resolve` to apply them.
  // `resolve` is not requestable through toolNames, so leaving this enabled
  // would advertise edits the browser session can never commit.
  settings.override('astEdit.enabled', false);

  // Tool discovery is the other door into the session's tool set, and it does
  // not consult `toolNames`: a server listed in the user's own settings, or an
  // `.mcp.json` in whatever project they open, would put tools this app never
  // decided on in front of a browser session. Both default to false, so this
  // pins the default rather than changing behaviour - but a boundary that only
  // holds while a user leaves their config alone is not a boundary.
  settings.override('mcp.discoveryMode', false);
  settings.override('mcp.enableProjectConfig', false);
}

function isAppOAuthCommand(message: string): boolean {
  const commandName = /^\/([^\s]+)/.exec(message.trim())?.[1];
  return commandName === 'login' || commandName === 'logout';
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactCredentialRef(value: unknown): value is ExactCredentialRef {
  if (!object(value)) return false;
  if (value.kind === 'stored') {
    return Object.keys(value).every((key) => key === 'kind' || key === 'providerId' || key === 'credentialId')
      && (value.providerId === undefined || (typeof value.providerId === 'string' && value.providerId.length > 0))
      && (value.credentialId === undefined || (typeof value.credentialId === 'number' && Number.isInteger(value.credentialId)));
  }
  return value.kind === 'runtime-env'
    && Object.keys(value).length === 2
    && typeof value.envVar === 'string'
    && RUNTIME_CREDENTIAL_ENV_VARS.has(value.envVar);
}

function configFromOptions(value: Record<string, unknown>): SdkRunConfig {
  const candidate = value;
  if (!object(candidate)
    || typeof candidate.cwd !== 'string' || !candidate.cwd
    || typeof candidate.sessionRoot !== 'string' || !candidate.sessionRoot
    || !exactCredentialRef(candidate.credential)
    || typeof candidate.modelId !== 'string' || !candidate.modelId
    || (candidate.modelProfile !== undefined && (typeof candidate.modelProfile !== 'string' || !candidate.modelProfile))
    || (candidate.effort !== undefined && ![
      'default', 'inherit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
    ].includes(String(candidate.effort)))
    || !Array.isArray(candidate.toolNames) || candidate.toolNames.some((name) => typeof name !== 'string' || !name)
    || typeof candidate.spawns !== 'string'
    || !object(candidate.bashPolicy) || !Array.isArray(candidate.bashPolicy.allowedPrefixes)
    || candidate.bashPolicy.allowedPrefixes.some((prefix) => typeof prefix !== 'string')
    || (candidate.bashPolicy.restrictionProfile !== undefined
      && candidate.bashPolicy.restrictionProfile !== 'workflow'
      && candidate.bashPolicy.restrictionProfile !== 'read-only')
    || (candidate.appSessionId !== undefined && (typeof candidate.appSessionId !== 'string' || !candidate.appSessionId))
  ) throw new Error(FAILURE);
  // A malformed policy block throws GjcRunPermissionsError, which keeps its
  // `invalid_permissions` code so the worker can answer with that code and the
  // app can tell the user why the run never started.
  const permissions = parseGjcRunPermissions(candidate.permissions);
  if (candidate.goalCommand !== undefined) parseGjcGoalCommand(candidate.goalCommand);
  if (candidate.goalOwner !== undefined && (typeof candidate.goalOwner !== 'string' || !candidate.goalOwner)) throw new Error(FAILURE);
  return {
    ...(candidate as unknown as SdkRunConfig),
    // The SDK resolves builtin names case-insensitively. Canonicalize before
    // selecting app replacements so TASK cannot reach its builtin executor.
    toolNames: candidate.toolNames.map((name: string) => name.toLowerCase()),
    ...(permissions ? { permissions } : {}),
  };
}

async function modelsForCredential(
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
  credential: ExactCredentialRef,
): Promise<Model[]> {
  const available = modelRegistry.getAvailable();
  if (credential.kind === 'runtime-env') return available;

  const rows: Array<{ id: number; provider: string }> = authStorage.exportSnapshot().credentials;
  const eligibleProviders = new Set(
    rows
      .filter((row) => credential.providerId === undefined || row.provider === credential.providerId)
      .filter((row) => credential.credentialId === undefined || row.id === credential.credentialId)
      .map((row) => row.provider),
  );
  // A provider with no stored row can still be usable when the auth layer can
  // resolve a credential another way - a `models.yml` `apiKey`/`apiKeyEnv` pin,
  // or the env fallback. `peekApiKey` answers exactly that question without
  // resolving anything, so probing each row-less provider once keeps default
  // role resolution aligned with what the run could actually authenticate. A
  // pinned providerId/credentialId is an assertion, not a search: no probe.
  if (credential.providerId === undefined && credential.credentialId === undefined) {
    for (const provider of new Set(available.map((model) => model.provider))) {
      if (!eligibleProviders.has(provider) && await authStorage.peekApiKey(provider) !== undefined) {
        eligibleProviders.add(provider);
      }
    }
  }
  return available.filter((model) => eligibleProviders.has(model.provider));
}

async function configuredDefaultModelId(
  settings: Settings,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
  credential: ExactCredentialRef,
  modelProfile?: string,
): Promise<string> {
  const resolveConfigured = async (selector: Parameters<typeof resolveModelRoleValue>[0]): Promise<string | undefined> => {
    const resolved = resolveModelRoleValue(selector, await modelsForCredential(authStorage, modelRegistry, credential), {
      settings,
      modelRegistry,
    });
    return resolved.model ? `${resolved.model.provider}/${resolved.model.id}` : undefined;
  };
  if (modelProfile) {
    const profile = modelRegistry.getModelProfile(modelProfile) ?? mergeModelProfiles().get(modelProfile);
    const selector = profile && resolveProfileBindings(profile).defaultSelector;
    const resolved = await resolveConfigured(selector);
    if (!resolved) throw new GjcModelResolutionError();
    return resolved;
  }
  const roleValue = settings.getModelRole('default');
  const roleModelId = await resolveConfigured(roleValue);
  if (roleModelId) return roleModelId;

  const profileName = settings.get('modelProfile.default');
  if (typeof profileName !== 'string' || !profileName) throw new GjcModelResolutionError();

  // ModelRegistry loads models.yml user profiles and merges them with builtins.
  const profile = modelRegistry.getModelProfile(profileName) ?? mergeModelProfiles().get(profileName);
  const selector = profile && resolveProfileBindings(profile).defaultSelector;
  const resolved = await resolveConfigured(selector);
  if (!resolved) throw new GjcModelResolutionError();
  return resolved;
}

/**
 * The `default` role resolves against the registry's available models, and a
 * warm worker's registry can lose models between runs: after a turn, the
 * runtime's catalog refresh replaces a preset-registered provider's models
 * with the one it discovered, and the role's model is no longer there until
 * the next `refresh()` restores it. Every `session.start` with the app default
 * after that failed with `model_unresolved` while an explicit model id, which
 * already refreshes on a miss, kept working. Same remedy here.
 */
async function configuredDefaultModelIdWithRefresh(
  settings: Settings,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
  credential: ExactCredentialRef,
  modelProfile?: string,
): Promise<string> {
  try {
    return await configuredDefaultModelId(settings, authStorage, modelRegistry, credential, modelProfile);
  } catch (error) {
    if (!(error instanceof GjcModelResolutionError)) throw error;
    await modelRegistry.refresh();
    return configuredDefaultModelId(settings, authStorage, modelRegistry, credential, modelProfile);
  }
}

function modelFor(registry: ModelRegistry, modelId: string): Model {
  const all = registry.getAll();
  // Provider-qualified form wins: a gateway model whose bare id happens to look
  // like "provider/id" must not shadow the provider-qualified reference.
  const qualified = all.filter((model) => `${model.provider}/${model.id}` === modelId);
  const matches = qualified.length > 0 ? qualified : all.filter((model) => model.id === modelId);
  if (matches.length !== 1) throw new Error(FAILURE);
  return matches[0];
}

async function modelForWithRefresh(registry: ModelRegistry, modelId: string): Promise<Model> {
  try {
    return modelFor(registry, modelId);
  } catch {
    // A long-lived worker may not have seen newly available models yet.
    await registry.refresh();
    return modelFor(registry, modelId);
  }
}

async function credentialFor(
  authStorage: AuthStorage,
  credential: ExactCredentialRef,
  model: ReturnType<ModelRegistry['getAll']>[number],
): Promise<{ credentialSelector?: { provider: string; selector: { kind: 'id'; value: string }; raw: string }; credential?: { kind: 'stored'; providerId: string; credentialId: number }; dispose(): void }> {
  if (credential.kind === 'stored') {
    // The provider is derived deterministically from the pinned model; an
    // explicit providerId is an assertion that must agree with it.
    if (credential.providerId !== undefined && credential.providerId !== model.provider) throw new Error(FAILURE);
    const snapshotRows: Array<{ id: number; provider: string }> = authStorage.exportSnapshot().credentials;
    const rows = snapshotRows
      .filter((row) => row.provider === model.provider)
      .sort((left, right) => left.id - right.id);
    if (rows.length === 0) {
      // No stored row to pin. The runtime still authenticates the provider
      // itself when no selector is installed - a `models.yml` `apiKey`/
      // `apiKeyEnv` pin or the env fallback, which is how the CLI runs these
      // providers. When nothing resolves either, name the model problem
      // instead of failing as a generic worker error.
      if (await authStorage.peekApiKey(model.provider) === undefined) throw new GjcModelResolutionError();
      return { dispose() {} };
    }
    // Deterministic selection: explicit credentialId wins; otherwise the lowest
    // stored row id. Installing a selector also blocks the env-var fallback.
    const row = credential.credentialId !== undefined
      ? rows.find((candidate) => candidate.id === credential.credentialId)
      : rows[0];
    if (!row) throw new Error(FAILURE);
    return {
      credentialSelector: {
        provider: model.provider,
        selector: { kind: 'id', value: String(row.id) },
        raw: `id:${row.id}`,
      },
      credential: { kind: 'stored', providerId: model.provider, credentialId: row.id },
      dispose() {},
    };
  }

  const apiKey = process.env[credential.envVar];
  if (!apiKey) throw new Error(FAILURE);
  authStorage.setRuntimeApiKey(model.provider, apiKey);
  return {
    dispose: () => authStorage.removeRuntimeApiKey(model.provider),
  };
}

async function resumeManager(providerSessionId: string, sessionRoot: string): Promise<SessionManager> {
  const matches = (await SessionManager.list('', sessionRoot)).filter((session) => session.id === providerSessionId);
  if (matches.length !== 1) throw new Error(FAILURE);
  const manager = await SessionManager.open(matches[0].path, sessionRoot);
  if (manager.getSessionId() !== providerSessionId) throw new Error(FAILURE);
  return manager;
}

/** In-process, serial-only SDK runtime. AuthStorage and ModelRegistry are app-owned singleton inputs. */
export class GjcBunSdkAdapter implements GjcWorkerRuntime {
  readonly #generation = randomUUID();
  #revision = 0;
  #operations = 0;
  #backgroundTitles = 0;
  #admissionClosed = false;
  #sdkBackgroundOwnershipUnproven = false;
  readonly #sdkSessionOwners = new Set<ActiveRun['session']>();
  readonly #sdkCoverageFailures = new Set<string>();
  #baseSettings?: Settings;
  #cleanupFailure?: GjcCleanupUnconfirmedError;

  getGeneration(): string {
    // Hash the component generations so adding another real owner cannot exceed
    // the protocol's bounded identifier size during a long-running worker.
    return createHash('sha256').update(JSON.stringify([
      this.#generation, this.#revision, this.oauth.getGeneration(), this.#registryActivity().generation,
      this.#credentialActivity().generation, this.#settingsActivity().generation,
      [...this.#sdkSessionOwners].map((session) => readSdkLifecycleOwner(session, 'sdk_background_ownership_unproven').generation),
    ])).digest('hex');
  }

  setAdmissionFence(closed: boolean): void {
    if (this.#admissionClosed === closed) return;
    this.#admissionClosed = closed;
    this.#revision += 1;
    const registry = this.modelRegistry as ModelRegistry & Partial<GjcRegistryLifecycle>;
    registry.setAppLifecycleAdmission?.(closed);
  }

  #registryActivity(): GjcRegistryActivity {
    const registry = this.modelRegistry as ModelRegistry & Partial<GjcRegistryLifecycle>;
    return readSdkLifecycleOwner(typeof registry.setAppLifecycleAdmission === 'function' ? registry : undefined,
      'sdk_registry_ownership_unproven');
  }
  #credentialActivity(): GjcRegistryActivity { return readSdkLifecycleOwner(this.authStorage, 'sdk_auth_ownership_unproven'); }
  #settingsActivity(): GjcRegistryActivity { return readSdkLifecycleOwner(this.#baseSettings, 'sdk_settings_ownership_unproven'); }

  #assertAdmission(): void {
    this.#assertHealthy();
    if (this.#admissionClosed) throw Object.assign(new Error('Worker admission is fenced.'), { code: 'worker_admission_fenced' });
  }

  /** No credential access, teardown, SDK diagnostic polling or new work. */
  observeActivity(): GjcWorkerActivity {
    const value = this.snapshotActivity();
    return {
      generation: value.generation,
      complete: value.complete,
      starting: value.starting + value.oauth.starting + value.registry.starting + value.credentials.starting + value.settings.starting,
      queued: value.registry.queued + value.credentials.queued + value.settings.queued,
      running: value.running + value.oauth.running + value.registry.running + value.credentials.running + value.settings.running,
      settling: value.settling + value.operations + value.oauth.settling + value.background + value.registry.settling + value.credentials.settling + value.settings.settling,
      approvals: value.oauth.approvals,
      retained: 0,
      unknown: [...value.unknown],
    };
  }

  /** Fixed-size, credential-free observation. Never polls or disposes the SDK. */
  snapshotActivity(): GjcSdkActivitySnapshot {
    const oauth = this.oauth.snapshotActivity();
    const registry = this.#registryActivity();
    const credentials = this.#credentialActivity();
    const settings = this.#settingsActivity();
    let starting = 0;
    let running = 0;
    let settling = 0;
    for (const runId of this.#starting.keys()) if (!this.#runs.has(runId)) starting += 1;
    for (const run of this.#runs.values()) {
      if (run.settling) settling += 1;
      else running += 1;
    }
    const unknown: GjcSdkActivitySnapshot['unknown'][number][] = [];
    if (this.#sdkBackgroundOwnershipUnproven) unknown.push('sdk_background_ownership_unproven');
    if (this.#cleanupFailure) unknown.push('sdk_cleanup_unconfirmed');
    unknown.push(...this.#sdkCoverageFailures);
    const activeSessions = new Set([...this.#runs.values()].map((run) => run.session));
    for (const session of this.#sdkSessionOwners) {
      const activity = readSdkLifecycleOwner(session, 'sdk_background_ownership_unproven');
      // An active run already owns its entire subtree until retained disposal.
      // A returned session not (or no longer) covered by a run still counts.
      if (!activeSessions.has(session)) {
        starting += activity.starting;
        running += activity.running;
        settling += activity.queued + activity.settling;
      }
      unknown.push(...activity.unknown);
      if (!activity.complete && !activity.unknown.length) unknown.push('sdk_background_ownership_unproven');
    }
    // Ordinary diagnostics describe coverage. A worker admission proof, unlike
    // those diagnostics, requires the registry's own producer fence to be shut.
    unknown.push(...registry.unknown.filter((reason) => this.#admissionClosed || reason !== 'model_registry_admission_open'));
    if (!registry.complete && registry.unknown.length === 0) unknown.push('sdk_registry_ownership_unproven');
    for (const [value, reason] of [[credentials, 'sdk_auth_ownership_unproven'], [settings, 'sdk_settings_ownership_unproven']] as const) {
      unknown.push(...value.unknown);
      if (!value.complete && !value.unknown.length) unknown.push(reason);
    }
    return {
      generation: this.getGeneration(), revision: this.#revision + oauth.revision,
      starting, running, settling, background: this.#backgroundTitles, operations: this.#operations,
      oauth, registry, credentials, settings, complete: unknown.length === 0, unknown: [...new Set(unknown)],
    };
  }

  async #withOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.#operations += 1;
    this.#revision += 1;
    try { return await operation(); }
    finally {
      this.#operations -= 1;
      this.#revision += 1;
    }
  }

  async #withTitleTask(operation: () => Promise<void>): Promise<void> {
    // Reserve synchronously, including before an injected generator can throw.
    // The lifetime includes setSessionName persistence and the title callback.
    this.#backgroundTitles += 1;
    this.#revision += 1;
    try { await operation(); }
    catch { /* A title failure does not fail the user's turn. */ }
    finally {
      this.#backgroundTitles -= 1;
      this.#revision += 1;
    }
  }

  #assertHealthy(): void {
    if (this.#cleanupFailure) throw this.#cleanupFailure;
  }

  #poison(): GjcCleanupUnconfirmedError {
    if (this.#cleanupFailure) return this.#cleanupFailure;
    const failure = this.#cleanupFailure = new GjcCleanupUnconfirmedError();
    this.#revision += 1;
    // Fence every session in this shared runtime immediately. These are only
    // best-effort aborts; the Node supervisor must prove whole-worker reaping.
    for (const starting of this.#starting.values()) starting.abortRequested = true;
    for (const run of this.#runs.values()) {
      run.abortState = 'aborting';
      run.state.abortPending = true;
      for (const stop of [
        () => run.goals?.fenceMutations(),
        () => run.askController.dispose(),
        () => run.delegation?.dispose(),
        () => run.session.abort(),
      ]) {
        try { void Promise.resolve(stop()).catch(() => {}); }
        catch { /* The fatal fault already requires OS-level termination. */ }
      }
    }
    return failure;
  }
  readonly #runs = new Map<string, ActiveRun>();
  /** Accepted roots through settlement; pre-session aborts still reach them here. */
  readonly #starting = new Map<string, { abortRequested: boolean }>();
  readonly oauth: GjcWorkerOAuthRuntime & Pick<GjcBunOAuthController, 'snapshotActivity' | 'getGeneration'>;

  constructor(
    private readonly authStorage: AuthStorage,
    private readonly modelRegistry: ModelRegistry,
    private readonly options: GjcBunSdkAdapterOptions = {},
  ) {
    if (modelRegistry.authStorage !== authStorage) throw new Error(FAILURE);
    if (options.sdkPatch !== undefined && !isVerifiedSdkPatch(options.sdkPatch)) throw new Error(FAILURE);
    this.#baseSettings = options.settings;
    const oauth = new GjcBunOAuthController(authStorage, modelRegistry, options.oauth);
    this.oauth = {
      providers: () => oauth.providers(),
      status: () => oauth.status(),
      start: (providerId) => { this.#assertAdmission(); return oauth.start(providerId); },
      submit: (attemptId, value) => oauth.submit(attemptId, value),
      cancel: (attemptId) => oauth.cancel(attemptId),
      subscribe: (listener) => oauth.subscribe(listener),
      close: () => oauth.close(),
      snapshotActivity: () => oauth.snapshotActivity(),
      getGeneration: () => oauth.getGeneration(),
    };
  }

  async modelCatalog() {
    this.#assertAdmission();
    return this.#withOperation(() => this.#modelCatalog());
  }

  async #modelCatalog() {
    const seen = new Set<string>();
    const models = [];
    const candidates = await modelsForCredential(this.authStorage, this.modelRegistry, { kind: 'stored' });

    for (const model of candidates) {
      const value = `${model.provider}/${model.id}`;
      if (seen.has(value)) continue;
      seen.add(value);
      let efforts: readonly string[] = [];
      if (model.reasoning) {
        efforts = getSupportedEfforts(model);
      }
      const defaultEffort = MODEL_ID_EFFORT.exec(model.id)?.[1];
      const canonicalId = this.modelRegistry.getCanonicalId(model);
      models.push({
        value,
        label: model.name || model.id,
        group: model.provider,
        ...(canonicalId ? { canonicalId } : {}),
        effort: {
          ...(defaultEffort ? { default: defaultEffort } : {}),
          values: efforts.map((effort) => ({ value: effort })),
        },
      });
    }
    return { models };
  }

  spawnGjc(message: string, options: Record<string, unknown>, writer: GjcWorkerWriter): Promise<void> & { abortHandle?: string; processId?: number } {
    this.#assertAdmission();
    if (isAppOAuthCommand(message)) throw new Error(FAILURE);
    const runId = typeof options.runHandle === 'string' && options.runHandle ? options.runHandle : '';
    const config = configFromOptions(options);
    if (!runId || this.#runs.has(runId) || this.#starting.has(runId)) throw new Error(FAILURE);
    this.#starting.set(runId, { abortRequested: false });
    this.#revision += 1;
    const guardedWriter: GjcWorkerWriter = {
      send: (value) => { if (!this.#cleanupFailure) writer.send(value); },
      ...(writer.setSessionId ? { setSessionId: (id: string) => { if (!this.#cleanupFailure) writer.setSessionId!(id); } } : {}),
      ...(writer.setCredential ? { setCredential: (credential: Parameters<NonNullable<GjcWorkerWriter['setCredential']>>[0]) => {
        if (!this.#cleanupFailure) writer.setCredential!(credential);
      } } : {}),
      ...(writer.setModel ? { setModel: (model: string) => { if (!this.#cleanupFailure) writer.setModel!(model); } } : {}),
      ...(writer.setAborted ? { setAborted: () => { if (!this.#cleanupFailure) writer.setAborted!(); } } : {}),
    };
    const task = this.#run(runId, message, options, config, guardedWriter).finally(() => {
      this.#starting.delete(runId);
      this.#revision += 1;
    });
    return Object.assign(task, { abortHandle: runId });
  }

  /**
   * Delivers a message into the turn that is already running.
   *
   * The SDK's own `prompt()` routes a call made while streaming into the
   * session's steering queue, so the running turn picks the message up instead
   * of a second turn being started behind it. That is the whole feature: the
   * live session object is already held here for the duration of the run,
   * which is the same handle `abortGjcSession` uses.
   *
   * Refuses when the run is not streaming. Prompting a settled session would
   * silently start a fresh turn under a run id whose terminal event the client
   * has already seen, so the caller queues the message instead.
   */
  async steerGjcSession(runHandle: string, message: string): Promise<boolean> {
    this.#assertHealthy();
    return this.#withOperation(() => this.#steerGjcSession(runHandle, message));
  }

  async #steerGjcSession(runHandle: string, message: string): Promise<boolean> {
    const run = this.#runs.get(runHandle);
    if (!run || run.abortState !== 'idle') return false;
    if (run.session.isStreaming === false) return false;

    const text = message.trim();
    if (!text) return false;

    // The SDK refuses a bare prompt() on a busy agent (AgentBusyError) and
    // requires the caller to say which queue the message belongs in. 'steer' is
    // the one the running turn consumes at its next tool or turn boundary.
    await run.session.prompt(text, { streamingBehavior: 'steer' });
    return true;
  }

  async abortGjcSession(sessionId: string): Promise<boolean> {
    this.#assertHealthy();
    return this.#withOperation(() => this.#abortGjcSession(sessionId));
  }

  async #abortGjcSession(sessionId: string): Promise<boolean> {
    const run = this.#runs.get(sessionId);
    if (!run) {
      // Stop pressed while the session is still being built (model and
      // credential resolution, createAgentSession): there is nothing to abort
      // yet, but there will be. Record it so the run ends before its prompt
      // instead of refusing the user and letting the turn go ahead.
      const starting = this.#starting.get(sessionId);
      if (!starting || starting.abortRequested) return false;
      starting.abortRequested = true;
      this.#revision += 1;
      return true;
    }
    if (run.abortState !== 'idle') return false;
    run.abortState = 'aborting';
    // Set before awaiting: the SDK emits its aborted `message_end` while
    // `session.abort()` is still in flight, and that turn must not be reported
    // back to the user as an unexpected interruption.
    run.state.abortPending = true;
    this.#revision += 1;
    const closeAutomation = this.options.closeAutomationSession
      ?? (this.options.automationBridge
        ? (appSessionId: string) => closeGjcAutomationSession(appSessionId, this.options.automationBridge)
        : undefined);
    const automationCleanup = run.appSessionId && closeAutomation
      ? closeAutomation(run.appSessionId).catch(() => {})
      : Promise.resolve();
    try {
      await Promise.all([
        run.goals ? run.goals.stop() : run.session.abort(),
        run.delegation?.dispose(),
      ]);
      run.askController.dispose();
      run.abortState = 'aborted';
      run.state.abortRequested = true;
      this.#revision += 1;
      run.markAborted?.();
      await automationCleanup;
      return true;
    } catch {
      await automationCleanup;
      run.abortState = 'idle';
      run.state.abortPending = false;
      this.#revision += 1;
      return false;
    }
  }

  resolveGjcToolApproval(requestId: string, decision: unknown): boolean {
    this.#assertHealthy();
    // Resolution may synchronously enqueue an owned SDK continuation.
    this.#revision += 1;
    for (const run of this.#runs.values()) {
      if (run.askController.resolve(requestId, decision)) return true;
    }
    return false;
  }

  async inspectGjcGoal(scope: GjcGoalScope, providerSessionId: string, sessionRoot: string): Promise<GjcGoalSnapshot> {
    this.#assertAdmission();
    return this.#withOperation(() => this.#inspectGjcGoal(scope, providerSessionId, sessionRoot));
  }

  async #inspectGjcGoal(scope: GjcGoalScope, providerSessionId: string, sessionRoot: string): Promise<GjcGoalSnapshot> {
    const manager = await resumeManager(providerSessionId, sessionRoot);
    try {
      const { state, scope: owner } = readPersistedGjcGoal(manager);
      const actualCwd = await realpath(manager.getCwd());
      if (actualCwd !== (owner?.cwd ?? scope.cwd)) throw new Error('Goal working directory does not match the persisted session.');
      return {
        supported: true, goal: state?.goal ?? null, runId: null,
        canControl: owner ? matchesGjcGoalOwner(owner, scope) : !state,
        resumeRequired: state?.goal.status === 'active',
      };
    } finally { await manager.close(); }
  }

  async controlGjcGoal(runId: string, scope: GjcGoalScope, command?: GjcGoalCommand, stopAfterMutation = true): Promise<GjcGoalSnapshot> {
    this.#assertHealthy();
    return this.#withOperation(() => this.#controlGjcGoal(runId, scope, command, stopAfterMutation));
  }

  async #controlGjcGoal(runId: string, scope: GjcGoalScope, command?: GjcGoalCommand, stopAfterMutation: boolean = true): Promise<GjcGoalSnapshot> {
    const run = this.#runs.get(runId);
    if (!run || run.abortState !== 'idle' || !matchesGjcGoalOwner(run.goalScope, scope)) throw new Error('No controllable goal exists for this run.');
    if (!run.goals) {
      if (command) throw new Error('Start a goal after this run finishes.');
      return { supported: true, goal: null, runId, canControl: false, resumeRequired: false };
    }
    if (!command) return run.goals.snapshot();
    const snapshot = await run.goals.control(command);
    if (command.operation === 'pause' || command.operation === 'drop') {
      if (!stopAfterMutation) {
        // The native worktree runtime owns this run's cancellation/finalization.
        // Freeze further model changes while its caller stops that authority.
        run.goals.fenceMutations();
        return { ...snapshot, canControl: false };
      }
      if (!await this.abortGjcSession(runId)) throw new Error('The goal changed, but stopping the run could not be confirmed.');
      return { ...snapshot, runId: null, resumeRequired: command.operation === 'pause' };
    }
    return snapshot;
  }

  async #run(runId: string, message: string, options: Record<string, unknown>, config: SdkRunConfig, writer: GjcWorkerWriter): Promise<void> {
    let active: ActiveRun | undefined;
    let runError: unknown;
    let didRunFail = false;
    let disposalError: Error | undefined;
    try {
      await this.#runInner(runId, options, config, writer, message, (value) => { active = value; });
    } catch (error) {
      if (isGjcCleanupUnconfirmedError(error)) throw this.#poison();
      // Diagnostics stay opt-in and never reach Protocol frames.
      if (process.env.GJC_BUN_ADAPTER_DEBUG === '1') {
        console.error('[gjc-bun-adapter]', error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error));
      }
      runError = error;
      didRunFail = true;
    }
    if (active) {
      const run = active;
      run.settling = true;
      this.#revision += 1;
      for (const cleanup of [
        () => run.goals?.dispose(),
        () => run.unsubscribe(),
        () => run.askController.dispose(),
        () => run.delegation?.dispose(),
        () => disposeSdkSession(run.session),
      ]) {
        try { await cleanup(); }
        catch { disposalError ??= new Error(FAILURE); }
      }
      if (disposalError) {
        console.error('GJC SDK session disposal failed.');
        throw this.#poison();
      }
      // Only a completed physical teardown plus its live ownership receipt may
      // retire this session. Source hashes and logical terminal events are not idle proof.
      if (this.#sdkSessionOwners.has(run.session)) {
        const activity = readSdkLifecycleOwner(run.session, 'sdk_background_ownership_unproven');
        if (activity.starting + activity.queued + activity.running + activity.settling === 0) {
          for (const reason of activity.unknown) this.#sdkCoverageFailures.add(reason);
          if (!activity.complete && !activity.unknown.length) this.#sdkBackgroundOwnershipUnproven = true;
          this.#sdkSessionOwners.delete(run.session);
        }
      }
      this.#assertHealthy();
      this.#runs.delete(runId);
      this.#revision += 1;
      forwardPromptTerminal(writer, run.state, didRunFail ? runError ?? new Error(FAILURE) : undefined);
    }
    this.#assertHealthy();
    if (didRunFail) throw runError;
  }

  async #runInner(runId: string, options: Record<string, unknown>, config: SdkRunConfig, writer: GjcWorkerWriter, message: string, setActive: (run: ActiveRun) => void): Promise<void> {
    {
      const resumedId = typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : undefined;
      const sessionManager = resumedId
        ? await resumeManager(resumedId, config.sessionRoot)
        : SessionManager.create(config.cwd, config.sessionRoot);
      const globalSettings = this.options.settings
        ?? await this.options.loadSettings?.()
        ?? await Settings.init(
          process.env.GJC_WORKER_AGENT_DIR ? { agentDir: process.env.GJC_WORKER_AGENT_DIR } : {},
        );
      this.#baseSettings = globalSettings;
      const configuredModelId = config.modelId === 'default'
        ? await configuredDefaultModelIdWithRefresh(
          globalSettings,
          this.authStorage,
          this.modelRegistry,
          config.credential,
          config.modelProfile,
        )
        : config.modelId;
      // Settings.init is process-global, but each run receives a cwd-specific
      // clone before session creation. A Bun worker can serve multiple project
      // sessions, and the clone keeps their project settings and overrides isolated.
      const settings = await globalSettings.cloneForCwd(config.cwd);
      applyGjcToolSettingsPolicy(settings);
      const goalScope = config.appSessionId && config.goalOwner
        ? { appSessionId: config.appSessionId, owner: config.goalOwner, cwd: await realpath(config.cwd),
            projectPath: await realpath(typeof options.projectPath === 'string' ? options.projectPath : config.cwd) }
        : undefined;
      // Requested delegation names are replaced below by the checked app
      // executor. Its children explicitly disable goal lifecycle operations.
      const goalEnabled = config.goalUiVersion === 1 && Boolean(goalScope);
      if (config.goalCommand && !goalEnabled) throw new Error('Goal controls are unavailable in this view.');
      settings.override('goal.enabled', goalEnabled);
      const askController = new GjcBunAskController(writer);
      const model = await modelForWithRefresh(this.modelRegistry, configuredModelId);
      const resolvedCredential = await credentialFor(this.authStorage, config.credential, model);
      let delegation: GjcDelegationExecutor | undefined;
      try {
        const permissionProvider = config.permissions
          ? createGjcPermissionProvider(config.permissions, askController, writer)
          : undefined;
        const sessionOptions: Parameters<typeof createAgentSession>[0] = {
          // The app hosts the runtime in-process; the model must not reach for
          // the gjc CLI (absent on most app installs) or hand-edit ~/.gjc when
          // asked to configure sign-in, models or permissions — those live in
          // the app's UI, and "the agent stopped instead of editing .gjc" is
          // the alternative.
          systemPrompt: (defaults: string[]) => [...defaults, GAJAE_APP_ENV_NOTE],
          cwd: config.cwd,
          sessionManager,
          // The SDK defaults provider/cache identity to this manager's logical
          // ID, including on exact-ID resume. Supplying the same ID explicitly
          // instead makes SDK 0.15.6 expose a transcript-path endpoint tuple as
          // tool getSessionId()/GJC_SESSION_ID, which workflow skills reject.
          // Keep the SDK's default logical endpoint and transition rekeying.
          settings,
          authStorage: this.authStorage,
          modelRegistry: this.modelRegistry,
          model,
          ...(
            config.effort && config.effort !== 'default' && config.effort !== 'inherit'
              ? { thinkingLevel: config.effort }
              : {}
          ),
          ...(resolvedCredential.credentialSelector
            ? { credentialSelector: resolvedCredential.credentialSelector }
            : {}),
          toolNames: [...new Set([...config.toolNames, 'ask', ...(goalEnabled ? ['goal'] : [])])],
          spawns: config.spawns,
          goalToolAllowedOps: goalEnabled ? GJC_GOAL_MODEL_OPERATIONS : [],
          bashAllowedPrefixes: config.bashPolicy.allowedPrefixes,
          ...(config.bashPolicy.restrictionProfile ? { bashRestrictionProfile: config.bashPolicy.restrictionProfile } : {}),
          hasUI: true,
          ...(config.appSessionId ? {
            automationTools: serializeGjcDelegationAutomationTools(createGjcAutomationTools(
              config.appSessionId,
              askController.uiContext,
              this.options.automationBridge,
              config.permissions?.mode,
            )),
          } : {}),
        };
        if (config.toolNames.some((name) => GJC_APP_DELEGATION_TOOL_NAMES.includes(name as 'task' | 'subagent'))) {
          delegation = new GjcDelegationExecutor({
            parent: sessionManager, session: () => result.session, sessionOptions,
            permissionProvider, createSession: this.options.createSessionFactory,
          });
          delegation.setToolUIContext(askController.uiContext);
        }
        this.#assertHealthy();
        const result = await Promise.resolve().then(() => (this.options.createSessionFactory ?? createAgentSession)({
          ...sessionOptions,
          // CustomTool is the public SDK replacement API. Never construct the
          // built-in executor: it does not inherit the app permission boundary.
          toolNames: sessionOptions.toolNames!.filter((name) => !GJC_APP_DELEGATION_TOOL_NAMES.includes(name as 'task' | 'subagent')),
          ...(delegation ? { customTools: delegation.tools() } : {}),
          // The app executor above receives the configured role policy. Only
          // native SDK spawning is denied for goal/delegation-capable sessions.
          spawns: delegation || goalEnabled ? 'deny' : sessionOptions.spawns,
        })).catch((error: unknown) => {
          // No returned owner: even a patched factory's rejection is not a
          // receipt for every fallible discovery/extension implementation.
          this.#sdkBackgroundOwnershipUnproven = true;
          this.#revision += 1;
          throw error;
        });
        const ownership = readSdkLifecycleOwner(result.session, 'sdk_background_ownership_unproven');
        if (ownership.unknown.includes('sdk_background_ownership_unproven')) this.#sdkBackgroundOwnershipUnproven = true;
        else this.#sdkSessionOwners.add(result.session);
        this.#revision += 1;
        this.#assertHealthy();
        if (config.modelProfile) {
          await activateModelProfile({
            session: result.session,
            modelRegistry: this.modelRegistry,
            settings,
            profileName: config.modelProfile,
          });
        } else if (config.modelId !== 'default') {
          // createAgentSession receives the requested model, but a resumed
          // session can still restore its previously configured default role
          // chain when the turn starts. Mirror the upstream CLI's explicit
          // --model startup override so the app's session pin owns both the
          // live model and the default fallback controller for this run.
          const thinkingLevel = config.effort && config.effort !== 'default' && config.effort !== 'inherit'
            ? config.effort
            : undefined;
          await result.session.setModelTemporary(model, thinkingLevel, {
            persistAsSessionDefault: true,
            cause: 'startup-override',
          });
          result.session.setConfiguredModelChain(
            'default',
            [`${model.provider}/${model.id}`],
            'startup-override',
            undefined,
            true,
          );
          result.session.seedDefaultFallbackResolution(0, []);
        }
        if (resolvedCredential.credential) writer.setCredential?.(resolvedCredential.credential);
        writer.setModel?.(model.id);
        if (result.modelFallbackMessage) throw new Error(FAILURE);
        result.setToolUIContext(askController.uiContext, true);
        if (config.permissions) {
          // The runtime's SDK permission mode defaults to `allow`, which runs
          // bash and destructive edits without a word. Switching to `prompt`
          // routes every gated call through the project's policy instead. A
          // runtime without the gate cannot honour the policy, so fail closed
          // rather than run a session the user believes is asking.
          const session: ActiveRun['session'] = result.session;
          if (typeof session.setSdkPermissionMode !== 'function' || typeof session.setSdkPermissionProvider !== 'function') {
            throw new Error(FAILURE);
          }
          session.setSdkPermissionMode('prompt');
          session.setSdkPermissionProvider(permissionProvider);
        }
        const state: SdkRunState = { abortRequested: false, abortPending: false, terminalEmitted: false, finalError: false };
        // The adapter is the only place holding the live session, so the
        // footer snapshot is read here and handed to the event mapper.
        let goals: GjcGoalSession | undefined;
        const unsubscribe = result.session.subscribe((event: unknown) => {
          this.#revision += 1;
          goals?.onEvent(event);
          forwardSdkEvent(
            event,
            writer,
            state,
            () => ({ ...readSessionSnapshot(result.session, sessionManager), ...(goals ? { goal: goals.snapshot() } : {}) }),
          );
        });
        const activeRun: ActiveRun = {
          markAborted: writer.setAborted,
          ...(goalScope ? { goalScope } : {}),
          session: result.session,
          sessionManager,
          unsubscribe,
          askController,
          state,
          abortState: 'idle',
          settling: false,
          ...(delegation ? { delegation } : {}),
          ...(config.appSessionId ? { appSessionId: config.appSessionId } : {}),
        };
        setActive(activeRun);
        this.#runs.set(runId, activeRun);
        this.#revision += 1;
        if (goalEnabled && goalScope) {
          goals = new GjcGoalSession(result.session, sessionManager, goalScope, runId,
            (goal) => writer.send({ kind: 'status', text: 'session_state', sessionState: { goal } }),
            () => this.abortGjcSession(runId));
          activeRun.goals = goals;
          activeRun.goalScope = goalScope;
          await goals.restore();
          await installGjcGoalTool(result.session, goals);
        }
        if (this.#starting.get(runId)?.abortRequested) {
          // Aborted before it had a session. No prompt, no terminal frame
          // (the app already completed the run as aborted when the abort was
          // accepted), and no session id: an empty transcript that the next
          // turn would try to resume does not exist on disk.
          activeRun.abortState = 'aborted';
          state.abortPending = true;
          state.abortRequested = true;
          this.#revision += 1;
          return;
        }
        if (!resumedId) writer.setSessionId?.(sessionManager.getSessionId());
        const initialSnapshot = readSessionSnapshot(result.session, sessionManager);
        if (goals) writer.send({ kind: 'status', text: 'session_state', sessionState: { ...initialSnapshot, goal: goals.snapshot() } });
        let promptMessage: string | null = message;
        if (config.goalCommand) {
          const goal = await goals!.control(config.goalCommand);
          promptMessage = config.goalCommand.operation === 'create' || config.goalCommand.operation === 'resume'
            ? `Work on this goal: ${goal.goal!.objective}`
            : null;
        }
        const commandMatch = /^\/([^\s]+)(?:\s+(.*))?$/.exec(message.trim());
        const commandName = commandMatch?.[1];
        if (commandName && GJC_APP_BUILTIN_COMMAND_NAMES.has(commandName)) {
          const requestedExportPath = commandName === 'export' ? commandMatch?.[2]?.trim() : '';
          const output = (text: string) => {
            const content = normalizeBuiltinCommandStdout(text);
            // The upstream exporter can corrupt a nested relative path in its
            // own error text. The original command is the only authoritative
            // source, so report that rather than trying to reconstruct it.
            const corruptedExportPath = commandName === 'export'
              && requestedExportPath
              && content.includes('\uFFFD');
            const safeContent = corruptedExportPath
              ? `Failed to export "${requestedExportPath}"${content.includes('ENOENT') ? ': ENOENT' : ''}: the upstream export command returned a corrupted path.`
              : content;
            writer.send({
              kind: 'text',
              role: 'assistant',
              content: safeContent,
              isLocalCommandStdout: true,
            });
          };
          // `/export` writes through a relative path resolved against the
          // worker's process cwd, and one worker serves every session. Rebind
          // the destination to this run's own project directory before the
          // handler sees it, and refuse rather than write outside it.
          const exportPath = commandName === 'export'
            ? resolveContainedExportCommand(message, config.cwd, sessionManager.getSessionFile())
            : ({ kind: 'passthrough' } as const);
          if (exportPath.kind === 'rejected') {
            output(exportPath.reason);
            promptMessage = null;
          } else {
            const commandResult = await (this.options.executeBuiltinCommand ?? executeAcpBuiltinSlashCommand)(
              exportPath.kind === 'contained' ? exportPath.message : message,
              {
                session: result.session,
                sessionManager,
                settings,
                cwd: config.cwd,
                output,
                refreshCommands: () => {},
                reloadPlugins: async () => {},
              },
            );
            if (commandResult && 'consumed' in commandResult) {
              promptMessage = null;
            } else if (commandResult && 'prompt' in commandResult) {
              promptMessage = commandResult.prompt;
            }
          }
        }
        // The runtime's TUI titles a session from its first message with a
        // smol-model completion and records it in the transcript header. The
        // SDK session never does that on its own, so the app mirrors the TUI
        // here: the first turn of a new session, unless the user already named
        // it or opted out. The title reaches the app as a `session_title`
        // message that the server stores and never shows as chat.
        const titleTask = !resumedId && promptMessage !== null && !sessionManager.getSessionName() && !sessionTitlesDisabled()
          ? this.#withTitleTask(async () => {
              const title = await (this.options.generateSessionTitle ?? runtimeSessionTitle)(message, this.modelRegistry, settings, model);
              if (!title || !(await sessionManager.setSessionName(title, 'auto'))) return;
              writer.send({ kind: 'session_title', title: sessionManager.getSessionName(), source: 'auto', sessionId: sessionManager.getSessionId() });
            })
          : null;
        let promptError: unknown;
        try {
          if (promptMessage !== null) {
            this.#assertHealthy();
            // Attachments ride as an <images_input> block: the title above used
            // the bare user text, the model reads the files its own way.
            await result.session.prompt(appendImagesInputTag(promptMessage, config.images));
          }
        } catch (error) {
          promptError = error;
        }
        if (titleTask) {
          let grace: ReturnType<typeof setTimeout> | undefined;
          const requestedGrace = this.options.sessionTitleGraceMs;
          const graceMs = requestedGrace !== undefined && Number.isSafeInteger(requestedGrace) && requestedGrace >= 0
            ? Math.min(requestedGrace, SESSION_TITLE_GRACE_MS) : SESSION_TITLE_GRACE_MS;
          await Promise.race([titleTask, new Promise<void>((resolve) => { grace = setTimeout(resolve, graceMs); })]);
          clearTimeout(grace);
        }
        await delegation?.dispose();
        if (promptError !== undefined) throw promptError;
      } finally {
        try { await delegation?.dispose(); }
        finally { resolvedCredential.dispose(); }
      }
    }
  }
}

/**
 * The SDK's in-process tools render through a process-global theme instance that
 * only the GJC CLI entrypoints initialize. The app drives the SDK programmatically,
 * so without this the first option-bearing `ask` dereferences an undefined `theme`
 * ("undefined is not an object (evaluating 'theme.status')") and kills the worker.
 * The watcher stays off: this process owns stdout for Protocol v1 and must not grow
 * SIGWINCH or theme-file listeners.
 */
export async function ensureSdkThemeInitialized(): Promise<void> {
  if (theme) return;
  await initTheme(false);
}

export async function createGjcBunSdkAdapter(agentDir: string = process.env.GJC_WORKER_AGENT_DIR ?? '', sdkPatch?: VerifiedSdkPatch): Promise<GjcBunSdkAdapter> {
  if (!agentDir) throw new Error(FAILURE);
  if (!installGjcCliShim() && !warnedAboutGjcCliShim) {
    warnedAboutGjcCliShim = true;
    console.warn('Could not install the bundled gjc CLI shim; bundled workflow skills may be unavailable.');
  }
  // Capture the app-owned bridge capability in trusted adapter memory, then
  // remove it before the SDK creates bash tools whose child processes inherit
  // the worker environment. The model can use the injected tools but cannot
  // print or reuse the bridge token through shell commands.
  const automationBridge = takeGjcAutomationBridgeTransport();
  const [authStorage, , settings] = await Promise.all([
    discoverAuthStorage(agentDir),
    ensureSdkThemeInitialized(),
    Settings.init({ agentDir }),
  ]);
  const modelRegistry = new ModelRegistry(authStorage, undefined, settings, { agentDir });
  await modelRegistry.refresh();
  return new GjcBunSdkAdapter(authStorage, modelRegistry, {
    sdkPatch,
    settings,
    ...(automationBridge ? { automationBridge } : {}),
  });
}
