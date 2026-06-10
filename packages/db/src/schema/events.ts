// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-E event-pipeline tables (WS-E.3.1, SPEC §21.3/§22.1/§22.4).
//
// `events` is the durable system of record for every validated event. It is
// LIST-partitioned by `retention_tier` (declared in the hand-tuned migration —
// Drizzle's table API cannot express PARTITION BY, but queries are unaffected)
// so retention sweeps prune partitions instead of full-scanning, and a
// partition drop is provably complete deletion. The composite primary key
// includes the partition key, and `event_id` uniqueness within a tier is the
// durable replay/idempotency backstop (WS-E.1.3b): a captured event can never
// be ingested twice, even after the Redis nonce TTL lapses.
//
// `privacy_classification` and `retention_tier` are NOT NULL enums — the
// storage-layer defense in depth: even a code path that bypassed schema
// validation cannot persist an unclassified event.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './user.js';

// Mirrors of the closed shared enums (packages/shared events schemas); the
// shared zod schemas remain the wire SSOT, these enforce the same domains at
// rest.
export const eventPrivacyClassificationEnum = pgEnum('event_privacy_classification', [
  'public',
  'aggregated',
  'sensitive',
  'restricted',
]);

export const retentionTierEnum = pgEnum('retention_tier', [
  'attention_raw',
  'attention_aggregated',
  'public_contribution',
  'ranking_log',
  'moderation_legal',
  'account_active',
  'security_log',
]);

export const dwellBucketEnum = pgEnum('dwell_bucket', [
  'none',
  'glance',
  'short',
  'medium',
  'long',
  'extended',
]);

export const branchDepthBucketEnum = pgEnum('branch_depth_bucket', [
  'none',
  'shallow',
  'moderate',
  'deep',
]);

export const returnVisitBucketEnum = pgEnum('return_visit_bucket', [
  'none',
  'few',
  'several',
  'many',
]);

export const collectionPrivacyLevelEnum = pgEnum('collection_privacy_level', [
  'standard',
  'reduced',
  'minimum',
]);

export const itemSafetyStateEnum = pgEnum('item_safety_state', ['normal', 'frozen', 'removed']);

export const aggregationWindowSizeEnum = pgEnum('aggregation_window_size', [
  '1h',
  '6h',
  '24h',
  '7d',
]);

/** Durable, structured event store (WS-E.3.1). Partitioned by retention tier. */
export const events = pgTable(
  'events',
  {
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    /** Routing key; identical to event_type in schema version 1. */
    topic: text('topic').notNull(),
    /** Event time (client-claimed, bounded by the WS-E.1.3b acceptance window). */
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    privacyClassification: eventPrivacyClassificationEnum('privacy_classification').notNull(),
    retentionTier: retentionTierEnum('retention_tier').notNull(),
    /** The validated topic payload (conforms to the registry schema). */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /**
     * The owning user for deletion/export-on-request (SPEC §19.3); null for
     * unowned system events AND for pseudonymized (minimum-privacy) attention
     * events, whose payloads are already de-linked from the user.
     */
    ownerUserId: uuid('owner_user_id').references(() => users.userId, { onDelete: 'set null' }),
    /** Server receipt time. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Hard purge deadline computed at write time from tier + user retention
     * preference + jurisdiction override (WS-E.1.4); null ⇒ tier default
     * applies at sweep time.
     */
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
    /** Set by the annual-review sweep for moderation_legal rows (WS-E.1.4). */
    reviewFlaggedAt: timestamp('review_flagged_at', { withTimezone: true }),
  },
  (t) => [
    // The partition key must be part of the PK on a partitioned table.
    primaryKey({ columns: [t.eventId, t.retentionTier] }),
    index('events_topic_timestamp_idx').on(t.topic, t.timestamp),
    index('events_owner_idx').on(t.ownerUserId).where(sql`${t.ownerUserId} is not null`),
    index('events_purge_after_idx').on(t.purgeAfter).where(sql`${t.purgeAfter} is not null`),
    index('events_tier_timestamp_idx').on(t.retentionTier, t.timestamp),
  ],
);

