// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U adapter from the GovernanceService bounded agent to the forum's
// RoomAgentModerator port (SPEC §16.6/§24.6). When a room has an active
// community-approved binding, this runs the agent's deterministic, capability-
// gated moderation over a contribution and maps the decision to a contribution
// moderation state. The agent is SUBORDINATE to the platform floor: the forum
// combines this state floor-dominantly, and the agent holds no capability to
// reduce or reverse a floor decision. The agent's action (with its provenance
// triple) is logged inside GovernanceService.moderate — not here.
import type { ModerationAction, ModerationContext } from '@licio/governance';
import type { ContributionType } from '@licio/shared';
import type { RoomAgentModerator } from '../forum/services.js';
import { getGovernanceService } from './services.js';

function contentKindOf(type: ContributionType): ModerationContext['contentKind'] {
  if (type === 'evidence') return 'evidence';
  if (type === 'correction') return 'correction';
  return 'comment';
}

/** Count a literal marker without regex (ReDoS-safe, deterministic). */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Closed action → contribution-state map. A `warn` is logged but does not hide
 * content; `restrict`/`flag_for_review` route to human review; `remove` removes
 * (appealable). `allow` is a no-op. Floor-reserved actions are not expressible.
 */
const ACTION_TO_STATE: Readonly<
  Record<ModerationAction, 'published' | 'under_review' | 'removed'>
> = {
  allow: 'published',
  warn: 'published',
  flag_for_review: 'under_review',
  restrict: 'under_review',
  remove: 'removed',
};

export function createRoomAgentModerator(): RoomAgentModerator {
  return {
    async moderateContribution({
      roomId,
      contributionId,
      type,
      body,
      citationCount,
      attachmentCount,
    }) {
      const svc = getGovernanceService();
      const binding = await svc.getBinding(roomId);
      if (binding === null || !binding.active) return null; // no active agent ⇒ floor only
      const lower = body.toLowerCase();
      const context: ModerationContext = {
        contentText: body,
        contentKind: contentKindOf(type),
        contentLength: body.length,
        linkCount:
          citationCount + countOccurrences(lower, 'http://') + countOccurrences(lower, 'https://'),
        mentionCount: countOccurrences(body, '@'),
        hasMediaUpload: attachmentCount > 0,
        // Author-history enrichment (account-age bucket, room familiarity, prior
        // removals) is a tracked enhancement; v1 uses non-triggering defaults so
        // the agent never over-moderates on absent history.
        authorAccountAgeDays: 3650,
        authorNewToRoom: false,
        priorRemovalsInRoom: 0,
      };
      const result = await svc.moderate(roomId, context, contributionId);
      if (!result.ok || result.value === null) return null;
      return { state: ACTION_TO_STATE[result.value.action] };
    },
  };
}
