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
// ranking (SPEC §21.5 service boundaries). The interface is BATCHED (one
// provider call per candidate pool; the default provider issues three bulk
// queries — stories, threads, safety states — instead of three per item).
// The default provider composes today's authoritative sources:
//   • WS-F hidden state (takedown / safety-hidden stories)
//   • WS-E item safety state `removed` (frozen items stay VISIBLE — a trend
//     freeze is a constraint, not a removal)
//   • WS-G thread safety state `restricted`
//   • age gating (WS-D.1.7): graphic/crisis-labeled content is excluded for
//     teen bands AND for unknown-age (signed-out) requests — fail closed
//   • jurisdiction legal restriction (WS-N seam; defaults to none)
//
// Personalization-off is honored by the BASELINE stage (topic relevance is
// excluded and its weight renormalized away) rather than here: the plan
// places the guarantee at this stage, and the realized invariant is
// identical — no personalized signal is applied anywhere for such a request
// — the enforcement point is simply the component that owns the signal.
//
// Every exclusion is recorded with `policy_reason` + the moderation case ref
// for the decision log; an exclusion never reveals WHICH rule fired to the
// end user (the item simply does not appear).

import type { Candidate, SafetyExclusion } from '@licio/ranking';
import type { EventPipelineServices } from '../events/services.js';
import type { StoryRecord, ThreadShellRecord } from '../ingestion/stores.js';

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

/** The WS-J read-only seam (SPEC §21.5: ranking never computes policy).
 *  BATCHED: one call per candidate pool. */
export interface ModerationStateProvider {
  itemPolicyStates(itemIds: readonly string[]): Promise<Map<string, ItemPolicyState>>;
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

/** The fail-closed state for an item the provider cannot verify. */
const UNKNOWN_ITEM_STATE: ItemPolicyState = {
  removed: true,
  removalReason: 'unknown_item',
  moderationCaseRef: null,
  sensitivityLabels: [],
  legallyRestrictedIn: [],
  stewardHold: false,
};

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
  const states = await provider.itemPolicyStates(candidates.map((c) => c.item_id));
  for (const candidate of candidates) {
    // An item the provider returned NO verdict for fails closed.
    const state = states.get(candidate.item_id) ?? UNKNOWN_ITEM_STATE;
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
    getByIds(storyIds: readonly string[]): Promise<Map<string, StoryRecord>>;
    getThreadsByStoryIds(storyIds: readonly string[]): Promise<Map<string, ThreadShellRecord>>;
  };
  /** WS-J.2.3 shadow enforcement (SPEC §24.4): the subset of the given author
   *  ids under a STANDING shadow.  A FUNCTION dependency — NOT a `../moderation`
   *  import — so the ranking import closure stays free of moderation/financial
   *  code (the `check:neutrality` gate).  Boot injects the real moderation-store
   *  query; the default is a no-op (empty set), so a ranking built without
   *  moderation stays closure-clean. */
  shadowedSubjects(authorUserIds: readonly string[]): Promise<Set<string>>;
}

/**
 * The default provider over today's authoritative stores — THREE bulk
 * queries per pool (stories, WS-E safety states, thread shells). WS-J
 * replaces this behind the SAME interface when the moderation service lands.
 */
export function createDefaultModerationStateProvider(
  deps: DefaultProviderDeps,
): ModerationStateProvider {
  return {
    async itemPolicyStates(itemIds: readonly string[]): Promise<Map<string, ItemPolicyState>> {
      const out = new Map<string, ItemPolicyState>();
      if (itemIds.length === 0) return out;
      const [stories, safetyStates, threads] = await Promise.all([
        deps.stories.getByIds(itemIds),
        deps.events.safetyStore.getMany(itemIds),
        deps.stories.getThreadsByStoryIds(itemIds),
      ]);
      // WS-J.2.3 shadow: which of the candidate authors are under a standing
      // shadow.  Resolved AFTER stories (their authors are the query input) in
      // ONE batched call — a shadowed author's content gets zero ORGANIC reach
      // while staying directly readable (a reach reduction, NOT a removal).
      const authorIds = [
        ...new Set(
          [...stories.values()].map((s) => s.submittedBy).filter((id): id is string => id !== null),
        ),
      ];
      const shadowed = await deps.shadowedSubjects(authorIds);
      for (const itemId of itemIds) {
        const story = stories.get(itemId);
        if (story === undefined) {
          // Unknown item: fail closed — an item ranking cannot verify is
          // not served (demo fixtures route through their own path).
          out.set(itemId, UNKNOWN_ITEM_STATE);
          continue;
        }
        if (story.hiddenState !== null) {
          out.set(itemId, {
            removed: true,
            removalReason: story.hiddenState === 'takedown' ? 'takedown_removal' : 'safety_removal',
            moderationCaseRef: null,
            sensitivityLabels: story.sensitivityLabels,
            legallyRestrictedIn: [],
            stewardHold: false,
          });
          continue;
        }
        const safety = safetyStates.get(itemId);
        if (safety?.safetyState === 'removed') {
          out.set(itemId, {
            removed: true,
            removalReason: 'integrity_removal',
            moderationCaseRef: safety.caseId ?? null,
            sensitivityLabels: story.sensitivityLabels,
            legallyRestrictedIn: [],
            stewardHold: false,
          });
          continue;
        }
        const thread = threads.get(itemId);
        if (thread?.safetyState === 'restricted') {
          out.set(itemId, {
            removed: true,
            removalReason: 'thread_restricted',
            moderationCaseRef: null,
            sensitivityLabels: story.sensitivityLabels,
            legallyRestrictedIn: [],
            stewardHold: false,
          });
          continue;
        }
        // Author shadow (WS-J.2.3): exclude from organic distribution.  Checked
        // LAST so a more-specific takedown/integrity/thread reason logs instead
        // when present; the item stays directly readable (zero organic reach).
        if (story.submittedBy !== null && shadowed.has(story.submittedBy)) {
          out.set(itemId, {
            removed: true,
            removalReason: 'author_shadow',
            moderationCaseRef: null,
            sensitivityLabels: story.sensitivityLabels,
            legallyRestrictedIn: [],
            stewardHold: false,
          });
          continue;
        }
        out.set(itemId, {
          removed: false,
          removalReason: null,
          moderationCaseRef: null,
          sensitivityLabels: story.sensitivityLabels,
          legallyRestrictedIn: [],
          stewardHold: false,
        });
      }
      return out;
    },
  };
}
