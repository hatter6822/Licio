// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared attention-ingestion pipeline (WS-E.1.3a-e, SPEC §25.5 "client
// aggregates are hints, never sole truth"). BOTH ingestion surfaces flow
// through this one pipeline with identical guards (WS-E.1.3e):
//
//   POST /v1/events/attention      — the canonical single-event endpoint
//                                    (ONLINE acceptance: 5 min past / 30 s
//                                    future, per WS-E.1.3b);
//   POST /v1/attention/aggregates  — the WS-C client batch wire, converted
//                                    aggregate-by-aggregate into canonical
//                                    events (OFFLINE_SYNC acceptance: the
//                                    background-sync queue may replay batches
//                                    days later, §6.9 — bounded by the 7-day
//                                    attention_raw ceiling).
//
// Guard order per event: ownership → timestamp window → replay nonce →
// privacy gate → durable insert (event_id-unique: the durable replay
// backstop) → publish. Rate limiting runs once per REQUEST before the
// pipeline (routes). Logs carry event ids and the user id ONLY — never an
// attention value (asserted by a log-redaction test).

import { randomUUID } from 'node:crypto';
import {
  type AttentionAggregate,
  type AttentionAggregateEvent,
  attentionAggregateEventSchema,
  type PrivacySettings,
  type SourceOpenedAggregateEvent,
  TOPIC_REGISTRY,
} from '@licio/shared';
import { accountRef } from '../identity/crypto.js';
import type { IdentityServices } from '../identity/services.js';
import {
  attentionPurgeAfterIso,
  effectivePrivacyLevel,
  evaluateAttentionPrivacy,
} from './privacy-gate.js';
import { NONCE_TTL_MS } from './replay.js';
import type { EventPipelineServices } from './services.js';
import {
  type AttentionAggregateRecord,
  type NewStoredEvent,
  PRIVACY_BUCKET,
  PSEUDONYMOUS_USER_ID,
} from './stores.js';

/** Timestamp acceptance windows (WS-E.1.3b). */
export interface AcceptancePolicy {
  maxPastMs: number;
  maxFutureMs: number;
}

/** The canonical online policy: 5 minutes past, 30 seconds future skew. */
export const ONLINE_ACCEPTANCE: AcceptancePolicy = { maxPastMs: 5 * 60_000, maxFutureMs: 30_000 };

/**
 * The offline-sync policy for the WS-C batch wire: the durable pending queue
 * replays batches when connectivity returns (possibly days later, SPEC §6.9).
 * Replay safety does NOT depend on this window — every aggregate_id is a
 * single-use nonce AND the durable event_id uniqueness rejects re-ingestion
 * forever — so the window only bounds how stale an aggregate may still enter
 * scoring (7 days = the longest aggregation window and the attention_raw
 * ceiling).
 */
export const OFFLINE_SYNC_ACCEPTANCE: AcceptancePolicy = {
  maxPastMs: 7 * 86_400_000,
  maxFutureMs: 30_000,
};

export type AttentionIngestEvent = AttentionAggregateEvent | SourceOpenedAggregateEvent;

export type IngestOutcome =
  | 'accepted'
  | 'replay'
  | 'stale_timestamp'
  | 'future_timestamp'
  | 'ownership_mismatch'
  | 'discarded_privacy';

export interface IngestResult {
  outcomes: IngestOutcome[];
  accepted: number;
}

