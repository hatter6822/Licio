// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.3f — ranking-profile configuration and validating loader (SPEC §5.5,
// §13.1). A profile is a named, VERSIONED configuration carrying the five
// positive weights (validated through the same §5.5 guardrail code WS-E uses —
// `validateRankingProfile` from @licio/invariants, so the two layers can never
// disagree about what a legal weight set is), the four nonnegative penalty
// coefficients, every constraint threshold, per-content-type freshness decay
// curves, diversification/balancing limits, per-surface diversity quotas, and
// the applicability selector. The loader REFUSES the whole set if any profile
// is invalid (the ranker must not start on a bad profile).
//
// The selector deliberately has no payment/wallet/membership dimension — the
// pay-to-rank firewall holds at the type level here exactly as it does for
// the WS-E `ProfileSelectionContext`.

import {
  type RankingProfile as PwattWeightProfile,
  validateRankingProfile,
} from '@licio/invariants';
import { z } from 'zod';
import { RANKING_SURFACES } from './candidate.js';

/** Age groups a profile can target (WS-D.1.7 bands + signed-out unknown). */
export const PROFILE_AGE_GROUPS = ['adult', 'teen_16_17', 'teen_13_15', 'unknown'] as const;
export type ProfileAgeGroup = (typeof PROFILE_AGE_GROUPS)[number];

/** Item risk states a profile can target (WS-E safety states). */
export const PROFILE_RISK_STATES = ['normal', 'elevated'] as const;

/** Freshness classes a profile can target. */
export const PROFILE_FRESHNESS = ['breaking', 'recent', 'evergreen'] as const;

const pct = z.number().int().min(0).max(100);

/** §5.5 positive weights (integer percents; guardrails re-checked below). */
export const profileWeightsSchema = z
  .object({
    wA: z.number().int(),
    wP: z.number().int(),
    wE: z.number().int(),
    wS: z.number().int(),
    wC: z.number().int(),
  })
  .strict();

/** The per-item penalty coefficients — separate NONNEGATIVE multipliers, never
 *  part of the convex combination (SPEC §5.4/§5.5). There is no `pH` (holonomy):
 *  PHI is realized as the per-user diversification constraint, not a per-item
 *  penalty (the vestigial per-item holonomy term was removed). */
export const profilePenaltiesSchema = z
  .object({
    pM: z.number().nonnegative(),
    pT: z.number().nonnegative(),
    pR: z.number().nonnegative(),
    /** WS-T dispute penalty (a `corrected` story sinks); optional, defaults strong. */
    pD: z.number().nonnegative().optional(),
    /** WS-T validation BOOST — the sole ADDITIVE coefficient here: a `validated`
     *  story (challenged and proven accurate) is nudged UP by `vD`, applied
     *  OUTSIDE the SCOI multiplier (symmetric with the dispute sink). A soft,
     *  bounded lift — never a guarantee of the top. Optional, defaults modest.
     *  A content-integrity signal, uniform across authors/topics — never
     *  applause/financial. */
    vD: z.number().nonnegative().optional(),
  })
  .strict();

/** Hard risk-constraint thresholds (WS-I.2.3c; SPEC §13.1). */
export const profileConstraintsSchema = z
  .object({
    /** MFCI risk state at/above which cross-community spread is excluded. */
    mfci_exclude_at: z.enum(['high', 'severe']),
    /** PHI risk at/above which the user's feed diversifies (per-user). */
    phi_diversify_threshold: z.number().positive(),
    /** PHI threshold multiplier for sensitive topics (stricter ⇒ < 1). */
    phi_sensitive_factor: z.number().positive().max(1),
    /** GWEI cohort disparity above which this profile may not deploy. */
    gwei_max_disparity: z.number().positive(),
    /** Max items from one MERI duplicate cluster per feed page (≥ 1). */
    meri_max_per_cluster: z.number().int().min(1).max(10),
    /** SCOI level at which a context card is required. */
    scoi_context_card_at: z.enum(['medium', 'high', 'very_high']),
    /** SCOI level at which cross-community distribution is reduced. */
    scoi_reduce_at: z.enum(['high', 'very_high']),
    /** Dampening multiplier applied at `scoi_reduce_at` (0 < m < 1). */
    scoi_reduce_multiplier: z.number().gt(0).lt(1),
  })
  .strict();

