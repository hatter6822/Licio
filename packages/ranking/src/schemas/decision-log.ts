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

/** Reasons the fallback ranker can serve (WS-I.4.1b). */
export const FALLBACK_REASONS = [
  'kill_switch',
  'pipeline_error',
  'user_mode',
  'empty_pool',
  'gwei_gate',
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/** The user-selected deterministic sort orders a `user_mode` decision can
 *  serve (SPEC §11.6 feed modes; `best` is the ranked pipeline, not one of
 *  these). */
export const USER_ORDERINGS = ['new', 'rising', 'sources', 'debates'] as const;
export type UserOrdering = (typeof USER_ORDERINGS)[number];

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
    /** False ⇒ the quota did not apply to this request (e.g. the local
     *  quota with no local signal) — distinct from a real shortfall.
     *  Defaulted for logs written before the field existed. */
    applicable: z.boolean().default(true),
  })
  .strict();
export type QuotaOutcome = z.infer<typeof quotaOutcomeSchema>;

/** Promotion-enforcement flags in force at decision time (WS-H.1.2e).
 *  `scoi` is DEPRECATED — the SCOI constraint ladder was removed; the key
 *  stays optional so pre-removal snapshots keep parsing on replay. */
export const enforcementSnapshotSchema = z
  .object({
    mfci: z.boolean(),
    phi: z.boolean(),
    hodge: z.boolean(),
    meri: z.boolean(),
    tropical: z.boolean(),
    scoi: z.boolean().optional(),
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
    /** item id → lens id (room surfaces; WS-I.2.4b lens balancing). Pinned
     *  here because lens assignments affect the ordering. Defaulted for
     *  logs written before lens balancing carried real data. */
    lens_by_item: z.record(uuid, z.string().min(1).max(64)).nullable().default(null),
    /**
     * Whether the §11.5 sensitive-freshness CAP was in force at serve time.
     *
     * The POLICY, recorded alongside the inputs — not re-derived on replay from
     * `profile_snapshot.profile_version`, which is an operator-writable label
     * and so answers neither direction of this question reliably (see
     * `RankingRequestContext.sensitiveFreshnessCap`).  Defaults to false so a
     * decision logged before the cap existed replays the formula it was actually
     * served under, which is the whole reason replay needs to know.
     */
    sensitive_freshness_cap: z.boolean().default(false),
  })
  .strict();
export type ReplayInputs = z.infer<typeof replayInputsSchema>;

export const rankingDecisionLogSchema = z
  .object({
    request_id: uuid,
    /** The PREVIOUS page's request id when this decision served a
     *  seen-aware pagination request (`?cursor=`); null on first pages.
     *  Links the page chain for exclusion resolution and audit lineage.
     *  Defaulted so logs written before pagination existed still parse. */
    parent_request_id: uuid.nullable().default(null),
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
    /** WS-Q.4.2b — candidates dropped by the always-on visibility distribution
     *  gate (item-tier + room-tier containment). Defaulted so pre-WS-Q logs
     *  still parse and replay. */
    visibility_excluded_count: z.number().int().nonnegative().default(0),
    quota_outcomes: z.array(quotaOutcomeSchema),
    /** DEPRECATED — the per-item explanation system was removed; the field
     *  stays optional so pre-removal logs keep parsing. Never written now. */
    explanation_ids: z.record(uuid, z.string().min(1).max(64)).optional(),
    experiment_ids: z.array(z.string().min(1).max(64)),
    timestamp: z.string(),
    /** Replay keys (in addition to §23.3): profile + feature versions. */
    profile_id: z.string().min(1).max(64),
    profile_version: z.string().min(1).max(32),
    feature_version: z.number().int().positive(),
    /** True when served by the safe fallback ranker (WS-I.4.1b). */
    fallback: z.boolean(),
    /** Why the fallback served, when it did. */
    fallback_reason: z.enum(FALLBACK_REASONS).nullable(),
    /** Which user-selected sort order served a `user_mode` decision (SPEC
     *  §11.6 feed modes; the ordering itself is deterministic but its metric
     *  inputs are not score components, so the audit records WHICH order
     *  ran). Null on ranked decisions and non-user-mode fallbacks; defaulted
     *  so logs written before the sort modes existed still parse. */
    user_ordering: z.enum(USER_ORDERINGS).nullable().default(null),
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
