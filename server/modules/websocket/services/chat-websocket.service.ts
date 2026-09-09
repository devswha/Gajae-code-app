import path from 'node:path';

import type { WebSocket } from 'ws';

import { sessionsDb, sessionWorktreesDb } from '@/modules/database/index.js';
import { grantProjectAlwaysAllow, resolveProjectRunPermissions } from '@/modules/projects/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { GjcJobProjectionService } from '@/modules/websocket/services/gjc-job-projection.service.js';
import { getGlobalImageAssetsDir, normalizeImageDescriptors } from '@/shared/image-attachments.js';
import type { DesktopWorkAdmission } from '@/shared/interfaces.js';
import type { AnyRecord, AuthenticatedWebSocketRequest, LLMProvider } from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';

import type { GjcGoalCommand } from '../../../../shared/gjc-goal.js';
import type { SessionWorktreeRuntime } from '../../../../shared/session-worktree-protocol.js';

import { handleChatGoal, type GoalSupervisor } from './chat-goal.service.js';

type ProviderSpawnFn = (command: string, options: AnyRecord, writer: unknown) => Promise<unknown>;
type ProviderSpawnResult = Promise<unknown> & { abortHandle?: string; };
type OAuthEvent = { method: 'oauth.phase' | 'oauth.providers.updated' | 'provider.auth.updated'; payload: AnyRecord; };
type OAuthSupervisor = {
  oauthProviders(): Promise<unknown>; oauthStatus(): Promise<unknown>; oauthStart(providerId: string): Promise<unknown>; oauthSubmit(attemptId: string, value: string): Promise<unknown>; oauthCancel(attemptId: string): Promise<unknown>; subscribeOAuth(listener: (event: OAuthEvent) => void): () => void;
};
type ChatWebSocketDependencies = {
  desktopRestartAdmission?: DesktopWorkAdmission;
  goalSupervisor?: GoalSupervisor;
  sessionWorktrees?: SessionWorktreeRuntime;
  spawnFns: Record<LLMProvider, ProviderSpawnFn>;
  abortFns: Record<LLMProvider, (providerSessionId: string) => boolean | Promise<boolean>>;
  steerFns?: Partial<Record<LLMProvider, (providerSessionId: string, message: string) => boolean | Promise<boolean>>>;
  resolveToolApproval: (requestId: string, payload: { allow: boolean; always?: boolean; updatedInput?: unknown; message?: string; rememberEntry?: unknown; }) => void;
  getPendingApprovalsForSession: (providerSessionId: string) => unknown[];
  resolveSessionModel?: (provider: LLMProvider, sessionId: string, requestedModel?: string | null, options?: { firstTurn?: boolean }) => Promise<string | undefined>;
  /** Test seam; production reads the project's stored policy. */
  resolveRunPermissions?: (projectPath: string | null | undefined) => Record<string, unknown>;
  /** Test seam; production persists "Always allow" against the project. */
  grantAlwaysAllow?: (projectPath: string, toolName: string) => unknown;
  gjcProjection?: GjcJobProjectionService;
  oauthSupervisor?: OAuthSupervisor;
};
type OAuthAttemptOwner = { attemptId: string; userKey: string; };

const oauthTypes = new Set(['oauth.providers', 'oauth.status', 'oauth.start', 'oauth.submit', 'oauth.cancel']);
let activeOAuthOwner: OAuthAttemptOwner | null = null;

const asRecord = (value: unknown): AnyRecord | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : null;
const oauthKey = (userId: string | number | null): string => `${typeof userId}:${String(userId)}`;
const ownershipError = (): AnyRecord => ({ ok: false, error: { code: 'oauth_attempt_not_owner', message: 'OAuth request failed.' } });

export function filterImagesToUploadStore(images: unknown, assetsRootOverride?: string): AnyRecord[] {
  const assetRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());
  return normalizeImageDescriptors(images).filter(({ path: imagePath }) => {
    const relativePath = path.relative(assetRoot, path.resolve(assetRoot, imagePath));
    const isStoredAsset = relativePath.length > 0
      && !relativePath.startsWith('..')
      && !path.isAbsolute(relativePath)
      && !relativePath.includes(path.sep)
      && !relativePath.includes('/');
    if (!isStoredAsset) console.warn(`[Chat] Dropping image outside the upload store: ${imagePath}`);
    return isStoredAsset;
  });
}

