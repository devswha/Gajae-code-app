import { useTranslation } from 'react-i18next';
import { Mic, Square, Loader2 } from 'lucide-react';

import { PromptInputButton } from '../../../shared/view/ui';
import type { VoiceInputState } from '../hooks/useVoiceInput';

type Props = {
  state: VoiceInputState;
  onToggle: () => void;
  errorMsg?: string | null;
  disabled?: boolean;
};

// Push-to-talk mic button (presentational). Recording state and the stop-and-send action
// are owned by the composer so the main Send button can drive them too. This button just
// starts recording and, while recording, stops and drops the transcript into the input box.
export default function VoiceInputButton({ state, onToggle, errorMsg, disabled = false }: Props) {
  const { t } = useTranslation('chat');

  const icon =
    state === 'recording' ? (
      <Square className="text-destructive" />
    ) : state !== 'idle' ? (
      <Loader2 className="animate-spin" />
    ) : (
      <Mic />
    );

  return (
    <span className="relative inline-flex shrink-0">
      {errorMsg && (
        <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 rounded bg-destructive px-2 py-1 text-xs whitespace-nowrap text-destructive-foreground shadow-lg">
          {errorMsg}
        </span>
      )}
      <PromptInputButton
        disabled={state !== 'recording' && (disabled || state !== 'idle')}
        aria-label={state === 'recording' ? t('voice.stopRecording') : t('voice.input')}
        tooltip={{ content: state === 'recording' ? t('voice.stopRecording') : t('voice.input') }}
        onClick={(e: { preventDefault: () => void }) => {
          e.preventDefault();
          onToggle();
        }}
      >
        {icon}
      </PromptInputButton>
    </span>
  );
}