/** Exponential freshness decay curve per content type (WS-I.2.3d). */
export const decayCurveSchema = z
  .object({
    /** Half-life in hours: freshness = 2^(−age/half_life). */
    half_life_hours: z
      .number()
      .positive()
      .max(24 * 365),
  })
  .strict();

/**
 * Baseline part weights (WS-I.2.3d): integer percents over freshness /
 * source-reliability / topic-relevance, summing to exactly 100 (the same
 * integer-exact convention as the §5.5 positive weights). DEFAULTED so that
 * decision-log profile snapshots written before this field existed still
 * parse — and replay with the identical arithmetic they were served with.
 */
export const baselineWeightsSchema = z
  .object({
    freshness: z.number().int().min(0).max(100),
    reliability: z.number().int().min(0).max(100),
    relevance: z.number().int().min(0).max(100),
  })
  .strict()
  .default({ freshness: 50, reliability: 30, relevance: 20 });
export type BaselineWeights = z.infer<typeof baselineWeightsSchema>;

/** Source/topic/lens balancing limits (WS-I.2.4b). */
export const profileBalancingSchema = z
  .object({
    /** Max share of one source per feed page, percent (default 15). */
    max_source_share_pct: pct.refine((v) => v >= 1, 'must be ≥ 1'),
    /** Max share of one topic cluster per feed page, percent (default 25). */
    max_topic_share_pct: pct.refine((v) => v >= 1, 'must be ≥ 1'),
    /** Minimum distinct lenses represented when available (room feeds). */
    min_distinct_lenses: z.number().int().min(1).max(8),
  })
  .strict();

/** Per-surface candidate diversity quotas (WS-I.1.1b), percent of pool. */
export const profileQuotasSchema = z
  .object({
    fresh_min_pct: pct,
    independent_min_pct: pct,
    local_min_pct: pct,
  })
  .strict();

/** Applicability selector: which requests this profile serves. Empty array ⇒
 *  matches every value of that dimension. NO financial dimension exists. */
export const profileSelectorSchema = z
  .object({
    surfaces: z.array(z.enum(RANKING_SURFACES)),
    freshness: z.array(z.enum(PROFILE_FRESHNESS)),
    topic_sensitivity: z.array(z.enum(['standard', 'sensitive'])),
    age_groups: z.array(z.enum(PROFILE_AGE_GROUPS)),
    /** ISO 3166-1 alpha-2 codes; empty ⇒ all jurisdictions (WS-N seam). */
    jurisdictions: z.array(z.string().length(2)),
    risk_states: z.array(z.enum(PROFILE_RISK_STATES)),
    /** Higher wins when several profiles match (ties ⇒ lexicographic id). */
    priority: z.number().int().min(0).max(1000),
  })
  .strict();

export const rankingProfileConfigSchema = z
  .object({
    profile_id: z.string().min(1).max(64),
    profile_version: z.string().min(1).max(32),
    weights: profileWeightsSchema,
    penalties: profilePenaltiesSchema,
    constraints: profileConstraintsSchema,
    baseline_weights: baselineWeightsSchema,
    decay_curves: z
      .object({
        breaking: decayCurveSchema,
        evergreen: decayCurveSchema,
      })
      .strict(),
    balancing: profileBalancingSchema,
    quotas: profileQuotasSchema,
    selector: profileSelectorSchema,
    /** Candidate-pool budget for requests served by this profile. */
    candidate_budget: z.number().int().min(10).max(2000),
    /** Feed page size this profile serves. */
    page_size: z.number().int().min(5).max(100),
  })
  .strict();
export type RankingProfileConfig = z.infer<typeof rankingProfileConfigSchema>;

