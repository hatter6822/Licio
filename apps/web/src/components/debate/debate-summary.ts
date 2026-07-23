// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T live-debate discovery — the PURE list model shared by the story's two
// discovery surfaces: the compact trigger (how many debates are live, and how
// soon the next deadline falls) and the live-debates modal (search + sort over
// the short summaries).  No React and no i18n here, so ONE definition of "which
// deadline is this debate counting down to" and "what order do the rows come
// in" backs both surfaces — and each is unit-testable on its own.
//
// STORY CHALLENGES PIN FIRST.  A correction aimed at the story itself disputes
// the ground everything else is standing on, so it leads every ordering: the
// pin is the comparator's primary key, which no sort mode can outrank, and the
// modal reinforces it structurally with its own leading group.
//
// Strictly no-applause: nothing here ranks a debate by popularity, engagement,
// or any member signal — the orders are deadline, recency, and subject only.
import type { DebateArenaSummary } from '@licio/shared';

/** Which deadline a debate is counting down to, derived from its state. */
export type DebateDeadlineKind = 'edit' | 'resolve' | 'override';

export interface DebateDeadline {
  kind: DebateDeadlineKind;
  /** The ISO instant the countdown runs to. */
  at: string;
}

/**
 * The ONE live deadline a debate is counting down to, or null when it is
 * waiting on something with no clock the reader can watch:
 *
 * - `open`    → the editing window closes (`edit_deadline_at`);
 * - `locked`  → the material is frozen, AI resolution is due (`resolve_due_at`);
 * - `judged`  → the steward's override window closes, when one is still open;
 * - otherwise → queued for adjudication / already terminal: no countdown.
 */
export function debateDeadline(debate: DebateArenaSummary): DebateDeadline | null {
  switch (debate.state) {
    case 'open':
      return { kind: 'edit', at: debate.edit_deadline_at };
    case 'locked':
      return { kind: 'resolve', at: debate.resolve_due_at };
    case 'judged':
      return debate.override_deadline_at === null
        ? null
        : { kind: 'override', at: debate.override_deadline_at };
    default:
      return null;
  }
}

/**
 * A coarse "2h 5m" / "<1m" duration to a deadline; null once it has passed (or
 * if the instant is unparseable — a missing countdown, never a "NaNh" one).
 * The caller owns the surrounding phrasing ("… left", "AI resolution in …"),
 * so one duration format serves every countdown line.
 */
export function remainingLabel(deadline: string, nowMs: number): string | null {
  const ms = Date.parse(deadline) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 60_000) return '<1m';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * The soonest deadline still in the FUTURE across a list — what the compact
 * trigger counts down to.  Past-due instants are skipped (a debate whose state
 * has not been swept forward yet must not hide a live countdown behind it).
 */
export function soonestDeadline(
  debates: readonly DebateArenaSummary[],
  nowMs: number,
): string | null {
  let best: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const debate of debates) {
    const deadline = debateDeadline(debate);
    if (deadline === null) continue;
    const ms = Date.parse(deadline.at);
    if (!Number.isFinite(ms) || ms <= nowMs || ms >= bestMs) continue;
    best = deadline.at;
    bestMs = ms;
  }
  return best;
}

/** How many of these debates challenge the STORY itself (vs. a comment). */
export function storyChallengeCount(debates: readonly DebateArenaSummary[]): number {
  return debates.reduce((count, debate) => count + (debate.target_type === 'story' ? 1 : 0), 0);
}

// ---------------------------------------------------------------------------
// Ordering.
// ---------------------------------------------------------------------------

export const DEBATE_SORT_MODES = ['urgent', 'recent', 'newest', 'oldest'] as const;
export type DebateSortMode = (typeof DEBATE_SORT_MODES)[number];
export const DEFAULT_DEBATE_SORT: DebateSortMode = 'urgent';

/** ISO → epoch ms, with an unparseable instant pinned to 0 rather than NaN (a
 *  NaN would poison the comparator and make the sort order undefined). */
function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** Sort key for `urgent`: the live deadline, with "no countdown" sorting last. */
function deadlineRank(debate: DebateArenaSummary): number {
  const deadline = debateDeadline(debate);
  return deadline === null ? Number.POSITIVE_INFINITY : timeOf(deadline.at);
}

const COMPARATORS: Record<
  DebateSortMode,
  (a: DebateArenaSummary, b: DebateArenaSummary) => number
> = {
  // Soonest live deadline first; the ones with no clock (queued for the AI,
  // or judged with the override window closed) fall to the back, newest first.
  urgent: (a, b) => {
    const left = deadlineRank(a);
    const right = deadlineRank(b);
    if (left !== right) return left < right ? -1 : 1;
    return timeOf(b.updated_at) - timeOf(a.updated_at);
  },
  recent: (a, b) => timeOf(b.updated_at) - timeOf(a.updated_at),
  newest: (a, b) => timeOf(b.created_at) - timeOf(a.created_at),
  oldest: (a, b) => timeOf(a.created_at) - timeOf(b.created_at),
};

/** Story challenges rank ahead of comment challenges in EVERY sort mode. */
function pinRank(debate: DebateArenaSummary): number {
  return debate.target_type === 'story' ? 0 : 1;
}

/**
 * Order a debate list for display: story challenges first (the pin), then the
 * chosen mode, then the debate id — a TOTAL order, so the list cannot shuffle
 * between renders when two debates tie on the mode's key.
 */
export function sortDebates(
  debates: readonly DebateArenaSummary[],
  mode: DebateSortMode,
): DebateArenaSummary[] {
  const compare = COMPARATORS[mode];
  return [...debates].sort(
    (a, b) => pinRank(a) - pinRank(b) || compare(a, b) || a.debate_id.localeCompare(b.debate_id),
  );
}

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------

/** The localized text a row DISPLAYS, supplied by the caller so the search
 *  matches what the reader can actually see (in their language). */
export interface DebateRowLabels {
  /** The target-kind label ("Challenges to this story" / "…to comments"). */
  target: string;
  /** The lifecycle-state label ("Live", "Locked in", …). */
  state: string;
  /** The verdict label, once judged. */
  verdict?: string | undefined;
}

/**
 * The haystack for one row: its subject excerpt, both parties, and the labels
 * the row renders.  Searching is over the VISIBLE row — never over a hidden
 * field a reader could not have known to type.
 */
export function debateSearchText(debate: DebateArenaSummary, labels: DebateRowLabels): string {
  return [
    labels.target,
    labels.state,
    labels.verdict ?? '',
    debate.target_excerpt ?? '',
    debate.incumbent_display_name ?? '',
    debate.challenger_display_name ?? '',
  ].join(' ');
}

/** True when EVERY token occurs in the row's text (AND semantics — typing more
 *  narrows).  An empty token list matches everything. */
export function debateMatchesTokens(text: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = text.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}
