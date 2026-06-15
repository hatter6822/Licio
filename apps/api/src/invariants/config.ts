// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H fail-closed runtime configuration, following the WS-E/F/G pattern:
// tunables live under `invariants.*` keys in the shared runtime-config store,
// every stored value is VALIDATED on load, and an invalid value is rejected
// (logged, CONFIG_REJECTED metric) while the reviewed default is kept — a
// misconfiguration can never silently rebalance thresholds. Steward writes
// are validated at configuration time (422 on rejection).

import {
  DEFAULT_MFCI_RISK_THRESHOLDS,
  DEFAULT_NARROW_LOOP_CONFIG,
  DEFAULT_PHI_THRESHOLD_CONFIG,
  DEFAULT_PROMOTION_POLICY,
  DEFAULT_SCOI_STATE_THRESHOLDS,
  validateMfciRiskThresholds,
  validatePhiThresholdConfig,
  validateScoiStateThresholds,
} from '@licio/invariants';
import { z } from 'zod';
import type { PwattConfigStore } from '../events/stores.js';

export interface InvariantsRuntimeConfig {
  /** Per-call timeout for the fallback execution wrapper (WS-H.1.2c). */
  wrapperTimeoutMs: number;
  /** Real-time tier per-call latency budget (logged when exceeded). */
  realtimeLatencyBudgetMs: number;
  /** Batch-tier concurrency cap (back-pressure, WS-H.1.2f). */
  batchConcurrency: number;
  /** Candidate-set size cap per MERI evaluation. */
  meriCandidateLimit: number;
  /** Near-duplicate Jaccard threshold for MERI grouping (lexical, MinHash). */
  meriNearDuplicateThreshold: number;
  /** Semantic (embedding cosine) near-duplicate threshold for MERI grouping
   *  (WS-O.4.5): unions hard paraphrases MinHash misses. Its strength depends
   *  on the deployed embedding provider — the DEFAULT provider is LEXICAL
   *  (n-gram-correlated), so the semantic benefit is realized only with a
   *  semantic EMBEDDING_URL provider. */
  meriSemanticDuplicateThreshold: number;
  /** MFCI sampler parameters (WS-H.3.3b). */
  mfciSamples: number;
  mfciBurnIn: number;
  mfciThinning: number;
  /** Cheap-statistic anomaly score that opens a sub-minute freeze. */
  mfciFreezeScore: number;
  /** MFCI risk-state thresholds on −log p̂. */
  mfciRiskThresholds: typeof DEFAULT_MFCI_RISK_THRESHOLDS;
  /** SCOI context-state thresholds. */
  scoiStateThresholds: typeof DEFAULT_SCOI_STATE_THRESHOLDS;
  /** PHI loop/threshold config (sensitive/minor strictness, WS-H.6.2d). */
  phiThresholds: typeof DEFAULT_PHI_THRESHOLD_CONFIG;
  /** PHI narrow-loop detection window/repeats (WS-H.6.1b). */
  phiNarrowLoop: typeof DEFAULT_NARROW_LOOP_CONFIG;
  /** Session sequence cap (WS-H.6.1a). */
  phiSequenceCap: number;
  /** GWEI entropic regularization grid + seeds (WS-H.5.2b). */
  gweiEpsilons: number[];
  gweiSeeds: number[];
  /** GWEI cohort k-anonymity threshold (WS-H.5.1b-2). */
  gweiKAnonymity: number;
  /** Minimum cohort size for GWEI comparison (WS-H.5.1a). */
  gweiMinCohortSize: number;
  /** Promotion policy (WS-H.1.2e). */
  promotionMinShadowDays: number;
  /** "Needs Context" feed threshold (WS-H.4.3a). */
  scoiNeedsContextThreshold: number;
  /** Threshold-hugging meta-monitor (WS-O.4.5): the sub-threshold "hug band"
   *  width as a FRACTION of each invariant's public threshold (relative so it
   *  scales uniformly across the MFCI/SCOI/PHI score scales). */
  thresholdHuggingBandFraction: number;
  /** Minimum score population for the meta-monitor to judge (fail-closed). */
  thresholdHuggingMinPopulation: number;
  /** Minimum observed/expected band excess to flag hugging. */
  thresholdHuggingExcess: number;
  /** MFCI calibration drift guard (WS-O.4.5): retain the previous calibration
   *  when a new q99 jumps beyond this ratio over the same-volume bucket. */
  mfciCalibrationDriftMaxRatio: number;
  /** Exclude hourly windows touching an under-case target from the MFCI
   *  baseline (anti-poisoning, WS-O.4.5). */
  mfciExcludeFlaggedWindows: boolean;
}