/** Validate one profile fully (schema + §5.5 guardrails). */
export function validateRankingProfileConfig(profile: unknown): string[] {
  const parsed = rankingProfileConfigSchema.safeParse(profile);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  }
  const weightProfile: PwattWeightProfile = {
    name: parsed.data.profile_id,
    weights: parsed.data.weights,
  };
  // The SAME §5.5 guardrail/sum-to-100 validator WS-E uses (single source of
  // truth for what a legal weight set is).
  const weightCheck = validateRankingProfile(weightProfile);
  const problems = weightCheck.ok ? [] : [...weightCheck.problems];
  if (parsed.data.quotas.fresh_min_pct + parsed.data.quotas.independent_min_pct > 100) {
    problems.push('fresh + independent quotas exceed 100%');
  }
  const baseline = parsed.data.baseline_weights;
  const baselineSum = baseline.freshness + baseline.reliability + baseline.relevance;
  if (baselineSum !== 100) {
    problems.push(`baseline weights must sum to exactly 100, got ${baselineSum}`);
  }
  return problems;
}

/** Loader error: the ranker must refuse to start on any invalid profile. */
export class RankingProfileLoadError extends Error {
  readonly problems: ReadonlyArray<{ profileId: string; problems: string[] }>;
  constructor(problems: ReadonlyArray<{ profileId: string; problems: string[] }>) {
    super(
      `invalid ranking profile(s): ${problems
        .map((p) => `${p.profileId} [${p.problems.join('; ')}]`)
        .join(' | ')}`,
    );
    this.name = 'RankingProfileLoadError';
    this.problems = problems;
  }
}

/**
 * Validate a whole profile set at load time. Throws on ANY invalid profile
 * (all-or-none: a half-valid profile set is a configuration mistake), on
 * duplicate ids, and on an empty set.
 */
export function loadRankingProfiles(raw: readonly unknown[]): RankingProfileConfig[] {
  if (raw.length === 0) {
    throw new RankingProfileLoadError([
      { profileId: '(none)', problems: ['at least one ranking profile is required'] },
    ]);
  }
  const failures: Array<{ profileId: string; problems: string[] }> = [];
  const profiles: RankingProfileConfig[] = [];
  const ids = new Set<string>();
  for (const candidate of raw) {
    const id =
      typeof candidate === 'object' && candidate !== null && 'profile_id' in candidate
        ? String((candidate as { profile_id: unknown }).profile_id)
        : '(unknown)';
    const problems = validateRankingProfileConfig(candidate);
    if (problems.length > 0) {
      failures.push({ profileId: id, problems });
      continue;
    }
    if (ids.has(id)) {
      failures.push({ profileId: id, problems: ['duplicate profile_id'] });
      continue;
    }
    ids.add(id);
    profiles.push(rankingProfileConfigSchema.parse(candidate));
  }
  if (failures.length > 0) throw new RankingProfileLoadError(failures);
  return profiles;
}

/** The request context a profile is selected for. NO financial field. */
export interface ProfileRequestContext {
  surface: (typeof RANKING_SURFACES)[number];
  freshness: (typeof PROFILE_FRESHNESS)[number];
  topicSensitivity: 'standard' | 'sensitive';
  ageGroup: ProfileAgeGroup;
  /** ISO 3166-1 alpha-2 or null when unknown (WS-N seam). */
  jurisdiction: string | null;
  riskState: (typeof PROFILE_RISK_STATES)[number];
}

function dimensionMatches<T>(allowed: readonly T[], value: T): boolean {
  return allowed.length === 0 || allowed.includes(value);
}

/**
 * Deterministically select the applicable profile: among profiles whose
 * selector matches every dimension, the highest `priority` wins; ties break
 * lexicographically on `profile_id`. Returns null when none match (the
 * caller falls back to the default profile).
 */
export function selectProfileForContext(
  context: ProfileRequestContext,
  profiles: readonly RankingProfileConfig[],
): RankingProfileConfig | null {
  const matching = profiles.filter(
    (p) =>
      dimensionMatches(p.selector.surfaces, context.surface) &&
      dimensionMatches(p.selector.freshness, context.freshness) &&
      dimensionMatches(p.selector.topic_sensitivity, context.topicSensitivity) &&
      dimensionMatches(p.selector.age_groups, context.ageGroup) &&
      (p.selector.jurisdictions.length === 0 ||
        (context.jurisdiction !== null &&
          p.selector.jurisdictions.includes(context.jurisdiction))) &&
      dimensionMatches(p.selector.risk_states, context.riskState),
  );
  if (matching.length === 0) return null;
  return [...matching].sort(
    (a, b) => b.selector.priority - a.selector.priority || a.profile_id.localeCompare(b.profile_id),
  )[0] as RankingProfileConfig;
}