// The §22.1 pseudonym placeholder written into STORED payloads of
// minimum-privacy events: the uploaded `user_id` is REWRITTEN to this constant
// before persistence so the at-rest payload is de-linked from the user
// (ownership was already verified against the session; the row also carries
// `owner_user_id = null`). Defined with the stores (the owner de-linking path
// shares it); re-exported here for the ingestion call sites and tests.
export { PSEUDONYMOUS_USER_ID } from './stores.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Ingest a batch of canonical attention events for an authenticated user. */
export async function ingestAttentionEvents(
  events: EventPipelineServices,
  identity: IdentityServices,
  sessionUserId: string,
  batch: readonly AttentionIngestEvent[],
  policy: AcceptancePolicy,
): Promise<IngestResult> {
  const now = events.now();
  const outcomes: IngestOutcome[] = [];
  const toStore: NewStoredEvent[] = [];
  const aggregateRowsByEvent: Array<{ eventId: string; row: AttentionAggregateRecord }> = [];
  const toPublish: AttentionIngestEvent[] = [];
  const storeIndexByEventId = new Map<string, number>();

  // The privacy gate reads the user's CURRENT durable settings once per
  // request — a mid-session change applies to the next request (WS-E.1.3d).
  const user = await identity.store.getUser(sessionUserId);
  const settings: PrivacySettings | null = user?.privacySettings ?? null;
  const decision = settings ? evaluateAttentionPrivacy(settings) : null;
  // Compliance log (WS-E.1.3d): the retention-mode enforcement DECISION is
  // recorded once per request — user id + action only, never event data.
  if (decision?.action === 'accept' && decision.preference !== 'default') {
    events.log('events.attention.privacy_enforced', {
      user_id: sessionUserId,
      enforcement_action:
        decision.preference === 'none'
          ? 'retention_none_realtime_only'
          : 'retention_minimal_window',
    });
  }
  const userRef = accountRef(identity.config.masterSecret, sessionUserId);

  for (const event of batch) {
    // 1. Ownership: the event's user must be the authenticated session user
    //    (one user can never attribute attention to another, WS-E.1.3a).
    if (event.user_id !== sessionUserId) {
      outcomes.push('ownership_mismatch');
      continue;
    }
    // 2. Timestamp acceptance window (WS-E.1.3b).
    const eventMs = Date.parse(event.timestamp);
    if (eventMs < now - policy.maxPastMs) {
      outcomes.push('stale_timestamp');
      continue;
    }
    if (eventMs > now + policy.maxFutureMs) {
      outcomes.push('future_timestamp');
      continue;
    }
    // 3. Replay nonce — fast layer (user-scoped key; non-reversible ref).
    const fresh = await events.replay.putIfAbsent(
      `evnonce:${userRef}:${event.nonce}`,
      NONCE_TTL_MS,
      now,
    );
    if (!fresh) {
      outcomes.push('replay');
      continue;
    }
    // 4. Privacy gate (server-side enforcement, WS-E.1.3d).
    if (!decision || decision.action === 'discard') {
      events.log('events.attention.privacy_enforced', {
        user_id: sessionUserId,
        enforcement_action: decision ? decision.reason : 'unknown_user',
      });
      outcomes.push('discarded_privacy');
      continue;
    }

    // 5. Build storage rows. The claimed collection level can only ever
    //    STRENGTHEN pseudonymization relative to the server floor.
    const level = effectivePrivacyLevel(event.privacy_level);
    const pseudonymous = level === 'minimum';
    const purgeAfter = attentionPurgeAfterIso(decision.preference, eventMs, now);
    const storedPayload = asRecord(
      pseudonymous ? { ...event, user_id: PSEUDONYMOUS_USER_ID } : event,
    );
    const registryEntry = TOPIC_REGISTRY[event.event_type];
    storeIndexByEventId.set(event.event_id, outcomes.length);
    toStore.push({
      eventId: event.event_id,
      eventType: event.event_type,
      topic: event.event_type,
      timestamp: event.timestamp,
      privacyClassification: registryEntry.privacy_classification,
      retentionTier: registryEntry.retention_tier,
      payload: storedPayload,
      // Server-receipt instant from the injectable clock (one clock source:
      // the scheduler's freshness comparison depends on it).
      createdAt: new Date(now).toISOString(),
      // Pseudonymized rows carry no owner: they are already de-linked, which
      // is strictly stronger than deletion-on-request (SPEC §19.2).
      ownerUserId: pseudonymous ? null : sessionUserId,
      purgeAfter,
    });
    toPublish.push(storedPayload as unknown as AttentionIngestEvent);

    // Durable §22.1 aggregate rows — only when the preference retains them.
    if (decision.persistDurable && event.event_type === 'attention.aggregate') {
      for (const item of event.items) {
        aggregateRowsByEvent.push({
          eventId: event.event_id,
          row: {
            aggregate_id: randomUUID(),
            user_id_or_privacy_bucket: pseudonymous ? PRIVACY_BUCKET : sessionUserId,
            story_id: item.story_id,
            session_bucket: event.session_bucket,
            active_dwell_bucket: item.active_dwell_bucket,
            source_opened: item.source_opened,
            context_opened: item.context_opened,
            branch_depth_bucket: item.branch_depth_bucket,
            return_visit_count_bucket: item.return_visit_count_bucket,
            privacy_level: level,
            created_at: event.timestamp,
          },
        });
      }
    }
    outcomes.push('accepted');
  }

  // 6. Durable insert. A duplicate event_id here is a replay that outlived the
  //    nonce TTL — re-classify it (the durable backstop, WS-E.1.3b). Its §22.1
  //    aggregate rows are dropped with it: a replayed batch must never add
  //    fresh aggregate rows (they would double-count in retention/export).
  const { duplicateIds } = await events.eventStore.insertMany(toStore);
  for (const duplicateId of duplicateIds) {
    const index = storeIndexByEventId.get(duplicateId);
    if (index !== undefined) outcomes[index] = 'replay';
  }
  const duplicateSet = new Set(duplicateIds);
  const aggregateRows = aggregateRowsByEvent
    .filter(({ eventId }) => !duplicateSet.has(eventId))
    .map(({ row }) => row);
  if (aggregateRows.length > 0) {
    await events.attentionStore.insertMany(aggregateRows);
  }

  // 7. Publish accepted events to the router (real-time aggregation etc.).
  let accepted = 0;
  for (const event of toPublish) {
    if (duplicateSet.has(event.event_id)) continue;
    accepted += 1;
    await events.router.publish(event);
  }

  // Observability: ids and counts only — never an attention value.
  events.metrics.increment('events_attention_accepted', accepted);
  for (const outcome of outcomes) {
    if (outcome !== 'accepted') events.metrics.increment(`events_attention_rejected_${outcome}`, 1);
  }
  if (accepted > 0) {
    events.log('events.attention.accepted', {
      user_id: sessionUserId,
      event_ids: toStore.map((row) => row.eventId),
      count: accepted,
    });
  }

  return { outcomes, accepted };
}

