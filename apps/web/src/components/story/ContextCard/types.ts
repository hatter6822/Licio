// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Presentation + control contract for the Context Card (WS-B.2.4a layout,
// WS-B.2.4b interaction). Like the rest of the story surface this is no-applause
// safe BY CONSTRUCTION: `distributionReason` is a human-readable string (never a
// numeric score), `conversationState` carries a RatingLabel kind (conversation
// state, not popularity), and "Signal problem" is a report CALLBACK that routes
// to a report flow — there is deliberately no downvote, like, or score field.
import type { ReactNode } from 'react';
import type { RatingLabelKind } from '../RatingLabel/index.js';

/** A single community perspective in "Where interpretations differ". */
export interface ContextInterpretation {
  /** Whose reading this is (e.g. a lens or community name). */
  perspective: string;
  /** That community's human-readable summary of the situation. */
  summary: ReactNode;
}

export interface ContextCardData {
  // ---- The seven sections, in render order ----
  /** 1. What happened — the factual core. */
  whatHappened: ReactNode;
  /** 2. Why it matters — significance / stakes. */
  whyItMatters: ReactNode;
  /** 3. Where interpretations differ — multiple community perspectives. */
  interpretations: ContextInterpretation[];
  /** 4. Evidence status — sourcing / verification state. */
  evidenceStatus: ReactNode;
  /**
   * 5. Conversation state — may surface a RatingLabel (conversation state, not
   * a score). Provide free-form `detail` and/or a `ratingLabel` kind.
   */
  conversationState: {
    ratingLabel?: RatingLabelKind;
    detail?: ReactNode;
  };
  /**
   * 6. Distribution reason — why this surfaced for you. HUMAN-READABLE prose,
   * never a raw numeric score (no-applause doctrine).
   */
  distributionReason: string;

  // ---- 7. User controls (callbacks; the section renders Buttons) ----
  /** Show this topic less often. */
  onSeeLess?: () => void;
  /** Show this topic more often. */
  onSeeMore?: () => void;
  /** Mute the topic entirely. */
  onMuteTopic?: () => void;
  /** Open the ranking-signal inspector (transparency, not a score readout). */
  onInspectSignals?: () => void;
  /** Route to the report flow ("Signal problem") — never a public downvote. */
  onReport?: () => void;
}
