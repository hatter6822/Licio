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
  DEFAULT_RANKING_PROFILES,
  type PenaltyCoefficients,
  type PwattV0Config,
  type RankingProfile,
  validatePenaltyCoefficients,
  validatePwattV0Config,
  validateRankingProfile,
} from '@licio/invariants';
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
  burst: BurstDetectorConfig;
  cascade: CascadeDetectorConfig;
  penaltyCoefficients: PenaltyCoefficients;
  profiles: readonly RankingProfile[];
  /** Real-time event-count threshold that triggers an early aggregation run. */
  triggerThreshold: number;
}

export const DEFAULT_PWATT_RUNTIME_CONFIG: PwattRuntimeConfig = {
  v0: DEFAULT_PWATT_V0_CONFIG,
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

  // The composed v0 config is structural (validated constants); assert anyway
  // so a future code change cannot ship an invalid default.
  validatePwattV0Config(config.v0);
  return config;
}
