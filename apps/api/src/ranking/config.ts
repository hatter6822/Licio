// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I runtime configuration (the house fail-closed pattern, WS-E.2.3c):
// values live in the shared runtime-config store under `ranking.*` keys,
// every stored value is zod-validated on load, an invalid stored value is
// LOGGED AND IGNORED (the reviewed default stays in force — fail closed),
// and the steward write surface rejects invalid values with 422 BEFORE they
// land. Ranking profiles are additionally validated through the WS-I.2.3f
// loader (§5.5 guardrails); a stored profile set that fails the loader is
// rejected wholesale (all-or-none — a half-valid profile set is a mistake).

import {
  DECISION_LOG_RETENTION_MIN_DAYS,
  loadRankingProfiles,
  type RankingProfileConfig,
  RankingProfileLoadError,
  SHIPPED_RANKING_PROFILES,
} from '@licio/ranking';
import { z } from 'zod';
import type { EventPipelineServices } from '../events/services.js';

export interface RankingRuntimeConfig {
  /** Validated profile set (WS-I.2.3f). Defaults to the shipped two. */
  profiles: readonly RankingProfileConfig[];
  /** Decision-log retention in days (§22.4: clamped to 180–365 at use). */
  decisionLogRetentionDays: number;
  /** Per-tick replay-regression sample size (WS-I.2.5b scheduled job). */
  replaySampleSize: number;
  /** Feature-store batch refresh: max items per scheduler tick. */
  featureBatchLimit: number;
  /** Feature staleness horizon (hours) before batch refresh re-assembles. */
  featureStaleHours: number;
  /** GWEI-gate recency window: only rows this fresh feed the gate. */
  gweiGateWindowHours: number;
  /**
   * The DOCUMENTED-OWNER override of the GWEI release gate (SPEC §9.5 /
   * WS-H.5: "override requires a documented owner"): while `untilMs` is in
   * the future, a tripped gate keeps ranked serving but logs loudly with
   * the owner and reason on every affected request. Null ⇒ no override.
   */
  gweiOverride: { untilMs: number; owner: string; reason: string } | null;
}

export const DEFAULT_RANKING_CONFIG: RankingRuntimeConfig = {
  profiles: SHIPPED_RANKING_PROFILES,
  decisionLogRetentionDays: DECISION_LOG_RETENTION_MIN_DAYS,
  replaySampleSize: 5,
  featureBatchLimit: 200,
  featureStaleHours: 6,
  gweiGateWindowHours: 7 * 24,
  gweiOverride: null,
};

const scalarsSchema = z
  .object({
    decision_log_retention_days: z.number().int().min(180).max(365).optional(),
    replay_sample_size: z.number().int().min(0).max(100).optional(),
    feature_batch_limit: z.number().int().min(1).max(5000).optional(),
    feature_stale_hours: z.number().int().min(1).max(168).optional(),
    gwei_gate_window_hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .optional(),
  })
  .strict();

const profilesSchema = z.object({ profiles: z.array(z.unknown()).min(1) }).strict();

const gweiOverrideSchema = z
  .object({
    until: z.string().datetime(),
    owner: z.string().min(1).max(128),
    reason: z.string().min(1).max(512),
  })
  .strict();

export const RANKING_CONFIG_KEYS = [
  'ranking.scalars',
  'ranking.profiles',
  'ranking.gwei_override',
] as const;
export type RankingConfigKey = (typeof RANKING_CONFIG_KEYS)[number];

/**
 * Pre-write validation for the steward surface (422 on rejection — an
 * invalid value never lands). Returns null when valid, else the problem.
 */
export function validateRankingConfigValue(
  key: RankingConfigKey,
  value: Record<string, unknown>,
): string | null {
  switch (key) {
    case 'ranking.scalars': {
      const parsed = scalarsSchema.safeParse(value);
      return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid scalars');
    }
    case 'ranking.profiles': {
      const parsed = profilesSchema.safeParse(value);
      if (!parsed.success) return parsed.error.issues[0]?.message ?? 'invalid profiles wrapper';
      try {
        loadRankingProfiles(parsed.data.profiles);
        return null;
      } catch (error) {
        return error instanceof RankingProfileLoadError ? error.message : 'invalid profiles';
      }
    }
    case 'ranking.gwei_override': {
      const parsed = gweiOverrideSchema.safeParse(value);
      return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid override');
    }
    default:
      return 'unknown ranking config key';
  }
}

/** Load with fail-closed fallback: invalid stored values keep the default. */
export async function loadRankingRuntimeConfig(
  events: EventPipelineServices,
): Promise<RankingRuntimeConfig> {
  const config: RankingRuntimeConfig = { ...DEFAULT_RANKING_CONFIG };
  const reject = (key: string, detail: string): void => {
    events.log('ranking.config.rejected', { key, detail });
  };

  const scalars = await events.configStore.get('ranking.scalars');
  if (scalars) {
    const parsed = scalarsSchema.safeParse(scalars);
    if (parsed.success) {
      if (parsed.data.decision_log_retention_days !== undefined) {
        config.decisionLogRetentionDays = parsed.data.decision_log_retention_days;
      }
      if (parsed.data.replay_sample_size !== undefined) {
        config.replaySampleSize = parsed.data.replay_sample_size;
      }
      if (parsed.data.feature_batch_limit !== undefined) {
        config.featureBatchLimit = parsed.data.feature_batch_limit;
      }
      if (parsed.data.feature_stale_hours !== undefined) {
        config.featureStaleHours = parsed.data.feature_stale_hours;
      }
      if (parsed.data.gwei_gate_window_hours !== undefined) {
        config.gweiGateWindowHours = parsed.data.gwei_gate_window_hours;
      }
    } else {
      reject('ranking.scalars', parsed.error.issues[0]?.message ?? 'invalid');
    }
  }

  const override = await events.configStore.get('ranking.gwei_override');
  if (override) {
    const parsed = gweiOverrideSchema.safeParse(override);
    if (parsed.success) {
      config.gweiOverride = {
        untilMs: Date.parse(parsed.data.until),
        owner: parsed.data.owner,
        reason: parsed.data.reason,
      };
    } else {
      // Fail closed: an unreadable override does NOT override the gate.
      reject('ranking.gwei_override', parsed.error.issues[0]?.message ?? 'invalid');
    }
  }

  const storedProfiles = await events.configStore.get('ranking.profiles');
  if (storedProfiles) {
    const parsed = profilesSchema.safeParse(storedProfiles);
    if (parsed.success) {
      try {
        config.profiles = loadRankingProfiles(parsed.data.profiles);
      } catch (error) {
        reject('ranking.profiles', error instanceof Error ? error.message : 'invalid profile set');
      }
    } else {
      reject('ranking.profiles', parsed.error.issues[0]?.message ?? 'invalid');
    }
  }

  // The defaults themselves must always validate (boot-time assertion).
  loadRankingProfiles([...config.profiles]);
  return config;
}
