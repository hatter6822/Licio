// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Attention events (WS-E.1.1b, SPEC §5.3/§19.2/§21.3/§22.4) — the single most
// privacy-critical schema in the system. The "no raw fields" guarantee is
// structural: every attention metric is a closed enum bucket (never a number),
// `.strict()` rejects unknown keys, and a dedicated test asserts the schema
// cannot be widened to accept a numeric dwell. Raw scroll/touch traces are
// processed in-browser and discarded (SPEC §19.2); only these bucketed shapes
// ever cross the network. Bucketing also prevents fingerprinting via precise
// dwell timing.
//
// Both topics carry a client-generated `nonce` (replay protection, WS-E.1.3b)
// and the §22.1 `privacy_level` (collection granularity) so the server can
// honor a MORE-private pseudonymization claim at persistence — never a less
// private one (see envelope.ts for the canonical field-name mapping).
import { z } from 'zod';
import {
  dwellBucketSchema,
  privacyLevelSchema,
  replyDepthBucketSchema,
  returnVisitBucketSchema,
} from '../attention.js';
import { uuidSchema } from '../common.js';
import { eventBaseShape } from './envelope.js';

/** Shared attention-topic envelope fields. */
const attentionEventShape = {
  ...eventBaseShape,
  /** Client-generated replay nonce (WS-E.1.3b); single-use per user. */
  nonce: uuidSchema,
  /** The authenticated owner; must match the session (WS-E.1.3a ownership). */
  user_id: uuidSchema,
  /**
   * Collection granularity claimed by the client (§22.1 `privacy_level`).
   * `minimum` ⇒ the persisted row carries the coarse privacy bucket, never the
   * user id. The server honors a more-private claim, never a less private one.
   */
  privacy_level: privacyLevelSchema,
  privacy_classification: z.literal('aggregated'),
  retention_tier: z.literal('attention_aggregated'),
} as const;

/**
 * One per-item attention summary inside `attention.aggregate`. Field names
 * match the §22.1 `AttentionAggregate` entity exactly (unit-asserted): every
 * metric is bucketed, capped by the bucket ceiling, and idle-filtered upstream
 * (WS-C.4). There is deliberately no numeric field of any kind.
 */
export const attentionAggregateItemSchema = z
  .object({
    story_id: uuidSchema,
    active_dwell_bucket: dwellBucketSchema,
    source_opened: z.boolean(),
    context_opened: z.boolean(),
    reply_depth_bucket: replyDepthBucketSchema,
    return_visit_count_bucket: returnVisitBucketSchema,
  })
  .strict();
export type AttentionAggregateItem = z.infer<typeof attentionAggregateItemSchema>;

/**
 * Periodic aggregated attention summary emitted by the client signal processor
 * (WS-C.4): the canonical `attention.aggregate` topic (SPEC §21.3).
 */
export const attentionAggregateEventSchema = z
  .object({
    ...attentionEventShape,
    event_type: z.literal('attention.aggregate'),
    /** Coarse, non-identifying session-window label (§22.1 `session_bucket`). */
    session_bucket: z.string().min(1).max(64),
    items: z.array(attentionAggregateItemSchema).min(1).max(50),
  })
  .strict();
export type AttentionAggregateEvent = z.infer<typeof attentionAggregateEventSchema>;

/**
 * Source-visit duration bucket for `source.opened.aggregate`. `brief` is the
 * bounce-adjacent bucket; scoring gives it zero or minimal weight (§5.3
 * clickbait guardrail). Coarse by design — never a duration.
 */
export const SOURCE_DWELL_BUCKETS = ['brief', 'moderate', 'extended'] as const;
export type SourceDwellBucket = (typeof SOURCE_DWELL_BUCKETS)[number];
export const sourceDwellBucketSchema = z.enum(SOURCE_DWELL_BUCKETS);

/**
 * A source-open report (SPEC §21.3 `source.opened.aggregate`). References only
 * the in-app `story_id`/`source_id` pair — both UUIDs, so an arbitrary external
 * URL is structurally rejected and no off-app browsing history can be implied
 * (SPEC §19.2 "no full browsing history outside the app"). `bounce` is a
 * boolean, never a duration.
 */
export const sourceOpenedAggregateEventSchema = z
  .object({
    ...attentionEventShape,
    event_type: z.literal('source.opened.aggregate'),
    story_id: uuidSchema,
    /** In-app source id (already-public canonical source), never a URL. */
    source_id: uuidSchema,
    dwell_bucket: sourceDwellBucketSchema,
    /** True when the user returned immediately (clickbait indicator, §5.3). */
    bounce: z.boolean(),
  })
  .strict();
export type SourceOpenedAggregateEvent = z.infer<typeof sourceOpenedAggregateEventSchema>;

/**
 * `content.saved` (SIG-ATT-SAVE, SPEC §5.3 "Save for later" — private by
 * default, LOW rank weight). A discrete, deduped save signal that rides the
 * SAME attention-ingestion privacy machinery as every other attention event
 * (ownership, replay nonce, privacy level, minimum-privacy pseudonymization,
 * retention preference). It carries ONLY the item id — never the user's saved
 * COLLECTION, which stays client-local (IndexedDB) and never reaches the server.
 * So a save aggregate is no more revealing than an attention aggregate: it says
 * "an interested reader kept this item", privacy-leveled, and contributes a low
 * weight to the item's ConstructiveParticipation.
 */
export const contentSavedAggregateEventSchema = z
  .object({
    ...attentionEventShape,
    event_type: z.literal('content.saved'),
    story_id: uuidSchema,
  })
  .strict();
export type ContentSavedAggregateEvent = z.infer<typeof contentSavedAggregateEventSchema>;
