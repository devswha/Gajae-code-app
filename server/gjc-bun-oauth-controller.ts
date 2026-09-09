import { randomUUID } from 'node:crypto';

import { getOAuthProviders } from '@gajae-code/ai/utils/oauth';
import { ModelRegistry } from '@gajae-code/coding-agent/config/model-registry';
import { AuthStorage } from '@gajae-code/coding-agent/session/auth-storage';

const GJC_OAUTH_SUBMIT_MAX_LENGTH = 16 * 1024;
const GJC_OAUTH_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
const GJC_OAUTH_AUTHORIZATION_URL_MAX_LENGTH = 4_096;
type OAuthAuthInfo = { url: string; instructions?: string };
type OAuthPrompt = { message: string; placeholder?: string; allowEmpty?: boolean };

export type GjcOAuthAttemptPhase =
  | 'starting'
  | 'awaiting_browser'
  | 'awaiting_input'
  | 'persisting'
  | 'refreshing'
  | 'completed'
  | 'cancelled'
  | 'timed_out'
  | 'failed';

export type GjcOAuthInputValueKind = 'manual_code' | 'password' | 'prompt';

export type GjcOAuthProviderDescriptor = {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
};

export type GjcOAuthAttempt = {
  attemptId: string;
  providerId: string;
  phase: GjcOAuthAttemptPhase;
  authorizationUrl?: string;
  instruction?: string;
  errorCode?: string;
  expiresAt?: number;
  valueKind?: GjcOAuthInputValueKind;
  password?: true;
};

export type GjcOAuthEvent =
  | { method: 'oauth.phase'; payload: GjcOAuthAttempt }
  | { method: 'oauth.providers.updated'; payload: { providers: GjcOAuthProviderDescriptor[] } }
  | { method: 'provider.auth.updated'; payload: GjcOAuthProviderDescriptor };

export type GjcBunOAuthControllerOptions = {
  timeoutMs?: number;
};

/** Actual task ownership, not the last phase shown by the login dialog. */
export type GjcOAuthActivitySnapshot = Readonly<{
  generation: string;
  revision: number;
  starting: number;
  running: number;
  settling: number;
  approvals: number;
}>;

type PendingInput = {
  resolve(value: string): void;
  reject(reason: Error): void;
};

type AttemptState = GjcOAuthAttempt & {
  abortController: AbortController;
  input?: PendingInput;
  timeout: ReturnType<typeof setTimeout>;
  taskStarted: boolean;
};

const terminalPhases = new Set<GjcOAuthAttemptPhase>(['completed', 'cancelled', 'timed_out', 'failed']);
const passwordPrompt = /\b(?:password|passphrase|secret|token|(?:api|access)[\s_-]?(?:key|token))\b/i;

class GjcOAuthControllerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super('OAuth request failed.');
    this.name = 'GjcOAuthControllerError';
    this.code = code;
  }
}

function error(code: string): never {
  throw new GjcOAuthControllerError(code);
}

function safeText(value: unknown, maxLength = 8 * 1024): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function isPasswordPrompt(prompt: { message: string; placeholder?: string }): boolean {
  return passwordPrompt.test(prompt.message) || (prompt.placeholder !== undefined && passwordPrompt.test(prompt.placeholder));
}

/** Owns one canonical AuthStorage login attempt and emits only safe UI state. */
export class GjcBunOAuthController {
  readonly #listeners = new Set<(event: GjcOAuthEvent) => void>();
  readonly #timeoutMs: number;
  readonly #generation = randomUUID();
  #revision = 0;
  // A cancelled attempt may still be persisting credentials or refreshing
  // models while a new attempt owns the dialog. Never transfer these tasks
  // to #lastAttempt or release them on abort/timeout/close notification.
  readonly #tasks = new Set<AttemptState>();
  #active: AttemptState | undefined;
  #lastAttempt: AttemptState | undefined;

  constructor(
    private readonly authStorage: AuthStorage,
    private readonly modelRegistry: ModelRegistry,
    options: GjcBunOAuthControllerOptions = {},
  ) {
    const timeoutMs = options.timeoutMs ?? GJC_OAUTH_ATTEMPT_TIMEOUT_MS;
    this.#timeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, GJC_OAUTH_ATTEMPT_TIMEOUT_MS)
      : GJC_OAUTH_ATTEMPT_TIMEOUT_MS;
  }

