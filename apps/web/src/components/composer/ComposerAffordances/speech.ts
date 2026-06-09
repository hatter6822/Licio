// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal, dependency-free typings for the Web Speech API (WS-B.2.11). The DOM
// lib does not ship `SpeechRecognition`/`webkitSpeechRecognition`, so we declare
// just the surface VoiceDictation needs and feature-detect at runtime. Voice is
// NEVER a hard dependency — when the constructor is absent the control degrades
// gracefully and text entry stays fully functional.

/** A single recognition alternative. */
export interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

/** One result, indexable by alternative; `isFinal` marks a committed phrase. */
export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternativeLike;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

/** The list of results delivered on a `result` event. */
export interface SpeechRecognitionResultListLike {
  readonly length: number;
  item(index: number): SpeechRecognitionResultLike;
  readonly [index: number]: SpeechRecognitionResultLike;
}

export interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

export interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}

/** The instance surface VoiceDictation drives. */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechCapableWindow {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

/**
 * Resolve the platform SpeechRecognition constructor, preferring the standard
 * name and falling back to the WebKit-prefixed one. Returns `undefined` when the
 * API is unavailable or there is no `window` (SSR / test without the global).
 */
export function getSpeechRecognition(): SpeechRecognitionConstructor | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const candidate = window as unknown as SpeechCapableWindow;
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition;
}
