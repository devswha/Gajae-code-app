import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangleIcon, InfoIcon, OctagonAlertIcon } from 'lucide-react';

import SessionProviderLogo from '../../llm-logo-provider/SessionProviderLogo';
import type {
  ChatMessage,
  Provider,
  ToolResult, CodeEditorDiffInfo 
} from '../types/types';
import { getIntrinsicMessageKey } from '../utils/messageKeys';
import { formatUsageLimitText } from '../utils/chatFormatting';
import { toolOutputDensityRules } from '../utils/toolOutputDensity';
import type { ToolOutputDensity } from '../utils/toolOutputDensity';
import type { Project } from '../../../types/app';
import { ToolRenderer, rendersResultInline, shouldHideToolResult } from '../tools';
import { Reasoning, ReasoningTrigger, ReasoningContent } from '../../../shared/view/ui';
import { authenticatedFetch } from '../../../utils/api';

import ChatMessageImages from './ChatMessageImages';
import { Markdown } from './Markdown';
import MessageCopyControl from './MessageCopyControl';
import MessageSpeakControl from './MessageSpeakControl';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

type MessageComponentProps = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: CodeEditorDiffInfo | null) => void;
  onShowSettings?: () => void;
  density?: ToolOutputDensity;
  showImagePreviews?: boolean;
  selectedProject?: Project | null;
  provider: Provider | string;
};

type InteractiveOption = {
  number: string;
  text: string;
  isSelected: boolean;
};

const COPY_HIDDEN_TOOL_NAMES = new Set(['Bash', 'Edit', 'Write', 'ApplyPatch']);

/**
 * System notices sit between chat turns as a quiet record of something the agent
 * did to the run itself — an interrupted response, a model fallback, a
 * compaction that rewrote history. A failed turn shares the row: an error is a
 * line of machine output, not a document, and the avatar-plus-name header it
 * used to carry made every failure taller than the answer it replaced.
 */
const NOTICE_STYLES = {
  info: {
    Icon: InfoIcon,
    container: 'border-border/60 bg-muted/40 text-muted-foreground',
    icon: 'text-muted-foreground',
  },
  warning: {
    Icon: AlertTriangleIcon,
    container: 'border-border bg-muted text-foreground',
    icon: 'text-primary',
  },
  error: {
    Icon: OctagonAlertIcon,
    container: 'border-destructive/30 bg-destructive/10 text-foreground',
    icon: 'text-destructive',
  },
} as const;