  providers(): { providers: GjcOAuthProviderDescriptor[] } {
    return { providers: this.#providerDescriptors() };
  }

  getGeneration(): string {
    return `${this.#generation}:${this.#revision}`;
  }

  /** Pure in-memory read: no auth snapshot, tokens, URLs, inputs or task IDs. */
  snapshotActivity(): GjcOAuthActivitySnapshot {
    let starting = 0;
    let running = 0;
    let settling = 0;
    let approvals = 0;
    for (const attempt of this.#tasks) {
      if (!this.#isActive(attempt)) settling += 1;
      else if (!attempt.taskStarted) starting += 1;
      else running += 1;
      if (attempt.input) approvals += 1;
    }
    return { generation: this.getGeneration(), revision: this.#revision, starting, running, settling, approvals };
  }

  status(): { providers: GjcOAuthProviderDescriptor[]; attempt?: GjcOAuthAttempt } {
    return {
      providers: this.#providerDescriptors(),
      ...(this.#lastAttempt ? { attempt: this.#snapshot(this.#lastAttempt) } : {}),
    };
  }

  start(providerId: string): GjcOAuthAttempt {
    const provider = this.#providerDescriptors().find((candidate) => candidate.id === providerId);
    if (!provider) error('oauth_provider_not_found');
    if (!provider.available) error('oauth_provider_unavailable');
    if (this.#active) error('oauth_attempt_active');

    const attemptId = `oauth-${randomUUID()}`;
    const attempt: AttemptState = {
      attemptId,
      providerId,
      phase: 'starting',
      expiresAt: Date.now() + this.#timeoutMs,
      abortController: new AbortController(),
      timeout: undefined as unknown as ReturnType<typeof setTimeout>,
      taskStarted: false,
    };
    attempt.timeout = setTimeout(() => this.#timeout(attempt), this.#timeoutMs);
    this.#active = attempt;
    this.#lastAttempt = attempt;
    this.#tasks.add(attempt);
    this.#revision += 1;
    this.#emitPhase(attempt);
    void Promise.resolve().then(() => this.#run(attempt));
    return this.#snapshot(attempt);
  }

  submit(attemptId: string, value: string): GjcOAuthAttempt {
    if (value.length > GJC_OAUTH_SUBMIT_MAX_LENGTH) error('oauth_submit_too_large');
    const attempt = this.#matchingAttempt(attemptId);
    if (!this.#isActive(attempt)) error('oauth_attempt_not_active');
    const input = attempt.input;
    if (!input) error('oauth_input_not_requested');

    attempt.input = undefined;
    this.#revision += 1;
    try {
      input.resolve(value);
    } finally {
      value = '';
    }
    return this.#snapshot(attempt);
  }

  cancel(attemptId: string): GjcOAuthAttempt {
    const attempt = this.#matchingAttempt(attemptId);
    if (!this.#isActive(attempt)) error('oauth_attempt_not_active');
    this.#terminate(attempt, 'cancelled');
    return this.#snapshot(attempt);
  }

  subscribe(listener: (event: GjcOAuthEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#active) this.#terminate(this.#active, 'cancelled');
    this.#listeners.clear();
  }

  #providerDescriptors(): GjcOAuthProviderDescriptor[] {
    const authenticatedProviderIds = new Set(
      this.authStorage.exportSnapshot().credentials.map((credential: { provider: string }) => credential.provider),
    );
    return getOAuthProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      available: provider.available,
      authenticated: authenticatedProviderIds.has(provider.id),
    }));
  }

  #matchingAttempt(attemptId: string): AttemptState {
    const attempt = this.#lastAttempt;
    if (!attempt || attempt.attemptId !== attemptId) error('oauth_attempt_not_found');
    return attempt;
  }

  #isActive(attempt: AttemptState): boolean {
    return this.#active === attempt && !terminalPhases.has(attempt.phase);
  }

  #snapshot(attempt: AttemptState): GjcOAuthAttempt {
    const { attemptId, providerId, phase, authorizationUrl, instruction, errorCode, expiresAt, valueKind, password } = attempt;
    return {
      attemptId,
      providerId,
      phase,
      ...(authorizationUrl ? { authorizationUrl } : {}),
      ...(instruction ? { instruction } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(valueKind ? { valueKind } : {}),
      ...(password ? { password } : {}),
    };
  }

  #emit(event: GjcOAuthEvent): void {
    for (const listener of this.#listeners) {
      try { listener(event); }
      catch { /* A UI observer cannot abandon the underlying login owner. */ }
    }
  }

  #emitPhase(attempt: AttemptState): void {
    this.#emit({ method: 'oauth.phase', payload: this.#snapshot(attempt) });
  }

  #transition(attempt: AttemptState, phase: GjcOAuthAttemptPhase, fields: Partial<Pick<GjcOAuthAttempt, 'authorizationUrl' | 'instruction' | 'errorCode' | 'valueKind' | 'password'>> = {}): void {
    if (!this.#isActive(attempt) && !terminalPhases.has(phase)) return;
    attempt.phase = phase;
    delete attempt.valueKind;
    delete attempt.password;
    Object.assign(attempt, fields);
    this.#revision += 1;
    this.#emitPhase(attempt);
  }

  #requestInput(attempt: AttemptState, valueKind: GjcOAuthInputValueKind, password?: true): Promise<string> {
    if (!this.#isActive(attempt)) return Promise.reject(new GjcOAuthControllerError('oauth_attempt_not_active'));
    return new Promise((resolve, reject) => {
      attempt.input = { resolve, reject };
      // Register before notifying: a synchronous subscriber may submit/cancel.
      this.#transition(attempt, 'awaiting_input', { valueKind, ...(password ? { password } : {}) });
    });
  }

  #terminate(attempt: AttemptState, phase: Extract<GjcOAuthAttemptPhase, 'cancelled' | 'timed_out'>): void {
    if (!this.#isActive(attempt)) return;
    this.#active = undefined;
    this.#revision += 1;
    clearTimeout(attempt.timeout);
    attempt.abortController.abort();
    const input = attempt.input;
    attempt.input = undefined;
    if (input) this.#revision += 1;
    input?.reject(new GjcOAuthControllerError(phase === 'timed_out' ? 'oauth_timed_out' : 'oauth_cancelled'));
    this.#transition(attempt, phase, { errorCode: phase === 'timed_out' ? 'oauth_timed_out' : 'oauth_cancelled' });
  }

  #timeout(attempt: AttemptState): void {
    this.#terminate(attempt, 'timed_out');
  }

  async #run(attempt: AttemptState): Promise<void> {
    try {
      // A same-stack cancellation must not start a new login in a microtask.
      if (!this.#isActive(attempt)) return;
      attempt.taskStarted = true;
      this.#revision += 1;
      await this.#runAttempt(attempt);
    } catch {
      if (this.#isActive(attempt)) {
        this.#active = undefined;
        this.#revision += 1;
        clearTimeout(attempt.timeout);
        this.#transition(attempt, 'failed', { errorCode: 'oauth_login_failed' });
      }
    } finally {
      // Only the underlying login/refresh chain reaching settlement releases
      // this task. Neither #terminate nor close is a completion proof.
      this.#tasks.delete(attempt);
      this.#revision += 1;
    }
  }

  async #runAttempt(attempt: AttemptState): Promise<void> {
    try {
      await this.authStorage.login(attempt.providerId, {
        onAuth: (info: OAuthAuthInfo) => {
          if (!this.#isActive(attempt)) return;
          const authorizationUrl = safeText(info.url, GJC_OAUTH_AUTHORIZATION_URL_MAX_LENGTH);
          const instruction = safeText(info.instructions);
          this.#transition(attempt, 'awaiting_browser', {
            ...(authorizationUrl ? { authorizationUrl } : {}),
            ...(instruction ? { instruction } : {}),
          });
        },
        onPrompt: async (prompt: OAuthPrompt) => {
          const password = isPasswordPrompt(prompt);
          return this.#requestInput(attempt, password ? 'password' : 'prompt', password ? true : undefined);
        },
        onManualCodeInput: async () => this.#requestInput(attempt, 'manual_code'),
        onProgress: () => {
          if (this.#isActive(attempt) && attempt.phase !== 'awaiting_input') this.#transition(attempt, 'persisting');
        },
        signal: attempt.abortController.signal,
      });
    } catch (error) {
      if (!this.#isActive(attempt)) return;
      clearTimeout(attempt.timeout);
      this.#active = undefined;
      this.#revision += 1;
      // The runtime's callback listener rejects a callback whose `state` is
      // not this attempt's: the browser finished a link from an earlier
      // attempt (a retry issues a new one). Named so the dialog can say
      // "use the newest link" instead of a generic "try again"; the raw
      // message never crosses the protocol.
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = /state mismatch/i.test(message) ? 'oauth_state_mismatch' : 'oauth_login_failed';
      this.#transition(attempt, 'failed', { errorCode });
      return;
    }

    if (!this.#isActive(attempt)) return;
    this.#transition(attempt, 'refreshing');
    if (!this.#isActive(attempt)) return;

    let refreshFailed = false;
    try {
      await this.modelRegistry.refresh();
    } catch {
      refreshFailed = true;
    }
    if (!this.#isActive(attempt)) return;

    const providers = this.#providerDescriptors();
    const provider = providers.find((candidate) => candidate.id === attempt.providerId);
    if (provider) this.#emit({ method: 'provider.auth.updated', payload: provider });
    if (!this.#isActive(attempt)) return;
    this.#emit({ method: 'oauth.providers.updated', payload: { providers } });
    if (!this.#isActive(attempt)) return;
    clearTimeout(attempt.timeout);
    this.#active = undefined;
    this.#revision += 1;
    this.#transition(
      attempt,
      refreshFailed ? 'failed' : 'completed',
      refreshFailed ? { errorCode: 'oauth_model_refresh_failed' } : {},
    );
  }
}
