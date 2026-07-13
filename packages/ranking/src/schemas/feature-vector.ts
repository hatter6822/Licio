// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.1a/c — the per-item feature vector (SPEC §13.3 "invariant feature
// join", §21.2 feature store, §22.1 InvariantOutput mapping). The field set is
// CLOSED (`.strict()`): an unknown field — financial or otherwise — fails
// validation, which together with the WS-I.2.1b denylist gives defense in
// depth against financial-field injection. Every invariant-derived field is
// OPTIONAL: a degraded/missing invariant output is an ABSENT feature (ranking
// proceeds with the contribution omitted, WS-H.1.2c), never a fabricated zero.
//
// Field provenance (WS-I.2.1a acceptance "documented with their source"):
//   active_attention / constructive_participation . WS-E PWAtt v1 components
//   exposure_independence ......................... WS-H MERI (meri ∈ [0,1])
//   source_evidence_completeness .................. WS-F claims/evidence join
//   context_coherence_gain ........................ §5.4 C slot; NO current
//                                                   provider (the SCOI→ranking
//                                                   coupling was removed) —
//                                                   absent ⇒ contributes 0
//   meri_rank / redundancy_penalty ................ WS-H MERI
//   mfci_score / mfci_risk_state / coordination_penalty ... WS-H MFCI (+ tropical)
//   scoi_level .................................... DEPRECATED (no producer;
//                                                   kept so persisted feature
//                                                   revisions parse on replay)
//   gwei_cohort_disparity ......................... WS-H GWEI
//   (PHI has NO per-item feature: holonomy is a per-USER/session signal, so it
//    enters ranking as the per-user diversification constraint — see
//    `phiDiversification` — never a per-item penalty.)
//   hodge_harmonic_tension / harmful_tension_risk . WS-H Hodge (WS-J hostility seam)
//   tropical_cascade_rank ......................... WS-H tropical cascade
//   braid_agenda_entropy .......................... WS-H braid dynamics
//   reeb_landscape_basin_id ....................... WS-H Reeb landscape
//   cid_defect .................................... WS-H counterfactual defect
//   path_signature_wellbeing ...................... WS-H path signatures
//   freshness_decay ............................... WS-F freshness baseline
//   source_reliability ............................ WS-F source model history
//   topic_relevance ............................... per-REQUEST personalization
//                                                   (never stored; see below)

import { z } from 'zod';
import { findDeniedFields } from '../denylist.js';

/** Bump on any change to the feature-vector field set (WS-I.2.1c). */
// v2: the WS-I topic-validation cut — the PHI penalty inputs (`phi_risk`,
// `holonomy_risk`) were removed and `sensitivity_labels` added, changing the
// stored field set, so serve/replay cohorts stay distinguishable by version.
// v3 (WS-T): added `dispute_validation` (the validation-boost input). It changes
// the stored field set + the score for validated stories, so the version bumps —
// stale v2 rows self-heal via the migration-on-read rebuild (service.ts) and
// decision logs stay distinguishable, rather than silently mixing field sets.
// v4: the SCOI→ranking decoupling — `context_coherence_gain` and `scoi_level`
// are no longer populated. Without the bump, already-stored v3 rows would keep
// contributing `wC·C` to live scores until the next batch refresh touched
// them; the bump forces the migration-on-read rebuild on first serve, so the
// removal takes effect deterministically and serve cohorts stay
// distinguishable. (Store reads return persisted payloads raw — validation
// is write-side — so v3 rows flow into the version gate and replay still
// joins them by pinned revision; the two fields stay deprecated-optional so
// any future re-validation of historic rows stays tolerant.)
export const FEATURE_SCHEMA_VERSION = 4;

/** MFCI risk states as ranking features (SPEC §8.5). */
export const MFCI_RISK_STATE_FEATURES = ['normal', 'elevated', 'high', 'severe'] as const;
export type MfciRiskStateFeature = (typeof MFCI_RISK_STATE_FEATURES)[number];

/**
 * DEPRECATED — the SCOI ranking-constraint ladder was removed (it was
 * promotion-gated and never enforced; its upper levels were unreachable under
 * production calibration). The enum stays ONLY so persisted feature revisions
 * that carry `scoi_level` keep parsing on replay. No producer writes it.
 */
export const SCOI_LEVELS = ['low', 'medium', 'high', 'very_high'] as const;
export type ScoiLevel = (typeof SCOI_LEVELS)[number];

/** One invariant version entry (WS-I.2.1c traceability). */
export const invariantVersionEntrySchema = z
  .object({
    version_string: z.string().min(1).max(64),
    computation_timestamp: z.string(),
    /** Hash of the invariant's configuration at computation time. */
    config_hash: z.string().min(1).max(128),
  })
  .strict();
export type InvariantVersionEntry = z.infer<typeof invariantVersionEntrySchema>;

const unit = z.number().min(0).max(1);

/**
 * The strict per-item feature vector. Stored rows are item-scoped and shared
 * across users; `topic_relevance` is the ONE per-request field — it is merged
 * in at request time from the requesting user's own personalization settings
 * and is never persisted (a per-user value must not sit in a shared store).
 */