const MessageComponent = memo(({ message, prevMessage, createDiff, onFileOpen, density, showImagePreviews = true, selectedProject, provider }: MessageComponentProps) => {
  const densityRules = toolOutputDensityRules(density);
  // Remounting the cards on a level change is what discards the folds and
  // unfolds the reader made by hand under the previous level.
  const densityKey = density ?? 'balanced';
  // Every user message opens a new exchange. Marking that boundary is what
  // replaces the per-turn name rows: one rule, once, instead of a label on
  // every answer. The first message in a session has nothing to separate from.
  const startsExchange = message.type === 'user' && Boolean(prevMessage);

  // A transcript stored by another agent still needs its name; the live GJC
  // session does not, because every turn in it comes from the same agent.
  const isForeignProviderTurn = provider !== 'gjc' && message.type !== 'tool';
  const { t } = useTranslation('chat');
  const isGrouped = prevMessage && prevMessage.type === message.type &&
    ((prevMessage.type === 'assistant') ||
      (prevMessage.type === 'user') ||
      (prevMessage.type === 'tool') ||
      (prevMessage.type === 'error'));
  const messageRef = useRef<HTMLDivElement | null>(null);
  const userCopyContent = String(message.content || '');
  const formattedMessageContent = useMemo(
    () => formatUsageLimitText(String(message.content || '')),
    [message.content]
  );
  const assistantCopyContent = message.isLocalCommandStdout
    ? String(message.content || '')
    : message.isToolUse
    ? String(message.displayText || message.content || '')
    : formattedMessageContent;
  const isCommandOrFileEditToolResponse = Boolean(
    message.isToolUse && COPY_HIDDEN_TOOL_NAMES.has(String(message.toolName || ''))
  );
  const shouldShowUserCopyControl = message.type === 'user' && userCopyContent.trim().length > 0;
  const shouldShowAssistantCopyControl = message.type === 'assistant' &&
    assistantCopyContent.trim().length > 0 &&
    !isCommandOrFileEditToolResponse &&
    !message.isThinking;


  const formattedTime = useMemo(() => new Date(message.timestamp).toLocaleTimeString(), [message.timestamp]);
  const shouldHideThinkingMessage = Boolean(message.isThinking && !densityRules.showReasoning);

  const [fullToolResult, setFullToolResult] = useState<ToolResult | null>(null);
  const [isLoadingFullToolResult, setIsLoadingFullToolResult] = useState(false);
  const [fullToolResultError, setFullToolResultError] = useState(false);
  useEffect(() => {
    setFullToolResult(null);
    setIsLoadingFullToolResult(false);
    setFullToolResultError(false);
  }, [message.sessionId, message.toolId]);
  const effectiveToolResult = fullToolResult ?? message.toolResult;

  const loadFullToolResult = async () => {
    if (!message.sessionId || !message.toolId || isLoadingFullToolResult) return;
    setIsLoadingFullToolResult(true);
    setFullToolResultError(false);
    try {
      const params = new URLSearchParams({ toolId: message.toolId });
      const response = await authenticatedFetch(
        `/api/providers/sessions/${encodeURIComponent(message.sessionId)}/tool-result?${params}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;
      const result = data.toolResult as ToolResult | null | undefined;
      if (!result) {
        throw new Error('Missing tool result');
      }
      const content = typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content ?? '', null, 2);
      setFullToolResult({ ...result, content });
    } catch {
      setFullToolResultError(true);
    } finally {
      setIsLoadingFullToolResult(false);
    }
  };

  if (shouldHideThinkingMessage) {
    return null;
  }

  return (
    <div
      ref={messageRef}
      data-message-timestamp={message.timestamp || undefined}
      data-message-anchor={getIntrinsicMessageKey(message) ?? undefined}
      className={`chat-message group/turn ${message.type} ${isGrouped ? 'grouped' : ''} ${message.type === 'user' ? 'flex justify-end px-3 sm:px-0' : 'px-3 sm:px-0'} ${startsExchange ? 'mt-6 border-t border-border/40 pt-6' : ''}`}
    >
      {message.type === 'user' ? (
        /* User turn on the right. No avatar: one column of accent bubbles on the
           right already says who is speaking, and the badge only pushed the
           bubble inward on every desktop row. */
        <div className="flex w-full items-end sm:w-auto sm:max-w-[85%] md:max-w-md lg:max-w-lg xl:max-w-xl">
          <div className="flex min-w-0 flex-1 flex-col items-end gap-2 sm:flex-initial">
            {showImagePreviews && message.images && message.images.length > 0 && (
              <ChatMessageImages
                images={message.images}
                projectId={selectedProject?.projectId}
              />
            )}
            {userCopyContent.trim().length > 0 || !message.images?.length ? (
              <div className="group relative max-w-full rounded-2xl rounded-br-md bg-chat-bubble px-3 py-2 text-chat-bubble-foreground shadow-xs sm:px-4">
                <div dir="auto" className="text-base wrap-break-word whitespace-pre-wrap">
                  {message.content}
                </div>
                {/* Outside the bubble's flow: hidden with opacity it still held
                    its 20px row, so a one-line message sat in a 60px bubble of
                    which a third was invisible. Absolute keeps the bubble the
                    size of what was typed. */}
                <div className="pointer-events-none absolute top-full right-1 z-10 mt-0.5 flex items-center justify-end gap-1 text-[11px] whitespace-nowrap text-muted-foreground opacity-0 transition-opacity group-hover/turn:pointer-events-auto group-hover/turn:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
                  {shouldShowUserCopyControl && (
                    <MessageCopyControl content={userCopyContent} messageType="user" />
                  )}
                  <span>{formattedTime}</span>
                </div>
              </div>
            ) : (
              /* Image-only turn: no text bubble, but the timestamp still shows */
              <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                <span>{formattedTime}</span>
              </div>
            )}
          </div>
        </div>
      ) : message.isSystemNotice || message.type === 'error' ? (
        /* Run-level record (interrupt, fallback, compaction) or a failed turn */
        (() => {
          const level = message.type === 'error' ? 'error' : message.noticeLevel ?? 'info';
          const { Icon, container, icon } = NOTICE_STYLES[level];
          return (
            <div className="w-full py-0.5">
              <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${container}`} role="note">
                <Icon className={`mt-px h-3.5 w-3.5 shrink-0 ${icon}`} aria-hidden="true" />
                <span className="sr-only">{t(`messageTypes.notice.${level}`)}</span>
                <span dir="auto" className="max-h-80 min-w-0 overflow-auto wrap-break-word whitespace-pre-wrap">{message.content}</span>
              </div>
            </div>
          );
        })()
      ) : message.isTaskNotification ? (
        /* Compact task notification on the left */
        <div className="w-full">
          <div className="flex items-center gap-2 py-0.5">
            <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${message.taskStatus === 'completed' ? 'bg-muted-foreground' : 'bg-primary'}`} />
            <span className="text-xs text-muted-foreground">{message.content}</span>
          </div>
        </div>
      ) : (
        /* Claude/Tool messages on the left */
        <div className="w-full">
          {!isGrouped && isForeignProviderTurn && (
            /* A stored transcript from another agent says which agent it was. A
               live GJC answer does not: it is already identified by being prose
               on the left, opposite the user's blue bubbles, so its name and
               logo were a label nobody needed to read on every turn. */
            <div className="mb-2 flex items-center space-x-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-1 text-sm text-foreground">
                <SessionProviderLogo provider={provider} className="h-full w-full" />
              </div>
              <div className="text-sm font-medium text-foreground">
                {provider === 'cursor'
                  ? t('messageTypes.cursor')
                  : provider === 'codex'
                    ? t('messageTypes.codex')
                    : provider === 'opencode'
                      ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
                      : t('messageTypes.claude')}
              </div>
            </div>
          )}

          <div className="w-full">

            {message.isToolUse ? (
              <>
                <div className="flex flex-col">
                  <div className="flex flex-col">
                    <Markdown className="prose prose-base max-w-none dark:prose-invert [&_pre]:max-w-none [&_table]:max-w-none">
                      {String(message.displayText || '')}
                    </Markdown>
                  </div>
                </div>

                {message.toolInput && (
                  <ToolRenderer
                    key={densityKey}
                    toolName={message.toolName || 'UnknownTool'}
                    toolInput={message.toolInput}
                    toolResult={effectiveToolResult}
                    toolId={message.toolId}
                    mode="input"
                    onFileOpen={onFileOpen}
                    createDiff={createDiff}
                    selectedProject={selectedProject}
                    density={density}
                    rawToolInput={typeof message.toolInput === 'string' ? message.toolInput : undefined}
                    isSubagentContainer={message.isSubagentContainer}
                    subagentState={message.subagentState}
                  />
                )}

                {/* Tool Result Section - merged tools render their output inside the call block above. */}
                {effectiveToolResult && !(rendersResultInline(message.toolName || '') && message.toolInput) && !shouldHideToolResult(message.toolName || 'UnknownTool', effectiveToolResult) && (
                  effectiveToolResult.isError ? (
                    /* A failed tool is output, like Bash output: mono, dense,
                       height-capped. Rendered as a filled card of 16px prose it
                       took more of the transcript than the answer around it,
                       for a message that is usually one line long. */
                    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4 py-0.5 pl-2">
                      <div className="flex items-start gap-1.5">
                        <OctagonAlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
                        <span className="sr-only">{t('tools.error')}</span>
                        <pre dir="auto" className="max-h-80 min-w-0 flex-1 overflow-auto font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap text-destructive">
                          {String(effectiveToolResult.content || '')}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    // Non-error results - route through ToolRenderer (single source of truth)
                    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4">
                      <ToolRenderer
                        key={densityKey}
                        toolName={message.toolName || 'UnknownTool'}
                        toolInput={message.toolInput}
                        toolResult={effectiveToolResult}
                        toolId={message.toolId}
                        mode="result"
                        onFileOpen={onFileOpen}
                        createDiff={createDiff}
                        selectedProject={selectedProject}
                        density={density}
                      />
                    </div>
                  )
                )}
                {message.toolResultTruncated && !fullToolResult && (
                  <div className="mt-2 flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      className="rounded border border-border bg-muted/40 px-2.5 py-1 text-foreground hover:bg-muted disabled:opacity-60"
                      onClick={loadFullToolResult}
                      disabled={isLoadingFullToolResult}
                    >
                      {isLoadingFullToolResult
                        ? t('session.messages.loadingFullToolOutput')
                        : t('session.messages.loadFullToolOutput')}
                    </button>
                    {message.toolResultBytes && (
                      <span className="text-muted-foreground">
                        {(message.toolResultBytes / 1024).toFixed(0)} KB
                      </span>
                    )}
                    {fullToolResultError && (
                      <span className="text-destructive">
                        {t('session.messages.fullToolOutputFailed')}
                      </span>
                    )}
                  </div>
                )}
              </>
            ) : message.isInteractivePrompt ? (
              // Special handling for interactive prompts
              <div className="rounded-lg border border-border bg-muted p-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary">
                    <svg className="h-5 w-5 text-primary-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h4 className="mb-3 text-base font-semibold text-foreground">
                      {t('interactive.title')}
                    </h4>
                    {(() => {
                      const lines = (message.content || '').split('\n').filter((line) => line.trim());
                      const questionLine = lines.find((line) => line.includes('?')) || lines[0] || '';
                      const options: InteractiveOption[] = [];

                      // Parse the menu options
                      lines.forEach((line) => {
                        // Match lines like "❯ 1. Yes" or "  2. No"
                        const optionMatch = line.match(/[❯\s]*(\d+)\.\s+(.+)/);
                        if (optionMatch) {
                          const isSelected = line.includes('❯');
                          options.push({
                            number: optionMatch[1],
                            text: optionMatch[2].trim(),
                            isSelected
                          });
                        }
                      });

                      return (
                        <>
                          <p className="mb-4 text-sm text-foreground">
                            {questionLine}
                          </p>

                          {/* Option buttons */}
                          <div className="mb-4 space-y-2">
                            {options.map((option) => (
                              <button
                                key={option.number}
                                className={`w-full rounded-lg border-2 px-4 py-3 text-left transition-all ${option.isSelected
                                  ? 'border-primary bg-primary text-primary-foreground shadow-md'
                                  : 'border-border bg-card text-foreground'
                                  } cursor-not-allowed opacity-75`}
                                disabled
                              >
                                <div className="flex items-center gap-3">
                                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${option.isSelected
                                    ? 'bg-primary-foreground/20'
                                    : 'bg-secondary'
                                    }`}>
                                    {option.number}
                                  </span>
                                  <span className="flex-1 text-sm font-medium sm:text-base">
                                    {option.text}
                                  </span>
                                  {option.isSelected && (
                                    <span className="text-lg">❯</span>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>

                          <div className="rounded-lg bg-secondary p-3">
                            <p className="mb-1 text-sm font-medium text-foreground">
                              {t('interactive.waiting')}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {t('interactive.instruction')}
                            </p>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ) : message.isThinking ? (
              /* Thinking messages — Reasoning component (ai-elements pattern) */
              <Reasoning key={densityKey} defaultOpen={densityRules.reasoningOpen}>
                <ReasoningTrigger />
                <ReasoningContent>
                  <Markdown className="prose prose-base max-w-none dark:prose-invert [&_pre]:max-w-none [&_table]:max-w-none">
                    {message.content}
                  </Markdown>
                  <div className="mt-3 flex items-center text-[11px]">
                    <MessageCopyControl content={String(message.content || '')} messageType="assistant" />
                  </div>
                </ReasoningContent>
              </Reasoning>
            ) : (
              <div dir="auto" className="text-sm text-foreground">
                {/* Reasoning accordion */}
                {densityRules.showReasoning && message.reasoning && (
                  <Reasoning key={densityKey} className="mb-3" defaultOpen={densityRules.reasoningOpen}>
                    <ReasoningTrigger />
                    <ReasoningContent>
                      <div className="whitespace-pre-wrap">
                        {message.reasoning}
                      </div>
                    </ReasoningContent>
                  </Reasoning>
                )}

                {(() => {
                  if (message.isLocalCommandStdout) {
                    return (
                      <pre className="overflow-x-auto font-mono text-sm wrap-break-word whitespace-pre-wrap">
                        <code>{String(message.content || '')}</code>
                      </pre>
                    );
                  }

                  const content = formattedMessageContent;

                  // Detect if content is pure JSON (starts with { or [)
                  const trimmedContent = content.trim();
                  if ((trimmedContent.startsWith('{') || trimmedContent.startsWith('[')) &&
                    (trimmedContent.endsWith('}') || trimmedContent.endsWith(']'))) {
                    try {
                      const parsed = JSON.parse(trimmedContent);
                      const formatted = JSON.stringify(parsed, null, 2);

                      return (
                        <div className="my-2">
                          <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                            <span className="font-medium">{t('json.response')}</span>
                          </div>
                          <div className="overflow-hidden rounded-lg border border-border bg-muted">
                            <pre className="overflow-x-auto p-4">
                              <code className="block font-mono text-sm whitespace-pre text-foreground">
                                {formatted}
                              </code>
                            </pre>
                          </div>
                        </div>
                      );
                    } catch {
                      // Not valid JSON, fall through to normal rendering
                    }
                  }

                  // Normal rendering for non-JSON content
                  return message.type === 'assistant' ? (
                    <Markdown className="prose prose-base max-w-none dark:prose-invert [&_pre]:max-w-none [&_table]:max-w-none">
                      {content}
                    </Markdown>
                  ) : (
                    <div className="whitespace-pre-wrap">
                      {content}
                    </div>
                  );
                })()}
              </div>
            )}

            {(shouldShowAssistantCopyControl || !isGrouped) && (
              // The end of a turn: quiet, but always there. Hiding it entirely
              // removed the only mark saying where one answer stops and the
              // next begins, which left the transcript reading as one wall.
              <div className="mt-1.5 flex w-full items-center gap-2 text-[11px] text-muted-foreground/50 transition-colors group-hover/turn:text-muted-foreground">
                {shouldShowAssistantCopyControl && (
                  <MessageCopyControl content={assistantCopyContent} messageType="assistant" />
                )}
                {shouldShowAssistantCopyControl && (
                  <MessageSpeakControl content={assistantCopyContent} />
                )}
                {!isGrouped && <span>{formattedTime}</span>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default MessageComponent;
