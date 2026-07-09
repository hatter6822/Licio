// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The deterministic DEFAULT in-room moderation proposer (WS-U ADR-9; the ADR-3
// "deterministic default behind a governed port" pattern, as with the summary
// and translation providers). This is NOT the removed community policy-DSL — it
// is a small, FIXED platform classifier over the room-scoped context signals,
// used as the in-room model when no LLM backend is configured (so the feature is
// operable + testable without an LLM). When an LLM backend IS configured, the
// LLM proposer replaces this behind the same port.
//
// It never fails (no outage), so it always returns `decided` — deferred
// re-moderation (which handles LLM outages) never triggers for it. It ignores
// the community moderation prompt (a deterministic classifier cannot read a
// prompt; the prompt conditions the LLM only). Its output, like any proposer's,
// is bounded by the deterministic wrapper (escalate-to-review ceiling +
// capability clamp) before it can take effect.

import type { ModerationContext } from '@licio/governance';
import type { ModerationProposer, ModerationProposerResult } from './moderation-proposer.js';

/** The fixed platform heuristic: route obviously-suspicious contributions to
 *  human review, add a warn for a young account posting a link, else allow.
 *  High-precision + conservative — the always-on WS-J baseline catches the
 *  egregious cases independently; this only adds in-room caution. */
export function classifyDeterministic(context: ModerationContext): ModerationProposerResult {
  const decide = (action: 'allow' | 'warn' | 'flag_for_review', reason: string) =>
    ({ status: 'decided', proposal: { action, reason, outputId: null } }) as const;

  if (context.linkCount >= 3) {
    return decide('flag_for_review', 'High link density — routed to human review.');
  }
  if (context.priorRemovalsInRoom >= 2) {
    return decide('flag_for_review', 'Author has prior removals in this room — routed to review.');
  }
  if (context.authorNewToRoom && context.linkCount >= 1) {
    return decide('flag_for_review', 'New author posting a link — routed to human review.');
  }
  if (context.authorAccountAgeDays < 7 && context.linkCount >= 1) {
    return decide('warn', 'Young account posting a link.');
  }
  return decide('allow', 'No in-room moderation concern detected.');
}

/** Build the deterministic default proposer (dev/test/no-LLM default). */
export function createDeterministicModerationProposer(): ModerationProposer {
  return {
    kind: 'deterministic',
    async propose(request) {
      return classifyDeterministic(request.context);
    },
  };
}