/**
 * The §22.1 AttentionAggregate entity, field-for-field (WS-E.3.1 acceptance:
 * exact name parity — asserted in tests). One row per per-item attention
 * summary accepted at the ingestion boundary.
 */
export const attentionAggregates = pgTable(
  'attention_aggregates',
  {
    aggregateId: uuid('aggregate_id').primaryKey(),
    userIdOrPrivacyBucket: text('user_id_or_privacy_bucket').notNull(),
    storyId: uuid('story_id').notNull(),
    sessionBucket: text('session_bucket').notNull(),
    activeDwellBucket: dwellBucketEnum('active_dwell_bucket').notNull(),
    sourceOpened: boolean('source_opened').notNull(),
    contextOpened: boolean('context_opened').notNull(),
    branchDepthBucket: branchDepthBucketEnum('branch_depth_bucket').notNull(),
    returnVisitCountBucket: returnVisitBucketEnum('return_visit_count_bucket').notNull(),
    privacyLevel: collectionPrivacyLevelEnum('privacy_level').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('attention_aggregates_user_idx').on(t.userIdOrPrivacyBucket),
    index('attention_aggregates_story_created_idx').on(t.storyId, t.createdAt),
    index('attention_aggregates_created_idx').on(t.createdAt),
    check(
      'attention_aggregates_user_len',
      sql`char_length(${t.userIdOrPrivacyBucket}) between 1 and 128`,
    ),
  ],
);

/** Time-bucketed per-item aggregation results (WS-E.2.1a). */
export const aggregationWindows = pgTable(
  'aggregation_windows',
  {
    itemId: uuid('item_id').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowSize: aggregationWindowSizeEnum('window_size').notNull(),
    /** Distinct actors with any active attention (per-user dedup applied). */
    uniqueActiveUsers: integer('unique_active_users').notNull(),
    sourceOpens: integer('source_opens').notNull(),
    contextOpens: integer('context_opens').notNull(),
    returnVisits: integer('return_visits').notNull(),
    /** Counts by EVENT_CONTRIBUTION_TYPES key. */
    contributionCounts: jsonb('contribution_counts').$type<Record<string, number>>().notNull(),
    /** Counts by INTEGRITY_SIGNAL_TYPES key. */
    antiSignalCounts: jsonb('anti_signal_counts').$type<Record<string, number>>().notNull(),
    /** Total events folded into the window (idempotency/threshold metric). */
    eventCount: integer('event_count').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.windowStart, t.windowSize] }),
    index('aggregation_windows_start_idx').on(t.windowStart),
    check(
      'aggregation_windows_nonneg',
      sql`${t.uniqueActiveUsers} >= 0 and ${t.sourceOpens} >= 0 and ${t.contextOpens} >= 0 and ${t.returnVisits} >= 0 and ${t.eventCount} >= 0`,
    ),
  ],
);

/** InvariantOutput (SPEC §22.1) + the WS-E.2.1e shadow-mode flag. */
export const invariantOutputs = pgTable(
  'invariant_outputs',
  {
    invariantOutputId: uuid('invariant_output_id').primaryKey().defaultRandom(),
    invariantType: text('invariant_type').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    timeWindow: text('time_window').notNull(),
    version: text('version').notNull(),
    scoreVector: jsonb('score_vector').$type<Record<string, number>>().notNull(),
    explanationSummary: text('explanation_summary'),
    confidence: doublePrecision('confidence').notNull(),
    /**
     * True ⇒ the output has ZERO distribution power (SPEC §30.5). The ranking
     * boundary independently rejects shadow rows; lifting shadow mode is a
     * code change (PWATT_V0_SHADOW_MODE), never configuration.
     */
    shadowMode: boolean('shadow_mode').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invariant_outputs_run_idx').on(
      t.invariantType,
      t.targetType,
      t.targetId,
      t.timeWindow,
      t.version,
    ),
    index('invariant_outputs_target_idx').on(t.targetId, t.createdAt),
    index('invariant_outputs_created_idx').on(t.createdAt),
    check('invariant_outputs_confidence', sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  ],
);

