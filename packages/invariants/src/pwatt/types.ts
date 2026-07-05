// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PWAtt scoring input/output types (WS-E.2, SPEC §5.3-§5.5, §30.5). Every
// scoring function in this package is PURE — same inputs, same outputs, no
// clock, no randomness — which is what makes shadow-mode equivalence testing
// (WS-E.2.1e) and decision replay (SPEC §30.6) possible.
import type {
  DwellBucket,
  EventContributionType,
  ReplyDepthBucket,
  ReturnVisitBucket,
} from '@licio/shared';

/**
 * SHADOW MODE (SPEC §30.5). LIFTED by WS-I (the §30.5 v1 "bounded ranking
 * input" stage): PWAtt outputs are now stored `shadow_mode: false` and feed
 * the WS-I ranking pipeline as BOUNDED inputs — saturated components in
 * [0, 1], §5.5-guardrailed convex weights, promotion-gated penalties, the
 * non-overridable safety filter, the runtime kill switch (WS-I.4.1a), and
 * the safe chronological fallback (WS-I.4.1b). Review evidence for the lift:
 * the WS-I.3 ranking-neutrality suite (ten CI tests), deterministic decision
 * logs with replay (WS-I.2.5), and the WS-E fallback-invariance tests (the
 * fallback ranker provably ignores every PWAtt value, so engaging the kill
 * switch restores the pre-lift posture instantly).
 *
 * Changing this constant remains a CODE change reviewed like any other —
 * never a configuration flip. Setting it back to `true` is the code-level
 * counterpart of the runtime kill switch: the WS-I scoring path refuses
 * PWAtt components while it is true (see apps/api ranking/features.ts).
 */
export const PWATT_V0_SHADOW_MODE = false as const;

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
  /**
   * Maximum distinct reply-depth traversal bucket observed in the window
   * (SIG-ATT-TRAVERSE, §5.3 "thread traversal"): nonredundant traversal of
   * nested comment depths. Absent ⇒ `none` (no effect) — the field is optional
   * so pre-traversal callers/tests need no change; the fold populates it.
   */
  replyDepthBucket?: ReplyDepthBucket;
  /** Contribution counts by type within the window. */
  contributions: Partial<Record<EventContributionType, number>>;
  /**
   * The actor's accusations WITHOUT a citation, by contribution type
   * (WS-E.2.2b). Per-type counts never exceed `contributions[type]` — the
   * scoring functions clamp defensively. Typed so the v1 hierarchy can apply
   * the downweight at the accusing contribution's own weight.
   */
  uncitedAccusationsByType: Partial<Record<EventContributionType, number>>;
  /**
   * The actor's contributions WITH at least one attached source, by type (WS-T
   * sourced comments).  Per-type counts never exceed `contributions[type]` — the
   * scoring functions clamp defensively.  A sourced contribution earns a positive
   * citation weight (the exact structural inverse of the uncited-accusation
   * downweight): a sourced comment counts as strictly greater participation than
   * an unsourced one.  This is an EVIDENCE signal, never applause (it derives
   * only from whether the content carries a source, uniformly across authors).
   */
  citedContributionsByType: Partial<Record<EventContributionType, number>>;
  /** Private saves within the window (0 until a save topic exists; low weight). */
  savedForLater: number;
  /**
   * Account-age trust weight in [0, 1] (WS-O.4.5): a coarse, non-financial,
   * privacy-preserving multiplier applied to THIS actor's contribution so a
   * fresh/throwaway account contributes reduced score and the economic cost of
   * a Sybil brigade rises with account age. Absent ⇒ 1 (no effect). The coarse
   * privacy-bucket actor and any unresolvable actor are ALWAYS 1 (anonymity is
   * never penalized — the caller resolves this before building the summary).
   */
  trustWeight?: number;
}

/** Read an actor's trust weight, defaulting to 1 (no effect) and clamped to
 *  [0, 1]. Anonymity/unresolved actors carry no weight field ⇒ full trust. */
export function actorTrustFactor(actor: Pick<ActorItemSummary, 'trustWeight'>): number {
  return clamp01(actor.trustWeight ?? 1);
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
