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

export type InvariantPromotionRow = typeof invariantPromotions.$inferSelect;
export type InvariantCalibrationRow = typeof invariantCalibrations.$inferSelect;
export type InvariantRunMetadataRow = typeof invariantRunMetadata.$inferSelect;
export type MfciCaseRow = typeof mfciCases.$inferSelect;
