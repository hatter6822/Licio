// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H invariant-platform tables (SPEC §21.4, §30.4).
//
// `invariant_promotions` is the APPEND-ONLY record behind the WS-H.1.2e
// shadow-to-enforcement gate: an invariant's current shadow_status is the
// latest record's to_status (no records = shadow), promotions are validated
// against the checklist at the application layer, and a demotion (the kill
// switch) is just another appended record — effective without redeploy.
//
// `invariant_calibrations` holds versioned precomputed null calibrations
// (MFCI cheap statistics) and similar reference data; `invariant_run_metadata`
// records every tier execution for the WS-H.1.2f/g observability surface;
// `mfci_cases` is the analyst review queue for high/severe coordination
// findings (WS-H.3.4b — WS-J takes ownership of queue UX later, through this
// same table).

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Append-only shadow-status history (WS-H.1.2e). */
export const invariantPromotions = pgTable(
  'invariant_promotions',
  {
    promotionId: uuid('promotion_id').primaryKey().defaultRandom(),
    invariantType: text('invariant_type').notNull(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    /** Checklist evidence: shadow days, drift report ref, coverage stats. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
    /** Named owner sign-off — never a service account. */
    owner: text('owner').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('invariant_promotions_type_idx').on(t.invariantType, t.createdAt),
    check(
      'invariant_promotions_from_status',
      sql`${t.fromStatus} in ('shadow', 'soft_constraint', 'hard_constraint')`,
    ),
    check(
      'invariant_promotions_to_status',
      sql`${t.toStatus} in ('shadow', 'soft_constraint', 'hard_constraint')`,
    ),
    check('invariant_promotions_owner_len', sql`char_length(${t.owner}) between 1 and 256`),
  ],
);

/** Versioned reference calibrations (MFCI null quantiles, …). */
export const invariantCalibrations = pgTable(
  'invariant_calibrations',
  {
    calibrationKey: text('calibration_key').primaryKey(),
    version: text('version').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    sampleCount: integer('sample_count').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => [check('invariant_calibrations_samples', sql`${t.sampleCount} >= 0`)],
);

/** Per-run execution metadata (WS-H.1.2f observability). */
export const invariantRunMetadata = pgTable(
  'invariant_run_metadata',
  {
    runId: uuid('run_id').primaryKey().defaultRandom(),
    invariantType: text('invariant_type').notNull(),
    tier: text('tier').notNull(),
    targetCount: integer('target_count').notNull(),
    durationMs: integer('duration_ms').notNull(),
    success: boolean('success').notNull(),
    /** Reason-code or error class on failure; never payload contents. */
    failureReason: text('failure_reason'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('invariant_run_metadata_type_idx').on(t.invariantType, t.startedAt),
    check('invariant_run_metadata_tier', sql`${t.tier} in ('realtime', 'near_realtime', 'batch')`),
    check('invariant_run_metadata_nonneg', sql`${t.targetCount} >= 0 and ${t.durationMs} >= 0`),
  ],
);

/** MFCI analyst review queue (WS-H.3.4b; WS-J consumes the same rows). */
export const mfciCases = pgTable(
  'mfci_cases',
  {
    caseId: uuid('case_id').primaryKey().defaultRandom(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    riskState: text('risk_state').notNull(),
    statistic: text('statistic').notNull(),
    mfciScore: doublePrecision('mfci_score').notNull(),
    pHat: doublePrecision('p_hat').notNull(),
    sampleCount: integer('sample_count').notNull(),
    /** Persisted margin reference (MFCI-4: every action logs its margins). */
    fixedMarginsRef: text('fixed_margins_ref').notNull(),
    /** Identifier-free analyst rationale. */
    summary: text('summary').notNull(),
    /** Identifier-free appeal-facing rationale (MFCI-5). */
    appealSummary: text('appeal_summary').notNull(),
    status: text('status').notNull().default('open'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** Steward reference (`steward:<uuid>`), never a raw identity. */
    resolvedBy: text('resolved_by'),
  },
  (t) => [
    index('mfci_cases_status_idx').on(t.status, t.openedAt),
    index('mfci_cases_target_idx').on(t.targetId),
    check('mfci_cases_risk_state', sql`${t.riskState} in ('normal', 'elevated', 'high', 'severe')`),
    check('mfci_cases_status', sql`${t.status} in ('open', 'confirmed', 'cleared', 'escalated')`),
    check('mfci_cases_p_hat', sql`${t.pHat} > 0 and ${t.pHat} <= 1`),
    check('mfci_cases_nonneg', sql`${t.mfciScore} >= 0 and ${t.sampleCount} >= 0`),
  ],
);

/**
 * Persisted conditioning margins (WS-H.3.2b / MFCI-4): every MFCI output's
 * `fixed_margins_ref` resolves HERE, so an analyst can always see exactly
 * which margins an automated coordination decision conditioned on. One
 * content-addressed row per (window, table) — idempotent across recomputes.
 */
export const mfciMargins = pgTable(
  'mfci_margins',
  {
    marginsRef: text('margins_ref').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    /** { axes: string[], margins: number[][], total: number } */
    margins: jsonb('margins').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mfci_margins_window_idx').on(t.windowStart),
    check('mfci_margins_ref_len', sql`char_length(${t.marginsRef}) between 1 and 256`),
  ],
);

/**
 * Per-target MFCI risk state (WS-H.3.4a): upward transitions follow the
 * score immediately; DOWNWARD transitions are held until a converged fiber
 * test clears or an analyst overrides — a freeze never silently melts.
 * `reason` records why the state last moved (or why it was held).
 */
export const mfciRiskStates = pgTable(
  'mfci_risk_states',
  {
    targetId: uuid('target_id').primaryKey(),
    state: text('state').notNull(),
    score: doublePrecision('score').notNull(),
    reason: text('reason').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('mfci_risk_states_state', sql`${t.state} in ('normal', 'elevated', 'high', 'severe')`),
    check(
      'mfci_risk_states_reason',
      sql`${t.reason} in ('score', 'fiber_cleared', 'analyst_override', 'held_pending_review')`,
    ),
    check('mfci_risk_states_score', sql`${t.score} >= 0`),
  ],
);

/**
 * Bridge requests/attempts (WS-H.4.2d / SCOI-2): routing records for
 * multi-community participants, the SCOI baseline at request time, and the
 * credit decision when a bridge contribution measurably reduces the
 * obstruction. Records only — notification dispatch is a later seam.
 */
export const bridgeAttempts = pgTable(
  'bridge_attempts',
  {
    attemptId: uuid('attempt_id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id').notNull(),
    storyId: uuid('story_id').notNull(),
    status: text('status').notNull().default('requested'),
    /** `steward:<uuid>` or `system:scoi`. */
    requestedBy: text('requested_by').notNull(),
    /** Routed candidate user ids (multi-lens participants). */
    candidateUserIds: jsonb('candidate_user_ids').$type<string[]>().notNull(),
    contributionId: uuid('contribution_id'),
    bridgeUserId: uuid('bridge_user_id'),
    scoiBaseline: doublePrecision('scoi_baseline').notNull(),
    scoiAfter: doublePrecision('scoi_after'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('bridge_attempts_thread_idx').on(t.threadId, t.status),
    /**
     * At most ONE open request per thread — the constraint the route's
     * `openForThread()` pre-check could only approximate.
     *
     * Two stewards of the same room both see the Civic Map's fragile join, so
     * the concurrent pair is the expected case: both read "none open" and both
     * insert. The duplicate is not the harm — the credit consumer credits the
     * NEWEST, after which the older row is "the open attempt" again and a later
     * contribution credits a second time for one bridge.
     *
     * PARTIAL: a thread accumulates any number of CREDITED attempts over its
     * life, and this must not forbid the next one.
     */
    uniqueIndex('bridge_attempts_open_thread_uq')
      .on(t.threadId)
      .where(sql`${t.status} = 'requested'`),
    check('bridge_attempts_status', sql`${t.status} in ('requested', 'credited')`),
    check('bridge_attempts_baseline', sql`${t.scoiBaseline} >= 0 and ${t.scoiBaseline} <= 1`),
  ],
);

export type InvariantPromotionRow = typeof invariantPromotions.$inferSelect;
export type InvariantCalibrationRow = typeof invariantCalibrations.$inferSelect;
export type InvariantRunMetadataRow = typeof invariantRunMetadata.$inferSelect;
export type MfciCaseRow = typeof mfciCases.$inferSelect;
export type MfciMarginsRow = typeof mfciMargins.$inferSelect;
export type MfciRiskStateRow = typeof mfciRiskStates.$inferSelect;
export type BridgeAttemptRow = typeof bridgeAttempts.$inferSelect;