/** Shared constraint/balancing defaults for the two shipped profiles. */
const DEFAULT_CONSTRAINTS: z.infer<typeof profileConstraintsSchema> = {
  mfci_exclude_at: 'severe',
  phi_diversify_threshold: 1.0,
  phi_sensitive_factor: 0.5,
  gwei_max_disparity: 0.35,
  meri_max_per_cluster: 2,
  scoi_context_card_at: 'medium',
  scoi_reduce_at: 'high',
  scoi_reduce_multiplier: 0.5,
};

const DEFAULT_BALANCING: z.infer<typeof profileBalancingSchema> = {
  max_source_share_pct: 15,
  max_topic_share_pct: 25,
  min_distinct_lenses: 2,
};

const DEFAULT_QUOTAS: z.infer<typeof profileQuotasSchema> = {
  fresh_min_pct: 15,
  independent_min_pct: 20,
  local_min_pct: 10,
};

/**
 * The shipped breaking-news profile: timeliness-weighted (wA at its 30% cap),
 * fast freshness decay. Applies to breaking, standard-sensitivity, normal-risk
 * front-page/topic traffic.
 */
export const BREAKING_NEWS_PROFILE: RankingProfileConfig = {
  profile_id: 'breaking_news',
  profile_version: '1.2.0',
  weights: { wA: 30, wP: 25, wE: 15, wS: 15, wC: 15 },
  penalties: { pM: 1.0, pT: 0.75, pR: 0.5, pD: 1.0, vD: 0.25 },
  constraints: DEFAULT_CONSTRAINTS,
  // Timeliness-weighted baseline: freshness carries more of B.
  baseline_weights: { freshness: 60, reliability: 25, relevance: 15 },
  decay_curves: {
    breaking: { half_life_hours: 6 },
    evergreen: { half_life_hours: 24 * 7 },
  },
  balancing: DEFAULT_BALANCING,
  quotas: DEFAULT_QUOTAS,
  selector: {
    surfaces: ['front_page', 'topic'],
    freshness: ['breaking'],
    topic_sensitivity: ['standard'],
    age_groups: [],
    jurisdictions: [],
    risk_states: ['normal'],
    priority: 100,
  },
  candidate_budget: 400,
  page_size: 30,
};

/**
 * The shipped evergreen profile: evidence/participation-weighted (wP at its
 * 40% cap), slow decay. The conservative DEFAULT for everything the breaking
 * profile does not match — including all sensitive topics, elevated risk,
 * room feeds, and minors.
 */
export const EVERGREEN_PROFILE: RankingProfileConfig = {
  profile_id: 'evergreen',
  profile_version: '1.2.0',
  weights: { wA: 20, wP: 40, wE: 15, wS: 15, wC: 10 },
  penalties: { pM: 1.0, pT: 0.75, pR: 0.75, pD: 1.0, vD: 0.25 },
  constraints: DEFAULT_CONSTRAINTS,
  baseline_weights: { freshness: 50, reliability: 30, relevance: 20 },
  decay_curves: {
    breaking: { half_life_hours: 12 },
    evergreen: { half_life_hours: 24 * 14 },
  },
  balancing: DEFAULT_BALANCING,
  quotas: DEFAULT_QUOTAS,
  selector: {
    surfaces: [],
    freshness: [],
    topic_sensitivity: [],
    age_groups: [],
    jurisdictions: [],
    risk_states: [],
    priority: 0,
  },
  candidate_budget: 400,
  page_size: 30,
};

/** The shipped profile set (snapshot-tested against unreviewed changes). */
export const SHIPPED_RANKING_PROFILES: readonly RankingProfileConfig[] = [
  BREAKING_NEWS_PROFILE,
  EVERGREEN_PROFILE,
];