/**
 * Convert one legacy §22.1 aggregate (the WS-C batch wire) into a canonical
 * single-item `attention.aggregate` event. The client-generated aggregate_id
 * becomes BOTH the event id and the replay nonce, so a replayed batch item is
 * rejected by the same two replay layers as the canonical endpoint.
 */
export function aggregateToCanonicalEvent(
  aggregate: AttentionAggregate,
  sessionUserId: string,
): AttentionAggregateEvent {
  return attentionAggregateEventSchema.parse({
    event_id: aggregate.aggregate_id,
    event_type: 'attention.aggregate',
    timestamp: aggregate.created_at,
    schema_version: '1',
    nonce: aggregate.aggregate_id,
    user_id: sessionUserId,
    privacy_level: aggregate.privacy_level,
    session_bucket: aggregate.session_bucket,
    items: [
      {
        story_id: aggregate.story_id,
        active_dwell_bucket: aggregate.active_dwell_bucket,
        source_opened: aggregate.source_opened,
        context_opened: aggregate.context_opened,
        branch_depth_bucket: aggregate.branch_depth_bucket,
        return_visit_count_bucket: aggregate.return_visit_count_bucket,
      },
    ],
    privacy_classification: 'aggregated',
    retention_tier: 'attention_aggregated',
  });
}

/**
 * Ownership rule for the legacy batch wire: every aggregate must belong to the
 * session user — its identifier is either the session user id or the coarse
 * privacy bucket (whose ownership the session itself attests).
 */
export function aggregateBelongsToSession(
  aggregate: AttentionAggregate,
  sessionUserId: string,
): boolean {
  return (
    aggregate.user_id_or_privacy_bucket === sessionUserId ||
    aggregate.user_id_or_privacy_bucket === PRIVACY_BUCKET
  );
}
