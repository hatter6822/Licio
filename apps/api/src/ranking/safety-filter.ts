// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.2a — the safety-filter stage (SPEC §13.4 `remove_policy_disallowed`,
// §24.4 non-overridable constraints). Runs after feature join and BEFORE
// scoring; the scoring orchestrator receives only what survives, and a final
// assertion in the service guarantees nothing filtered here can be re-
// admitted downstream (the filter result is authoritative).
//
// The filter READS moderation state through the `ModerationStateProvider`
// seam — policy is computed by Moderation (WS-J when it lands), never by
// ranking (SPEC §21.5 service boundaries). The default provider composes
// today's authoritative sources:
//   • WS-F hidden state (takedown / safety-hidden stories)
//   • WS-E item safety state `removed` (frozen items stay VISIBLE — a trend
//     freeze is a constraint, not a removal)
//   • WS-G thread safety state `restricted`
//   • age gating (WS-D.1.7): graphic/crisis-labeled content is excluded for
//     teen bands AND for unknown-age (signed-out) requests — fail closed
//   • jurisdiction legal restriction (WS-N seam; defaults to none)
//
// Every exclusion is recorded with `policy_reason` + the moderation case ref
// for the decision log; an exclusion never reveals WHICH rule fired to the
// end user (the item simply does not appear).

import type { Candidate, SafetyExclusion } from '@licio/ranking';
import type { EventPipelineServices } from '../events/services.js';

export interface ItemPolicyState {
  removed: boolean;
  removalReason: string | null;
  moderationCaseRef: string | null;
  /** Sensitivity labels that drive age gating. */
  sensitivityLabels: readonly string[];
  /** ISO 3166-1 alpha-2 jurisdictions where the item is legally restricted. */
  legallyRestrictedIn: readonly string[];
  /** True under an active steward hold. */
  stewardHold: boolean;
}

/** The WS-J read-only seam (SPEC §21.5: ranking never computes policy). */
export interface ModerationStateProvider {
  itemPolicyState(itemId: string): Promise<ItemPolicyState>;
}

export interface SafetyRequestContext {
  /** WS-D age band of the requester; null = signed out / unknown. */
  ageBand: 'adult' | 'teen_16_17' | 'teen_13_15' | null;
  /** Requesting jurisdiction (WS-N seam); null = unknown. */
  jurisdiction: string | null;
}

export interface SafetyFilterResult {
  feasible: Candidate[];
  exclusions: SafetyExclusion[];
}

/** Sensitivity labels excluded for minors and unknown-age requests. */
const AGE_RESTRICTED_LABELS: ReadonlySet<string> = new Set(['graphic', 'crisis']);

/**
 * Apply the non-overridable policy filter. Scoring has NO path to re-admit
 * an excluded item: the feasible set is what this function returns, and the
 * service asserts every served item is a member.
 */
export async function applySafetyFilter(
  candidates: readonly Candidate[],
  provider: ModerationStateProvider,
  context: SafetyRequestContext,
): Promise<SafetyFilterResult> {
  const feasible: Candidate[] = [];
  const exclusions: SafetyExclusion[] = [];
  for (const candidate of candidates) {
    const state = await provider.itemPolicyState(candidate.item_id);
    if (state.removed) {
      exclusions.push({
        item_id: candidate.item_id,
        policy_reason: state.removalReason ?? 'active_removal',
        moderation_case_ref: state.moderationCaseRef,
      });
      continue;
    }
    if (state.stewardHold) {
      exclusions.push({
        item_id: candidate.item_id,
        policy_reason: 'steward_hold',
        moderation_case_ref: state.moderationCaseRef,
      });
      continue;
    }
    if (context.jurisdiction !== null && state.legallyRestrictedIn.includes(context.jurisdiction)) {
      exclusions.push({
        item_id: candidate.item_id,
        policy_reason: 'jurisdiction_restricted',
        moderation_case_ref: state.moderationCaseRef,
      });
      continue;
    }
    // Age gating: adults see everything lawful; teens AND unknown-age
    // (signed-out) requests exclude graphic/crisis content (fail closed,
    // SPEC §19.4 minor-safety limits are non-overridable).
    const ageRestricted = state.sensitivityLabels.some((label) => AGE_RESTRICTED_LABELS.has(label));
    if (ageRestricted && context.ageBand !== 'adult') {
      exclusions.push({
        item_id: candidate.item_id,
        policy_reason: 'age_inappropriate',
        moderation_case_ref: null,
      });
      continue;
    }
    feasible.push(candidate);
  }
  return { feasible, exclusions };
}

/** Dependency surface of the default provider (kept narrow + testable). */
export interface DefaultProviderDeps {
  events: EventPipelineServices;
  stories: {
    getById(storyId: string): Promise<{
      hiddenState: 'takedown' | 'safety' | null;
      sensitivityLabels: readonly string[];
    } | null>;
    getThreadByStoryId(storyId: string): Promise<{ safetyState: string } | null>;
  };
}

/**
 * The default provider over today's authoritative stores. WS-J replaces this
 * behind the SAME interface when the moderation service lands.
 */
export function createDefaultModerationStateProvider(
  deps: DefaultProviderDeps,
): ModerationStateProvider {
  return {
    async itemPolicyState(itemId: string): Promise<ItemPolicyState> {
      const story = await deps.stories.getById(itemId);
      if (story === null) {
        // Unknown item: fail closed — an item ranking cannot verify is not
        // served (the demo fixtures route through their own explicit path).
        return {
          removed: true,
          removalReason: 'unknown_item',
          moderationCaseRef: null,
          sensitivityLabels: [],
          legallyRestrictedIn: [],
          stewardHold: false,
        };
      }
      if (story.hiddenState !== null) {
        return {
          removed: true,
          removalReason: story.hiddenState === 'takedown' ? 'takedown_removal' : 'safety_removal',
          moderationCaseRef: null,
          sensitivityLabels: story.sensitivityLabels,
          legallyRestrictedIn: [],
          stewardHold: false,
        };
      }
      const safety = await deps.events.safetyStore.get(itemId);
      if (safety?.safetyState === 'removed') {
        return {
          removed: true,
          removalReason: 'integrity_removal',
          moderationCaseRef: safety.caseId ?? null,
          sensitivityLabels: story.sensitivityLabels,
          legallyRestrictedIn: [],
          stewardHold: false,
        };
      }
      const thread = await deps.stories.getThreadByStoryId(itemId);
      if (thread?.safetyState === 'restricted') {
        return {
          removed: true,
          removalReason: 'thread_restricted',
          moderationCaseRef: null,
          sensitivityLabels: story.sensitivityLabels,
          legallyRestrictedIn: [],
          stewardHold: false,
        };
      }
      return {
        removed: false,
        removalReason: null,
        moderationCaseRef: null,
        sensitivityLabels: story.sensitivityLabels,
        legallyRestrictedIn: [],
        stewardHold: false,
      };
    },
  };
}
