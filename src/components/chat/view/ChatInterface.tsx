import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { ArrowDownIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import PermissionContext from '../../../contexts/PermissionContext';
import { readSessionFacts, readTokenTotals, type SessionStatusSnapshot } from '../../../contexts/sessionStatusSnapshot';
import { usePublishSessionStatus } from '../../../contexts/SessionStatusContext';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { useLegacySkipPermissionsMigration, useProjectPermissions } from '../../../hooks/useProjectPermissions';
import type { ProjectSession } from '../../../types/app';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionLocation } from '../hooks/useSessionLocation';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useEscapeToAbort } from '../hooks/useEscapeToAbort';
import { useOAuthLogin } from '../hooks/useOAuthLogin';
import type { ChatInterfaceProps } from '../types/types';
import { deriveLiveActivity } from '../utils/toolActivity';
import OAuthLoginDialog from '../OAuthLoginDialog';
import { useGoalControls } from '../hooks/useGoalControls';

import GoalControls from './GoalControls';
import ChatComposer from './ChatComposer';
import ChatMessagesPane from './ChatMessagesPane';
import ChatTasksPanel from './ChatTasksPanel';
import CommandResultModal from './CommandResultModal';
import type { ReasoningEffort } from './reasoningEffort';

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

function ComposerSurface(props: ComponentProps<typeof ChatComposer>) {
  return <ChatComposer {...props} />;
}

function ProjectSelectionNotice({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center text-muted-foreground">
        <p className="text-sm">{text}</p>
      </div>
    </div>
  );
}

export function isHistoricalNonGjcReadOnlySession(selectedSession: ProjectSession | null): boolean {
  const sourceProvider = selectedSession?.provider ?? selectedSession?.__provider;
  return Boolean(sourceProvider && sourceProvider !== 'gjc');
}

