// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Safety-state constraints (WS-E.2.3e / WS-E.2.2c, SPEC §5.3/§30.5). The pure
// state machine + score pinning behind "freeze ranking growth, apply safety
// review": flagged content keeps its current score (events still populate the
// Signal Ledger — that coupling lives in the scoring service), cleared content
// resumes growth, removed content scores zero. `removed` is terminal in v0;
// reinstatement is a WS-J appeal concern.
import type { ItemSafetyState } from '@licio/shared';

export type SafetyAction = 'flag' | 'clear' | 'remove';

const LEGAL_SAFETY_TRANSITIONS: Readonly<
  Record<ItemSafetyState, Partial<Record<SafetyAction, ItemSafetyState>>>
> = {
  normal: { flag: 'frozen', remove: 'removed' },
  frozen: { clear: 'normal', remove: 'removed' },
  removed: {},
};

export type SafetyTransitionResult =
  | { ok: true; next: ItemSafetyState }
  | { ok: false; reason: string };

/** Apply a safety action to a state; illegal transitions are rejected. */
export function transitionItemSafetyState(
  current: ItemSafetyState,
  action: SafetyAction,
): SafetyTransitionResult {
  const next = LEGAL_SAFETY_TRANSITIONS[current][action];
  if (next === undefined) {
    return { ok: false, reason: `illegal safety transition: ${current} + ${action}` };
  }
  return { ok: true, next };
}

export interface ItemSafetySnapshot {
  safetyState: ItemSafetyState;
  /** The score pinned at freeze time; null while not frozen. */
  frozenScore: number | null;
  /** ActiveAttention pinned at freeze time; null when not frozen / unknown. */
  frozenActiveAttention?: number | null;
  /** ConstructiveParticipation pinned at freeze time; null when not frozen. */
  frozenParticipation?: number | null;
}

/**
 * Apply the safety-state constraint to a freshly computed score:
 *   normal  → the candidate score (growth allowed),
 *   frozen  → the pinned freeze-time score (growth denied, §5.3),
 *   removed → 0 (moderation decisions fully propagate to ranking).
 */
export function applySafetyStateToScore(
  snapshot: ItemSafetySnapshot,
  candidateScore: number,
): number {
  switch (snapshot.safetyState) {
    case 'normal':
      return candidateScore;
    case 'frozen':
      return snapshot.frozenScore ?? 0;
    case 'removed':
      return 0;
  }
}

export interface PwattComponentPair {
  activeAttention: number;
  participation: number;
}

/**
 * Apply the safety-state constraint to the SERVED PWAtt components (§5.3
 * "freeze ranking growth"). Because the WS-I ranking feature store consumes the
 * stored `active_attention`/`participation` — NOT the composite `score` — the
 * freeze must pin the COMPONENTS too, or a frozen item keeps growing from fresh
 * (cascade-inflated) attention. `frozen` pins each component at its freeze-time
 * value (0 when unknown — a brand-new item whose first window is a cascade has
 * no legitimate prior level to preserve); `removed` zeroes both; `normal`
 * passes the candidate components through unchanged.
 */
export function applySafetyStateToComponents(
  snapshot: ItemSafetySnapshot,
  candidate: PwattComponentPair,
): PwattComponentPair {
  switch (snapshot.safetyState) {
    case 'normal':
      return candidate;
    case 'frozen':
      return {
        activeAttention: snapshot.frozenActiveAttention ?? 0,
        participation: snapshot.frozenParticipation ?? 0,
      };
    case 'removed':
      return { activeAttention: 0, participation: 0 };
  }
}
