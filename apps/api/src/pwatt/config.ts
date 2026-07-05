// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tunable PWAtt configuration (WS-E.2.2a/2.3a-d: thresholds and weights are
// data, changeable without a code deployment). Values live in the
// `pwatt_config` store and are read at each scheduler tick; every stored value
// is VALIDATED before use and an invalid value FAILS CLOSED to the reviewed
// defaults (logged) — a misconfiguration can never silently rebalance
// distribution (WS-E.2.3c).
import {
  DEFAULT_PWATT_V0_CONFIG,
  DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
  type PwattV0Config,
  type PwattV1ComponentsConfig,
  validatePwattV0Config,
  validatePwattV1ComponentsConfig,
} from '@licio/invariants';
import { EVENT_CONTRIBUTION_TYPES } from '@licio/shared';
import { z } from 'zod';
import type { EventPipelineServices } from '../events/services.js';
import {
  type BurstDetectorConfig,
  type CascadeDetectorConfig,
  DEFAULT_BURST_CONFIG,
  DEFAULT_CASCADE_CONFIG,
  DEFAULT_TRUST_WEIGHTS,
  type TrustWeights,
} from './anti-signals.js';

export interface PwattRuntimeConfig {
  v0: PwattV0Config;
  /** The INTEGRATED v1 stage: hierarchy weights + saturation (WS-E.2.3a/b). */
  v1: PwattV1ComponentsConfig;
  burst: BurstDetectorConfig;
  cascade: CascadeDetectorConfig;
  /** Account-age progressive-trust weights (WS-O.4.5). */
  trustWeights: TrustWeights;
  /** Real-time event-count threshold that triggers an early aggregation run. */
  triggerThreshold: number;
}

// NOTE: the batch engine no longer holds ranking profiles or penalty
// coefficients. Those are the SERVED §5.4 composition's inputs and live SOLELY
// in the WS-I ranking config (`ranking.*`), which is where a steward tunes
// them; a second copy here would be dead config that silently changes nothing
// when set (PR7 — single §5.4 config source, no drift).

