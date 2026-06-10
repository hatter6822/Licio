// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tunable PWAtt configuration (WS-E.2.2a/2.3a-d: thresholds and weights are
// data, changeable without a code deployment). Values live in the
// `pwatt_config` store and are read at each scheduler tick; every stored value
// is VALIDATED before use and an invalid value FAILS CLOSED to the reviewed
// defaults (logged) — a misconfiguration can never silently rebalance
// distribution (WS-E.2.3c).
import {
  DEFAULT_PENALTY_COEFFICIENTS,
  DEFAULT_PWATT_V0_CONFIG,
  DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
  DEFAULT_RANKING_PROFILES,
  type PenaltyCoefficients,
  type PwattV0Config,
  type PwattV1ComponentsConfig,
  type RankingProfile,
  validatePenaltyCoefficients,
  validatePwattV0Config,
  validatePwattV1ComponentsConfig,
  validateRankingProfile,
} from '@licio/invariants';
import { EVENT_CONTRIBUTION_TYPES } from '@licio/shared';
import { z } from 'zod';
import type { EventPipelineServices } from '../events/services.js';
import {
  type BurstDetectorConfig,
  type CascadeDetectorConfig,
  DEFAULT_BURST_CONFIG,
  DEFAULT_CASCADE_CONFIG,
} from './anti-signals.js';

export interface PwattRuntimeConfig {
  v0: PwattV0Config;
  /** The INTEGRATED v1 stage: hierarchy weights + saturation (WS-E.2.3a/b). */
  v1: PwattV1ComponentsConfig;
  burst: BurstDetectorConfig;
  cascade: CascadeDetectorConfig;
  penaltyCoefficients: PenaltyCoefficients;
  profiles: readonly RankingProfile[];
  /** Real-time event-count threshold that triggers an early aggregation run. */
  triggerThreshold: number;
}

export const DEFAULT_PWATT_RUNTIME_CONFIG: PwattRuntimeConfig = {
  v0: DEFAULT_PWATT_V0_CONFIG,
  v1: DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
  burst: DEFAULT_BURST_CONFIG,
  cascade: DEFAULT_CASCADE_CONFIG,
  penaltyCoefficients: DEFAULT_PENALTY_COEFFICIENTS,
  profiles: DEFAULT_RANKING_PROFILES,
  triggerThreshold: 500,
};

const burstSchema = z
  .object({
    minVolume: z.number().int().min(1),
    minDistinctActors: z.number().int().min(1),
    burstMultiplier: z.number().positive(),
    baseRateFloor: z.number().positive(),
  })
  .strict();

const cascadeSchema = z
  .object({
    minDistinctActors: z.number().int().min(1),
    minContributions: z.number().int().min(1),
    hostileShareThreshold: z.number().min(0).max(1),
    volumeMultiplier: z.number().positive(),
    baseRateFloor: z.number().positive(),
  })
  .strict();

const penaltySchema = z
  .object({
    pM: z.number().min(0),
    pH: z.number().min(0),
    pT: z.number().min(0),
    pR: z.number().min(0),
  })
  .strict();

const profileSchema = z
  .object({
    name: z.string().min(1).max(64),
    weights: z
      .object({
        wA: z.number().int(),
        wP: z.number().int(),
        wE: z.number().int(),
        wS: z.number().int(),
        wC: z.number().int(),
      })
      .strict(),
  })
  .strict();

const integerPercentSchema = z.number().int().min(1).max(50);

const v0Schema = z
  .object({
    activeAttention: z
      .object({
        weights: z
          .object({
            dwellPct: integerPercentSchema,
            sourcePct: integerPercentSchema,
            contextPct: integerPercentSchema,
          })
          .strict(),
        halfSaturationActors: z.number().positive(),
      })
      .strict(),
    participation: z
      .object({
        weights: z
          .object({
            returnPct: integerPercentSchema,
            savePct: integerPercentSchema,
            contributionPct: integerPercentSchema,
          })
          .strict(),
        contribSaturation: z.number().positive(),
        rapidThreshold: z.number().min(1),
        rapidDampening: z.number().min(0).max(1),
        accusationDownweight: z.number().min(0).max(1),
        burstPlaceholderDampening: z.number().min(0).max(1),
        halfSaturationActors: z.number().positive(),
      })
      .strict(),
    confidenceHalfSaturation: z.number().positive(),
  })
  .strict();

const curveSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('logarithmic'),
      scale: z.number().positive(),
      saturationPoint: z.number().positive(),
    })
    .strict(),
  z.object({ kind: z.literal('sigmoid'), scale: z.number().positive() }).strict(),
]);

const dimensionSchema = z.object({ weightPct: integerPercentSchema, curve: curveSchema }).strict();

const contributionWeightsSchema = z
  .object(
    Object.fromEntries(
      EVENT_CONTRIBUTION_TYPES.map((type) => [type, z.number().min(0).max(1)]),
    ) as Record<(typeof EVENT_CONTRIBUTION_TYPES)[number], z.ZodNumber>,
  )
  .strict();

const v1Schema = z
  .object({
    contributionWeights: contributionWeightsSchema,
    contributionCurve: curveSchema,
    attentionDimensions: z
      .object({ dwell: dimensionSchema, source: dimensionSchema, context: dimensionSchema })
      .strict(),
    participationDimensions: z
      .object({ returns: dimensionSchema, saves: dimensionSchema, contributions: dimensionSchema })
      .strict(),
    accusationDownweight: z.number().min(0).max(1),
    rapidThreshold: z.number().min(1),
    rapidDampening: z.number().min(0).max(1),
  })
  .strict();

/** The closed set of writable pwatt_config keys (the steward admin surface). */
export const PWATT_CONFIG_KEYS = [
  'v0',
  'v1',
  'burst',
  'cascade',
  'penalty_coefficients',
  'ranking_profiles',
  'trigger_threshold',
] as const;
export type PwattConfigKey = (typeof PWATT_CONFIG_KEYS)[number];

/**
 * Validate a config value for `key` BEFORE it is written (the steward admin
 * surface, WS-E.2.3c "invalid profiles are rejected at configuration time").
 * Returns the problem message, or null when the value is acceptable. The
 * loader still re-validates on every read (defense in depth): a value written
 * around this surface can still never reach scoring.
 */
export function validatePwattConfigValue(
  key: PwattConfigKey,
  value: Record<string, unknown>,
): string | null {
  try {
    switch (key) {
      case 'v0': {
        const parsed = v0Schema.safeParse(value);
        if (!parsed.success) return parsed.error.issues[0]?.message ?? 'invalid v0 config';
        validatePwattV0Config(parsed.data);
        return null;
      }
      case 'v1': {
        const parsed = v1Schema.safeParse(value);
        if (!parsed.success) return parsed.error.issues[0]?.message ?? 'invalid v1 config';
        validatePwattV1ComponentsConfig(parsed.data);
        return null;
      }
      case 'burst': {
        const parsed = burstSchema.safeParse(value);
        return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid burst config');
      }
      case 'cascade': {
        const parsed = cascadeSchema.safeParse(value);
        return parsed.success
          ? null
          : (parsed.error.issues[0]?.message ?? 'invalid cascade config');
      }
      case 'penalty_coefficients': {
        const parsed = penaltySchema.safeParse(value);
        if (!parsed.success) return parsed.error.issues[0]?.message ?? 'invalid penalties';
        validatePenaltyCoefficients(parsed.data);
        return null;
      }
      case 'ranking_profiles': {
        const parsed = z.object({ profiles: z.array(profileSchema).min(1) }).safeParse(value);
        if (!parsed.success) return parsed.error.issues[0]?.message ?? 'invalid profiles';
        for (const profile of parsed.data.profiles) {
          const result = validateRankingProfile(profile);
          if (!result.ok) return `${profile.name}: ${result.problems.join('; ')}`;
        }
        return null;
      }
      case 'trigger_threshold': {
        const parsed = z.object({ value: z.number().int().min(1) }).safeParse(value);
        return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid threshold');
      }
    }
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid config value';
  }
}

