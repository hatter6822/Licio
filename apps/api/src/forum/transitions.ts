// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread state-transition service (WS-G.1.1).  The pure legal graphs live in
// @licio/shared; this service is the ONLY write path for thread states:
// illegal transitions are rejected with a typed error, every change emits a
// durable `thread.state.changed` event (dimension `conversation` or
// `thread_safety` — distinct from the WS-E item-scoring `safety` dimension),
// and every SAFETY change is written to the moderation audit log with actor,
// reason, and timestamp (WS-G.1.1 acceptance; conversation changes are
// audited too — observability is cheap, reconstructing history is not).
import { randomUUID } from 'node:crypto';
import {
  isLegalConversationTransition,
  isLegalThreadSafetyTransition,
  type ThreadConversationState,
  type ThreadSafetyState,
  TOPIC_REGISTRY,
  threadStateChangedEventSchema,
} from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import type { AuditStore } from '../identity/audit.js';
import type { StoryStore, ThreadShellRecord } from '../ingestion/stores.js';

export interface TransitionDeps {
  stories: StoryStore;
  events: EventPipelineServices;
  audit: AuditStore;
  /** Detached-work tracker (event publication never blocks the response). */
  trackBackground: (work: Promise<unknown>) => void;
  now: () => number;
}

export type TransitionOutcome =
  | { ok: true; thread: ThreadShellRecord }
  | {
      ok: false;
      reason: 'thread_not_found' | 'illegal_transition' | 'no_change';
      message: string;
    };

async function emitStateChanged(
  deps: TransitionDeps,
  thread: ThreadShellRecord,
  dimension: 'conversation' | 'thread_safety',
  oldState: string,
  newState: string,
  actorUserId: string | null,
): Promise<void> {
  const event = threadStateChangedEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'thread.state.changed',
    timestamp: new Date(deps.now()).toISOString(),
    schema_version: '1',
    thread_id: thread.threadId,
    story_id: thread.storyId,
    state_dimension: dimension,
    old_state: oldState,
    new_state: newState,
    changed_by: actorUserId ?? 'system',
    privacy_classification: 'sensitive',
    retention_tier: 'ranking_log',
  });
  const registryEntry = TOPIC_REGISTRY['thread.state.changed'];
  await deps.events.eventStore.insertMany([
    {
      eventId: event.event_id,
      eventType: event.event_type,
      topic: event.event_type,
      timestamp: event.timestamp,
      privacyClassification: registryEntry.privacy_classification,
      retentionTier: registryEntry.retention_tier,
      payload: event as unknown as Record<string, unknown>,
      ownerUserId: null,
      purgeAfter: null,
    },
  ]);
  deps.trackBackground(deps.events.router.publish(event));
}

/** Apply a WS-G.1.1 conversation transition (steward surface / system sweep). */
export async function applyConversationTransition(
  deps: TransitionDeps,
  threadId: string,
  to: ThreadConversationState,
  actorUserId: string | null,
  reason: string,
): Promise<TransitionOutcome> {
  const thread = await deps.stories.getThreadById(threadId);
  if (!thread) {
    return { ok: false, reason: 'thread_not_found', message: 'Thread not found' };
  }
  const from = thread.conversationState;
  if (from === to) {
    return { ok: false, reason: 'no_change', message: 'The thread is already in that state' };
  }
  if (!isLegalConversationTransition(from, to)) {
    return {
      ok: false,
      reason: 'illegal_transition',
      message: `Illegal conversation transition: ${from} → ${to}`,
    };
  }
  const updated = await deps.stories.updateThread(threadId, { conversationState: to });
  if (!updated) {
    return { ok: false, reason: 'thread_not_found', message: 'Thread not found' };
  }
  await emitStateChanged(deps, updated, 'conversation', from, to, actorUserId);
  await deps.audit.append({
    actorUserId,
    eventType: 'thread_state_change',
    targetRef: threadId,
    context: { setting: 'conversation_state', previous_value: from, new_value: to, reason },
  });
  return { ok: true, thread: updated };
}

/** Apply a WS-G.1.1 thread-safety transition (audited, WS-J seam). */
export async function applyThreadSafetyTransition(
  deps: TransitionDeps,
  threadId: string,
  to: ThreadSafetyState,
  actorUserId: string | null,
  reason: string,
): Promise<TransitionOutcome> {
  const thread = await deps.stories.getThreadById(threadId);
  if (!thread) {
    return { ok: false, reason: 'thread_not_found', message: 'Thread not found' };
  }
  const from = thread.safetyState;
  if (from === to) {
    return { ok: false, reason: 'no_change', message: 'The thread is already in that state' };
  }
  if (!isLegalThreadSafetyTransition(from, to)) {
    return {
      ok: false,
      reason: 'illegal_transition',
      message: `Illegal safety transition: ${from} → ${to}`,
    };
  }
  const updated = await deps.stories.updateThread(threadId, { safetyState: to });
  if (!updated) {
    return { ok: false, reason: 'thread_not_found', message: 'Thread not found' };
  }
  await emitStateChanged(deps, updated, 'thread_safety', from, to, actorUserId);
  await deps.audit.append({
    actorUserId,
    eventType: 'thread_state_change',
    targetRef: threadId,
    context: { setting: 'safety_state', previous_value: from, new_value: to, reason },
  });
  return { ok: true, thread: updated };
}