export const DEFAULT_PWATT_RUNTIME_CONFIG: PwattRuntimeConfig = {
  v0: DEFAULT_PWATT_V0_CONFIG,
  v1: DEFAULT_PWATT_V1_COMPONENTS_CONFIG,
  burst: DEFAULT_BURST_CONFIG,
  cascade: DEFAULT_CASCADE_CONFIG,
  trustWeights: DEFAULT_TRUST_WEIGHTS,
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

const trustWeightsSchema = z
  .object({
    new: z.number().min(0.1).max(1),
    recent: z.number().min(0.1).max(1),
    active: z.number().min(0.1).max(1),
    established: z.number().min(0.1).max(1),
  })
  .strict()
  .refine((w) => w.new <= w.recent && w.recent <= w.active && w.active <= w.established, {
    message: 'trust weights must be monotone non-decreasing (new ≤ recent ≤ active ≤ established)',
  });

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
            traversalPct: integerPercentSchema,
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
        citationBonus: z.number().min(0).max(1),
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

const antiSignalAttenuationSchema = z
  .object({
    coordinatedBurstMax: z.number().min(0).max(1),
    harassmentCascade: z.number().min(0).max(1),
  })
  .strict();

const v1Schema = z
  .object({
    contributionWeights: contributionWeightsSchema,
    contributionCurve: curveSchema,
    attentionDimensions: z
      .object({
        dwell: dimensionSchema,
        source: dimensionSchema,
        context: dimensionSchema,
        traversal: dimensionSchema,
      })
      .strict(),
    participationDimensions: z
      .object({ returns: dimensionSchema, saves: dimensionSchema, contributions: dimensionSchema })
      .strict(),
    accusationDownweight: z.number().min(0).max(1),
    citationBonus: z.number().min(0).max(1),
    rapidThreshold: z.number().min(1),
    rapidDampening: z.number().min(0).max(1),
    antiSignalAttenuation: antiSignalAttenuationSchema,
  })
  .strict();

/** The closed set of writable pwatt_config keys (the steward admin surface).
 *  Ranking profiles + penalty coefficients are NOT here: they are the served
 *  §5.4 composition's inputs and are tuned via the WS-I `ranking.*` config. */
export const PWATT_CONFIG_KEYS = [
  'v0',
  'v1',
  'burst',
  'cascade',
  'trust_weights',
  'trigger_threshold',
] as const;
export type PwattConfigKey = (typeof PWATT_CONFIG_KEYS)[number];

/**
 * Backward-compat upgrade of a STORED v0/v1 config row (WS-E.2.3a). Adding the
 * `traversal` ActiveAttention dimension + the v1 `antiSignalAttenuation` block
 * changed the config shape; a row written before that change would otherwise
 * fail the strict schema and be silently discarded on deploy — losing the
 * steward's OTHER tuning (contribution weights, curves, participation split, …)
 * to the reviewed defaults. This fills ONLY the structurally-changed pieces from
 * the reviewed defaults, preserving everything else. Pure; leaves an already-new
 * row untouched. (New WRITES still go through the strict `validatePwattConfigValue`.)
 */
function upgradeStoredV0Config(raw: Record<string, unknown>): Record<string, unknown> {
  let next = raw;
  const attention = next['activeAttention'];
  if (
    typeof attention === 'object' &&
    attention !== null &&
    typeof (attention as { weights?: unknown }).weights === 'object' &&
    (attention as { weights?: Record<string, unknown> }).weights !== null &&
    !('traversalPct' in (attention as { weights: Record<string, unknown> }).weights)
  ) {
    next = {
      ...next,
      activeAttention: {
        ...(attention as Record<string, unknown>),
        // The old 3-weight split cannot absorb `traversal` without breaking the
        // sum-to-100 invariant, so adopt the reviewed default weight split
        // (keeping any tuned halfSaturationActors).
        weights: { ...DEFAULT_PWATT_V0_CONFIG.activeAttention.weights },
      },
    };
  }
  // WS-T — a row written before the sourced-comment citation bonus lacks it;
  // fill it from the reviewed default (preserving the steward's other tuning).
  const participation = next['participation'];
  if (
    typeof participation === 'object' &&
    participation !== null &&
    !('citationBonus' in participation)
  ) {
    next = {
      ...next,
      participation: {
        ...(participation as Record<string, unknown>),
        citationBonus: DEFAULT_PWATT_V0_CONFIG.participation.citationBonus,
      },
    };
  }
  return next;
}

function upgradeStoredV1Config(raw: Record<string, unknown>): Record<string, unknown> {
  let next = raw;
  const dims = raw['attentionDimensions'];
  if (typeof dims === 'object' && dims !== null && !('traversal' in dims)) {
    // The old 3-dimension attention set cannot absorb `traversal` without
    // breaking sum-to-100; adopt the reviewed default dimension set.
    next = {
      ...next,
      attentionDimensions: { ...DEFAULT_PWATT_V1_COMPONENTS_CONFIG.attentionDimensions },
    };
  }
  if (!('antiSignalAttenuation' in next)) {
    next = {
      ...next,
      antiSignalAttenuation: { ...DEFAULT_PWATT_V1_COMPONENTS_CONFIG.antiSignalAttenuation },
    };
  }
  // WS-T — fill the sourced-comment citation bonus for a pre-bonus row.
  if (!('citationBonus' in next)) {
    next = { ...next, citationBonus: DEFAULT_PWATT_V1_COMPONENTS_CONFIG.citationBonus };
  }
  return next;
}

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
      case 'trust_weights': {
        const parsed = trustWeightsSchema.safeParse(value);
        return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid trust weights');
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
    // Upgrade a pre-`traversal` row so its OTHER tuning survives (WS-E.2.3a).
    const parsed = v0Schema.safeParse(upgradeStoredV0Config(v0));
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
    // Upgrade a pre-`traversal`/`antiSignalAttenuation` row (WS-E.2.3a).
    const parsed = v1Schema.safeParse(upgradeStoredV1Config(v1));
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

  const trustWeights = await events.configStore.get('trust_weights');
  if (trustWeights) {
    const parsed = trustWeightsSchema.safeParse(trustWeights);
    if (parsed.success) config.trustWeights = parsed.data;
    else reject('trust_weights', parsed.error.issues[0]?.message ?? 'invalid');
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
