import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeEvent, ClipboardEvent, Dispatch, FormEvent, KeyboardEvent, MouseEvent, MutableRefObject, RefObject, SetStateAction, TouchEvent } from 'react';
import { useDropzone } from 'react-dropzone';
import type { DropEvent } from 'react-dropzone';
import { useTranslation } from 'react-i18next';

import { useAppShellStore } from '../../../stores/useAppShellStore';
import { usePaletteOps } from '../../../stores/usePaletteOpsStore';
import { beginComposerOperation, finishComposerOperation, invalidateComposerFreeze, isComposerFrozen, isComposerSealed, subscribeComposerFreeze } from '../../../shared/composerFreeze';
import type { MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import type { ChatMessage, PendingPermissionRequest, PermissionDecision, SessionEstablishedContext  } from '../types/types';
import type { LLMProvider, Project, ProjectSession, ProviderModelsCacheInfo } from '../../../types/app';
import { authenticatedFetch } from '../../../utils/api';
import { classifyCommandInput, isAutoSendable } from '../commandDispatchPolicy';
import { findAppUiCommand, getLocalCommandNotice, resolveCommandAlias, runAppUiCommand, type AppUiCommand } from '../appUiCommands';
import { gateForCommand, type CommandGate } from '../commandGatePolicy';
import { permissionResponseMessage } from '../utils/chatPermissions';
import { draftKeysToClear, readQueuedMessages, reorderQueue, safeLocalStorage, type QueuedSendOptions } from '../utils/chatStorage';
import type { ComposerDraftRepository, ComposerRoute, DurableQueuedDraft } from '../utils/composerDraftStorage';
import { decideQueueFlush } from '../utils/queueFlush';
import { chooseComposerAttachments, composerFilesFromEvent } from '../utils/composerAttachmentIntake';

import { useFileMentions } from './useFileMentions';
import { useSlashCommands } from './useSlashCommands';
import { useWorkspaceTarget, type WorkspaceCandidate } from './useWorkspaceTarget';
import { newQueuedDraftId, settleRetainedComposerSteer, useDurableComposerDraft } from './useDurableComposerDraft';

interface UseChatComposerStateArgs { draftRepository?: ComposerDraftRepository; executionCwd?: string | null; selectedProject: Project | null; selectedSession: ProjectSession | null; currentSessionId: string | null; gjcModel: string; reasoningEffort?: string; isLoading: boolean; canAbortSession: boolean; tokenBudget: Record<string, unknown> | null; sendMessage: (message: unknown) => boolean | void; sendByCtrlEnter?: boolean; onSessionProcessing?: MarkSessionProcessing; onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void; onInputFocusChange?: (focused: boolean) => void; onCommandGateChange?: (gate: PendingCommandGate | null) => void; onShowSettings?: () => void; onLogin?: (providerId?: string) => void; scrollToBottom: () => void; addMessage: (msg: ChatMessage) => void; setIsUserScrolledUp: (isScrolledUp: boolean) => void; setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>; }
interface MentionableFile { name: string; path: string; }
export type ModelCommandData = { current?: { provider?: string; providerLabel?: string; model?: string }; available?: Partial<Record<LLMProvider, string[]>>; availableModels?: string[]; availableOptions?: Array<{ value: string; label?: string; description?: string }>; defaultModel?: string; cache?: ProviderModelsCacheInfo; };
export type CostCommandData = { tokenUsage?: { used?: number; total?: number }; tokenBreakdown?: { input?: number; output?: number }; provider?: string; model?: string; };
export type StatusCommandData = { version?: string; packageName?: string; uptime?: string; model?: string; provider?: string; nodeVersion?: string; platform?: string; pid?: number; memoryUsage?: { rssMb?: number; heapUsedMb?: number; heapTotalMb?: number }; };
export type HelpCommandData = { content?: string; format?: string; commands?: Array<{ name: string; description?: string; namespace?: string }>; };
type CommandModalKind = 'help' | 'models' | 'cost' | 'status';
export type CommandModalPayload = { kind: CommandModalKind; data: HelpCommandData | ModelCommandData | CostCommandData | StatusCommandData; };
export type QueuedDraft = DurableQueuedDraft;
export type PendingCommandGate = CommandGate & { text: string };

const TURN_START_GRACE = 5000;
const syntheticSubmit = () => ({ preventDefault() {} }) as unknown as FormEvent<HTMLFormElement>;
const steerKey = (sessionId: string, content: string) => JSON.stringify([sessionId, content]);
const shorten = (text: string) => { const compact = text.replace(/\s+/g, ' ').trim(); return compact ? (compact.length > 80 ? `${compact.slice(0, 77)}...` : compact) : null; };
const sessionLabel = (session: ProjectSession | null, input: string) => shorten(String(session?.summary || session?.name || session?.title || '')) || shorten(input);
const resetBox = (setInput: (value: string) => void, value: MutableRefObject<string>, setImages: (files: File[]) => void, setUploads: (items: Map<string, number>) => void, setErrors: (items: Map<string, string>) => void, resetCommands: () => void, setExpanded: (open: boolean) => void, area: RefObject<HTMLTextAreaElement | null>) => { if (isComposerSealed()) return; setInput(''); value.current = ''; setImages([]); setUploads(new Map()); setErrors(new Map()); resetCommands(); setExpanded(false); if (area.current) area.current.style.height = 'auto'; };

export function useChatComposerState(args: UseChatComposerStateArgs) {
  const { t } = useTranslation('chat');
  const { executionCwd, selectedProject, selectedSession, currentSessionId, gjcModel, reasoningEffort = 'default', isLoading, canAbortSession, tokenBudget, sendMessage, sendByCtrlEnter, onSessionProcessing, onSessionEstablished, onInputFocusChange, onCommandGateChange, onShowSettings, onLogin, scrollToBottom, addMessage, setIsUserScrolledUp, setPendingPermissionRequests } = args;
  const projectId = selectedProject?.projectId;
  const conversation = selectedSession?.id || currentSessionId || null;
  const drafts = useDurableComposerDraft(projectId, conversation, args.draftRepository);
  const composerFrozen = useSyncExternalStore(subscribeComposerFreeze, isComposerFrozen, () => false);
  const { input, setInput, images: attachedImages, setImages: setAttachedImages, queue: queuedDrafts, setQueue: setQueuedDrafts, getQueue: restoreQueue, updateQueue, persistence: draftPersistence, ready: draftReady, retryPersistence: retryDraftPersistence } = drafts;
  const [uploadingImages, setUploadingImages] = useState<Map<string, number>>(new Map());
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setExpanded] = useState(false);
  const [isInputFocused, setFocused] = useState(false);
  const [commandModalPayload, setModal] = useState<CommandModalPayload | null>(null);
  const [modelPickerTrigger, setModelPickerTrigger] = useState(0);
  const [pendingCommandGate, setGateState] = useState<PendingCommandGate | null>(null);
  const [queuePulse, setQueuePulse] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef(input);
  const liveImages = useRef(attachedImages);
  const lineHeight = useRef<number | null>(null);
  const resized = useRef<string | null>(null);
  const submitRef = useRef<((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>, queued?: QueuedDraft) => Promise<void>) | null>(null);
  const composerOwner = JSON.stringify([projectId, conversation]);
  const queueOwner = useRef(composerOwner);
  const queueInFlight = useRef(false);
  const dispatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const priorLoading = useRef(isLoading);
  const priorConversation = useRef(composerOwner);
  const bypassGate = useRef(false);
  const gateRef = useRef<PendingCommandGate | null>(null);
  const steerWaiting = useRef(new Map<string, Array<{ draft: QueuedDraft; route: ComposerRoute }>>());
  const submissionOwner = useRef<object | null>({});
  const submissionInFlight = useRef<object | null>(null);
  const gateChangeRef = useRef(onCommandGateChange);
  gateChangeRef.current = onCommandGateChange;
  const recoveryNotice = useRef('');
  const storageErrorNotice = useRef('');

  useEffect(() => {
    if (!draftReady || !queuedDrafts.some((item) => item.requiresReview)) return;
    const key = JSON.stringify([composerOwner, queuedDrafts.filter((item) => item.requiresReview).map((item) => item.id)]);
    if (recoveryNotice.current === key) return;
    recoveryNotice.current = key;
    addMessage({ type: 'system', isSystemNotice: true, noticeLevel: 'warning', timestamp: new Date(),
      content: t('input.queue.recoveryNotice', { defaultValue: 'Recovered queued messages are paused to avoid duplicate sending. Use Edit on a queued message, review its text and attachments, then Send. Your current draft is kept when you edit a queued message.' }) });
  }, [addMessage, composerOwner, draftReady, queuedDrafts, t]);
  useEffect(() => {
    if (draftPersistence.phase !== 'error') return;
    const key = JSON.stringify([composerOwner, draftPersistence.reason]);
    if (storageErrorNotice.current === key) return;
    storageErrorNotice.current = key;
    addMessage({ type: 'system', isSystemNotice: true, noticeLevel: 'warning', timestamp: new Date(),
      content: t('input.draftPersistence.failedInline', { reason: draftPersistence.reason ?? 'storage', defaultValue: 'Draft and attachment saving failed ({{reason}}). Your live input is still here. Use Retry draft saving. Keep this window open; do not restart until saving succeeds.' }) });
  }, [addMessage, composerOwner, draftPersistence.phase, draftPersistence.reason, t]);

  useEffect(() => {
    const owner = {};
    submissionOwner.current = owner;
    submissionInFlight.current = null;
    return () => {
      if (submissionOwner.current === owner) submissionOwner.current = null;
    };
  }, [conversation, projectId]);
  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => { liveImages.current = attachedImages; }, [attachedImages]);

  const eraseDraft = useCallback((settled?: string | null) => { if (projectId) draftKeysToClear(projectId, conversation, settled).forEach((key) => safeLocalStorage.removeItem(key)); }, [conversation, projectId]);
  const announceGate = useCallback((gate: PendingCommandGate | null) => { gateRef.current = gate; setGateState(gate); onCommandGateChange?.(gate); }, [onCommandGateChange]);
  // The pending command stays in the durable input. Editing it revokes the old
  // confirmation instead of retaining a second, volatile send intent.
  useEffect(() => {
    if (gateRef.current && input.trimEnd() !== gateRef.current.text) announceGate(null);
  }, [announceGate, input]);
  useEffect(() => {
    setUploadingImages(new Map());
    setImageErrors(new Map());
    setModal(null);
    gateRef.current = null;
    setGateState(null);
    gateChangeRef.current?.(null);
    bypassGate.current = false;
  }, [conversation, projectId]);
  const login = useCallback((provider?: string) => { if (isComposerSealed()) return; resetBox(setInput, inputRef, setAttachedImages, setUploadingImages, setImageErrors, () => undefined, setExpanded, textareaRef); eraseDraft(); onLogin?.(provider); }, [eraseDraft, onLogin, setAttachedImages, setInput]);
  const palette = usePaletteOps();
  const showCostModal = useCallback(() => { const parts = tokenBudget?.breakdown && typeof tokenBudget.breakdown === 'object' ? tokenBudget.breakdown as Record<string, unknown> : {}; const inTokens = Number(tokenBudget?.inputTokens ?? parts.input); const outTokens = Number(tokenBudget?.outputTokens ?? parts.output); const used = Number(tokenBudget?.used); const total = Number(tokenBudget?.total); setModal({ kind: 'cost', data: { tokenUsage: { used: Number.isFinite(used) ? used : (Number.isFinite(inTokens) ? inTokens : 0) + (Number.isFinite(outTokens) ? outTokens : 0), total: Number.isFinite(total) ? total : 0 }, ...(Number.isFinite(inTokens) || Number.isFinite(outTokens) ? { tokenBreakdown: { input: Number.isFinite(inTokens) ? inTokens : 0, output: Number.isFinite(outTokens) ? outTokens : 0 } } : {}), provider: typeof tokenBudget?.provider === 'string' ? tokenBudget.provider : 'gjc', model: typeof tokenBudget?.model === 'string' ? tokenBudget.model : gjcModel } }); }, [gjcModel, tokenBudget]);
  const applyAppCommand = useCallback((command: AppUiCommand) => { if (isComposerSealed()) return; return runAppUiCommand(command, { openSessionPicker: palette.openSessionPicker, startNewChat: palette.startNewChat, openSettings: () => onShowSettings ? onShowSettings() : palette.openSettings(), openModelPicker: () => setModelPickerTrigger((n) => n + 1), openCostModal: showCostModal }); }, [onShowSettings, palette, showCostModal]);

  const { slashCommands, slashCommandsCount, filteredCommands, frequentCommands, commandQuery, showCommandMenu, selectedCommandIndex, resetCommandMenuState, handleCommandSelect, handleToggleCommandMenu, handleCommandInputChange, handleCommandMenuKeyDown } = useSlashCommands({ selectedProject, executionCwd, provider: 'gjc', sessionId: conversation, input, setInput, textareaRef, onLoginCommand: login, onAppCommand: (command) => { const app = findAppUiCommand(command.name); if (app) applyAppCommand(app); } });
  const { showFileDropdown, filteredFiles, selectedFileIndex, renderInputWithMentions, selectFile, setCursorPosition, handleFileMentionsKeyDown } = useFileMentions({ selectedProject, executionCwd, sessionId: conversation, input, setInput, textareaRef });
  const clearComposer = useCallback(() => resetBox(setInput, inputRef, setAttachedImages, setUploadingImages, setImageErrors, resetCommandMenuState, setExpanded, textareaRef), [resetCommandMenuState, setAttachedImages, setInput]);

  // Permissions are deliberately absent here: the policy is the project's, read
  // by the server when the run starts, so nothing the browser sends can widen it.
  const optionsFor = useCallback((text: string): QueuedSendOptions => ({ model: gjcModel, effort: reasoningEffort, sessionSummary: sessionLabel(selectedSession, text) }), [gjcModel, reasoningEffort, selectedSession]);
  const upload = useCallback(async (files: File[]) => { if (!files.length) return []; const body = new FormData(); files.forEach((file) => body.append('images', file)); const response = await authenticatedFetch('/api/assets/images', { method: 'POST', headers: {}, body }); if (!response.ok) throw new Error('Failed to upload images'); return (await response.json()).images as unknown[]; }, []);
  const workspaceTarget = useWorkspaceTarget({ selectedProject, selectedSession, currentSessionId, input });
  const { resolveForSend } = workspaceTarget;
  // A workspace root (e.g. `~/Projects`) never hosts a session itself: the
  // resolved child repo becomes the session's project, and it is what the
  // caller (ChatInterface's `establishSession`) registers into the sidebar.
  const descend = useCallback(async (target: WorkspaceCandidate): Promise<Project> => { const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(selectedProject!.projectId)}/descend`, { method: 'POST', body: JSON.stringify({ path: target.path }) }); if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string | { message?: string } }; const error = body.error; throw new Error(typeof error === 'string' ? error : error?.message ?? `Failed to switch to ${target.name} (${response.status})`); } return (await response.json())?.data as Project; }, [selectedProject]);
  const allocate = useCallback(async (summary: string | null, text: string, isCurrent: () => boolean): Promise<{ id: string; context?: SessionEstablishedContext } | null> => {
    let id = selectedSession ? (selectedSession.__provider === 'gjc' ? selectedSession.id : null) : currentSessionId;
    if (id) return { id };
    const target = await resolveForSend(text);
    if (!isCurrent()) return null;
    const project = target ? await descend(target) : selectedProject;
    if (!isCurrent()) return null;
    const response = await authenticatedFetch('/api/providers/sessions', { method: 'POST', body: JSON.stringify({ provider: 'gjc', projectPath: project?.fullPath || project?.path || '' }) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? `Failed to create session (${response.status})`);
    }
    id = (await response.json())?.data?.sessionId || null;
    if (!id) throw new Error('no session id returned.');
    return { id, context: { provider: 'gjc', project: project!, summary } };
  }, [currentSessionId, descend, resolveForSend, selectedProject, selectedSession]);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>, queued?: QueuedDraft) => {
    event.preventDefault(); const text = queued?.content ?? inputRef.current; if (!text.trim() || !selectedProject) return;
    if (isComposerFrozen()) return;
    if (!draftReady) {
      if (draftPersistence.phase === 'error') {
        const owner = submissionOwner.current;
        const recovered = await retryDraftPersistence();
        if (submissionOwner.current === owner) addMessage({ type: 'system', isSystemNotice: true, noticeLevel: recovered ? 'info' : 'warning', content: recovered ? t('input.draftPersistence.recoveredRetry', { defaultValue: 'Draft saving recovered. Review your input and attachments, then press Send again.' }) : t('input.draftPersistence.recoveryStillFailed', { defaultValue: 'Draft recovery still failed. Your live input and existing stored data have been kept.' }), timestamp: new Date() });
      } else addMessage({ type: 'error', content: t('input.draftPersistence.recoveryNotReady', { defaultValue: 'Draft recovery is not ready. Your input has been kept; retry after recovery completes.' }), timestamp: new Date() });
      return;
    }
    const sendOptions = queued?.options ?? optionsFor(text);
    const files = queued?.images ?? attachedImages;
    const signIn = /^\/login(?:\s+(.*))?$/.exec(text.trim()); if (signIn) { login(signIn[1]?.trim() || undefined); resetCommandMenuState(); return; }
    if (isLoading) { queueOwner.current = composerOwner; setQueuedDrafts((q) => [...q, { id: newQueuedDraftId(), content: text, images: files, options: sendOptions }]); clearComposer(); eraseDraft(); return; }
    const candidate = text.trimEnd(); const help = candidate.trim().toLowerCase() === 'help';
    if (candidate.startsWith('/') || help) { const gap = candidate.indexOf(' '); const name = help ? '/help' : gap > 0 ? candidate.slice(0, gap) : candidate; const commandArgs = gap > 0 ? candidate.slice(gap).trim() : ''; const app = findAppUiCommand(resolveCommandAlias(name)); if (app && (app.interceptWithArgs !== false || !commandArgs)) { clearComposer(); applyAppCommand(app); return; } const notice = getLocalCommandNotice(name, commandArgs); if (notice) { clearComposer(); addMessage({ type: 'assistant', content: notice, timestamp: Date.now() }); return; } if (!bypassGate.current) { const gate = gateForCommand(resolveCommandAlias(name), commandArgs); if (gate) { announceGate({ ...gate, text: candidate }); return; } } bypassGate.current = false; }
    const owner = submissionOwner.current;
    if (!owner || submissionInFlight.current === owner) return;
    const finishOperation = beginComposerOperation('send');
    if (!finishOperation) return;
    submissionInFlight.current = owner;
    const isCurrent = () => submissionOwner.current === owner;
    try {
      let images: unknown[];
      try { images = await upload(files); } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : 'Unknown error';
        addMessage({ type: 'error', content: `Failed to upload images: ${message}`, timestamp: new Date() });
        return;
      }
      if (!isCurrent()) return;
      const summary = sessionLabel(selectedSession, text);
      let allocation: Awaited<ReturnType<typeof allocate>>;
      try { allocation = await allocate(summary, text, isCurrent); } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : 'Unknown error';
        addMessage({ type: 'error', content: `Failed to start a new session: ${message}`, timestamp: new Date() });
        return;
      }
      if (!allocation || !isCurrent()) return;
      const { id, context } = allocation;
      if (sendMessage({ type: 'chat.send', sessionId: id, content: text, options: { ...sendOptions, images, goalUiVersion: 1 } }) === false) {
        addMessage({ type: 'error', content: 'Connection lost. Your draft has been kept; retry when connected.', timestamp: new Date() });
        return;
      }
      if (context) onSessionEstablished?.(id, context);
      addMessage({ type: 'user', content: text, images: images as any, timestamp: new Date() });
      onSessionProcessing?.(id, { statusText: null, canInterrupt: true });
      setIsUserScrolledUp(false);
      setTimeout(() => { if (isCurrent()) scrollToBottom(); }, 100);
      // Typing during an upload belongs to the next draft, even in this session.
      if (inputRef.current === text && liveImages.current === files) { clearComposer(); eraseDraft(id); }
    } finally {
      if (submissionInFlight.current === owner) submissionInFlight.current = null;
      finishOperation();
    }
  }, [addMessage, allocate, announceGate, applyAppCommand, attachedImages, clearComposer, composerOwner, draftPersistence.phase, draftReady, eraseDraft, isLoading, login, onSessionEstablished, onSessionProcessing, optionsFor, resetCommandMenuState, retryDraftPersistence, scrollToBottom, selectedProject, selectedSession, sendMessage, setIsUserScrolledUp, setQueuedDrafts, t, upload]);
  useEffect(() => { submitRef.current = handleSubmit; }, [handleSubmit]);

  const handleSteer = useCallback((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const text = inputRef.current;
    const id = selectedSession?.id || currentSessionId || null;
    if (!draftReady || !isLoading || !text.trim() || !selectedProject || !id || attachedImages.length || !isAutoSendable(classifyCommandInput(text))) return;
    const draft: QueuedDraft = { id: `steer_${crypto.randomUUID()}`, content: text, images: [], options: optionsFor(text), pendingSteer: true };
    const finishOperation = beginComposerOperation('steer', draft.id);
    if (!finishOperation) return;
    let sent: boolean | void;
    try { sent = sendMessage({ type: 'chat.steer', sessionId: id, content: text }); } catch (error) { finishOperation(); throw error; }
    if (sent === false) {
      finishOperation();
      addMessage({ type: 'error', content: 'Connection lost. Your draft has been kept; retry when connected.', timestamp: new Date() });
      return;
    }
    // A missing reply does not mean rejection. Persist the unresolved claim so
    // neither a later turn nor a remount can send the same instruction again.
    const key = steerKey(id, text);
    const pending = steerWaiting.current.get(key) || [];
    pending.push({ draft, route: { projectId: selectedProject.projectId, conversation: id } });
    steerWaiting.current.set(key, pending);
    queueOwner.current = composerOwner;
    setQueuedDrafts((q) => [...q, { ...draft, pendingSteer: true }]);
    clearComposer();
    eraseDraft(id);
  }, [addMessage, attachedImages.length, clearComposer, composerOwner, currentSessionId, draftReady, eraseDraft, isLoading, optionsFor, selectedProject, selectedSession?.id, sendMessage, setQueuedDrafts]);
  const resolveSteerResult = useCallback((content: string, accepted: boolean, sessionId: string | null = conversation) => {
    if (!sessionId) return;
    const key = steerKey(sessionId, content);
    const list = steerWaiting.current.get(key);
    const route = { projectId: projectId ?? '', conversation: sessionId };
    const restored = sessionId === conversation ? restoreQueue(route).find((draft) => draft.pendingSteer && draft.content === content) : undefined;
    const pending = list?.shift() ?? (restored ? { draft: restored, route } : undefined);
    if (!pending) {
      const orphan = settleRetainedComposerSteer(sessionId, content, accepted);
      if (orphan?.id) finishComposerOperation(orphan.id);
      if (orphan && accepted) onSessionProcessing?.(sessionId, { statusText: null, canInterrupt: true });
      return;
    }
    if (!list?.length) steerWaiting.current.delete(key);
    const settle = (queue: QueuedDraft[]) => accepted
      ? queue.filter((item) => item.id !== pending.draft.id)
      : queue.map((item) => item.id === pending.draft.id ? { ...item, pendingSteer: false } : item);
    if (sessionId === conversation && pending.route.projectId === projectId) {
      setQueuedDrafts(settle);
      if (accepted) {
        addMessage({ type: 'user', content: pending.draft.content, timestamp: new Date() });
        scrollToBottom();
      }
    } else {
      updateQueue(pending.route, settle);
    }
    if (pending.draft.id) finishComposerOperation(pending.draft.id);
    if (accepted) onSessionProcessing?.(sessionId, { statusText: null, canInterrupt: true });
  }, [addMessage, conversation, onSessionProcessing, projectId, restoreQueue, scrollToBottom, setQueuedDrafts, updateQueue]);

  useEffect(() => {
    const switched = priorConversation.current !== composerOwner;
    priorConversation.current = composerOwner;
    queueOwner.current = composerOwner;
    const wasBusy = priorLoading.current;
    priorLoading.current = isLoading;
    if (isLoading || switched) { queueInFlight.current = false; if (dispatchTimer.current) clearTimeout(dispatchTimer.current); }
    const head = queuedDrafts[0];
    const verdict = decideQueueFlush({ sessionSwitched: switched, isLoading, wasLoading: wasBusy, queueLength: queuedDrafts.length, awaitingDispatchedTurn: queueInFlight.current, composerHasInput: Boolean(input.trim()) || attachedImages.length > 0, headAwaitingSteer: Boolean(head?.pendingSteer || head?.requiresReview) });
    if (composerFrozen || !draftReady || draftPersistence.phase === 'error' || verdict.action !== 'flush' || !head) return;
    const timer = setTimeout(() => {
      if (isComposerFrozen()) return;
      // Only legacy text-only queues can be consumed by the offscreen sender.
      // Never hydrate a File-bearing intent from that lossy projection.
      const disk = conversation ? readQueuedMessages(conversation) : [];
      if (draftPersistence.phase === 'unavailable' && conversation && !head.images.length && disk.length < queuedDrafts.length) {
        setQueuedDrafts(disk.map((item) => ({ ...item, images: [] })));
        return;
      }
      const finishOperation = beginComposerOperation('queue-dispatch');
      if (!finishOperation) return;
      queueInFlight.current = true;
      if (dispatchTimer.current) clearTimeout(dispatchTimer.current);
      dispatchTimer.current = setTimeout(() => { queueInFlight.current = false; setQueuePulse((n) => n + 1); }, TURN_START_GRACE);
      setQueuedDrafts((q) => q.slice(1));
      setInput(head.content);
      inputRef.current = head.content;
      setAttachedImages(head.images);
      setTimeout(() => {
        try { if (queueOwner.current === composerOwner) void submitRef.current?.(syntheticSubmit(), head); }
        finally { finishOperation(); }
      }, 0);
    }, verdict.delayMs);
    return () => clearTimeout(timer);
  }, [attachedImages.length, composerFrozen, composerOwner, conversation, draftPersistence.phase, draftReady, input, isLoading, queuePulse, queuedDrafts, setAttachedImages, setInput, setQueuedDrafts]);
  useEffect(() => () => { queueOwner.current = ''; submitRef.current = null; if (dispatchTimer.current) clearTimeout(dispatchTimer.current); }, []);

  const resize = useCallback((target: HTMLTextAreaElement) => { target.style.height = 'auto'; const height = Math.max(22, target.scrollHeight); target.style.height = `${height}px`; if (!lineHeight.current) { const parsed = parseInt(window.getComputedStyle(target).lineHeight); lineHeight.current = Number.isFinite(parsed) ? parsed : 24; } setExpanded(height > lineHeight.current * 2); resized.current = target.value; }, []);
  useEffect(() => { if (textareaRef.current && resized.current !== input) resize(textareaRef.current); }, [input, resize]);
  const handleImageFiles = useCallback((files: File[]) => { if (isComposerSealed()) return; const accepted = files.filter((file) => { try { if (!file || typeof file !== 'object') { console.warn('Invalid file object:', file); return false; } if (!file.type?.startsWith('image/')) return false; if (!file.size || file.size > 5 * 1024 * 1024) { setImageErrors((old) => new Map(old).set(file.name || 'Unknown file', 'File too large (max 5MB)')); return false; } return true; } catch (error) { console.error('Error validating file:', error, file); return false; } }); if (accepted.length) setAttachedImages((old) => [...old, ...accepted].slice(0, 5)); }, [setAttachedImages]);
  const attachmentError = (error: Error) => {
    if (queueOwner.current === composerOwner && submissionOwner.current) setImageErrors((old) => new Map(old).set('attachment', error.message));
  };
  const acceptSelectedImages = (files: File[]) => {
    const accepted = files.filter((file) => file.type.startsWith('image/') && file.size > 0 && file.size <= 5 * 1024 * 1024);
    if (accepted.length > 5) { attachmentError(new Error('At most 5 images can be attached at once.')); return; }
    handleImageFiles(accepted);
  };
  const getFilesFromEvent = async (event: DropEvent) => {
    if (isComposerSealed()) return [];
    if (!Array.isArray(event) && event.type !== 'drop' && event.type !== 'change') return composerFilesFromEvent(event);
    // Dropped/pasted input revokes a freeze rather than discarding the Files.
    invalidateComposerFreeze();
    const finish = beginComposerOperation('attachment');
    if (!finish) return [];
    try {
      const files = (await composerFilesFromEvent(event)).filter((file): file is File => file instanceof File);
      acceptSelectedImages(files);
      return files;
    } finally { finish(); }
  };
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'] }, maxSize: 5 * 1024 * 1024, maxFiles: 5, getFilesFromEvent, onError: attachmentError, noClick: true, noKeyboard: true });
  const open = () => chooseComposerAttachments(acceptSelectedImages, attachmentError);
  const handleInputChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => { if (isComposerSealed()) { event.preventDefault?.(); event.target.value = inputRef.current; return; } const value = event.target.value; const position = event.target.selectionStart; setInput(value); inputRef.current = value; setCursorPosition(position); if (!value.trim()) { event.target.style.height = 'auto'; setExpanded(false); resetCommandMenuState(); } else handleCommandInputChange(value, position); }, [handleCommandInputChange, resetCommandMenuState, setCursorPosition, setInput]);
  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => { if (isComposerSealed()) { event.preventDefault?.(); return; } const items = Array.from(event.clipboardData.items); items.forEach((item) => { if (item.type.startsWith('image/')) { const file = item.getAsFile(); if (file) handleImageFiles([file]); } }); if (!items.length && event.clipboardData.files.length) handleImageFiles(Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))); }, [handleImageFiles]);
  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => { if (inputHighlightRef.current) { inputHighlightRef.current.scrollTop = target.scrollTop; inputHighlightRef.current.scrollLeft = target.scrollLeft; } }, []);
  const handleTextareaInput = useCallback((event: FormEvent<HTMLTextAreaElement>) => { if (isComposerSealed()) { event.preventDefault?.(); event.currentTarget.value = inputRef.current; return; } resize(event.currentTarget); setCursorPosition(event.currentTarget.selectionStart); syncInputOverlayScroll(event.currentTarget); }, [resize, setCursorPosition, syncInputOverlayScroll]);
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => { if (isComposerSealed()) { event.preventDefault(); return; } if (handleCommandMenuKeyDown(event) || handleFileMentionsKeyDown(event) || event.key !== 'Enter' || event.nativeEvent.isComposing) return; if ((event.ctrlKey || event.metaKey) && !event.shiftKey || (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter)) { event.preventDefault(); void handleSubmit(event); } }, [handleCommandMenuKeyDown, handleFileMentionsKeyDown, handleSubmit, sendByCtrlEnter]);
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    if (isComposerSealed()) return;
    const isCurrent = queueOwner.current === composerOwner && submissionOwner.current !== null;
    const shouldSend = send && isCurrent && !isComposerFrozen();
    setInput((previous) => {
      const next = previous.trim() ? `${previous.trim()} ${text}` : text;
      if (isCurrent) inputRef.current = next;
      return next;
    });
    if (shouldSend) void submitRef.current?.(syntheticSubmit());
  }, [composerOwner, setInput]);
  const editQueuedDraft = useCallback((index: number) => {
    if (!draftReady || isComposerSealed()) return;
    const item = queuedDrafts[index];
    if (!item) return;
    // Keep an unrelated active draft instead of replacing it during queue edit.
    setQueuedDrafts((q) => [...q.filter((_, position) => position !== index), ...(inputRef.current || attachedImages.length ? [{ id: newQueuedDraftId(), content: inputRef.current, images: attachedImages, requiresReview: true }] : [])]);
    setInput(item.content); inputRef.current = item.content; setAttachedImages(item.images); textareaRef.current?.focus();
  }, [attachedImages, draftReady, queuedDrafts, setAttachedImages, setInput, setQueuedDrafts]);
  const deleteQueuedDraft = useCallback((index: number) => { if (draftReady && !isComposerSealed()) setQueuedDrafts((q) => q.filter((_, position) => position !== index)); }, [draftReady, setQueuedDrafts]);
  const moveQueuedDraft = useCallback((from: number, to: number) => { if (draftReady && !isComposerSealed()) setQueuedDrafts((q) => reorderQueue(q, from, to)); }, [draftReady, setQueuedDrafts]);
  const confirmCommandGate = useCallback(() => { const gate = gateRef.current; if (!gate || isComposerFrozen() || inputRef.current.trimEnd() !== gate.text) return; announceGate(null); bypassGate.current = true;
    // A confirmed handoff moves the runtime to a fresh session; the next
    // session_upserted for a new id in this project is it, and the app should
    // follow instead of staying on the old session (issue #6).
    if (/^\/handoff\b/.test(gate.text.trim())) useAppShellStore.getState().setPendingHandoff({ fromSessionId: conversation, projectId, at: Date.now() });
    setInput(gate.text); inputRef.current = gate.text; void handleSubmit(syntheticSubmit()); }, [announceGate, conversation, handleSubmit, projectId, setInput]);
  const cancelCommandGate = useCallback(() => { if (isComposerSealed()) return; announceGate(null); bypassGate.current = false; }, [announceGate]);
  const handleClearInput = useCallback(() => { clearComposer(); textareaRef.current?.focus(); }, [clearComposer]);
  // The Changes tab's line comments arrive here: one new paragraph with the
  // reference and the quote, focus moved to the composer, ready to send.
  const insertAtEnd = useCallback((text: string) => { if (isComposerSealed() || !text.trim()) return; const next = inputRef.current.trim() ? `${inputRef.current.trimEnd()}\n\n${text}` : text; setInput(next); inputRef.current = next; textareaRef.current?.focus(); }, [setInput]);
  const handleAbortSession = useCallback(() => { if (isComposerSealed() || !canAbortSession) return; const id = selectedSession?.id || currentSessionId; if (!id) { console.warn('Abort requested but no session ID is available.'); return; } sendMessage({ type: 'chat.abort', sessionId: id }); }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);
  const handlePermissionDecision = useCallback((requestIds: string | string[], decision: PermissionDecision) => {
    const finishOperation = beginComposerOperation('send');
    if (!finishOperation) return;
    try {
      const ids = (Array.isArray(requestIds) ? requestIds : [requestIds]).filter(Boolean);
      const sent = ids.filter((requestId) => sendMessage(permissionResponseMessage(requestId, decision)) !== false);
      if (sent.length) setPendingPermissionRequests((requests) => requests.filter((request) => !sent.includes(request.requestId)));
    } finally { finishOperation(); }
  }, [sendMessage, setPendingPermissionRequests]);
  const handleInputFocusChange = useCallback((focused: boolean) => { setFocused(focused); onInputFocusChange?.(focused); }, [onInputFocusChange]);
  return { composerFrozen, draftPersistence, draftReady, retryDraftPersistence, input, setInput, textareaRef, inputHighlightRef, isTextareaExpanded, slashCommandsCount, skillCommands: slashCommands.filter((command) => command.type === 'skill'), filteredCommands, frequentCommands, commandQuery, showCommandMenu, selectedCommandIndex, resetCommandMenuState, handleCommandSelect, handleToggleCommandMenu, showFileDropdown, filteredFiles: filteredFiles as MentionableFile[], selectedFileIndex, renderInputWithMentions, selectFile, attachedImages, setAttachedImages, uploadingImages, imageErrors, getRootProps, getInputProps, isDragActive, openImagePicker: open, handleSubmit, handleSteer, modelPickerTrigger, queuedDrafts, editQueuedDraft, deleteQueuedDraft, moveQueuedDraft, resolveSteerResult, pendingCommandGate, confirmCommandGate, cancelCommandGate, handleVoiceTranscript, insertAtEnd, handleInputChange, handleKeyDown, handlePaste, handleTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => setCursorPosition(event.currentTarget.selectionStart), handleTextareaInput, syncInputOverlayScroll, handleClearInput, handleAbortSession, handlePermissionDecision, handleInputFocusChange, isInputFocused, commandModalPayload, closeCommandModal: () => setModal(null), showCostModal, isWorkspace: workspaceTarget.isWorkspace, workspaceCandidates: workspaceTarget.candidates, workspaceTargetValue: workspaceTarget.target, pickWorkspaceTarget: workspaceTarget.pickTarget };
}
