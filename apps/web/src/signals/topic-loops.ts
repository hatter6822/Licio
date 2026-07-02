// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI v0 client-side topic-loop tracking (WS-H.6.1a/b, SPEC §11.3).
//
// The session topic sequence lives ENTIRELY in the browser (the same
// privacy philosophy as the attention signal pipeline): topic-cluster ids
// and timestamps only — no story ids, no content — capped at the bounded
// sequence length and persisted to sessionStorage so it dies with the
// session. Detection reuses the @licio/invariants mathematics verbatim
// (one source of truth with the server-side batch tier), and its result
// feeds the NON-BLOCKING wellbeing prompt only.
//
// "Reset topic history" (WS-H.6.1c-2 / PHI-4) clears this state without
// touching the account or any contribution.

import {
  appendTransition,
  DEFAULT_NARROW_LOOP_CONFIG,
  detectCompulsiveSession,
  detectNarrowLoop,
  type NarrowLoopDetection,
  type TopicTransition,
} from '@licio/invariants';

const STORAGE_KEY = 'licio.topic-sequence.v1';
const SEQUENCE_CAP = 200;
/** Per-topic-cluster narrow-loop prompt dismissals for the SESSION (dies with
 *  it, same as the sequence). Prevents the prompt re-nagging on every story in
 *  the same loop after the reader has already dismissed it once. */
const DISMISSED_KEY = 'licio.loop-dismissed.v1';

function readDismissed(storage: Storage): Set<string> {
  try {
    const raw = storage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

function readSequence(storage: Storage): TopicTransition[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is TopicTransition =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as TopicTransition).topicClusterId === 'string' &&
        typeof (entry as TopicTransition).atMs === 'number',
    );
  } catch {
    return [];
  }
}

function writeSequence(storage: Storage, sequence: TopicTransition[]): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(sequence));
  } catch {
    // Storage full/unavailable: tracking degrades silently (wellbeing
    // prompts are best-effort; nothing else depends on this state).
  }
}

export interface TopicLoopAssessment {
  narrowLoop: NarrowLoopDetection;
  compulsive: boolean;
}

export class TopicLoopTracker {
  readonly #storage: Storage;
  readonly #now: () => number;

  constructor(storage: Storage = sessionStorage, now: () => number = Date.now) {
    this.#storage = storage;
    this.#now = now;
  }

  /** Record a topic-context visit (topic-cluster id only — never a story id). */
  recordVisit(topicClusterId: string): void {
    if (!topicClusterId) return;
    const sequence = readSequence(this.#storage);
    writeSequence(
      this.#storage,
      appendTransition(sequence, { topicClusterId, atMs: this.#now() }, SEQUENCE_CAP),
    );
  }

  /** Current loop assessment (pure read; never blocks anything). */
  assess(): TopicLoopAssessment {
    const sequence = readSequence(this.#storage);
    return {
      narrowLoop: detectNarrowLoop(sequence, this.#now(), DEFAULT_NARROW_LOOP_CONFIG),
      compulsive: detectCompulsiveSession(sequence).detected,
    };
  }

  /** Record that the reader dismissed the narrow-loop prompt for this topic
   *  cluster — session-scoped, so it does not re-nag on the next story in the
   *  same loop (WS-H.6.1c: a soft, non-repeating intervention). */
  dismissPrompt(topicClusterId: string): void {
    if (!topicClusterId) return;
    const dismissed = readDismissed(this.#storage);
    dismissed.add(topicClusterId);
    try {
      this.#storage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
    } catch {
      // Storage full/unavailable: the prompt may re-show (best-effort).
    }
  }

  /** Whether the narrow-loop prompt for this topic cluster was dismissed this
   *  session (empty/absent id ⇒ never dismissed). */
  isPromptDismissed(topicClusterId: string | null | undefined): boolean {
    if (!topicClusterId) return false;
    return readDismissed(this.#storage).has(topicClusterId);
  }

  /** PHI-4: clear the topic-sequence state. Touches nothing else. */
  reset(): void {
    try {
      this.#storage.removeItem(STORAGE_KEY);
      this.#storage.removeItem(DISMISSED_KEY);
    } catch {
      // Already unavailable — nothing to clear.
    }
  }
}

let singleton: TopicLoopTracker | undefined;

/** The app-wide tracker (sessionStorage-backed; lazily constructed). */
export function getTopicLoopTracker(): TopicLoopTracker {
  if (!singleton) singleton = new TopicLoopTracker();
  return singleton;
}

/** Test hook: reset the module singleton. */
export function resetTopicLoopTrackerForTests(): void {
  singleton = undefined;
}
