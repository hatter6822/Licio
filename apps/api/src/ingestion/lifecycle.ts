// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story lifecycle service (WS-F.1.1c, SPEC §14.4): applies the PURE shared
// transition function, persists the new state, and writes the append-only
// audit record — one record per applied transition, with from/to/trigger/
// actor. Trigger SOURCES are restricted by construction: this module is
// called only from system consumers (WS-E attention/contribution events,
// the low-activity sweep) and the steward admin surface — no client-facing
// route can force a transition (WS-F.1.1c security consideration). Illegal
// transitions are expected under at-least-once event delivery and are
// reported as no-ops, never errors (a redelivered `first_attention` must not
// dead-letter the consumer).
import {
  ACTIVE_LIFECYCLE_STATES,
  type StoryLifecycleState,
  type StoryLifecycleTrigger,
  transitionStoryLifecycle,
} from '@licio/shared';
import type { LifecycleAuditStore, StoryStore } from './stores.js';

export interface LifecycleActor {
  actorType: 'system' | 'steward';
  actorUserId: string | null;
}

export type LifecycleApplyResult =
  | { applied: true; from: StoryLifecycleState; to: StoryLifecycleState }
  | {
      applied: false;
      reason: 'story_not_found' | 'invalid_transition';
      state?: StoryLifecycleState;
    };

export interface LifecycleMetricsSink {
  onTransition(from: StoryLifecycleState, to: StoryLifecycleState): void;
}

/** Apply one trigger to one story: validate → persist → audit → count. */
export async function applyLifecycleTrigger(
  stories: StoryStore,
  audits: LifecycleAuditStore,
  storyId: string,
  trigger: StoryLifecycleTrigger,
  actor: LifecycleActor,
  metrics?: LifecycleMetricsSink,
): Promise<LifecycleApplyResult> {
  const story = await stories.getById(storyId);
  if (!story) return { applied: false, reason: 'story_not_found' };
  const result = transitionStoryLifecycle(story.lifecycleState, trigger);
  if (!result.ok) {
    return { applied: false, reason: 'invalid_transition', state: story.lifecycleState };
  }
  await stories.update(storyId, { lifecycleState: result.next });
  await audits.append({
    storyId,
    fromState: story.lifecycleState,
    toState: result.next,
    trigger,
    actorType: actor.actorType,
    actorUserId: actor.actorUserId,
  });
  metrics?.onTransition(story.lifecycleState, result.next);
  return { applied: true, from: story.lifecycleState, to: result.next };
}

/**
 * Low-activity sweep (WS-F.1.1c "any active state → archived"): archive
 * stories not materially updated for `idleDays`. Idempotent — an archived
 * story is no longer in the active-state list.
 */
export async function sweepLowActivity(
  stories: StoryStore,
  audits: LifecycleAuditStore,
  nowMs: number,
  idleDays: number,
  batch: number,
  metrics?: LifecycleMetricsSink,
): Promise<number> {
  const cutoff = new Date(nowMs - idleDays * 24 * 3_600_000).toISOString();
  const stale = await stories.listStaleByLifecycle(ACTIVE_LIFECYCLE_STATES, cutoff, batch);
  let archived = 0;
  for (const story of stale) {
    const result = await applyLifecycleTrigger(
      stories,
      audits,
      story.storyId,
      'low_activity',
      { actorType: 'system', actorUserId: null },
      metrics,
    );
    if (result.applied) archived += 1;
  }
  return archived;
}
