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

// ---------------------------------------------------------------------------
// Organic (system-actor) transitions.  Two principled drivers exist; both
// ride the SAME audited apply* path as the steward surface, with actor
// `system` and a machine-readable reason:
//
//   • structural deepening — §15.4 "deepening: sustained, multi-level
//     conversation with evidence accumulating", evaluated at contribution
//     creation (maybeDeepenConversation);
//   • integrity escalation — the WS-E harassment-cascade detection (a
//     validated, base-rate-conditioned signal — never a fresh lexical
//     heuristic) elevates the thread's safety posture and marks the
//     conversation tense (escalateThreadOnIntegritySignal).
//
// Everything else (de-escalation, review, resolution) stays HUMAN: the
// ratified graph routes recovery through `under_review`, which is steward
// judgment (WS-J).
// ---------------------------------------------------------------------------

/** Citation-bearing types whose accumulation marks "evidence accumulating"
 *  (each REQUIRES citations in the shared schema). */
const EVIDENCE_BEARING_TYPES = ['evidence', 'correction', 'counterexample'] as const;

export interface DeepeningConfig {
  deepeningMinContributions: number;
  deepeningMinDepth: number;
  deepeningMinEvidence: number;
}

/**
 * Structural `active → deepening` evaluation (WS-G.1.1 system trigger).
 * Fires only while a multi-level exchange is HAPPENING (the new
 * contribution sits at depth ≥ deepeningMinDepth) and the thread has both
 * volume (published contributions ≥ deepeningMinContributions) and
 * accumulated evidence (citation-bearing contributions ≥
 * deepeningMinEvidence).  Deterministic given store state; a no-op for any
 * thread not currently `active` (tense/under-review threads are never
 * auto-deepened).  Returns whether the transition applied.
 */
export async function maybeDeepenConversation(
  deps: TransitionDeps,
  countByType: (
    threadId: string,
    states: readonly ['published'],
  ) => Promise<Partial<Record<string, number>>>,
  config: DeepeningConfig,
  threadId: string,
  newContributionDepth: number,
): Promise<boolean> {
  if (newContributionDepth < config.deepeningMinDepth) return false;
  const thread = await deps.stories.getThreadById(threadId);
  if (thread?.conversationState !== 'active') return false;
  const counts = await countByType(threadId, ['published']);
  const total = Object.values(counts).reduce((sum: number, n) => sum + (n ?? 0), 0);
  if (total < config.deepeningMinContributions) return false;
  const evidence = EVIDENCE_BEARING_TYPES.reduce((sum, type) => sum + (counts[type] ?? 0), 0);
  if (evidence < config.deepeningMinEvidence) return false;
  const outcome = await applyConversationTransition(
    deps,
    threadId,
    'deepening',
    null,
    `structural: ${total} published contributions, ${evidence} evidence-bearing, reply depth ${newContributionDepth}`,
  );
  return outcome.ok;
}

/**
 * WS-E integrity escalation: a harassment cascade against a thread's story
 * elevates the thread's safety posture (`normal → elevated`) and marks the
 * conversation `tense` (legal only from `active` — the ratified graph gives
 * `deepening` no tense edge, and an already-reviewed thread stays put).
 * Both transitions are idempotent no-ops on redelivery (at-least-once
 * router semantics) and on already-escalated threads.
 */
export async function escalateThreadOnIntegritySignal(
  deps: TransitionDeps,
  threadId: string,
  signalType: string,
  confidence: number,
): Promise<{ safetyApplied: boolean; conversationApplied: boolean }> {
  const reason = `integrity:${signalType} confidence=${confidence.toFixed(2)}`;
  const thread = await deps.stories.getThreadById(threadId);
  if (!thread) return { safetyApplied: false, conversationApplied: false };
  let safetyApplied = false;
  if (thread.safetyState === 'normal') {
    const outcome = await applyThreadSafetyTransition(deps, threadId, 'elevated', null, reason);
    safetyApplied = outcome.ok;
  }
  let conversationApplied = false;
  if (thread.conversationState === 'active') {
    const outcome = await applyConversationTransition(deps, threadId, 'tense', null, reason);
    conversationApplied = outcome.ok;
  }
  return { safetyApplied, conversationApplied };
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