export const DEFAULT_INVARIANTS_CONFIG: InvariantsRuntimeConfig = {
  wrapperTimeoutMs: 10_000,
  realtimeLatencyBudgetMs: 100,
  batchConcurrency: 2,
  meriCandidateLimit: 200,
  meriNearDuplicateThreshold: 0.7,
  meriSemanticDuplicateThreshold: 0.85,
  mfciSamples: 2_000,
  mfciBurnIn: 2_000,
  mfciThinning: 2,
  mfciFreezeScore: 1,
  mfciRiskThresholds: DEFAULT_MFCI_RISK_THRESHOLDS,
  scoiStateThresholds: DEFAULT_SCOI_STATE_THRESHOLDS,
  phiThresholds: DEFAULT_PHI_THRESHOLD_CONFIG,
  phiNarrowLoop: DEFAULT_NARROW_LOOP_CONFIG,
  phiSequenceCap: 200,
  gweiEpsilons: [0.01, 0.002],
  gweiSeeds: [0, 7, 13],
  gweiKAnonymity: 25,
  gweiMinCohortSize: 25,
  promotionMinShadowDays: DEFAULT_PROMOTION_POLICY.minShadowDays,
  scoiNeedsContextThreshold: 0.4,
  thresholdHuggingBandFraction: 0.15,
  thresholdHuggingMinPopulation: 12,
  thresholdHuggingExcess: 2.5,
  mfciCalibrationDriftMaxRatio: 1.5,
  mfciExcludeFlaggedWindows: true,
};

const positiveInt = z.number().int().positive();
const positiveNum = z.number().positive();

/** Per-key zod validation (write-time AND load-time). */
const CONFIG_VALIDATORS: Record<string, z.ZodType> = {
  'invariants.wrapperTimeoutMs': positiveInt.lte(120_000),
  'invariants.realtimeLatencyBudgetMs': positiveInt.lte(10_000),
  'invariants.batchConcurrency': positiveInt.lte(16),
  'invariants.meriCandidateLimit': positiveInt.lte(2_000),
  'invariants.meriNearDuplicateThreshold': z.number().gt(0).lt(1),
  'invariants.meriSemanticDuplicateThreshold': z.number().gt(0).lte(1),
  'invariants.mfciSamples': positiveInt.gte(100).lte(100_000),
  'invariants.mfciBurnIn': positiveInt.lte(100_000),
  'invariants.mfciThinning': positiveInt.lte(100),
  'invariants.mfciFreezeScore': positiveNum,
  'invariants.mfciRiskThresholds': z
    .object({ elevated: positiveNum, high: positiveNum, severe: positiveNum })
    .strict()
    .refine((t) => validateMfciRiskThresholds(t) === null, {
      message: 'thresholds must satisfy elevated < high < severe',
    }),
  'invariants.scoiStateThresholds': z
    .object({ ambiguous: positiveNum, split: positiveNum, obstructed: positiveNum })
    .strict()
    .refine((t) => validateScoiStateThresholds(t) === null, {
      message: 'thresholds must satisfy ambiguous < split < obstructed inside (0, 1)',
    }),
  'invariants.phiThresholds': z
    .object({
      baseThreshold: positiveNum,
      sensitiveTopicFactor: z.number(),
      minorFactor: z.number(),
      baseRepeatThreshold: z.number().int(),
      repeatReduction: z.number().int(),
    })
    .strict()
    .refine((t) => validatePhiThresholdConfig(t) === null, {
      message: 'factors must lie in (0, 1] and repeat threshold >= 2',
    }),
  'invariants.phiNarrowLoop': z
    .object({ repeatThreshold: positiveInt.gte(2), windowMs: positiveInt })
    .strict(),
  'invariants.phiSequenceCap': positiveInt.gte(10).lte(1_000),
  'invariants.gweiEpsilons': z.array(z.number().gt(0).lte(1)).min(1).max(8),
  'invariants.gweiSeeds': z.array(z.number().int().nonnegative()).min(1).max(16),
  'invariants.gweiKAnonymity': positiveInt.gte(2),
  'invariants.gweiMinCohortSize': positiveInt.gte(2),
  'invariants.promotionMinShadowDays': positiveInt.lte(365),
  'invariants.scoiNeedsContextThreshold': z.number().gt(0).lt(1),
  'invariants.thresholdHuggingBandFraction': z.number().gt(0).lt(1),
  'invariants.thresholdHuggingMinPopulation': positiveInt.gte(5).lte(10_000),
  'invariants.thresholdHuggingExcess': positiveNum.gte(1),
  'invariants.mfciCalibrationDriftMaxRatio': positiveNum.gte(1),
  'invariants.mfciExcludeFlaggedWindows': z.boolean(),
};

