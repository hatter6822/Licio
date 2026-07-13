// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story safety-posture derivation (SPEC §22.1 `safety_state`). The single
// source of truth for mapping a story's live safety signals onto the wire
// posture — descriptive, never a sanction, never popularity. Both the WS-I
// feed path (apps/api/src/ranking/service.ts) and the story-detail read
// (apps/api/src/routes/v1.ts) call this SAME cascade, so they agree on the
// safety dimension by construction.
//
// This file previously also housed the SPEC §5.6 rating-label cascade
// ("Getting Attention" / "Deepening" / "Needs Context" / …). Those labels were
// removed with the story-card signal redesign: cards now surface the concrete
// content-integrity signals directly (the WS-T dispute badge, the sourced-
// comment count, and the corrections tally — see `storyCorrectionsSchema` in
// schemas/feed.ts) instead of a derived prose label. The safety posture is the
// one dimension of the old cascade that survives, because "Under review" is a
// transparency signal (WS-J), not a conversation-state summary.

import type { StorySafetyState } from '../schemas/feed.js';

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
