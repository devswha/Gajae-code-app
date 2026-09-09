import { useTranslation } from 'react-i18next';
import { memo, useMemo, useState } from 'react';
import type { RefObject } from 'react';

import type { ChatMessage, CodeEditorDiffInfo  } from '../types/types';
import type {
  Project,
  ProjectSession,
  LLMProvider,
} from '../../../types/app';
import { assignMessageKeys } from '../utils/messageKeys';
import { reconcilePaneItemIdentities } from '../utils/paneItemIdentity';
import type { LiveActivity } from '../utils/toolActivity';
import { isToolGroupItem } from '../utils/toolGrouping';
import { DEFAULT_TOOL_OUTPUT_DENSITY, toolOutputDensityRules } from '../utils/toolOutputDensity';
import type { ToolOutputDensity } from '../utils/toolOutputDensity';
import { buildPaneList, isTurnWorkBlockItem } from '../utils/turnWork';
import type { PaneListItem } from '../utils/turnWork';

import ChatScrollAnchor from './ChatScrollAnchor';
import GroupedMessageList from './GroupedMessageList';
import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';
import RunningActivityRow from './RunningActivityRow';
import ToolGroupContainer from './ToolGroupContainer';
import TurnWorkBlock from './TurnWorkBlock';
import LoadAllMessagesOverlay from './LoadAllMessagesOverlay';

/** The transcript message a list item ends with, so the next row knows what preceded it; null for an empty block. */
function lastMessageOf(item: PaneListItem): ChatMessage | null {
  if (isTurnWorkBlockItem(item) || isToolGroupItem(item)) return item.messages[item.messages.length - 1] ?? null;
  return item;
}

interface ChatMessagesPaneProps {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  preserveScrollPosition?: boolean;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** What the in-flight run is doing now; the running turn's work block (or bare running row) shows it. */
  liveActivity?: LiveActivity | null;
  /** When the in-flight run started (client clock), for the running row's elapsed time. */
  runStartedAt?: number | null;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  isLoadingMoreMessages: boolean;
  historyLoadError?: boolean;
  retryOlderMessages?: () => void;
  hasMoreMessages: boolean;
  totalMessages: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: CodeEditorDiffInfo | null) => void;
  onShowSettings?: () => void;
  density?: ToolOutputDensity;
  showImagePreviews?: boolean;
  selectedProject: Project;
}

