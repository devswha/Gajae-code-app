import { useEffect, useRef, useState } from 'react';

import { beginComposerOperation } from '../../../shared/composerFreeze';
import { transcribeVoice } from '../../../utils/voiceApi';

const RECORDING_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function recordingType(): string {
  if (typeof MediaRecorder === 'undefined') return '';

  for (const candidate of RECORDING_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // Some browser implementations throw while probing a type.
    }
  }

  return '';
}

function extensionFor(type: string): string {
  if (type.includes('mp4')) return 'm4a';
  return type.includes('ogg') ? 'ogg' : 'webm';
}

export type VoiceInputState = 'idle' | 'starting' | 'recording' | 'stopping' | 'transcribing';
type Recording = { phase: VoiceInputState; stop(send?: boolean): void; depart(): void };

export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void | Promise<void>,
  onError?: (msg: string) => void,
  ownerKey = '',
) {
  const [state, setState] = useState<VoiceInputState>('idle');
  const recording = useRef<Recording | null>(null);
  const owner = useRef<object | null>(null);

  useEffect(() => {
    const visit = {};
    owner.current = visit;
    setState('idle');
    return () => {
      owner.current = null;
      const prior = recording.current;
      recording.current = null;
      // Stop capturing on departure, but retain the operation through the
      // recorder's final data/stop events and any already accepted HTTP work.
      // A pending permission request cannot be cancelled: its promise owns it.
      prior?.depart();
    };
  }, [ownerKey]);

  async function begin() {
    const visit = owner.current;
    if (!visit || recording.current) return;
    const finishOperation = beginComposerOperation('voice');
    if (!finishOperation) return;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let sendWhenDone = false;
    let finished = false;
    const session: Recording = { phase: 'starting', stop, depart() { stop(); releaseMicrophone(); } };
    const isVisible = () => owner.current === visit && recording.current === session;
    const report = (message: string) => { if (isVisible()) onError?.(message); };
    const releaseMicrophone = () => { stream?.getTracks().forEach((track) => track.stop()); stream = null; };
    const phase = (next: VoiceInputState) => { session.phase = next; if (isVisible()) setState(next); };
    const finish = () => {
      if (finished) return;
      finished = true;
      releaseMicrophone();
      if (recorder) { recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null; }
      chunks = [];
      phase('idle');
      if (recording.current === session) recording.current = null;
      finishOperation();
    };
    function stop(send = false) {
      if (finished || session.phase !== 'recording' || !recorder || recorder.state === 'inactive') return;
      sendWhenDone = send;
      phase('stopping');
      try { recorder.stop(); } catch (error) {
        // A failed stop request is not evidence that recording finished. Keep
        // its actual owner, report the failure, and allow a real Stop retry.
        phase('recording');
        report(`Recording could not stop: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    recording.current = session;
    phase('starting');

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      if (!isVisible()) {
        finish();
        return;
      }
      const type = recordingType();
      recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);

      recorder.ondataavailable = ({ data }) => {
        if (!finished && data.size > 0) chunks.push(data);
      };

      recorder.onstop = async () => {
        if (finished || session.phase === 'transcribing') return;
        releaseMicrophone();
        phase('transcribing');
        const recordedType = recorder?.mimeType || 'audio/webm';
        const audio = new Blob(chunks, { type: recordedType });
        try {
          if (audio.size < 800) { report('Recording too short'); return; }
          const response = await transcribeVoice(audio, `recording.${extensionFor(recordedType)}`);
          if (!response.ok) throw new Error(`transcribe ${response.status}`);

          const payload = await response.json();
          const transcript = String(payload?.text || '').trim();
          // Capture the original delivery callback at begin(), not a newer
          // route's callback. Offscreen completion saves input but never sends.
          if (transcript) await onTranscript(transcript, isVisible() && sendWhenDone);
          else report('No speech detected');
        } catch (error) {
          report(`Transcription failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          finish();
        }
      };
      recorder.onerror = () => {
        report('Recording failed.');
        // MediaRecorder supplies final data and a stop event after an error.
        // Do not release admission before that terminal event arrives.
        stop();
      };

      recorder.start();
      phase('recording');
    } catch (error) {
      const microphoneError = error as { name?: string; message?: string };
      let message = `Mic error: ${microphoneError?.message || error}`;
      if (microphoneError?.name === 'NotAllowedError') message = 'Microphone access denied.';
      else if (microphoneError?.name === 'NotFoundError') message = 'No microphone found.';
      try { report(message); } finally { finish(); }
    }
  }
  const stop = (opts?: { send?: boolean }) => recording.current?.stop(opts?.send);
  const toggle = () => { if (!recording.current) void begin(); else recording.current.stop(); };

  return { state, toggle, stop };
}