/** The private, owner-only Signal Ledger (WS-E.2.1d, SPEC §19.3). */
export const signalLedgerEntries = pgTable(
  'signal_ledger_entries',
  {
    entryId: uuid('entry_id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    itemId: uuid('item_id').notNull(),
    storyTitle: text('story_title').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowSize: aggregationWindowSizeEnum('window_size').notNull(),
    /** Bucketed signal breakdown (attention + participation), never raw values. */
    signals: jsonb('signals').$type<Record<string, unknown>>().notNull(),
    /** Anti-signals applied to this item/window (transparency, §5.3). */
    antiSignals: jsonb('anti_signals').$type<string[]>().notNull(),
    /** The user's own PWAtt v0 shadow score (0-1). */
    pwattScore: doublePrecision('pwatt_score').notNull(),
    /** Plain-language explanation of how signals were counted. */
    summary: text('summary').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    /** Retention coupling (WS-E.1.4): expires with the user's attention data. */
    purgeAfter: timestamp('purge_after', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('signal_ledger_window_idx').on(
      t.ownerUserId,
      t.itemId,
      t.windowStart,
      t.windowSize,
    ),
    index('signal_ledger_owner_recorded_idx').on(t.ownerUserId, t.recordedAt),
    index('signal_ledger_purge_idx').on(t.purgeAfter),
    check('signal_ledger_score_range', sql`${t.pwattScore} >= 0 and ${t.pwattScore} <= 1`),
  ],
);

/** Per-item safety state for the PWAtt growth freeze (WS-E.2.3e / WS-E.2.2c). */
export const itemSafetyStates = pgTable('item_safety_states', {
  itemId: uuid('item_id').primaryKey(),
  safetyState: itemSafetyStateEnum('safety_state').notNull().default('normal'),
  /** The pinned score while frozen; null when not frozen. */
  frozenScore: doublePrecision('frozen_score'),
  /** The moderation/safety case that drove the current state, when any. */
  caseId: uuid('case_id'),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Tunable PWAtt configuration (WS-E.2.3a-d: changeable without redeploy). */
export const pwattConfig = pgTable('pwatt_config', {
  configKey: text('config_key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Dead-lettered events per consumer (WS-E.1.5): poisoned events never loop. */
export const eventDeadLetters = pgTable(
  'event_dead_letters',
  {
    deadLetterId: uuid('dead_letter_id').primaryKey().defaultRandom(),
    consumerName: text('consumer_name').notNull(),
    eventId: uuid('event_id').notNull(),
    topic: text('topic').notNull(),
    error: text('error').notNull(),
    attempts: integer('attempts').notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('event_dead_letters_consumer_idx').on(t.consumerName, t.failedAt),
    // At most ONE letter per (consumer, event): repeated failures update the
    // letter (accumulating attempts) instead of duplicating it.
    uniqueIndex('event_dead_letters_consumer_event_idx').on(t.consumerName, t.eventId),
  ],
);

/** Durable consumer replay checkpoints (WS-E.1.5 at-least-once recovery). */
export const consumerCheckpoints = pgTable('consumer_checkpoints', {
  consumerName: text('consumer_name').primaryKey(),
  lastEventTimestamp: timestamp('last_event_timestamp', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type EventRow = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
export type AttentionAggregateRow = typeof attentionAggregates.$inferSelect;
export type AggregationWindowRow = typeof aggregationWindows.$inferSelect;
export type InvariantOutputRow = typeof invariantOutputs.$inferSelect;
export type SignalLedgerEntryRow = typeof signalLedgerEntries.$inferSelect;
export type ItemSafetyStateRow = typeof itemSafetyStates.$inferSelect;
export type EventDeadLetterRow = typeof eventDeadLetters.$inferSelect;
