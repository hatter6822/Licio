// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PWAtt scoring input/output types (WS-E.2, SPEC §5.3-§5.5, §30.5). Every
// scoring function in this package is PURE — same inputs, same outputs, no
// clock, no randomness — which is what makes shadow-mode equivalence testing
// (WS-E.2.1e) and decision replay (SPEC §30.6) possible.
import type { DwellBucket, EventContributionType, ReturnVisitBucket } from '@licio/shared';

/**
 * SHADOW MODE (SPEC §30.5). While true, every PWAtt output is stored with
 * `shadow_mode: true` and has ZERO distribution power: the ranking boundary
 * (apps/api pwatt/shadow) rejects shadow rows as ranking inputs, and a CI
 * equivalence test proves ranking output is identical with and without PWAtt
 * scores. Lifting shadow mode requires EDITING THIS CONSTANT — a code change
 * reviewed like any other, never a configuration flip — and is gated on the
 * §30.5 safety review with WS-I.
 */
export const PWATT_V0_SHADOW_MODE = true as const;

/** Implementation version stamped on stored v0 outputs. */
export const PWATT_V0_VERSION = 'v0' as const;
/** Implementation version stamped on stored v1 outputs. */
export const PWATT_V1_VERSION = 'v1' as const;

/**
 * One actor's deduplicated signal summary for a single item within a single
 * window (WS-E.2.1a output). "Actor" is the §22.1 `user_id_or_privacy_bucket`:
 * all minimum-privacy readers share one bucket actor, which deliberately
 * UNDER-counts pseudonymous attention — the conservative, inflation-proof
 * direction.
 */
export interface ActorItemSummary {
  /** User id or the coarse privacy bucket. */
  actor: string;
  /** Maximum active-dwell bucket observed in the window (deduped). */
  dwellBucket: DwellBucket;
  /** Whether the actor opened the source at all. */
  sourceOpened: boolean;
  /**
   * True when EVERY source open by this actor bounced (immediate return).
   * The §5.3 clickbait guardrail: bounce-only source opens earn zero weight.
   */
  sourceBounceOnly: boolean;
  /** Whether a context card was opened (deduped once per session upstream). */
  contextOpened: boolean;
  /** Maximum return-visit bucket observed (rage-loops excluded upstream). */
  returnVisitBucket: ReturnVisitBucket;
  /** Contribution counts by type within the window. */
  contributions: Partial<Record<EventContributionType, number>>;
  /**
   * The actor's accusations WITHOUT a citation, by contribution type
   * (WS-E.2.2b). Per-type counts never exceed `contributions[type]` — the
   * scoring functions clamp defensively. Typed so the v1 hierarchy can apply
   * the downweight at the accusing contribution's own weight.
   */
  uncitedAccusationsByType: Partial<Record<EventContributionType, number>>;
  /** Private saves within the window (0 until a save topic exists; low weight). */
  savedForLater: number;
}

/** Anti-signal flags computed at the item level for the window. */
export interface ItemAntiSignals {
  /** Coordinated-burst detection result (WS-E.2.2a), when triggered. */
  coordinatedBurst?: { confidence: number };
  /** Harassment-cascade detection (WS-E.2.2c), when triggered. */
  harassmentCascade?: boolean;
}

/** The full scoring input for one item in one window. */
export interface ItemWindowInput {
  itemId: string;
  actors: readonly ActorItemSummary[];
  antiSignals: ItemAntiSignals;
}

/** A per-actor scoring breakdown, used for Signal Ledger transparency. */
export interface ActorScoreBreakdown {
  actor: string;
  activeAttention: number;
  participation: number;
  /** Anti-signal annotations applied to THIS actor (ledger transparency). */
  annotations: readonly string[];
}

/** The v0 scoring output for one item/window (shadow, SPEC §30.5). */
export interface PwattV0Result {
  itemId: string;
  /** ActiveAttention component in [0, 1] (WS-E.2.1b). */
  activeAttention: number;
  /** ConstructiveParticipation component in [0, 1] (WS-E.2.1c). */
  participation: number;
  /** Combined v0 score in [0, 1]. */
  score: number;
  /** Bounded confidence in [0, 1], growing with distinct-actor evidence. */
  confidence: number;
  /** Item-level anti-signal annotations (ledger + review transparency). */
  annotations: readonly string[];
  /** Per-actor breakdowns for Signal Ledger population (WS-E.2.1d). */
  actorBreakdowns: readonly ActorScoreBreakdown[];
}

/** Clamp into [0, 1]; NaN and non-finite collapse to 0 (totality). */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Coerce to a finite non-negative count; NaN/negative/non-finite → 0. */
export function toNonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}