function ChatMessagesPane({
  scrollContainerRef,
  preserveScrollPosition = false,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  liveActivity = null,
  runStartedAt = null,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  isLoadingMoreMessages,
  historyLoadError = false,
  retryOlderMessages,
  hasMoreMessages,
  totalMessages,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onFileOpen,
  onShowSettings,
  density = DEFAULT_TOOL_OUTPUT_DENSITY,
  showImagePreviews = true,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const displayProvider = selectedSession?.provider ?? selectedSession?.__provider ?? provider;
  // Realtime rows can outgrow the last persisted count; that total then says
  // nothing about how many older messages remain to be loaded.
  const canShowTotal = totalMessages > 0 && chatMessages.length <= totalMessages;
  // The live turn has a block from the moment it starts (empty until its first
  // call), so the run's status has one place in the transcript. Where blocks
  // are off, a bare running row stands in that place instead.
  const paneItems = useMemo(
    () => buildPaneList(visibleMessages, density, { running: isProcessing }),
    [visibleMessages, density, isProcessing],
  );
  const densityRules = toolOutputDensityRules(density);
  const showInlineRunningRow = isProcessing && !densityRules.workBlock;

  // Keys for the top-level items; each fold assigns its own inside. The key
  // function is not handed down: it is new whenever the list changes, which
  // is every streamed delta, and a prop that changes every delta would make
  // every folded block below re-render for an answer streaming above it.
  const getMessageKey = useMemo(() => assignMessageKeys(visibleMessages), [visibleMessages]);
  const sessionKey = selectedSession?.id ?? currentSessionId;
  const [identityState, setIdentityState] = useState(() => ({
    paneItems,
    density,
    sessionKey,
    identities: reconcilePaneItemIdentities(paneItems, density, getMessageKey),
  }));
  let paneIdentities = identityState.identities;
  if (identityState.paneItems !== paneItems || identityState.density !== density || identityState.sessionKey !== sessionKey) {
    paneIdentities = reconcilePaneItemIdentities(
      paneItems,
      density,
      getMessageKey,
      identityState.sessionKey === sessionKey ? identityState.identities : [],
    );
    // Render-state reconciliation is discarded with an abandoned render; a
    // mutable ref/map updated during rendering could leak uncommitted keys.
    setIdentityState({ paneItems, density, sessionKey, identities: paneIdentities });
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollContainerRef}
        onWheel={onWheel}
        onTouchMove={onTouchMove}
        className="chat-messages-pane relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-3 pb-3 sm:pt-4 sm:pb-4"
      >
        <ChatScrollAnchor scrollContainerRef={scrollContainerRef} sessionKey={sessionKey} enabled={preserveScrollPosition}>
          <div className="mx-auto w-full max-w-chat space-y-3 px-4 sm:space-y-4">
            {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
              <div className="mt-8 text-center text-muted-foreground">
                <div className="flex items-center justify-center space-x-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-border" />
                  <p>{t('session.loading.sessionMessages')}</p>
                </div>
              </div>
            ) : chatMessages.length === 0 ? (
              <ProviderSelectionEmptyState
                selectedSession={selectedSession}
                currentSessionId={currentSessionId}
              />
            ) : (
              <>
                {(hasMoreMessages || chatMessages.length > visibleMessageCount) && !isLoadingAllMessages && !historyLoadError ? (
                  <div data-history-controls className="border-b border-border py-2 text-center text-sm text-muted-foreground">
                    <button className="text-primary underline hover:text-primary" onClick={loadEarlierMessages}>
                      {t('session.messages.loadEarlier')}
                    </button>
                    {' | '}
                    <button className="text-primary underline hover:text-primary" onClick={loadAllMessages}>
                      {t('session.messages.loadAll')}
                    </button>
                  </div>
                ) : null}

                {paneItems.map((item, index) => {
                  // Hidden thoughts never had a row; an empty wrapper would
                  // introduce spacing and a non-visible scroll anchor for them.
                  if (!isTurnWorkBlockItem(item) && !isToolGroupItem(item) && item.isThinking && !densityRules.showReasoning) return null;
                  const before = index > 0 ? lastMessageOf(paneItems[index - 1]) : null;
                  const stablePaneKey = paneIdentities[index].key;
                  const renderProps = {
                    prevMessage: before,
                    createDiff,
                    onFileOpen,
                    onShowSettings,
                    density,
                    showImagePreviews,
                    selectedProject,
                    provider: displayProvider,
                  };
                  return (
                    <div key={stablePaneKey} data-scroll-anchor={stablePaneKey} className="flow-root">
                      {isTurnWorkBlockItem(item) ? (
                        <TurnWorkBlock
                          block={item}
                          running={isProcessing && item.isTail}
                          liveActivity={liveActivity}
                          runStartedAt={runStartedAt}
                          {...renderProps}
                        />
                      ) : isToolGroupItem(item) ? (
                        <ToolGroupContainer group={item} {...renderProps} />
                      ) : (
                        <GroupedMessageList items={[item]} {...renderProps} />
                      )}
                    </div>
                  );
                })}

                {showInlineRunningRow && (
                  <div data-scroll-anchor={`running-${density}`} className="flow-root">
                    <RunningActivityRow liveActivity={liveActivity} runStartedAt={runStartedAt} variant="inline" />
                  </div>
                )}
              </>
            )}
          </div>
        </ChatScrollAnchor>
      </div>
      {historyLoadError && (
        <div role="alert" className="absolute top-2 right-0 left-0 z-20 flex justify-center">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground shadow-xs">
            <span>{t('session.loading.olderMessagesFailed')}</span>
            <button type="button" className="text-primary underline" onClick={retryOlderMessages}>
              {t('session.loading.retry')}
            </button>
          </div>
        </div>

      )}
      {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
        <div data-pagination-status role="status" className="pointer-events-none absolute top-2 right-0 left-0 z-20 flex justify-center">
          <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-xs">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-primary" />
            <span>{t('session.loading.olderMessages')}</span>
          </div>
        </div>
      )}
      {chatMessages.length > 0 && (
        <LoadAllMessagesOverlay
          showLoadAllOverlay={showLoadAllOverlay}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          totalMessages={canShowTotal ? totalMessages : 0}
          onLoadAllMessages={loadAllMessages}
        />
      )}
    </div>
  );
}

export default memo(ChatMessagesPane);
