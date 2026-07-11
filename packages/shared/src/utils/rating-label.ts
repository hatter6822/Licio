// SPDX-License-Identifier: AGPL-3.0-or-later
//
// User-facing rating-label derivation (SPEC §5.6). The single source of truth
// for mapping a story's CONVERSATION STATE onto one of the descriptive
// labels — never popularity, never a score. Both the WS-I feed path
// (apps/api/src/ranking/service.ts) and the story-detail read
// (apps/api/src/routes/v1.ts) call this SAME cascade, so they agree on the
// safety and lifecycle dimensions. The one input that is NOT identical is
// `interpretationsDiverge`: the feed supplies its profile-aware SCOI context
// card, while the detail supplies SCOI energy ≥ the needs-context threshold
// (matching the story-page "Where interpretations differ" drawer's stricter
// signal). The two can therefore differ only at the SCOI margin — every other
// label is surface-invariant.
//
// The function is PURE and TOTAL: every input yields exactly one label, the same
// input always yields the same label, and it has no clock, I/O, or financial
// input. It is a strict PRIORITY CASCADE — live invariant signals (safety, SCOI
// context divergence) outrank the slower lifecycle state, because the live
// signal is the more current truth about the story (the §10.5 principle the
// feed already applied to SCOI is generalised here to every label).
//
// SPEC §5.6 label meanings — the cascade is a direct transcription:
//   Getting Attention  Active, non-idle reading is increasing.            (default)
//   Deepening          Users add sources, questions, corrections, summaries.
//   Needs Context      Interpretations differ or key context is missing.  (live)
//   Under Review       Coordination, safety, or policy signals require review. (live)
//   Resolved Context   A previously ambiguous issue has a high-quality synthesis.
//   Bridge Active      Multiple communities engaging with improving coherence.
//
// The former "Well-Sourced" label was removed with the EvidenceCard entity:
// sourcing is comment-centric (citations on contributions), and no production
// path could ever verify a card, so the label was unreachable outside seeded
// demo data.

import type { RatingLabelKind, StorySafetyState } from '../schemas/feed.js';
import type { StoryLifecycleState } from './story-lifecycle.js';

/** MFCI durable risk state (matches the ranking feature + the risk-state store). */
export type MfciRiskLevel = 'normal' | 'elevated' | 'high' | 'severe';

export interface StorySafetyStateInputs {
  /** True when the PWAtt safety machine has FROZEN the item (WS-E.2.2). */
  frozen: boolean;
  /** Latest MFCI per-target risk state; undefined when MFCI has not run. */
  mfciRiskState: MfciRiskLevel | undefined;
  /** The thread's §15.4 safety state (`under_review` / `elevated` / …). */
  threadSafetyState: string | undefined;
}

/**
 * Derive a story's wire-facing safety posture (SPEC §22.1 `safety_state`) — the
 * SINGLE derivation shared by the WS-I feed and the story-detail read, applied
 * to each surface's view of the same underlying state (the feed reads the
 * MFCI-risk ranking feature, the detail reads the durable MFCI risk-state store
 * it caches), so they agree by construction. Descriptive, never a sanction:
 * `under-review` means a coordination/safety/policy signal warrants review, not
 * that the content is false or banned. The cascade, strongest first: a thread
 * under an active §18.3 RESTRICTION is `restricted` (access-limited, not merely
 * flagged); a frozen item or a high/severe MFCI risk is `under-review`; an
 * elevated MFCI/thread signal is `caution`; otherwise `ok`. The thread
 * §15.4 safety machine's terminal `restricted` state therefore reaches the wire
 * `restricted` posture instead of silently collapsing to `ok`.
 */
export function deriveStorySafetyState(input: StorySafetyStateInputs): StorySafetyState {
  // An active §18.3 thread restriction is the strongest posture — the content
  // is access-limited, so it outranks the review/caution signals below.
  if (input.threadSafetyState === 'restricted') return 'restricted';
  if (input.frozen) return 'under-review';
  if (input.mfciRiskState === 'severe' || input.mfciRiskState === 'high') return 'under-review';
  if (input.threadSafetyState === 'under_review') return 'under-review';
  if (input.mfciRiskState === 'elevated' || input.threadSafetyState === 'elevated') {
    return 'caution';
  }
  return 'ok';
}

export interface RatingLabelInputs {
  /** The §14.4 lifecycle state — the slow, audited conversation state. */
  lifecycleState: StoryLifecycleState;
  /** The story's live safety posture (MFCI risk / frozen / thread review). */
  safetyState: StorySafetyState;
  /**
   * True when a live SCOI context card is attached (interpretations diverge
   * across lenses) — the §10.5 live signal that outranks the lifecycle state.
   */
  interpretationsDiverge: boolean;
  /**
   * The item's served PWAtt ActiveAttention component in [0, 1] (SPEC §5.4),
   * or undefined when no PWAtt run has covered it yet. Used ONLY to keep the
   * default label truthful: "Getting Attention" (§5.6 "active, non-idle reading
   * is increasing") requires an ACTUAL attention signal (any positive value —
   * the PWAtt fold already zeroes idle time and bounce-only opens, so a positive
   * component means genuine engagement passed those filters). Zero or absent
   * ⇒ the neutral "New" label. Never a number reaches the UI.
   */
  activeAttention?: number;
}

/**
 * Derive the single SPEC §5.6 rating label for a story. The cascade order is
 * load-bearing: each branch is strictly more specific / more current than the
 * ones below it, so a story under safety review is never mislabelled with a
 * calmer state, and an actively discussed story is upgraded past the generic
 * "Getting Attention".
 */
export function deriveRatingLabel(inputs: RatingLabelInputs): RatingLabelKind {
  // 1. Safety/coordination/policy review dominates everything (Under Review).
  //    A story under review is never simultaneously advertised as resolved —
  //    the review posture is the most important reader signal.
  if (inputs.safetyState === 'under-review' || inputs.safetyState === 'restricted') {
    return 'under-review';
  }
  // 2. Interpretations differ or key context is missing (Needs Context). The
  //    live SCOI signal OR the lifecycle's own context_needed state qualifies.
  if (inputs.interpretationsDiverge || inputs.lifecycleState === 'context_needed') {
    return 'needs-context';
  }
  // 3. Multiple communities reconciling divergent readings (Bridge Active).
  if (inputs.lifecycleState === 'bridging') {
    return 'bridge-active';
  }
  // 4. A previously ambiguous issue has a high-quality synthesis (Resolved
  //    Context) — the terminal good states.
  if (inputs.lifecycleState === 'stable' || inputs.lifecycleState === 'archived') {
    return 'resolved-context';
  }
  // 5. Users are adding sources, questions, corrections, or summaries (Deepening).
  if (inputs.lifecycleState === 'deepening') {
    return 'deepening';
  }
  // 6. Active, non-idle reading is increasing (Getting Attention) — but ONLY when
  //    there is a real ActiveAttention signal (any positive component; the fold
  //    already filtered idle/bounce). A story nobody has actively read yet reads
  //    as the neutral floor "New" rather than falsely claiming rising attention
  //    (SPEC §5.6).
  return (inputs.activeAttention ?? 0) > 0 ? 'getting-attention' : 'new';
}
