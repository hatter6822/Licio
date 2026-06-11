// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story lifecycle state machine (WS-F.1.1c, SPEC §14.4):
//
//   submitted → gathering_attention → deepening → context_needed → bridging
//             → stable → archived
//
// plus the documented non-linear edges (deepening→stable, stable→deepening,
// bridging→context_needed regression, any-active→archived on low activity,
// archived→deepening reactivation). The transition function is PURE and
// DETERMINISTIC: (state, trigger) maps to exactly one next state or a typed
// rejection — no clock, no I/O, and (structurally) no financial input. The
// audit record around each applied transition is written by the ingestion
// lifecycle service (apps/api), which is also where trigger sources are
// restricted to system services and stewards (clients can never force a
// transition).

export const STORY_LIFECYCLE_STATES = [
  'submitted',
  'gathering_attention',
  'deepening',
  'context_needed',
  'bridging',
  'stable',
  'archived',
] as const;
export type StoryLifecycleState = (typeof STORY_LIFECYCLE_STATES)[number];

/**
 * The trigger vocabulary, one per ✅ cell of the WS-F.1.1c transition table.
 * Triggers are SUPPLIED by other services (attention aggregates from WS-E,
 * SCOI/evidence-gap from WS-H/WS-G — soft dependencies with graceful
 * degradation) or by stewards; the names describe the signal, not the caller.
 */
export const STORY_LIFECYCLE_TRIGGERS = [
  /** First attention aggregate observed (submitted → gathering_attention). */
  'first_attention',
  /** Sustained participation (gathering_attention → deepening). */
  'sustained_participation',
  /** SCOI obstruction or evidence gaps elevated (deepening → context_needed). */
  'scoi_evidence_gap',
  /** Resolved with no context issue (deepening → stable). */
  'resolved_cleanly',
  /** Divergent lenses being reconciled (context_needed → bridging). */
  'lens_reconciliation',
  /** Context added without bridging (context_needed → stable). */
  'context_added',
  /** Bridging regressed (bridging → context_needed). */
  'regressed',
  /** Lenses reconciled (bridging → stable). */
  'reconciled',
  /** Renewed activity on a stable story (stable → deepening). */
  'renewed_activity',
  /** Sustained low activity (any active state → archived). */
  'low_activity',
  /** New activity on an archived story (archived → deepening). */
  'reactivation',
] as const;
export type StoryLifecycleTrigger = (typeof STORY_LIFECYCLE_TRIGGERS)[number];

/**
 * The authoritative (state, trigger) → state map — a direct transcription of
 * the WS-F.1.1c table. Any (state, trigger) pair absent here is an illegal
 * transition and rejects with `INVALID_LIFECYCLE_TRANSITION`.
 */
export const STORY_LIFECYCLE_TRANSITIONS: Readonly<
  Record<StoryLifecycleState, Partial<Readonly<Record<StoryLifecycleTrigger, StoryLifecycleState>>>>
> = {
  submitted: {
    first_attention: 'gathering_attention',
    low_activity: 'archived', // stale / never gathered attention
  },
  gathering_attention: {
    sustained_participation: 'deepening',
    low_activity: 'archived',
  },
  deepening: {
    scoi_evidence_gap: 'context_needed',
    resolved_cleanly: 'stable',
    low_activity: 'archived',
  },
  context_needed: {
    lens_reconciliation: 'bridging',
    context_added: 'stable',
    low_activity: 'archived',
  },
  bridging: {
    regressed: 'context_needed',
    reconciled: 'stable',
    low_activity: 'archived',
  },
  stable: {
    renewed_activity: 'deepening',
    low_activity: 'archived',
  },
  archived: {
    reactivation: 'deepening',
  },
};

export const INVALID_LIFECYCLE_TRANSITION = 'INVALID_LIFECYCLE_TRANSITION' as const;

export type StoryLifecycleTransitionResult =
  | { ok: true; next: StoryLifecycleState }
  | { ok: false; code: typeof INVALID_LIFECYCLE_TRANSITION };

/**
 * Apply one trigger to a state. Pure and total: every input yields a value,
 * the same input always yields the same output, and illegal pairs reject with
 * the typed `INVALID_LIFECYCLE_TRANSITION` code rather than throwing.
 */
export function transitionStoryLifecycle(
  current: StoryLifecycleState,
  trigger: StoryLifecycleTrigger,
): StoryLifecycleTransitionResult {
  const next = STORY_LIFECYCLE_TRANSITIONS[current][trigger];
  if (next === undefined) return { ok: false, code: INVALID_LIFECYCLE_TRANSITION };
  return { ok: true, next };
}

/** States from which `low_activity` archives the story (all but archived). */
export const ACTIVE_LIFECYCLE_STATES: readonly StoryLifecycleState[] =
  STORY_LIFECYCLE_STATES.filter((state) => state !== 'archived');
