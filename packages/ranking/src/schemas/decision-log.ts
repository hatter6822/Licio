// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.5a — the `RankingDecisionLog` audit record (SPEC §23.3, §22.4).
// Exactly ONE per served feed request, ranked or fallback. Carries the
// anonymized `user_privacy_bucket` (NEVER a raw user id — refined below), the
// full candidate and selected id lists, per-selected-item score breakdowns,
// the invariant versions and profile id/version used (the replay join keys,
// WS-I.2.5b), every constraint application, explanation ids, experiment ids,
// and the retention deadline (180–365 days, §22.4).

import { z } from 'zod';
import { rankingSurfaceSchema } from './candidate.js';
import { invariantVersionEntrySchema } from './feature-vector.js';
import { rankingProfileConfigSchema } from './profile.js';
import { scoredItemSchema } from './scored-item.js';

/** §22.4: ranking decision logs are retained 180–365 days. */
export const DECISION_LOG_RETENTION_MIN_DAYS = 180;
export const DECISION_LOG_RETENTION_MAX_DAYS = 365;

const uuid = z.string().uuid();

/**
 * The anonymized requester cohort. Shaped `bucket:<hex>` (a keyed-hash bucket,
 * WS-D crypto) or the literal `anonymous`; the refinement REJECTS anything
 * uuid-shaped so a raw user id can never be written even by mistake.
 */
export const userPrivacyBucketSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => v === 'anonymous' || /^bucket:[0-9a-f]{2,32}$/.test(v), {
    message: 'privacy bucket must be "anonymous" or "bucket:<hex>" — never an identifier',
  });

/** One constraint application entry (exclusion, demotion, gating). */
export const constraintApplicationSchema = z
  .object({
    constraint: z.string().min(1).max(64),
    item_id: uuid.nullable(),
    threshold: z.union([z.number(), z.string()]).nullable(),
    actual: z.union([z.number(), z.string()]).nullable(),
    action: z.enum(['excluded', 'demoted', 'context_card', 'reduced', 'paused', 'diversified']),
    /** False ⇒ computed and logged only (governing invariant still shadow). */
    enforced: z.boolean(),
  })
  .strict();
export type ConstraintApplication = z.infer<typeof constraintApplicationSchema>;

/** Safety-filter exclusion entry (WS-I.2.2a). */
export const safetyExclusionSchema = z
  .object({
    item_id: uuid,
    policy_reason: z.string().min(1).max(128),
    moderation_case_ref: z.string().max(128).nullable(),
  })
  .strict();
export type SafetyExclusion = z.infer<typeof safetyExclusionSchema>;

/** Per-quota outcome (WS-I.1.1b observability). */
export const quotaOutcomeSchema = z
  .object({
    quota_type: z.enum(['fresh', 'independent', 'local']),
    target_pct: z.number().min(0).max(100),
    achieved_pct: z.number().min(0).max(100),
    shortfall: z.boolean(),
  })
  .strict();
export type QuotaOutcome = z.infer<typeof quotaOutcomeSchema>;

/** Promotion-enforcement flags in force at decision time (WS-H.1.2e). */
export const enforcementSnapshotSchema = z
  .object({
    mfci: z.boolean(),
    phi: z.boolean(),
    hodge: z.boolean(),
    meri: z.boolean(),
    tropical: z.boolean(),
    scoi: z.boolean(),
    gwei: z.boolean(),
  })
  .strict();

/**
 * Everything replay needs beyond the feature revisions: the EXACT profile
 * served (snapshot — replay never depends on registry history), the
 * promotion-enforcement flags in force, the per-item RESOLVED topic
 * relevance (the user's interest LIST is never persisted — only the derived
 * per-item match values, under the same §22.4 access controls), the user's
 * PHI risk input, and any feed-mode balancing override.
 */
export const replayInputsSchema = z
  .object({
    profile_snapshot: rankingProfileConfigSchema,
    enforcement: enforcementSnapshotSchema,
    /** item id → resolved relevance; null ⇒ personalization off. */
    topic_relevance: z.record(uuid, z.number().min(0).max(1)).nullable(),
    user_phi_risk: z.number().nullable(),
    max_source_share_pct_override: z.number().int().min(1).max(100).nullable(),
    surface_room_id: uuid.nullable(),
  })
  .strict();
export type ReplayInputs = z.infer<typeof replayInputsSchema>;

export const rankingDecisionLogSchema = z
  .object({
    request_id: uuid,
    surface: rankingSurfaceSchema,
    user_privacy_bucket: userPrivacyBucketSchema,
    /** All candidate ids after retrieval (pre-safety-filter). */
    candidate_ids: z.array(uuid),
    /** Final ordered selection. */
    selected_ids: z.array(uuid),
    /** Full per-item breakdown for every SELECTED item, keyed by item id. */
    score_components: z.record(uuid, scoredItemSchema),
    /** Feature revision scored, for every FEASIBLE item (replay join). */
    feature_revisions: z.record(uuid, z.number().int().nonnegative()),
    /** invariant_name → version entry, union over selected items. */
    invariant_versions: z.record(z.string().min(1).max(64), invariantVersionEntrySchema),
    constraints_applied: z.array(constraintApplicationSchema),
    safety_exclusions: z.array(safetyExclusionSchema),
    quota_outcomes: z.array(quotaOutcomeSchema),
    /** item id → explanation template id (WS-I.2.6). */
    explanation_ids: z.record(uuid, z.string().min(1).max(64)),
    experiment_ids: z.array(z.string().min(1).max(64)),
    timestamp: z.string(),
    /** Replay keys (in addition to §23.3): profile + feature versions. */
    profile_id: z.string().min(1).max(64),
    profile_version: z.string().min(1).max(32),
    feature_version: z.number().int().positive(),
    /** True when served by the safe fallback ranker (WS-I.4.1b). */
    fallback: z.boolean(),
    /** Why the fallback served, when it did. */
    fallback_reason: z
      .enum(['kill_switch', 'pipeline_error', 'user_mode', 'empty_pool', 'gwei_gate'])
      .nullable(),
    /** Replay inputs (WS-I.2.5b); null only on fallback decisions. */
    replay_inputs: replayInputsSchema.nullable(),
    /** §22.4 retention deadline (180–365 days after `timestamp`). */
    retain_until: z.string(),
  })
  .strict()
  .refine((log) => log.selected_ids.every((id) => id in log.score_components) || log.fallback, {
    message: 'every ranked selected item must carry score components',
  });
export type RankingDecisionLog = z.infer<typeof rankingDecisionLogSchema>;

/** Compute the retention deadline, clamped to the §22.4 window. */
export function retentionDeadline(timestampIso: string, retentionDays: number): string {
  const days = Math.min(
    DECISION_LOG_RETENTION_MAX_DAYS,
    Math.max(DECISION_LOG_RETENTION_MIN_DAYS, Math.floor(retentionDays)),
  );
  return new Date(Date.parse(timestampIso) + days * 24 * 60 * 60 * 1000).toISOString();
}