/**
 * Load the runtime config: stored overrides validated key-by-key; any invalid
 * value is rejected (logged) and its reviewed default kept. Reads happen per
 * scheduler tick, so changes apply without redeploy (WS-E.2.3a acceptance).
 */
export async function loadPwattRuntimeConfig(
  events: EventPipelineServices,
): Promise<PwattRuntimeConfig> {
  const config: PwattRuntimeConfig = { ...DEFAULT_PWATT_RUNTIME_CONFIG };

  const reject = (key: string, detail: string): void => {
    events.log('pwatt.config.rejected', { key, detail });
  };

  const v0 = await events.configStore.get('v0');
  if (v0) {
    const parsed = v0Schema.safeParse(v0);
    if (parsed.success) {
      try {
        validatePwattV0Config(parsed.data);
        config.v0 = parsed.data;
      } catch (error) {
        reject('v0', error instanceof Error ? error.message : 'invalid');
      }
    } else {
      reject('v0', parsed.error.issues[0]?.message ?? 'invalid');
    }
  }

  const v1 = await events.configStore.get('v1');
  if (v1) {
    const parsed = v1Schema.safeParse(v1);
    if (parsed.success) {
      try {
        validatePwattV1ComponentsConfig(parsed.data);
        config.v1 = parsed.data;
      } catch (error) {
        reject('v1', error instanceof Error ? error.message : 'invalid');
      }
    } else {
      reject('v1', parsed.error.issues[0]?.message ?? 'invalid');
    }
  }

  const burst = await events.configStore.get('burst');
  if (burst) {
    const parsed = burstSchema.safeParse(burst);
    if (parsed.success) config.burst = parsed.data;
    else reject('burst', parsed.error.issues[0]?.message ?? 'invalid');
  }

  const cascade = await events.configStore.get('cascade');
  if (cascade) {
    const parsed = cascadeSchema.safeParse(cascade);
    if (parsed.success) config.cascade = parsed.data;
    else reject('cascade', parsed.error.issues[0]?.message ?? 'invalid');
  }

  const penalties = await events.configStore.get('penalty_coefficients');
  if (penalties) {
    const parsed = penaltySchema.safeParse(penalties);
    if (parsed.success) {
      try {
        validatePenaltyCoefficients(parsed.data);
        config.penaltyCoefficients = parsed.data;
      } catch (error) {
        reject('penalty_coefficients', error instanceof Error ? error.message : 'invalid');
      }
    } else {
      reject('penalty_coefficients', parsed.error.issues[0]?.message ?? 'invalid');
    }
  }

  const profiles = await events.configStore.get('ranking_profiles');
  if (profiles) {
    const parsed = z.object({ profiles: z.array(profileSchema).min(1) }).safeParse(profiles);
    if (parsed.success) {
      const validated: RankingProfile[] = [];
      for (const profile of parsed.data.profiles) {
        const result = validateRankingProfile(profile);
        if (result.ok) validated.push(profile);
        else reject(`ranking_profiles.${profile.name}`, result.problems.join('; '));
      }
      // All-or-none: a partially valid profile set is a config mistake.
      if (validated.length === parsed.data.profiles.length) {
        config.profiles = validated;
        // Profile changes are audit-relevant (WS-E.2.3c acceptance).
        events.log('pwatt.config.profiles_changed', {
          profiles: validated.map((p) => p.name),
        });
      }
    } else {
      reject('ranking_profiles', parsed.error.issues[0]?.message ?? 'invalid');
    }
  }

  const trigger = await events.configStore.get('trigger_threshold');
  if (trigger) {
    const parsed = z.object({ value: z.number().int().min(1) }).safeParse(trigger);
    if (parsed.success) config.triggerThreshold = parsed.data.value;
    else reject('trigger_threshold', parsed.error.issues[0]?.message ?? 'invalid');
  }

  // The composed v0/v1 configs are structural (validated constants); assert
  // anyway so a future code change cannot ship an invalid default.
  validatePwattV0Config(config.v0);
  validatePwattV1ComponentsConfig(config.v1);
  return config;
}
