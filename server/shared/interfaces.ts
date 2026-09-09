import type * as ProviderContract from '@/shared/types.js';

/** Server-owned admission only; never accept this capability from a request. */
export interface DesktopWorkAdmission {
  /** Acquire before dispatch; release after settlement or proven owner transfer. */
  enter(source: string): () => void;
  /** Already-owned completion may invalidate preparation, never committed shutdown. */
  enterCompletion(source: string): () => void;
}

type ProviderId = ProviderContract.LLMProvider;
type ActiveModel = ProviderContract.ProviderCurrentActiveModel;
type ActiveModelChange = ProviderContract.ProviderSessionActiveModelChange;
type ModelCatalog = ProviderContract.ProviderModelsDefinition;
type ModelChangeRequest = ProviderContract.ProviderChangeActiveModelInput;
type ProviderStatus = ProviderContract.ProviderAuthStatus;
type ProviderMessage = ProviderContract.NormalizedMessage;
type ProviderSkill = ProviderContract.ProviderSkill;
type SkillListOptions = ProviderContract.ProviderSkillListOptions;
type HistoryOptions = ProviderContract.FetchHistoryOptions;
type HistoryResult = ProviderContract.FetchHistoryResult;

/**
 * Provider facets are deliberately independently swappable: transport consumers
 * depend on the stable coordination surface rather than provider implementations.
 */
export interface IProvider {
  readonly id: ProviderId;
  readonly auth: IProviderAuth;
  readonly models: IProviderModels;
  readonly sessions: IProviderSessions;
  readonly skills: IProviderSkills;
  readonly sessionSynchronizer: IProviderSessionSynchronizer;
}

/** Prompt-facing capability discovery. */
export interface IProviderSkills {
  listSkills(options?: SkillListOptions): Promise<ProviderSkill[]>;
}

/** Per-provider model catalog and session preference boundary. */
export interface IProviderModels {
  getSupportedModels(): Promise<ModelCatalog>;
  getCatalogRevision?(): Promise<number | null>;
  getCurrentActiveModel(sessionId?: string): Promise<ActiveModel>;
  changeActiveModel(input: ModelChangeRequest): Promise<ActiveModelChange>;
}

/** The shared contract reads auth state but does not prescribe a sign-in mechanism. */
export interface IProviderAuth {
  getStatus(): Promise<ProviderStatus>;
}

/** Provider-native transcript data becomes browser-safe messages at this boundary. */
export interface IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): ProviderMessage[];
  fetchHistory(sessionId: string, options?: HistoryOptions): Promise<HistoryResult>;
}

/** Full scans and individual-file scans have compatible but distinct progress contracts. */
export interface IProviderSessionSynchronizer {
  synchronize(since?: Date): Promise<number>;
  reconcile?(since?: Date, signal?: AbortSignal): Promise<{ processed: number; sessionIds: string[] }>;
  synchronizeFile(filePath: string, signal?: AbortSignal): Promise<string | null>;
  /** Derives a fresh title from the provider's transcript; null when it holds nothing to derive from. */
  deriveSessionTitle?(filePath: string, signal?: AbortSignal): Promise<string | null>;
}
