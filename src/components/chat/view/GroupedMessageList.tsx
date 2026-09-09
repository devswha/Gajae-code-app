import { useState } from 'react';
import type { ReactNode } from 'react';

import type { ChatMessage, CodeEditorDiffInfo, Provider } from '../types/types';
import type { Project } from '../../../types/app';
import { assignMessageKeys } from '../utils/messageKeys';
import { reconcilePaneItemIdentities } from '../utils/paneItemIdentity';
import { isToolGroupItem } from '../utils/toolGrouping';
import type { MessageListItem } from '../utils/toolGrouping';
import { DEFAULT_TOOL_OUTPUT_DENSITY } from '../utils/toolOutputDensity';
import type { ToolOutputDensity } from '../utils/toolOutputDensity';

import MessageComponent from './MessageComponent';
import ToolGroupContainer from './ToolGroupContainer';

type DiffLine = { type: string; content: string; lineNum: number };

export interface MessageRenderProps {
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: CodeEditorDiffInfo | null) => void;
  onShowSettings?: () => void;
  density?: ToolOutputDensity;
  showImagePreviews?: boolean;
  selectedProject?: Project | null;
  provider: Provider | string;
}

interface GroupedMessageListProps extends MessageRenderProps {
  items: MessageListItem[];
  /** The message rendered just before this list, for turn boundaries and grouping. */
  prevMessage: ChatMessage | null;
}

/**
 * Renders a grouped message list - same-tool groups as one row, everything
 * else as its own message - threading `prevMessage` through so each row knows
 * what came before it. The pane and the turn's work block share this so the
 * cards inside a folded turn are exactly the cards the pane would have shown.
 */
export default function GroupedMessageList({ items, prevMessage, ...renderProps }: GroupedMessageListProps) {
  const { density = DEFAULT_TOOL_OUTPUT_DENSITY } = renderProps;
  const getMessageKey = assignMessageKeys(items.flatMap((item) => (isToolGroupItem(item) ? item.messages : [item])));
  const [identityState, setIdentityState] = useState(() => ({
    items,
    density,
    identities: reconcilePaneItemIdentities(items, density, getMessageKey),
  }));
  let identities = identityState.identities;
  if (identityState.items !== items || identityState.density !== density) {
    identities = reconcilePaneItemIdentities(items, density, getMessageKey, identityState.identities);
    setIdentityState({ items, density, identities });
  }
  const rendered: ReactNode[] = [];
  let previous = prevMessage;

  for (const [index, item] of items.entries()) {
    const before = previous;
    if (isToolGroupItem(item)) {
      previous = item.messages[item.messages.length - 1] || previous;
      rendered.push(
        <ToolGroupContainer
          key={identities[index].key}
          group={item}
          prevMessage={before}
          {...renderProps}
        />,
      );
      continue;
    }

    previous = item;
    rendered.push(
      <MessageComponent
        key={identities[index].key}
        message={item}
        prevMessage={before}
        createDiff={renderProps.createDiff}
        onFileOpen={renderProps.onFileOpen}
        onShowSettings={renderProps.onShowSettings}
        density={density}
        showImagePreviews={renderProps.showImagePreviews}
        selectedProject={renderProps.selectedProject}
        provider={renderProps.provider}
      />,
    );
  }

  return rendered;
}
