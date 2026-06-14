// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Voice dictation for composer body fields (WS-G.3.7d, SPEC §6.6).  Renders
// ONLY when the Web Speech API exists (graceful absence otherwise — no
// button, no error).  While recording, a clearly-labeled pulsing indicator
// shows "Listening…"; interim results stream to the live preview and the
// FINAL transcript is appended through `onAppend`.  No privacy claim is made
// about the audio: the browser may use a remote recognition service — that
// is the browser's documented behavior, not Licio's pipeline.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button/index.js';
import { Icon } from '../ui/Icon/index.js';

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Feature detection (WS-G.3.7d acceptance: button only when available). */
export function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface VoiceDictationProps {
  /** Receives the FINAL transcript chunk to append at the cursor. */
  onAppend: (text: string) => void;
  /** Field name for the accessible label. */
  fieldLabel: string;
}

export function VoiceDictation({
  onAppend,
  fieldLabel,
}: VoiceDictationProps): React.ReactElement | null {
  const t = useT();
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(
    () => () => {
      recognitionRef.current?.stop();
    },
    [],
  );

  const Ctor = speechRecognitionCtor();
  if (Ctor === null) return null; // graceful absence — no button, no error

  const stop = (): void => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
    setInterim('');
  };

  const start = (): void => {
    const recognition = new Ctor();
    recognition.lang = typeof navigator !== 'undefined' ? navigator.language : 'en';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      let interimText = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        if (result.isFinal) {
          onAppend(result[0].transcript);
        } else {
          interimText += result[0].transcript;
        }
      }
      setInterim(interimText);
    };
    recognition.onend = () => {
      setListening(false);
      setInterim('');
      recognitionRef.current = null;
    };
    recognition.onerror = () => stop();
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        onClick={listening ? stop : start}
        aria-pressed={listening}
        aria-label={
          listening
            ? t('dictation.stop', 'Stop dictating into {field}', { field: fieldLabel })
            : t('dictation.start', 'Dictate into {field}', { field: fieldLabel })
        }
      >
        <Icon name="mic" className="size-4" aria-hidden="true" />
        {listening ? t('dictation.stopShort', 'Stop') : t('dictation.startShort', 'Dictate')}
      </Button>
      {listening ? (
        <span className="flex items-center gap-2 text-sm text-ink-muted" aria-live="polite">
          <span
            className="inline-block size-2 animate-pulse rounded-full bg-error"
            aria-hidden="true"
          />
          {t('dictation.listening', 'Listening…')}
          {interim ? <span className="italic">{interim}</span> : null}
        </span>
      ) : null}
    </div>
  );
}
