// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Voice dictation affordance (WS-B.2.11). A toggle button (aria-pressed) backed
// by the Web Speech API. When the API is unavailable the control is disabled
// with an explanatory note — voice is an aid, never a hard dependency, and text
// entry remains fully functional. Interim and final transcripts are announced in
// an aria-live="polite" region so screen-reader users hear what was captured.
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';
import { getSpeechRecognition, type SpeechRecognitionLike } from './speech.js';

export interface VoiceDictationProps {
  /** Receives each finalized transcript chunk to append to the target field. */
  onTranscript?: (text: string) => void;
  /** BCP-47 language for recognition (defaults to the document language). */
  lang?: string;
  className?: string;
}

export function VoiceDictation({
  onTranscript,
  lang,
  className,
}: VoiceDictationProps): React.ReactElement {
  const t = useT();
  const noteId = useId();

  // Resolve support during the first render via a lazy initializer. This is
  // SSR-safe — `getSpeechRecognition()` returns undefined when there is no
  // `window` — and, on the client, it means a supporting browser shows the live
  // control immediately instead of flashing the "unavailable" note for one frame
  // before a mount effect corrects it.
  const [supported] = useState(() => getSpeechRecognition() !== undefined);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Abort any in-flight recognition if the component unmounts mid-session.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  const stop = (): void => {
    recognitionRef.current?.stop();
  };

  const start = (): void => {
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      return;
    }
    const recognition = new Recognition();
    // Truthy fallbacks: `document.documentElement.lang` is '' (not null) when
    // unset, so `??` would leave recognition with an empty language.
    recognition.lang = lang || document.documentElement.lang || 'en';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) {
          continue;
        }
        const alternative = result[0];
        const transcript = alternative ? alternative.transcript : '';
        if (result.isFinal) {
          onTranscript?.(transcript);
        } else {
          interimText += transcript;
        }
      }
      setInterim(interimText);
    };

    recognition.onerror = () => {
      setListening(false);
      setInterim('');
    };

    recognition.onend = () => {
      setListening(false);
      setInterim('');
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  const toggle = (): void => {
    if (listening) {
      stop();
    } else {
      start();
    }
  };

  if (!supported) {
    // Degrade gracefully: a disabled control plus a note explaining why. Text
    // entry is unaffected, so this is informational, not an error.
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <Button
          type="button"
          variant="ghost"
          disabled
          aria-describedby={noteId}
          aria-pressed={false}
        >
          <Icon name="mic" className="size-4" />
          {t('composer.voice.label', 'Dictate')}
        </Button>
        <p id={noteId} className="flex items-center gap-1 text-sm text-ink-muted">
          <Icon name="circle-info" className="size-4" />
          <span>
            {t(
              'composer.voice.unavailable',
              'Voice dictation is not available in this browser. You can still type your contribution.',
            )}
          </span>
        </p>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Button
        type="button"
        variant={listening ? 'primary' : 'ghost'}
        aria-pressed={listening}
        onClick={toggle}
      >
        <Icon name="mic" className="size-4" />
        {listening
          ? t('composer.voice.stop', 'Stop dictation')
          : t('composer.voice.label', 'Dictate')}
      </Button>

      {/* Live transcript: interim text is announced politely as it arrives;
          finalized text is appended to the field by the parent. */}
      <p className="sr-only" aria-live="polite">
        {listening && interim
          ? t('composer.voice.transcript', 'Transcribing: {text}', { text: interim })
          : ''}
      </p>
    </div>
  );
}
