// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI v0 client-side topic-loop tracking (WS-H.6.1a/b, SPEC §11.3/§11.6).
//
// The session topic sequence lives ENTIRELY in the browser (the same
// privacy philosophy as the attention signal pipeline): topic-cluster ids
// and timestamps only — no story ids, no content — capped at the bounded
// sequence length and persisted to sessionStorage so it dies with the
// session. Detection reuses the @licio/invariants mathematics verbatim
// (one source of truth with the server-side batch tier).
//
// The recorded sequence drives the CLIENT-SIDE topic-frequency dampener
// (topic-dampening.ts): a topic the reader is circling is shown steadily less
// often in the front-page feed, down to a non-zero floor (a quiet, self-
// correcting nudge — NOT an interrupting prompt), and the quiet-notification
// policy for a strongly-circled topic.
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
import { isSentinelTopicId } from '@licio/shared';
import { CIRCLING_QUIET_MULTIPLIER, computeTopicMultipliers } from './topic-dampening.js';

const STORAGE_KEY = 'licio.topic-sequence.v1';
const SEQUENCE_CAP = 200;

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

  /** Record a topic-context visit (topic-cluster id only — never a story id).
   *  The UNCLASSIFIED sentinel is NEVER recorded: an unclassified story has no
   *  known topic, so it must never contribute to "circling one topic" (that is
   *  exactly the false-positive a shared placeholder topic would cause). */
  recordVisit(topicClusterId: string): void {
    if (!topicClusterId || isSentinelTopicId(topicClusterId)) return;
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

  /** Per-topic feed display multipliers ∈ [floor, 1) for topics the reader is
   *  circling (topics with no dampening are omitted). The front-page feed uses
   *  these to show a circled topic less often; the score decays over time, so a
   *  reader who moves on recovers that topic's normal frequency. */
  topicMultipliers(nowMs: number = this.#now()): Map<string, number> {
    return computeTopicMultipliers(readSequence(this.#storage), nowMs);
  }

  /** Whether a topic is being circled ENOUGH to warrant the quiet-notification
   *  policy (its display multiplier is at/below {@link CIRCLING_QUIET_MULTIPLIER}).
   *  The sentinel is never circling (it is never recorded). */
  isCircling(topicClusterId: string | null | undefined, nowMs: number = this.#now()): boolean {
    if (!topicClusterId || isSentinelTopicId(topicClusterId)) return false;
    const multiplier = this.topicMultipliers(nowMs).get(topicClusterId);
    return multiplier !== undefined && multiplier <= CIRCLING_QUIET_MULTIPLIER;
  }

  /** PHI-4: clear the topic-sequence state. Touches nothing else. */
  reset(): void {
    try {
      this.#storage.removeItem(STORAGE_KEY);
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
