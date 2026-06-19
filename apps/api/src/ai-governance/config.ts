// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K fail-closed runtime configuration (the WS-E/F/G/H/I house pattern):
// tunables live under `ai.*` keys in the shared runtime-config store, every
// stored value is VALIDATED on load, and an invalid value is rejected (logged,
// CONFIG_REJECTED metric) while the reviewed default is kept — a misconfiguration
// can never silently loosen a confidence threshold or a deployment gate. Steward
// writes validate at configuration time (422 on rejection).
import { z } from 'zod';
import type { PwattConfigStore } from '../events/stores.js';

export interface AiGovernanceConfig {
  /** Topic-classification confidence threshold (sub-threshold ⇒ review). */
  topicConfidenceThreshold: number;
  /** Claim-extraction confidence floor (sub-threshold ⇒ review). */
  claimConfidenceFloor: number;
  /** Hallucination-detection acceptable rate (above ⇒ flag/fail). */
  hallucinationRateThreshold: number;
  /** Bias-audit disparity threshold (above + significant ⇒ block). */
  biasDisparityThreshold: number;
  /** Subgroup minimum sample size for the bias audit (small-cohort floor). */
  biasMinSampleSize: number;
  /** Red-team minimum test cases per category. */
  redTeamMinPerCategory: number;
  /** Runtime monitoring sample rate (fraction of outputs evaluated). */
  runtimeSampleRate: number;
  /** Label-rate / output-distribution drift threshold (relative). */
  runtimeDriftThreshold: number;
  /** User-report-rate alert threshold (fraction of outputs reported). */
  runtimeUserReportThreshold: number;
  /** Minimum thread activity (contributions) for an automated summary. */
  summaryMinActivity: number;
}

export const DEFAULT_AI_GOVERNANCE_CONFIG: AiGovernanceConfig = {
  topicConfidenceThreshold: 0.7,
  claimConfidenceFloor: 0.5,
  hallucinationRateThreshold: 0.2,
  biasDisparityThreshold: 0.1,
  biasMinSampleSize: 30,
  redTeamMinPerCategory: 50,
  runtimeSampleRate: 0.1,
  runtimeDriftThreshold: 0.25,
  runtimeUserReportThreshold: 0.05,
  summaryMinActivity: 3,
};

const unitOpen = z.number().gt(0).lt(1);
const positiveInt = z.number().int().positive();

const CONFIG_VALIDATORS: Record<string, z.ZodType> = {
  'ai.topicConfidenceThreshold': unitOpen,
  'ai.claimConfidenceFloor': unitOpen,
  'ai.hallucinationRateThreshold': z.number().gte(0).lt(1),
  'ai.biasDisparityThreshold': unitOpen,
  'ai.biasMinSampleSize': positiveInt.lte(100_000),
  'ai.redTeamMinPerCategory': positiveInt.lte(10_000),
  'ai.runtimeSampleRate': z.number().gt(0).lte(1),
  'ai.runtimeDriftThreshold': unitOpen,
  'ai.runtimeUserReportThreshold': unitOpen,
  'ai.summaryMinActivity': positiveInt.lte(10_000),
};

export const AI_GOVERNANCE_CONFIG_KEYS = Object.keys(
  CONFIG_VALIDATORS,
) as readonly (keyof typeof CONFIG_VALIDATORS)[];

/** Write-time validation: a problem string (422) or null. */
export function validateAiGovernanceConfigValue(key: string, value: unknown): string | null {
  const validator = CONFIG_VALIDATORS[key];
  if (!validator) return `unknown ai config key '${key}'`;
  const result = validator.safeParse(value);
  if (result.success) return null;
  return result.error.issues[0]?.message ?? 'invalid value';
}

const KEY_TO_FIELD: Record<string, keyof AiGovernanceConfig> = {
  'ai.topicConfidenceThreshold': 'topicConfidenceThreshold',
  'ai.claimConfidenceFloor': 'claimConfidenceFloor',
  'ai.hallucinationRateThreshold': 'hallucinationRateThreshold',
  'ai.biasDisparityThreshold': 'biasDisparityThreshold',
  'ai.biasMinSampleSize': 'biasMinSampleSize',
  'ai.redTeamMinPerCategory': 'redTeamMinPerCategory',
  'ai.runtimeSampleRate': 'runtimeSampleRate',
  'ai.runtimeDriftThreshold': 'runtimeDriftThreshold',
  'ai.runtimeUserReportThreshold': 'runtimeUserReportThreshold',
  'ai.summaryMinActivity': 'summaryMinActivity',
};

/** Load the runtime config: every stored value validates or the default is kept. */
export async function loadAiGovernanceConfig(
  configStore: PwattConfigStore,
  onInvalid: (key: string, problem: string) => void = () => {},
): Promise<AiGovernanceConfig> {
  const config: AiGovernanceConfig = structuredClone(DEFAULT_AI_GOVERNANCE_CONFIG);
  for (const key of AI_GOVERNANCE_CONFIG_KEYS) {
    const stored = await configStore.get(key);
    if (stored === null) continue;
    const value = 'value' in stored ? stored['value'] : stored;
    const problem = validateAiGovernanceConfigValue(key, value);
    if (problem !== null) {
      onInvalid(key, problem);
      continue;
    }
    const field = KEY_TO_FIELD[key];
    if (field) (config as unknown as Record<string, unknown>)[field] = value;
  }
  return config;
}

/** Store a validated value (callers must have validated first). */
export async function storeAiGovernanceConfigValue(
  configStore: PwattConfigStore,
  key: string,
  value: unknown,
): Promise<void> {
  await configStore.set(key, { value } as Record<string, unknown>);
}