async function defaultResolveSessionModel(provider: LLMProvider, sessionId: string, requestedModel?: string | null, options?: { firstTurn?: boolean }): Promise<string | undefined> {
  const { providerModelsService } = await import('@/modules/providers/index.js');
  return providerModelsService.resolveResumeModel(provider, sessionId, requestedModel, options);
}

function requestUserId(request: AuthenticatedWebSocketRequest | undefined): string | number | null {
  const account = request?.user;
  if (!account) return null;
  if (typeof account.id === 'string' || typeof account.id === 'number') return account.id;
  return typeof account.userId === 'string' || typeof account.userId === 'number' ? account.userId : null;
}

function sendFrame(ws: WebSocket, frame: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) ws.send(JSON.stringify(frame));
}

function protocolFailure(ws: WebSocket, code: string, error: string, sessionId?: string): void {
  sendFrame(ws, { kind: 'protocol_error', code, error, sessionId: sessionId ?? null, timestamp: new Date().toISOString() });
}

function requiredSessionId(data: AnyRecord): string | null {
  const suppliedSessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return suppliedSessionId || null;
}

function providerRunId(run: NonNullable<ReturnType<typeof chatRunRegistry.getRun>>): string | null {
  if (run.provider === 'gjc') return run.writer.getAbortHandle() ?? run.providerSessionId;
  return run.providerSessionId ?? run.writer.getAbortHandle();
}

async function resolveRequestedModel(dependencies: ChatWebSocketDependencies, provider: LLMProvider, sessionId: string, requestedModel: string | null, firstTurn: boolean): Promise<string | undefined> {
  try {
    return await (dependencies.resolveSessionModel ?? defaultResolveSessionModel)(provider, sessionId, requestedModel, { firstTurn });
  } catch {
    return requestedModel ?? undefined;
  }
}

