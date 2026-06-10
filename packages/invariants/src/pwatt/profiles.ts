// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ranking profiles and weight normalization (WS-E.2.3c, SPEC §5.5). The five
// positive weights (wA, wP, wE, wS, wC) are a CONVEX COMBINATION: integer
// percents that must sum to exactly 100 (integer arithmetic ⇒ the sum check is
// exact, no floating-point drift), each within its per-component guardrail
// range. Penalties are NOT part of this combination (WS-E.2.3d).
//
// Profiles vary by surface, topic sensitivity, freshness, and risk state —
// NEVER by payment or wallet state: `ProfileSelectionContext` has no such
// field, which makes the pay-to-rank firewall hold at the type level here.

/** The five positive component weights, as integer percents. */
export interface RankingProfileWeights {
  /** Active attention (guardrail 20-30%). */
  wA: number;
  /** Constructive participation (guardrail 25-40%). */
  wP: number;
  /** Exposure independence, MERI-derived (guardrail 10-20%). */
  wE: number;
  /** Evidence/source completeness (guardrail 5-15%). */
  wS: number;
  /** Context coherence gain, SCOI-derived (guardrail 5-15%). */
  wC: number;
}

export interface RankingProfile {
  name: string;
  weights: RankingProfileWeights;
}

/** SPEC §5.5 guardrail ranges (inclusive integer percents). */
export const WEIGHT_GUARDRAILS: Readonly<
  Record<keyof RankingProfileWeights, { min: number; max: number }>
> = {
  wA: { min: 20, max: 30 },
  wP: { min: 25, max: 40 },
  wE: { min: 10, max: 20 },
  wS: { min: 5, max: 15 },
  wC: { min: 5, max: 15 },
};

export interface ProfileValidation {
  ok: boolean;
  problems: string[];
}

/** Validate a profile: integer weights, in-guardrail, summing to exactly 100. */
export function validateRankingProfile(profile: RankingProfile): ProfileValidation {
  const problems: string[] = [];
  let sum = 0;
  for (const key of Object.keys(WEIGHT_GUARDRAILS) as Array<keyof RankingProfileWeights>) {
    const value = profile.weights[key];
    const { min, max } = WEIGHT_GUARDRAILS[key];
    if (!Number.isInteger(value)) {
      problems.push(`${key} must be an integer percent (got ${value})`);
      continue;
    }
    if (value < min || value > max) {
      problems.push(`${key}=${value} outside guardrail [${min}, ${max}]`);
    }
    sum += value;
  }
  if (sum !== 100) problems.push(`weights must sum to exactly 100, got ${sum}`);
  return { ok: problems.length === 0, problems };
}

/** Throwing form for config-time rejection (WS-E.2.3c acceptance). */
export function assertValidRankingProfile(profile: RankingProfile): void {
  const result = validateRankingProfile(profile);
  if (!result.ok) {
    throw new Error(`invalid ranking profile "${profile.name}": ${result.problems.join('; ')}`);
  }
}

/** The two default profiles (WS-E.2.3c acceptance). Both validate exactly. */
export const DEFAULT_RANKING_PROFILES: readonly RankingProfile[] = [
  { name: 'breaking_news', weights: { wA: 30, wP: 25, wE: 15, wS: 15, wC: 15 } },
  { name: 'evergreen_science', weights: { wA: 20, wP: 40, wE: 15, wS: 15, wC: 10 } },
];

/**
 * Profile-selection context. Deliberately contains NO payment, wallet,
 * balance, or membership field (pay-to-rank firewall at the type level).
 */
export interface ProfileSelectionContext {
  surface: 'feed' | 'room' | 'search';
  freshness: 'breaking' | 'recent' | 'evergreen';
  topicSensitivity: 'standard' | 'sensitive';
  riskState: 'normal' | 'elevated';
}

/**
 * Select a profile by context (WS-E.2.3c). Breaking, non-sensitive feed/search
 * traffic emphasizes timeliness; everything else — including any sensitive
 * topic or elevated risk state — uses the evidence/participation-weighted
 * evergreen profile (the conservative default).
 */
export function selectRankingProfile(
  context: ProfileSelectionContext,
  profiles: readonly RankingProfile[] = DEFAULT_RANKING_PROFILES,
): RankingProfile {
  const byName = new Map(profiles.map((p) => [p.name, p]));
  const evergreen = byName.get('evergreen_science') ?? profiles[1];
  const breaking = byName.get('breaking_news') ?? profiles[0];
  const fallback = evergreen ?? breaking;
  if (!fallback) throw new Error('no ranking profiles configured');
  if (
    context.freshness === 'breaking' &&
    context.topicSensitivity === 'standard' &&
    context.riskState === 'normal' &&
    context.surface !== 'room'
  ) {
    return breaking ?? fallback;
  }
  return fallback;
}
