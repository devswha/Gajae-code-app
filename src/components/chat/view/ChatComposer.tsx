import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  RefObject,
  ReactNode,
  TouchEvent,
} from 'react';
import type { DropzoneInputProps, DropzoneRootProps } from 'react-dropzone';
import { PlusIcon, Loader2, ArrowUpIcon, ForwardIcon } from 'lucide-react';

import { classifyCommandInput, isAutoSendable } from '../commandDispatchPolicy';
import { isComposerSealed, registerComposerInputValue, subscribeComposerFreeze } from '../../../shared/composerFreeze';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useVoiceAvailable } from '../hooks/useVoiceAvailable';
import type { PendingCommandGate, QueuedDraft } from '../hooks/useChatComposerState';
import type { DraftPersistenceStatus } from '../hooks/useDurableComposerDraft';
import type { WorkspaceCandidate } from '../hooks/useWorkspaceTarget';
import type { PendingPermissionRequest, PermissionDecision } from '../types/types';
import type { ProviderModelOption } from '../../../types/app';
import type { PermissionModeUpdate, ProjectPermissions } from '../../../hooks/useProjectPermissions';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  Tooltip,
  Button,
} from '../../../shared/view/ui';

import CommandMenu from './CommandMenu';
import ImageAttachment from './ImageAttachment';
import VoiceInputButton from './VoiceInputButton';
import PermissionRequestsBanner from './PermissionRequestsBanner';
import QueuedMessageCard from './QueuedMessageCard';
import CommandGateCard from './CommandGateCard';
import AgentConfigurationPicker from './AgentConfigurationPicker';
import ModelAndReasoningPicker from './ModelAndReasoningPicker';
import PermissionModePicker from './PermissionModePicker';
import ContextUsageBadge from './ContextUsageBadge';
import type { ReasoningEffort } from './reasoningEffort';
import SkillPicker from './SkillPicker';
import WorkspaceTargetChip from './WorkspaceTargetChip';

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ChatComposerProps {
  /** Page freeze is reversible; typing revokes its receipt instead of losing input. */
  composerFrozen?: boolean;
  voiceOwnerKey?: string;
  draftPersistence?: DraftPersistenceStatus;
  onRetryDraftPersistence?: () => Promise<boolean>;
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (requestIds: string | string[], decision: PermissionDecision) => void;
  /** A run is in flight for the viewed session: the primary button is Stop, Enter queues. */
  isLoading: boolean;
  onAbortSession: () => void;
  sessionState: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  onSubmit: (
    event: FormEvent<HTMLFormElement>
      | MouseEvent<HTMLButtonElement>
      | TouchEvent<HTMLButtonElement>
      | KeyboardEvent<HTMLTextAreaElement>,
  ) => void;
  onSteer: (event: MouseEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  /** Model pinned to this session, if any; outranks the last-run model. */
  sessionPinnedModel?: string | null;
  queuedDrafts: QueuedDraft[];
  onEditQueuedDraft: (index: number) => void;
  onDeleteQueuedDraft: (index: number) => void;
  onMoveQueuedDraft: (from: number, to: number) => void;
  pendingCommandGate: PendingCommandGate | null;
  onConfirmCommandGate: () => void;
  onCancelCommandGate: () => void;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  skillCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: <T extends DropzoneRootProps>(props?: T) => T;
  getInputProps: <T extends DropzoneInputProps>(props?: T) => T;
  openImagePicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement | null>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  onVoiceTranscript?: (text: string, send?: boolean) => void;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
  modelPreset?: string;
  modelPresetOptions?: ProviderModelOption[];
  modelOptions?: ProviderModelOption[];
  /** Whether `modelOptions` is the runtime's answer; see ModelAndReasoningPicker. */
  availabilityKnown?: boolean;
  modelPresetsLoading?: boolean;
  /** Monotonic signal: each increment opens the model preset popup. */
  modelPickerOpenTrigger?: number;
  onSelectModelPreset?: (value: string) => Promise<unknown> | unknown;
  reasoningEffort?: ReasoningEffort;
  onSelectReasoningEffort?: (value: ReasoningEffort) => void;
  /** The selected project's permission policy; null reserves its toolbar slot. */
  permissions?: ProjectPermissions | null;
  onSelectPermissionMode?: (update: PermissionModeUpdate) => Promise<unknown> | unknown;
  permissionsBusy?: boolean;
  /** True when the selected project is a workspace root; shows the target chip. */
  isWorkspace?: boolean;
  workspaceRootName?: string;
  workspaceCandidates?: WorkspaceCandidate[];
  workspaceTarget?: WorkspaceCandidate | null;
  onPickWorkspaceTarget?: (candidate: WorkspaceCandidate | null) => void;
}

export default function ChatComposer({
  composerFrozen = false,
  voiceOwnerKey,
  draftPersistence,
  onRetryDraftPersistence,
  pendingPermissionRequests,
  handlePermissionDecision,
  isLoading,
  onAbortSession,
  sessionState,
  onShowTokenUsage,
  onSubmit,
  onSteer,
  isDragActive,
  sessionPinnedModel,
  queuedDrafts,
  onEditQueuedDraft,
  onDeleteQueuedDraft,
  onMoveQueuedDraft,
  pendingCommandGate,
  onConfirmCommandGate,
  onCancelCommandGate,
  attachedImages,
  onRemoveImage,
  uploadingImages,
  imageErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  skillCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openImagePicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onVoiceTranscript,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
  modelPreset = 'default',
  modelPresetOptions = [],
  modelOptions = [],
  availabilityKnown = false,
  modelPresetsLoading,
  modelPickerOpenTrigger,
  onSelectModelPreset = () => {},
  reasoningEffort = 'default',
  onSelectReasoningEffort = () => {},
  permissions = null,
  onSelectPermissionMode = () => {},
  permissionsBusy = false,
  isWorkspace = false,
  workspaceRootName = '',
  workspaceCandidates = [],
  workspaceTarget = null,
  onPickWorkspaceTarget = () => {},
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  const sealed = useSyncExternalStore(subscribeComposerFreeze, isComposerSealed, () => false);
  const attachInput = (inputElement: HTMLTextAreaElement | null) => {
    textareaRef.current = inputElement;
    if (!inputElement) return;
    const unregister = registerComposerInputValue(inputElement, () => input);
    return () => { unregister(); if (textareaRef.current === inputElement) textareaRef.current = null; };
  };
  const commandMenuPosition = useMemo(() => {
    if (!isCommandMenuOpen) {
      return { top: 0, left: 16, bottom: 90 };
    }
    const textareaRect = textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
  }, [isCommandMenuOpen, textareaRef]);

  // Voice state is hosted here (not in the mic button) so the main Send button can stop
  // recording and send the transcript in one tap, the way the mic button drops it in the box.
  const voiceAvailable = useVoiceAvailable();
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVoiceError = useCallback((msg: string) => {
    setVoiceError(msg);
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
    voiceErrorTimer.current = setTimeout(() => setVoiceError(null), 4000);
  }, []);
  useEffect(() => () => {
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
  }, []);
  const noopTranscript = useCallback(() => {}, []);
  const { state: voiceState, toggle: voiceToggle, stop: voiceStop } = useVoiceInput(
    onVoiceTranscript ?? noopTranscript,
    handleVoiceError,
    voiceOwnerKey,
  );
  const isRecording = voiceState === 'recording';
  const isVoiceBusy = voiceState !== 'idle' && !isRecording;

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion' || r.toolName === 'ask'
  );

  const handleFormSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    onSubmit(event);
  }, [onSubmit]);

  // What the NEXT turn will run: a session's pinned model outranks the model
  // it last ran with, because the backend resolves the pin when dispatching.
  const reportedModel = typeof sessionState?.modelId === 'string' && sessionState.modelId.trim()
    ? sessionState.modelId.trim()
    : undefined;
  const displayedModel = sessionPinnedModel?.trim() || reportedModel;

  const canQueueDraft = isLoading && Boolean(input.trim());
  const canSteer = canQueueDraft
    && attachedImages.length === 0
    && isAutoSendable(classifyCommandInput(input));
  const submitHint = canQueueDraft
    ? t('input.hintText.queue')
    : sendByCtrlEnter
      ? t('input.hintText.ctrlEnter')
      : t('input.hintText.enter');
  // While a run is in flight the primary button is Stop, as in Codex and
  // Cursor: there is no status strip above the composer, the run's progress
  // lives in the transcript, and Escape does the same thing as this button.
  // A typed draft does not take the button back: Enter queues it, and the
  // arrow beside Stop does the same for a click.
  const stopLabel = `${t('input.stop')} · Esc`;
  const queueDraft = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onSubmit(event);
  };

  return (
    <div data-composer-root="" className="chat-composer-shell relative shrink-0 px-2 pt-0 pb-2 sm:px-4 sm:pb-4 md:px-4 md:pb-6">
      {pendingPermissionRequests.length > 0 && (
        <div className="mx-auto mb-3 max-w-chat">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
          />
        </div>
      )}

      {pendingCommandGate && (
        <CommandGateCard
          text={pendingCommandGate.text}
          summary={pendingCommandGate.summary}
          classified={pendingCommandGate.classified}
          onConfirm={onConfirmCommandGate}
          onCancel={onCancelCommandGate}
        />
      )}

      {queuedDrafts.map((draft, index) => (
        <QueuedMessageCard
          key={`${index}:${draft.content}`}
          content={draft.content}
          imageCount={draft.images.length}
          pendingSteer={draft.pendingSteer}
          requiresReview={draft.requiresReview}
          position={index + 1}
          total={queuedDrafts.length}
          onEdit={() => onEditQueuedDraft(index)}
          onDelete={() => onDeleteQueuedDraft(index)}
          onMoveUp={index > 0 ? () => onMoveQueuedDraft(index, index - 1) : undefined}
          onMoveDown={index < queuedDrafts.length - 1 ? () => onMoveQueuedDraft(index, index + 1) : undefined}
        />
      ))}

      {draftPersistence?.phase === 'error' && onRetryDraftPersistence && (
        <div role="alert" className="mx-auto mb-2 flex max-w-chat items-center justify-between gap-2 rounded-md border border-destructive/30 p-2 text-xs text-destructive">
          <span>{t('input.draftPersistence.failed', { defaultValue: 'Draft saving failed. Keep this window open.' })} ({draftPersistence.reason})</span>
          <Button type="button" size="sm" variant="outline" onClick={() => { void onRetryDraftPersistence(); }}>
            {t('input.draftPersistence.retry', { defaultValue: 'Retry draft saving' })}
          </Button>
        </div>
      )}

      {isWorkspace && (
        <WorkspaceTargetChip
          workspaceRootName={workspaceRootName}
          candidates={workspaceCandidates}
          target={workspaceTarget}
          onPick={onPickWorkspaceTarget}
        />
      )}

      {!hasQuestionPanel && <div className="relative mx-auto max-w-chat">
        {showFileDropdown && filteredFiles.length > 0 && (
          <div className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md">
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        <PromptInput
          onSubmit={handleFormSubmit}
          status={isLoading ? 'streaming' : 'ready'}
          className={isTextareaExpanded ? 'chat-input-expanded' : undefined}
          {...getRootProps()}
        >
          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">Drop images here</p>
              </div>
            </div>
          )}
          {attachedImages.length > 0 && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedImages.map((file, index) => (
                    <ImageAttachment
                      key={index}
                      file={file}
                      onRemove={() => onRemoveImage(index)}
                      uploadProgress={uploadingImages.get(file.name)}
                      error={imageErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />

          <PromptInputBody>
            <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div className="chat-input-placeholder block w-full px-4 py-2 text-sm leading-6 wrap-break-word whitespace-pre-wrap text-transparent">
                {renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={attachInput}
              readOnly={sealed}
              dir="auto"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.currentTarget)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={placeholder}
            />
        </PromptInputBody>

        <PromptInputFooter className="flex-wrap items-end gap-y-1">
          {/*
            Wraps rather than clips. This row carries attach, voice, two model
            controls, skills and context usage; `overflow-hidden` meant a narrow
            viewport silently cut the trailing ones off with nothing to show
            that they existed. Wrapping costs a second line on narrow screens
            and keeps every control reachable. Keep metadata-dependent slots
            mounted so loading cannot reposition the controls; the action group
            can wrap separately when a split pane leaves too little room.
          */}
          <PromptInputTools className="min-w-32 flex-1 basis-0 flex-wrap gap-y-1">
            <PromptInputButton
              tooltip={{ content: t('input.attachImages') }}
              onClick={openImagePicker}
              disabled={composerFrozen}
              aria-label={t('input.attachImages')}
              className="shrink-0"
            >
              <PlusIcon />
            </PromptInputButton>

            {onVoiceTranscript && voiceAvailable && (
              <VoiceInputButton state={voiceState} onToggle={voiceToggle} errorMsg={voiceError} disabled={composerFrozen} />
            )}

            <ModelAndReasoningPicker
              value={modelPreset}
              currentModel={displayedModel}
              presetOptions={modelPresetOptions}
              modelOptions={modelOptions}
              availabilityKnown={availabilityKnown}
              loading={modelPresetsLoading}
              onSelect={onSelectModelPreset}
              reasoningEffort={reasoningEffort}
              onSelectReasoningEffort={onSelectReasoningEffort}
            />

            <AgentConfigurationPicker
              value={modelPreset}
              options={modelPresetOptions}
              loading={modelPresetsLoading}
              openTrigger={modelPickerOpenTrigger}
              iconOnly
              onSelect={onSelectModelPreset}
            />

            {permissions ? (
              <PermissionModePicker
                permissions={permissions}
                onSelectMode={onSelectPermissionMode}
                busy={permissionsBusy}
                className="w-28 shrink-0"
              />
            ) : <div className="h-8 w-28 shrink-0" aria-hidden />}

            <SkillPicker
              skills={skillCommands}
              onSelect={(skill, index) => onCommandSelect(skill, index, false)}
            />

            <ContextUsageBadge sessionState={sessionState} onClick={onShowTokenUsage} />

          </PromptInputTools>

          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
            {canSteer && (
              <PromptInputButton
                onClick={onSteer}
                disabled={composerFrozen}
                tooltip={{ content: t('input.queue.steerNow') }}
                aria-label={t('input.queue.steerNow')}
                className="shrink-0 rounded-full border border-border/70 bg-background/70 text-muted-foreground hover:border-primary/30 hover:text-foreground"
              >
                <ForwardIcon />
              </PromptInputButton>
            )}
            {canQueueDraft && (
              <PromptInputButton
                onClick={queueDraft}
                disabled={composerFrozen}
                tooltip={{ content: t('input.queue.sendNext') }}
                aria-label={t('input.queue.sendNext')}
                data-run-control="queue"
                className="shrink-0 rounded-full border border-border/70 bg-background/70 text-muted-foreground hover:border-primary/30 hover:text-foreground"
              >
                <ArrowUpIcon />
              </PromptInputButton>
            )}
            {isLoading ? (
              <Tooltip
                content={(
                  <span className="flex items-center gap-1.5">
                    {t('input.stop')}
                    <kbd className="rounded border border-border px-1 text-[10px]">Esc</kbd>
                  </span>
                )}
                position="top"
              >
                <PromptInputSubmit
                  status="streaming"
                  onClick={onAbortSession}
                  aria-label={stopLabel}
                  title={stopLabel}
                  data-run-control="stop"
                  className="h-10 w-10 bg-foreground text-background shadow-sm hover:bg-foreground/90 active:bg-foreground/80 sm:h-10 sm:w-10"
                />
              </Tooltip>
            ) : (
              <PromptInputSubmit
                status="ready"
                onClick={
                  isRecording
                    ? (e: MouseEvent<HTMLButtonElement>) => {
                        e.preventDefault();
                        voiceStop({ send: true });
                      }
                    : undefined
                }
                disabled={composerFrozen || (isRecording ? false : isVoiceBusy ? true : !input.trim())}
                aria-label={t('input.send')}
                title={t('input.send')}
                data-run-control="send"
                className="h-10 w-10 sm:h-10 sm:w-10"
              >
                {isVoiceBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUpIcon className="h-4 w-4" />
                )}
              </PromptInputSubmit>
            )}
          </div>
        </PromptInputFooter>
        {/* Opacity keeps the hint's space while typing. Give it its own row so
            even invisible translated text cannot squeeze the toolbar. */}
        {(canQueueDraft || sendByCtrlEnter) && (
          <div
            data-slot="prompt-input-submit-hint"
            className={`hidden min-w-0 px-3 pb-2 text-right text-xs wrap-anywhere text-muted-foreground/50 transition-opacity duration-200 lg:block ${
              input.trim() && !canQueueDraft ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {submitHint}
          </div>
        )}
      </PromptInput>
      </div>}
    </div>
  );
}