export const INVARIANTS_CONFIG_KEYS = Object.keys(
  CONFIG_VALIDATORS,
) as readonly (keyof typeof CONFIG_VALIDATORS)[];

/** Write-time validation: a problem string (422) or null. */
export function validateInvariantsConfigValue(key: string, value: unknown): string | null {
  const validator = CONFIG_VALIDATORS[key];
  if (!validator) return `unknown invariants config key '${key}'`;
  const result = validator.safeParse(value);
  if (result.success) return null;
  return result.error.issues[0]?.message ?? 'invalid value';
}

const KEY_TO_FIELD: Record<string, keyof InvariantsRuntimeConfig> = {
  'invariants.wrapperTimeoutMs': 'wrapperTimeoutMs',
  'invariants.realtimeLatencyBudgetMs': 'realtimeLatencyBudgetMs',
  'invariants.batchConcurrency': 'batchConcurrency',
  'invariants.meriCandidateLimit': 'meriCandidateLimit',
  'invariants.meriNearDuplicateThreshold': 'meriNearDuplicateThreshold',
  'invariants.meriSemanticDuplicateThreshold': 'meriSemanticDuplicateThreshold',
  'invariants.mfciSamples': 'mfciSamples',
  'invariants.mfciBurnIn': 'mfciBurnIn',
  'invariants.mfciThinning': 'mfciThinning',
  'invariants.mfciFreezeScore': 'mfciFreezeScore',
  'invariants.mfciRiskThresholds': 'mfciRiskThresholds',
  'invariants.scoiStateThresholds': 'scoiStateThresholds',
  'invariants.phiThresholds': 'phiThresholds',
  'invariants.phiNarrowLoop': 'phiNarrowLoop',
  'invariants.phiSequenceCap': 'phiSequenceCap',
  'invariants.gweiEpsilons': 'gweiEpsilons',
  'invariants.gweiSeeds': 'gweiSeeds',
  'invariants.gweiKAnonymity': 'gweiKAnonymity',
  'invariants.gweiMinCohortSize': 'gweiMinCohortSize',
  'invariants.promotionMinShadowDays': 'promotionMinShadowDays',
  'invariants.scoiNeedsContextThreshold': 'scoiNeedsContextThreshold',
  'invariants.thresholdHuggingBandFraction': 'thresholdHuggingBandFraction',
  'invariants.thresholdHuggingMinPopulation': 'thresholdHuggingMinPopulation',
  'invariants.thresholdHuggingExcess': 'thresholdHuggingExcess',
  'invariants.mfciCalibrationDriftMaxRatio': 'mfciCalibrationDriftMaxRatio',
  'invariants.mfciExcludeFlaggedWindows': 'mfciExcludeFlaggedWindows',
};

/**
 * Load the runtime config: every stored value validates or the default is
 * kept (fail closed, with the rejection reported through `onInvalid`).
 * Scalar/object values are stored under `{ value: … }` envelopes in the
 * shared config store (whose rows are JSON objects).
 */
export async function loadInvariantsConfig(
  configStore: PwattConfigStore,
  onInvalid: (key: string, problem: string) => void = () => {},
): Promise<InvariantsRuntimeConfig> {
  const config: InvariantsRuntimeConfig = structuredClone(DEFAULT_INVARIANTS_CONFIG);
  for (const key of INVARIANTS_CONFIG_KEYS) {
    const stored = await configStore.get(key);
    if (stored === null) continue;
    const value = 'value' in stored ? stored['value'] : stored;
    const problem = validateInvariantsConfigValue(key, value);
    if (problem !== null) {
      onInvalid(key, problem);
      continue;
    }
    const field = KEY_TO_FIELD[key];
    if (field) {
      (config as unknown as Record<string, unknown>)[field] = value;
    }
  }
  return config;
}

/** Store a validated value (callers must have validated first). */
export async function storeInvariantsConfigValue(
  configStore: PwattConfigStore,
  key: string,
  value: unknown,
): Promise<void> {
  await configStore.set(key, { value } as Record<string, unknown>);
}