export const featureVectorSchema = z
  .object({
    // --- Metadata (required) ----------------------------------------------
    item_id: z.string().uuid(),
    item_type: z.enum(['story', 'thread']),
    room_id: z.string().uuid().nullable(),
    /** WS-Q.4.3 — item visibility recorded as a NON-SCORING eligibility/audit
     *  field (the scoring stage ignores it; the distribution gate reads it).
     *  Defaulted to `public` so pre-WS-Q feature snapshots replay correctly
     *  (every pre-WS-Q served item was public). */
    visibility: z.enum(['public', 'room_only']).default('public'),
    topic_ids: z.array(z.string().min(1).max(128)).max(16),
    /**
     * WS-F content-sensitivity labels (the story's `sensitivityLabels`, minus
     * `none`). A non-empty set marks the item sensitive — the per-ITEM signal
     * for the conservative decay curve + the §11.5 sensitive-content penalty.
     * Content sensitivity is a LABEL, not a topic (per-item topics are catalog
     * UUIDs); absent/empty ⇒ not sensitive. Optional so pre-existing feature
     * snapshots replay unchanged.
     */
    sensitivity_labels: z.array(z.string().min(1).max(32)).max(8).optional(),
    source_id: z.string().uuid().nullable(),
    created_at: z.string(),
    feature_version: z.literal(FEATURE_SCHEMA_VERSION),
    /** Monotonic per-item revision; stale writes are rejected (WS-I.2.1d). */
    revision: z.number().int().nonnegative(),
    /** Which invariant version produced each contributing field (immutable). */
    invariant_versions: z.record(z.string().min(1).max(64), invariantVersionEntrySchema),
    updated_at: z.string(),

    // --- PWAtt components (WS-E v1; each normalized to [0, 1]) -------------
    active_attention: unit.optional(),
    constructive_participation: unit.optional(),
    exposure_independence: unit.optional(),
    source_evidence_completeness: unit.optional(),
    context_coherence_gain: unit.optional(),

    // --- Invariant signals --------------------------------------------------
    meri_rank: z.number().int().nonnegative().optional(),
    mfci_score: z.number().nonnegative().optional(),
    mfci_risk_state: z.enum(MFCI_RISK_STATE_FEATURES).optional(),
    /** DEPRECATED — parse-compat only (see SCOI_LEVELS); never populated. */
    scoi_level: z.enum(SCOI_LEVELS).optional(),
    gwei_cohort_disparity: z.number().nonnegative().optional(),

    // --- Penalty terms (each normalized to [0, 1]) --------------------------
    coordination_penalty: unit.optional(),
    harmful_tension_risk: unit.optional(),
    redundancy_penalty: unit.optional(),
    // WS-T — a story adjudicated `incorrect` by a sourced-correction debate is
    // penalized to the bottom of the feed (a content-quality signal, uniform
    // across authors/topics, never financial — neutrality-safe).
    dispute_penalty: unit.optional(),
    /** WS-T: 1 when a sourced-correction debate UPHELD the story (`validated`) —
     *  challenged and PROVEN accurate. Drives a modest additive ranking BOOST
     *  (`disputeValidationBoost`). Uniform + content-derived, never applause. */
    dispute_validation: unit.optional(),

    // --- Baseline components ------------------------------------------------
    freshness_decay: unit.optional(),
    source_reliability: unit.optional(),
    /** Per-REQUEST only (never stored); see the schema doc comment. */
    topic_relevance: unit.optional(),

    // --- Supporting invariants ----------------------------------------------
    hodge_harmonic_tension: z.number().nonnegative().optional(),
    tropical_cascade_rank: z.number().nonnegative().optional(),
    braid_agenda_entropy: z.number().nonnegative().optional(),
    reeb_landscape_basin_id: z.string().min(1).max(64).optional(),
    cid_defect: z.number().nonnegative().optional(),
    path_signature_wellbeing: z.number().optional(),

    // --- MERI duplicate-cluster id for diversification (WS-I.2.4a) ----------
    duplicate_cluster_id: z.string().min(1).max(128).optional(),
  })
  .strict();
export type FeatureVector = z.infer<typeof featureVectorSchema>;

/** A validation failure at the feature-store write boundary. */
export interface FeatureValidationFailure {
  ok: false;
  /** Human-readable problems (schema issues and/or denied fields). */
  problems: string[];
  /** True when the failure was a denied financial field (WS-I.2.1b). */
  denied: boolean;
}

export interface FeatureValidationSuccess {
  ok: true;
  vector: FeatureVector;
}

export type FeatureValidationResult = FeatureValidationSuccess | FeatureValidationFailure;

/**
 * Validate a candidate feature vector for WRITE: the denylist runs FIRST on
 * the raw value (so a denied field is reported as such even though strict
 * mode would also reject it), then the strict schema.
 */
export function validateFeatureVector(value: unknown): FeatureValidationResult {
  const denied = findDeniedFields(value);
  if (denied.length > 0) {
    return {
      ok: false,
      denied: true,
      problems: denied.map(
        (f) => `denied financial field "${f.path}" (pattern "${f.matchedPattern}")`,
      ),
    };
  }
  const parsed = featureVectorSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      denied: false,
      problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }
  return { ok: true, vector: parsed.data };
}

/** Every field name of the feature schema (the WS-I.3.1b/g audit surface). */
export function featureSchemaFieldNames(): string[] {
  return Object.keys(featureVectorSchema.shape);
}