function ChatInterface({
  selectedProject, selectedSession, ws, sendMessage, onFileOpen, onInputFocusChange,
  onSessionProcessing, onSessionIdle, processingSessions, onNavigateToSession,
  onSessionEstablished, onShowSettings, toolOutputDensity,
  showImagePreviews, sendByCtrlEnter, newSessionTrigger, composerInsertRef, sessionStore,
}: ChatInterfaceProps) {
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const statusCheckSentAtRef = useRef(new Map<string, number>());

  const clearStreaming = useCallback(() => {
    const timer = streamTimerRef.current;
    if (timer) cancelAnimationFrame(timer);
    streamTimerRef.current = null;
    accumulatedStreamRef.current = '';
  }, []);

  const {
    gjcModel, sessionPinnedModel, pendingPermissionRequests, setPendingPermissionRequests,
    providerModelCatalog, providerModelCacheCatalog, providerModelsRefreshing,
    providerModelsLoading, hardRefreshProviderModels, selectProviderModel,
  } = useChatProviderState({ selectedSession, selectedProject });
  const oauthLogin = useOAuthLogin();
  const projectPermissions = useProjectPermissions(selectedProject?.projectId);
  useLegacySkipPermissionsMigration(selectedProject?.projectId, projectPermissions.setMode);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('default');
  const reasoningSessionRef = useRef<string | null>(selectedSession?.id ?? null);

  useEffect(() => {
    if (oauthLogin.attempt?.phase === 'completed') void hardRefreshProviderModels();
  }, [hardRefreshProviderModels, oauthLogin.attempt?.phase]);

  const session = useChatSessionState({
    selectedProject, selectedSession, ws, sendMessage, newSessionTrigger, processingSessions,
    onSessionIdle, resetStreamingState: clearStreaming, statusCheckSentAtRef,
    sessionStore, showImagePreviews,
  });

  const { setCurrentSessionId } = session;
  const sessionLocation = useSessionLocation(selectedSession?.id ?? session.currentSessionId);
  const establishSession = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((id, context) => {
    setCurrentSessionId(id);
    onSessionEstablished?.(id, context);
    onNavigateToSession?.(id);
  }, [onNavigateToSession, onSessionEstablished, setCurrentSessionId]);

  const composer = useChatComposerState({
    executionCwd: sessionLocation.data?.cwd,
    selectedProject,
    selectedSession,
    currentSessionId: session.currentSessionId,
    gjcModel,
    reasoningEffort,
    isLoading: session.isProcessing,
    canAbortSession: session.canAbortSession,
    tokenBudget: session.tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: establishSession,
    onInputFocusChange,
    onShowSettings,
    scrollToBottom: session.scrollToBottom,
    onLogin: oauthLogin.openLogin,
    addMessage: session.addMessage,
    setIsUserScrolledUp: session.setIsUserScrolledUp,
    setPendingPermissionRequests,
  });


  // "New work item" while a fresh conversation is already on screen changes
  // nothing visible — same project, same composer — so the click reads as
  // dead. The state reset happens in the session-state hook; here the click
  // also lands the cursor in the box, which is the only feedback that state
  // can offer.
  const previousFocusTrigger = useRef(newSessionTrigger ?? 0);
  useEffect(() => {
    if ((newSessionTrigger ?? 0) === previousFocusTrigger.current) return;
    previousFocusTrigger.current = newSessionTrigger ?? 0;
    composer.textareaRef.current?.focus();
  }, [composer.textareaRef, newSessionTrigger]);
  useEffect(() => {
    const prior = reasoningSessionRef.current;
    const selected = selectedSession?.id ?? null;
    if (prior && prior !== selected) setReasoningEffort('default');
    reasoningSessionRef.current = selected;
  }, [selectedSession?.id]);

  useEffect(() => {
    const serverValue = session.sessionState?.thinkingLevel;
    if (typeof serverValue === 'string' && REASONING_EFFORTS.has(serverValue as ReasoningEffort)) {
      setReasoningEffort(serverValue as ReasoningEffort);
    }
  }, [session.sessionState?.thinkingLevel]);

  const reconnectChat = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await sessionStore.refreshFromServer(selectedSession.id);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{ sessionId: selectedSession.id, ...sessionStore.getReplayCursor(selectedSession.id) }],
    });
  }, [selectedProject, selectedSession, sendMessage, sessionStore]);

  useChatRealtimeHandlers({
    subscribe,
    provider: 'gjc',
    selectedSession,
    currentSessionId: session.currentSessionId,
    setTokenBudget: session.setTokenBudget,
    setSessionState: session.setSessionState,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: reconnectChat,
    onSteerResult: composer.resolveSteerResult,
    sessionStore,
  });

  useEscapeToAbort(session.canAbortSession, composer.handleAbortSession);

  useEffect(() => clearStreaming, [clearStreaming]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision: composer.handlePermissionDecision,
  }), [composer.handlePermissionDecision, pendingPermissionRequests]);

  // The Changes tab calls into the composer through this ref so its line
  // comments land as the next message's draft; a stable ref keeps the panel
  // from re-rendering the chat for it.
  useEffect(() => {
    if (!composerInsertRef) return undefined;
    if (isHistoricalNonGjcReadOnlySession(selectedSession)) {
      composerInsertRef.current = null;
      return undefined;
    }
    composerInsertRef.current = composer.insertAtEnd;
    return () => { composerInsertRef.current = null; };
  }, [composer.insertAtEnd, composerInsertRef, selectedSession]);

  const sessionStatusSnapshot = useMemo<SessionStatusSnapshot>(() => {
    const reported = readSessionFacts(session.sessionState);
    const fallbackModel = gjcModel && gjcModel !== 'default' ? gjcModel : undefined;
    return {
      ...reported,
      sessionId: session.currentSessionId ?? selectedSession?.id ?? null,
      modelId: sessionPinnedModel ?? reported.modelId ?? fallbackModel,
      thinkingLevel: reported.thinkingLevel ?? reasoningEffort,
      tokens: readTokenTotals(session.tokenBudget),
      activity: {
        running: session.isProcessing,
        statusText: typeof session.sessionActivity?.statusText === 'string' ? session.sessionActivity.statusText : null,
        queued: composer.queuedDrafts.length,
      },
    };
  }, [
    composer.queuedDrafts.length, gjcModel, reasoningEffort, selectedSession?.id,
    session.currentSessionId, session.isProcessing, session.sessionActivity?.statusText,
    session.sessionState, session.tokenBudget, sessionPinnedModel,
  ]);
  usePublishSessionStatus(sessionStatusSnapshot);

  const historicalSession = isHistoricalNonGjcReadOnlySession(selectedSession);
  const goalControls = useGoalControls(historicalSession ? null : session.currentSessionId ?? selectedSession?.id ?? null, selectedProject?.projectId ?? null);
  const showLanding = !historicalSession
    && !selectedSession
    && !session.currentSessionId
    && session.chatMessages.length === 0;
  // The run's progress has one home, the transcript: the running turn's work
  // block (or, at detailed density, a bare running row) reads this.
  const liveActivity = session.isProcessing
    ? deriveLiveActivity(session.chatMessages, {
      statusText: session.sessionActivity?.statusText,
      awaitingInput: Boolean(session.sessionActivity?.awaitingInput) || pendingPermissionRequests.length > 0,
    })
    : null;

  if (!selectedProject) {
    return <ProjectSelectionNotice text={t('projectSelection.startChatWithProvider', {
      provider: 'Gajae Code',
      defaultValue: 'Select a project to start chatting with {{provider}}',
    })} />;
  }

  const composerNode = (
    <ComposerSurface
      pendingPermissionRequests={pendingPermissionRequests}
      handlePermissionDecision={composer.handlePermissionDecision}
      isLoading={session.isProcessing}
      onAbortSession={composer.handleAbortSession}
      sessionState={session.sessionState}
      onShowTokenUsage={composer.showCostModal}
      onSubmit={composer.handleSubmit}
      onSteer={composer.handleSteer}
      isDragActive={composer.isDragActive}
      sessionPinnedModel={sessionPinnedModel}
      queuedDrafts={composer.queuedDrafts}
      onEditQueuedDraft={composer.editQueuedDraft}
      onDeleteQueuedDraft={composer.deleteQueuedDraft}
      onMoveQueuedDraft={composer.moveQueuedDraft}
      pendingCommandGate={composer.pendingCommandGate}
      onConfirmCommandGate={composer.confirmCommandGate}
      onCancelCommandGate={composer.cancelCommandGate}
      attachedImages={composer.attachedImages}
      onRemoveImage={(index) => composer.setAttachedImages((images) => images.filter((_, imageIndex) => imageIndex !== index))}
      uploadingImages={composer.uploadingImages}
      imageErrors={composer.imageErrors}
      showFileDropdown={composer.showFileDropdown}
      filteredFiles={composer.filteredFiles}
      selectedFileIndex={composer.selectedFileIndex}
      onSelectFile={composer.selectFile}
      filteredCommands={composer.filteredCommands}
      skillCommands={composer.skillCommands}
      selectedCommandIndex={composer.selectedCommandIndex}
      onCommandSelect={composer.handleCommandSelect}
      onCloseCommandMenu={composer.resetCommandMenuState}
      isCommandMenuOpen={composer.showCommandMenu}
      frequentCommands={composer.commandQuery ? [] : composer.frequentCommands}
      getRootProps={composer.getRootProps}
      getInputProps={composer.getInputProps}
      openImagePicker={composer.openImagePicker}
      inputHighlightRef={composer.inputHighlightRef}
      renderInputWithMentions={composer.renderInputWithMentions}
      textareaRef={composer.textareaRef}
      input={composer.input}
      onVoiceTranscript={composer.handleVoiceTranscript}
      onInputChange={composer.handleInputChange}
      onTextareaClick={composer.handleTextareaClick}
      onTextareaKeyDown={composer.handleKeyDown}
      onTextareaPaste={composer.handlePaste}
      onTextareaScrollSync={composer.syncInputOverlayScroll}
      onTextareaInput={composer.handleTextareaInput}
      onInputFocusChange={composer.handleInputFocusChange}
      placeholder={t('input.placeholder', { provider: 'Gajae Code' })}
      isTextareaExpanded={composer.isTextareaExpanded}
      sendByCtrlEnter={sendByCtrlEnter}
      modelPreset={gjcModel}
      modelPresetOptions={providerModelCatalog.gjc?.OPTIONS ?? []}
      modelOptions={providerModelCatalog.gjc?.MODELS ?? []}
      availabilityKnown={Array.isArray(providerModelCatalog.gjc?.MODELS)}
      modelPresetsLoading={providerModelsLoading}
      modelPickerOpenTrigger={composer.modelPickerTrigger}
      onSelectModelPreset={(model) => selectProviderModel('gjc', model, session.currentSessionId || selectedSession?.id || null)}
      reasoningEffort={reasoningEffort}
      onSelectReasoningEffort={setReasoningEffort}
      permissions={projectPermissions.permissions}
      onSelectPermissionMode={projectPermissions.setMode}
      permissionsBusy={projectPermissions.isSettingMode}
      isWorkspace={composer.isWorkspace}
      workspaceRootName={selectedProject.displayName}
      workspaceCandidates={composer.workspaceCandidates}
      workspaceTarget={composer.workspaceTargetValue}
      onPickWorkspaceTarget={composer.pickWorkspaceTarget}
    />
  );

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        {!historicalSession && (session.currentSessionId || selectedSession?.id) && <GoalControls key={`${selectedProject.projectId}:${session.currentSessionId ?? selectedSession?.id}`} {...goalControls} />}
        <ChatTasksPanel sessionId={selectedSession?.id ?? session.currentSessionId ?? undefined} sessionStore={sessionStore} />
        {showLanding ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 pb-[10vh] sm:px-6">
            <div className="w-full max-w-184">
              <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {t('newSession.greeting', { defaultValue: 'What are we building today?' })}
              </h1>
              <p className="mt-2 mb-8 text-center text-sm text-muted-foreground">
                {t('newSession.subtitle', { project: selectedProject.displayName, defaultValue: 'Gajae Code is ready to work in {{project}}.' })}
              </p>
              {composerNode}
            </div>
          </div>
        ) : (
          <>
            <ChatMessagesPane
              scrollContainerRef={session.scrollContainerRef}
              onWheel={session.handleScroll}
              onTouchMove={session.handleScroll}
              isLoadingSessionMessages={session.isLoadingSessionMessages}
              isProcessing={session.isProcessing}
              liveActivity={liveActivity}
              runStartedAt={session.sessionActivity?.startedAt ?? null}
              chatMessages={session.chatMessages}
              selectedSession={selectedSession}
              currentSessionId={session.currentSessionId}
              provider="gjc"
              isLoadingMoreMessages={session.isLoadingMoreMessages}
              hasMoreMessages={session.hasMoreMessages}
              totalMessages={session.totalMessages}
              sessionMessagesCount={session.chatMessages.length}
              visibleMessageCount={session.visibleMessageCount}
              visibleMessages={session.visibleMessages}
              loadEarlierMessages={session.loadEarlierMessages}
              loadAllMessages={session.loadAllMessages}
              allMessagesLoaded={session.allMessagesLoaded}
              isLoadingAllMessages={session.isLoadingAllMessages}
              loadAllJustFinished={session.loadAllJustFinished}
              showLoadAllOverlay={session.showLoadAllOverlay}
              createDiff={session.createDiff}
              onFileOpen={onFileOpen}
              onShowSettings={onShowSettings}
              density={toolOutputDensity}
              showImagePreviews={showImagePreviews}
              selectedProject={selectedProject}
            />
            <div className="relative shrink-0">
              {session.isUserScrolledUp && session.chatMessages.length > 0 && (
                <div className="pointer-events-none absolute -top-11 right-0 left-0 z-20 flex justify-center">
                  <button
                    type="button"
                    onClick={session.scrollToBottomAndReset}
                    aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                    title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                    className={session.hasNewMessagesBelow
                      ? 'pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-primary/30 bg-primary px-3 text-xs font-medium text-primary-foreground shadow-md transition-all duration-200 hover:brightness-110'
                      : 'pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-xs transition-all duration-200 hover:bg-accent hover:text-foreground'}
                  >
                    {session.hasNewMessagesBelow && <span>{t('input.newMessages', { defaultValue: '새 메시지' })}</span>}
                    <ArrowDownIcon className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              )}
              {!historicalSession && composerNode}
            </div>
          </>
        )}
      </div>
      <CommandResultModal
        payload={composer.commandModalPayload}
        onClose={composer.closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        onHardRefreshProviderModels={hardRefreshProviderModels}
        currentSessionId={session.currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
      <OAuthLoginDialog
        open={oauthLogin.isOpen}
        providers={oauthLogin.providers}
        isLoadingProviders={oauthLogin.isLoadingProviders}
        isStarting={oauthLogin.isStarting}
        attempt={oauthLogin.attempt}
        failure={oauthLogin.failure}
        onSelectProvider={oauthLogin.startProvider}
        onSubmitValue={oauthLogin.submitValue}
        onDismiss={oauthLogin.closeLogin}
        onRetry={oauthLogin.retry}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