async function sendChat(ws: WebSocket, userId: string | number | null, data: AnyRecord, dependencies: ChatWebSocketDependencies, goalCommand?: GjcGoalCommand): Promise<void> {
  const content = typeof data.content === 'string' ? data.content : '';
  if (/^\/(?:login|logout)(?:\s|$)/i.test(content.trim())) {
    protocolFailure(ws, 'LOGIN_UI_REQUIRED', 'Account authentication commands must be completed in the app login dialog.', typeof data.sessionId === 'string' ? data.sessionId : undefined);
    return;
  }

  const sessionId = requiredSessionId(data);
  if (!sessionId) {
    protocolFailure(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.');
    return;
  }
  const storedSession = sessionsDb.getSessionById(sessionId);
  if (!storedSession) {
    protocolFailure(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`, sessionId);
    return;
  }

  const provider = storedSession.provider as LLMProvider;
  const spawn = dependencies.spawnFns[provider];
  if (!spawn) {
    protocolFailure(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return;
  }
  if (sessionWorktreesDb.get(sessionId) && !dependencies.sessionWorktrees) {
    protocolFailure(ws, 'SESSION_WORKTREES_UNAVAILABLE', 'Session worktree execution is unavailable.', sessionId);
    return;
  }
  const run = chatRunRegistry.startRun({ appSessionId: sessionId, provider, providerSessionId: storedSession.provider_session_id, connection: ws, userId });
  if (!run) {
    protocolFailure(ws, 'RUN_IN_PROGRESS', `Session "${sessionId}" already has a run in progress.`, sessionId);
    return;
  }

  const worktreeRun = provider === 'gjc' ? dependencies.sessionWorktrees?.prepare(sessionId) : null;
  if (worktreeRun) run.writer.setAbortHandle(worktreeRun.abortHandle);

  const requestOptions = (data.options ?? {}) as AnyRecord;
  const requestedModel = typeof requestOptions.model === 'string' ? requestOptions.model : null;
  // A session with no provider id yet is on its first turn: an explicit model
  // chosen for it becomes its pin (see resolveResumeModel).
  const model = await resolveRequestedModel(dependencies, provider, sessionId, requestedModel, !storedSession.provider_session_id);
  // The permission policy is the project's, read here and never taken from the
  // request: a browser cannot widen it by sending `skipPermissions` or a mode.
  const { permissions: _clientPermissions, skipPermissions: _legacySkip, goalOwner: _goalOwner, goalCommand: _goalCommand, goalUiVersion: _goalUiVersion, ...acceptedOptions } = requestOptions;
  const options: AnyRecord = {
    ...acceptedOptions,
    ...(dependencies.goalSupervisor && userId !== null && requestOptions.goalUiVersion === 1 ? { goalUiVersion: 1 } : {}),
    ...(userId !== null ? { goalOwner: `${typeof userId}:${userId}` } : {}),
    ...(goalCommand ? { goalCommand, goalUiVersion: 1 } : {}),
    ...(model ? { model } : {}),
    images: filterImagesToUploadStore(requestOptions.images),
    sessionId: storedSession.provider_session_id ?? undefined,
    resume: Boolean(storedSession.provider_session_id),
    cwd: storedSession.project_path ?? undefined,
    projectPath: storedSession.project_path ?? undefined,
    permissions: (dependencies.resolveRunPermissions ?? resolveProjectRunPermissions)(storedSession.project_path),
  };

  try {
    if (worktreeRun) {
      await worktreeRun.run(content, options, run.writer);
      return;
    }
    const providerRun = spawn(content, options, run.writer);
    if (provider === 'gjc') {
      const handle = (providerRun as ProviderSpawnResult).abortHandle;
      if (handle) run.writer.setAbortHandle(handle);
    }
    await providerRun;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: message });
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
    if (provider === 'gjc' && code) protocolFailure(ws, code, message, sessionId);
    // A run that already passed its terminal `complete` reported the failure
    // itself (GJC forwards `error` + `complete` before rejecting), so a second
    // bubble here is the same failure rendered twice in the transcript. The
    // console line above keeps the rejection visible server-side either way.
    else if (run.status === 'running') run.writer.send(createNormalizedMessage({ kind: 'error', provider, sessionId: storedSession.provider_session_id ?? sessionId, content: message }));
  } finally {
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: worktreeRun?.aborted ? 0 : 1, ...(worktreeRun?.aborted ? { aborted: true } : {}) });
    worktreeRun?.dispose();
  }
}

async function steerChat(ws: WebSocket, data: AnyRecord, dependencies: ChatWebSocketDependencies): Promise<void> {
  const sessionId = requiredSessionId(data);
  if (!sessionId) {
    protocolFailure(ws, 'SESSION_ID_REQUIRED', 'chat.steer requires a sessionId.');
    return;
  }
  const content = typeof data.content === 'string' ? data.content : '';
  if (!content.trim()) {
    protocolFailure(ws, 'CONTENT_REQUIRED', 'chat.steer requires content.', sessionId);
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  const destination = run ? providerRunId(run) : null;
  const steer = run ? dependencies.steerFns?.[run.provider] : undefined;
  let steered = false;
  let reason: 'steered' | 'no-run' | 'not-running' | 'unsupported' | 'refused' | 'failed' = 'no-run';
  if (!run) reason = 'no-run';
  else if (run.status !== 'running') reason = 'not-running';
  else if (!steer || !destination) reason = 'unsupported';
  else try {
    steered = Boolean(await steer(dependencies.sessionWorktrees?.workerHandle(destination) ?? destination, content));
    reason = steered ? 'steered' : 'refused';
  } catch (error) {
    console.error('[ERROR] chat.steer failed:', error instanceof Error ? error.message : String(error));
    reason = 'failed';
  }
  sendFrame(ws, { kind: 'chat_steered', sessionId, steered, reason, content });
}

async function abortChat(ws: WebSocket, data: AnyRecord, dependencies: ChatWebSocketDependencies): Promise<void> {
  const sessionId = requiredSessionId(data);
  if (!sessionId) {
    protocolFailure(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }
  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    protocolFailure(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  let succeeded = false;
  try {
    const abort = dependencies.abortFns[run.provider];
    const destination = providerRunId(run);
    if (destination) {
      const worktreeAborted = await dependencies.sessionWorktrees?.abort(destination);
      if (worktreeAborted != null) succeeded = worktreeAborted;
      else if (abort) succeeded = Boolean(await abort(destination));
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
    if (run.provider === 'gjc' && code) {
      protocolFailure(ws, code, error instanceof Error ? error.message : String(error), sessionId);
      return;
    }
    throw error;
  }

  if (!succeeded && run.provider === 'gjc') {
    protocolFailure(ws, 'ABORT_FAILED', `Session "${sessionId}" could not be aborted.`, sessionId);
    return;
  }
  chatRunRegistry.completeRunIfCurrent(run, { exitCode: succeeded ? 0 : 1, aborted: true });
}

function subscribeChat(ws: WebSocket, data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  const subscriptions = Array.isArray(data.sessions) ? data.sessions : [];
  for (const subscription of subscriptions) {
    const request = asRecord(subscription);
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : '';
    if (!request || !sessionId) continue;

    const rawSequence = request.lastSeq;
    const lastSeq = typeof rawSequence === 'number' && Number.isSafeInteger(rawSequence) && rawSequence >= 0 ? rawSequence : 0;
    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);
    if (isProcessing) chatRunRegistry.attachConnection(sessionId, ws);

    const approvalScope = run?.provider === 'gjc' ? run.appSessionId : run?.providerSessionId;
    const pendingPermissions = (approvalScope ? dependencies.getPendingApprovalsForSession(approvalScope) : []).map((approval) => {
      const record = asRecord(approval);
      return record ? { ...record, sessionId } : approval;
    });
    sendFrame(ws, { kind: 'chat_subscribed', sessionId, isProcessing, replayGeneration: run?.replayGeneration ?? null, lastSeq: run?.lastSeq ?? 0, pendingPermissions, timestamp: new Date().toISOString() });
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq, request.replayGeneration)) sendFrame(ws, event);
    }
  }
}

function permissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || !data.requestId.length) return;
  const pending = chatRunRegistry.resolvePendingApproval(data.requestId);
  const allow = data.allow === true;
  // "Always" rides with both answers: allow_always persists a project rule,
  // reject_always only tells the run to stop asking - a permanent deny list
  // is not something the browser gets to write.
  const always = data.always === true;
  if (allow && always && pending?.toolName) {
    // "Always allow" is remembered for the project before the reply reaches
    // the worker, so a second device (or the next run) never sees the card.
    const projectPath = sessionsDb.getSessionById(pending.appSessionId)?.project_path;
    if (projectPath) {
      try {
        (dependencies.grantAlwaysAllow ?? grantProjectAlwaysAllow)(projectPath, pending.toolName);
      } catch (error) {
        console.error('[Chat] Failed to persist always-allow', { projectPath, toolName: pending.toolName, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  dependencies.resolveToolApproval(data.requestId, {
    allow,
    ...(always ? { always: true } : {}),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
  // The answering tab drops its card itself; every other viewer of the run
  // learns here that the question is closed, or it would keep asking.
  if (pending) chatRunRegistry.getRun(pending.appSessionId)?.writer.send({ kind: 'permission_cancelled', requestId: data.requestId });
}

function responseAttemptId(response: unknown): string | null {
  const result = asRecord(asRecord(response)?.result);
  return typeof result?.attemptId === 'string' ? result.attemptId : null;
}

async function oauthRequest(ws: WebSocket, userId: string | number | null, type: string, data: AnyRecord, oauth: OAuthSupervisor): Promise<void> {
  const userKey = oauthKey(userId);
  const wantedAttemptId = typeof data.attemptId === 'string' ? data.attemptId : '';
  const requiresOwnership = type === 'oauth.submit' || type === 'oauth.cancel';
  if (requiresOwnership && (activeOAuthOwner?.attemptId !== wantedAttemptId || activeOAuthOwner?.userKey !== userKey)) {
    sendFrame(ws, { kind: type, payload: ownershipError() });
    return;
  }

  const requestOperations: Record<string, () => Promise<unknown>> = {
    'oauth.providers': () => oauth.oauthProviders(),
    'oauth.status': () => oauth.oauthStatus(),
    'oauth.start': () => oauth.oauthStart(typeof data.providerId === 'string' ? data.providerId : ''),
    'oauth.submit': () => oauth.oauthSubmit(wantedAttemptId, typeof data.value === 'string' ? data.value : ''),
    'oauth.cancel': () => oauth.oauthCancel(wantedAttemptId),
  };
  let response = await requestOperations[type]!();
  if (type === 'oauth.start') {
    const attemptId = responseAttemptId(response);
    if (attemptId) activeOAuthOwner = { attemptId, userKey };
  } else if (type === 'oauth.status') {
    const payload = asRecord(response);
    const result = asRecord(payload?.result);
    const attempt = asRecord(result?.attempt);
    if (attempt && (activeOAuthOwner?.attemptId !== attempt.attemptId || activeOAuthOwner?.userKey !== userKey)) {
      response = { ...payload, result: { ...result, attempt: undefined } };
    }
  }
  sendFrame(ws, { kind: type, payload: response });
}

export function handleChatConnection(ws: WebSocket, request: AuthenticatedWebSocketRequest, dependencies: ChatWebSocketDependencies): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = requestUserId(request);
  const userKey = oauthKey(userId);
  const unsubscribe = dependencies.oauthSupervisor?.subscribeOAuth((event) => {
    const eventAttemptId = typeof event.payload.attemptId === 'string' ? event.payload.attemptId : '';
    if (event.method === 'oauth.phase' && (activeOAuthOwner?.attemptId !== eventAttemptId || activeOAuthOwner?.userKey !== userKey)) return;
    sendFrame(ws, { kind: event.method, payload: event.payload });
  }) ?? (() => {});
  const chatHandlers: Record<string, (data: AnyRecord) => Promise<void> | void> = {
    'chat.goal': async (data) => {
      if (typeof data.requestId !== 'string' || !data.requestId || data.requestId.length > 120) return protocolFailure(ws, 'INVALID_GOAL_REQUEST', 'A goal request ID is required.');
      try {
        if (!dependencies.goalSupervisor) throw new Error('Goal controls are unavailable on this server.');
        const result = await handleChatGoal(userId, data, dependencies.goalSupervisor, async (sessionId, command) => {
          // Run ownership remains in the existing chat pipeline; controls do
          // not introduce a second execution loop or background task system.
          const release = dependencies.desktopRestartAdmission?.enter('ws:goal-continuation');
          void sendChat(ws, userId, {
            sessionId,
            content: command.operation === 'create' ? `Goal: ${command.objective}` : `Goal: ${command.operation}`,
            options: { model: 'default', goalUiVersion: 1 },
          }, dependencies, command).catch((error) => protocolFailure(ws, 'GOAL_RUN_FAILED', error instanceof Error ? error.message : 'Goal run failed.', sessionId)).finally(() => release?.());
          subscribeChat(ws, { sessions: [{ sessionId, lastSeq: 0 }] }, dependencies);
        }, dependencies.sessionWorktrees);
        sendFrame(ws, { kind: 'chat_goal', sessionId: data.sessionId, requestId: data.requestId, result });
      } catch (error) {
        sendFrame(ws, { kind: 'chat_goal', sessionId: data.sessionId, requestId: data.requestId, error: error instanceof Error ? error.message : 'Goal control failed.' });
      }
    },
    'chat.send': (data) => sendChat(ws, userId, data, dependencies),
    'chat.abort': (data) => abortChat(ws, data, dependencies),
    'chat.steer': (data) => steerChat(ws, data, dependencies),
    'chat.subscribe': (data) => subscribeChat(ws, data, dependencies),
    'chat.permission-response': (data) => permissionResponse(data, dependencies),
  };

  ws.on('message', async (raw) => {
    let release: (() => void) | undefined;
    try {
      const data = parseIncomingJsonObject(raw);
      if (!data) throw new Error('Invalid websocket payload');
      const type = typeof data.type === 'string' ? data.type : '';
      const admission = dependencies.desktopRestartAdmission;
      // In-memory replay/status does not spawn work. Every other dispatch is
      // acquired before projection/model/goal/OAuth's first asynchronous step.
      if (admission && type !== 'chat.subscribe') {
        const ownsRun = typeof data.sessionId === 'string' && chatRunRegistry.isProcessing(data.sessionId);
        const ownsApproval = typeof data.requestId === 'string' && chatRunRegistry.getPendingApproval(data.requestId) !== null;
        // OAuth's UI owner can outlive the actual attempt/worker. Its current
        // submit/cancel API may lazily spawn a worker, so it is not yet a
        // proven owned-completion path and must use normal admission.
        const completion = (type === 'chat.abort' && ownsRun)
          || (type === 'chat.permission-response' && ownsApproval);
        release = completion ? admission.enterCompletion('ws:owned-completion') : admission.enter('ws:dispatch');
      }
      if (await dependencies.gjcProjection?.handle(ws, data)) return;

      if (type.startsWith('oauth.')) {
        if (!oauthTypes.has(type)) protocolFailure(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${type}".`);
        else if (!dependencies.oauthSupervisor) protocolFailure(ws, 'OAUTH_UNAVAILABLE', 'App sign-in is unavailable.');
        else await oauthRequest(ws, userId, type, data, dependencies.oauthSupervisor);
        return;
      }

      const handler = chatHandlers[type];
      if (handler) await handler(data);
      else protocolFailure(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${type}".`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error && typeof error === 'object' && 'code' in error && error.code === 'DESKTOP_RESTART_FENCED') {
        protocolFailure(ws, 'DESKTOP_RESTART_FENCED', 'Desktop restart is being prepared. Retry this request.');
        return;
      }
      console.error('[ERROR] Chat WebSocket error:', message);
      protocolFailure(ws, 'INTERNAL_ERROR', message);
    } finally {
      release?.();
    }
  });
  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    unsubscribe();
    connectedClients.delete(ws);
    chatRunRegistry.detachConnection(ws);
  });
}
