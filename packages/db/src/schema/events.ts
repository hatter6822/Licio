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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { instant } from './_custom.js';
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

export const replyDepthBucketEnum = pgEnum('reply_depth_bucket', [
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
    timestamp: instant('timestamp').notNull(),
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
    createdAt: instant('created_at').notNull().defaultNow(),
    /**
     * Hard purge deadline computed at write time from tier + user retention
     * preference + jurisdiction override (WS-E.1.4); null ⇒ tier default
     * applies at sweep time.
     */
    purgeAfter: instant('purge_after'),
    /** Set by the annual-review sweep for moderation_legal rows (WS-E.1.4). */
    reviewFlaggedAt: instant('review_flagged_at'),
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
    /** Retained during the WS-T deploy window for pre-cutover clients/readers. */
    branchDepthBucket: branchDepthBucketEnum('branch_depth_bucket').notNull(),
    replyDepthBucket: replyDepthBucketEnum('reply_depth_bucket').notNull(),
    returnVisitCountBucket: returnVisitBucketEnum('return_visit_count_bucket').notNull(),
    privacyLevel: collectionPrivacyLevelEnum('privacy_level').notNull(),
    createdAt: instant('created_at').notNull(),
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
    windowStart: instant('window_start').notNull(),
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
    computedAt: instant('computed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.windowStart, t.windowSize] }),
    index('aggregation_windows_start_idx').on(t.windowStart),
    /**
     * The WS-H.7.4 landscape's read: one window, busiest first.
     *
     * `window_start` alone leaves the planner fetching every row in the hour and
     * sorting it by `event_count` before the LIMIT applies — and the landscape
     * calls it with growing limits while it scans past restricted stories, so
     * one Civic Map load repeated that full-hour sort several times. PARTIAL on
     * `event_count > 0`, because a zero row is not a landscape node and has no
     * business occupying the index.
     */
    index('aggregation_windows_active_idx')
      .on(t.windowStart, t.windowSize, t.eventCount.desc(), t.itemId)
      .where(sql`${t.eventCount} > 0`),
    check(
      'aggregation_windows_nonneg',
      sql`${t.uniqueActiveUsers} >= 0 and ${t.sourceOpens} >= 0 and ${t.contextOpens} >= 0 and ${t.returnVisits} >= 0 and ${t.eventCount} >= 0`,
    ),
  ],
);

/** Render a string vocabulary as a parenthesized SQL `IN (...)` value list, so
 *  a CHECK's allowed set is DERIVED from its single-source array rather than a
 *  hand-copied literal that could drift. */
function inList(values: readonly string[]) {
  return sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

/** The known invariant-type vocabulary at rest (12 WS-H + PWAtt shadow). */
export const INVARIANT_TYPE_DB_VALUES = [
  'MERI',
  'MFCI',
  'GWEI',
  'SCOI',
  'PHI',
  'hodge_tension',
  'tropical_cascade',
  'braid_dynamics',
  'reeb_landscape',
  'counterfactual_defect',
  'path_signature_wellbeing',
  'behavioral_authenticity',
  'PWAtt_v0',
  'PWAtt_v1',
] as const;

/** The six §22.1 target types (WS-H.1.1a). */
export const INVARIANT_TARGET_DB_VALUES = [
  'story',
  'thread',
  'feed',
  'room',
  'cohort',
  'session',
] as const;

/**
 * InvariantOutput (SPEC §22.1) + the WS-E.2.1e shadow-mode flag and the
 * WS-H.1.1a/b/c envelope: coverage, reason codes, fallback indicator, and
 * version metadata. `time_window` is JSONB `{start, end}` (half-open ISO
 * instants); `score_vector` is validated per invariant type at the
 * application layer (packages/invariants score-vector schemas) before any
 * insert — the DB CHECKs hold the closed type/target vocabularies and the
 * [0, 1] ranges.
 */
export const invariantOutputs = pgTable(
  'invariant_outputs',
  {
    invariantOutputId: uuid('invariant_output_id').primaryKey().defaultRandom(),
    invariantType: text('invariant_type').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    timeWindow: jsonb('time_window').$type<{ start: string; end: string }>().notNull(),
    version: text('version').notNull(),
    scoreVector: jsonb('score_vector').$type<Record<string, unknown>>().notNull(),
    explanationSummary: text('explanation_summary'),
    confidence: doublePrecision('confidence').notNull(),
    /** Fraction of required inputs available and fresh (WS-H.1.1c). */
    coverage: doublePrecision('coverage').notNull(),
    /** Registry-validated reason codes; empty array = unqualified output. */
    reasonCodes: jsonb('reason_codes').$type<string[]>().notNull().default([]),
    /** Derivable from reason codes; materialized for dashboard filters. */
    fallbackUsed: boolean('fallback_used').notNull().default(false),
    /** Algorithm parameters/config snapshot for reproducibility (WS-H.1.1b). */
    versionMetadata: jsonb('version_metadata').$type<Record<string, unknown>>(),
    /**
     * True ⇒ the output has ZERO distribution power (SPEC §30.5). The ranking
     * boundary independently rejects shadow rows; lifting shadow mode is a
     * code change (PWATT_V0_SHADOW_MODE), never configuration.
     */
    shadowMode: boolean('shadow_mode').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invariant_outputs_run_idx').on(
      t.invariantType,
      t.targetType,
      t.targetId,
      t.timeWindow,
      t.version,
    ),
    index('invariant_outputs_type_target_idx').on(t.invariantType, t.targetType, t.targetId),
    index('invariant_outputs_target_idx').on(t.targetId, t.invariantType),
    index('invariant_outputs_created_idx').on(t.createdAt),
    index('invariant_outputs_type_version_idx').on(t.invariantType, t.version),
    index('invariant_outputs_type_target_created_idx').on(
      t.invariantType,
      t.targetType,
      sql`${t.createdAt} DESC`,
    ),
    // Serves `InvariantOutputStore.latest()` — `(invariant_type, target_id)`
    // ORDER BY `created_at DESC`, the per-candidate-story read on the FEED
    // path.  Neither index above covers it: both key through `target_type`,
    // which this query does not filter on, so it fetched the target's whole
    // history and sorted it to take one row (migration 0101).
    index('invariant_outputs_type_target_latest_idx').on(
      t.invariantType,
      t.targetId,
      sql`${t.createdAt} DESC`,
    ),
    check('invariant_outputs_confidence', sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
    check('invariant_outputs_coverage', sql`${t.coverage} >= 0 and ${t.coverage} <= 1`),
    // The type/target vocabularies are DERIVED from the single-source arrays
    // (no hand-maintained second literal that could drift). A hand-authored
    // migration still writes the equivalent literal — a test pins that the
    // rendered CHECK matches this list.
    check('invariant_outputs_type', sql`${t.invariantType} in ${inList(INVARIANT_TYPE_DB_VALUES)}`),
    check(
      'invariant_outputs_target_type',
      sql`${t.targetType} in ${inList(INVARIANT_TARGET_DB_VALUES)}`,
    ),
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
    windowStart: instant('window_start').notNull(),
    windowSize: aggregationWindowSizeEnum('window_size').notNull(),
    /** Bucketed signal breakdown (attention + participation), never raw values. */
    signals: jsonb('signals').$type<Record<string, unknown>>().notNull(),
    /** Anti-signals applied to this item/window (transparency, §5.3). */
    antiSignals: jsonb('anti_signals').$type<string[]>().notNull(),
    /** The user's own PWAtt v0 shadow score (0-1). */
    pwattScore: doublePrecision('pwatt_score').notNull(),
    /** Plain-language explanation of how signals were counted. */
    summary: text('summary').notNull(),
    recordedAt: instant('recorded_at').notNull(),
    /** Retention coupling (WS-E.1.4): expires with the user's attention data. */
    purgeAfter: instant('purge_after').notNull(),
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
  /** The SERVED PWAtt components pinned at freeze time (§5.3 freeze growth):
   *  the ranking feature store reads components, not the composite, so the
   *  freeze must pin these or a frozen item keeps growing. Null when unfrozen. */
  frozenActiveAttention: doublePrecision('frozen_active_attention'),
  frozenParticipation: doublePrecision('frozen_participation'),
  /** The moderation/safety case that drove the current state, when any. */
  caseId: uuid('case_id'),
  updatedBy: text('updated_by').notNull(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

/** Tunable PWAtt configuration (WS-E.2.3a-d: changeable without redeploy). */
export const pwattConfig = pgTable('pwatt_config', {
  configKey: text('config_key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
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
    failedAt: instant('failed_at').notNull().defaultNow(),
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
  lastEventTimestamp: instant('last_event_timestamp').notNull(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

/**
 * Per-(actor, 1h window) behavior snapshot for the bot-prevention layer-2
 * authenticity assessment (WS-E/WS-H BAI).  Derived from the SAME deduplicated
 * per-item fold PWAtt scores — coarse §22.1 buckets only, nothing beyond what
 * the aggregates already disclose.  Only IDENTIFIABLE actors are recorded
 * (the coarse privacy-bucket actor is never profiled); rows die with the
 * account (FK cascade for dev deletes; the WS-D deletion job purges
 * explicitly, since production tombstones the users row) and are pruned past
 * the assessment lookback.
 */
export const actorBehaviorWindows = pgTable(
  'actor_behavior_windows',
  {
    actorRef: uuid('actor_ref')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    windowStart: instant('window_start').notNull(),
    eventCount: integer('event_count').notNull(),
    itemsTouched: integer('items_touched').notNull(),
    /** Count of items by per-item MAX dwell bucket (coarse §22.1 buckets). */
    dwellHistogram: jsonb('dwell_histogram').$type<Record<string, number>>().notNull(),
    replyDepthHistogram: jsonb('reply_depth_histogram').$type<Record<string, number>>().notNull(),
    returnHistogram: jsonb('return_histogram').$type<Record<string, number>>().notNull(),
    sourceOpens: integer('source_opens').notNull(),
    contextOpens: integer('context_opens').notNull(),
    saves: integer('saves').notNull(),
    contributions: integer('contributions').notNull(),
    computedAt: instant('computed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.actorRef, t.windowStart] }),
    index('actor_behavior_windows_start_idx').on(t.windowStart),
    check(
      'actor_behavior_windows_nonneg',
      sql`${t.eventCount} >= 0 and ${t.itemsTouched} >= 0 and ${t.sourceOpens} >= 0 and ${t.contextOpens} >= 0 and ${t.saves} >= 0 and ${t.contributions} >= 0`,
    ),
  ],
);

/**
 * The current per-actor authenticity assessment (bot-prevention layer 2):
 * the coherence multiplier, its components, and the near-duplicate cluster
 * membership.  INTERNAL integrity state — never a public surface, never an
 * export (the WS-J/WS-N anti-tipping-off posture for anti-abuse internals);
 * consumed by PWAtt scoring as a bounded trust factor and by the BAI
 * platform invariant as population statistics.
 */
export const actorAuthenticityScores = pgTable(
  'actor_authenticity_scores',
  {
    actorRef: uuid('actor_ref')
      .primaryKey()
      .references(() => users.userId, { onDelete: 'cascade' }),
    /** Effective multiplier (coherence × duplication, floored; (0, 1]). */
    score: doublePrecision('score').notNull(),
    /** Coherence composite before duplication ((0, 1]). */
    coherence: doublePrecision('coherence').notNull(),
    /** Per-component multipliers (dwell_variety, interaction_breadth, …). */
    components: jsonb('components').$type<Record<string, number>>().notNull(),
    /** Machine-readable component flags that fired. */
    flags: jsonb('flags').$type<string[]>().notNull().default([]),
    /** Scoring-topic events the assessment rests on. */
    evidence: integer('evidence').notNull(),
    /** Deterministic near-duplicate cluster id (null = unclustered). */
    clusterId: text('cluster_id'),
    clusterSize: integer('cluster_size').notNull().default(1),
    computedAt: instant('computed_at').notNull().defaultNow(),
  },
  (t) => [
    index('actor_authenticity_cluster_idx').on(t.clusterId),
    check('actor_authenticity_score_range', sql`${t.score} > 0 and ${t.score} <= 1`),
    check('actor_authenticity_coherence_range', sql`${t.coherence} > 0 and ${t.coherence} <= 1`),
    check(
      'actor_authenticity_cluster_size',
      sql`${t.clusterSize} >= 1 and (${t.clusterId} is not null or ${t.clusterSize} = 1)`,
    ),
  ],
);

export type EventRow = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
export type AttentionAggregateRow = typeof attentionAggregates.$inferSelect;
export type AggregationWindowRow = typeof aggregationWindows.$inferSelect;
export type InvariantOutputRow = typeof invariantOutputs.$inferSelect;
export type SignalLedgerEntryRow = typeof signalLedgerEntries.$inferSelect;
export type ItemSafetyStateRow = typeof itemSafetyStates.$inferSelect;
export type EventDeadLetterRow = typeof eventDeadLetters.$inferSelect;
export type ActorBehaviorWindowRow = typeof actorBehaviorWindows.$inferSelect;
export type ActorAuthenticityScoreRow = typeof actorAuthenticityScores.$inferSelect;
