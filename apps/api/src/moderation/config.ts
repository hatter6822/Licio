// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J runtime-tunable config (the WS-E/F/G config pattern): defaults live here;
// stewards override individual keys through the validated admin surface; the
// loader is FAIL-CLOSED — an invalid stored value is reported and the default
// kept, never half-applied.  Keys are namespaced `moderation.*` in the shared
// config store.  Rate limits, detection thresholds, spam patterns, and the
// malware-domain blocklist all live here so they are tunable WITHOUT a deploy
// (WS-J.1.1d / WS-J.2.6a/b/c/e acceptance: "configurable without code
// deployment").
import { isValidBlocklistDomain } from '@licio/shared';
import { z } from 'zod';
import type { PwattConfigStore } from '../events/stores.js';

export interface ModerationRuntimeConfig {
  /** Max reports per user per hour (WS-J.1.1d, default 10). */
  reportsPerHour: number;
  /** Max reports from one user against one target per 24h (WS-J.1.1d, default 3). */
  reportsPerTargetPerDay: number;
  /** Coordinated-report window + thresholds (WS-J.2.6e). */
  coordinationWindowSeconds: number;
  coordinationMinReports: number;
  coordinationMinDistinctReporters: number;
  /** Account age (days) below which a reporter counts toward the new-account
   *  cohort signal — the base-rate-conditioned coordination discriminator
   *  (MFCI-1): authentic communities have mixed ages, brigades skew new. */
  coordinationNewAccountDays: number;
  /** Coordination score (0..1) at/above which enforcement is delayed (MFCI-2). */
  coordinationDelayThreshold: number;
  /** Spam velocity (WS-J.2.6a): N similar items in the window from one account. */
  spamVelocityCount: number;
  spamVelocityWindowSeconds: number;
  /** Confidence (0..1) at/above which spam is auto-blocked (WS-J.2.6a). */
  spamBlockThreshold: number;
  /** Duplicate-flood (WS-J.2.6c): N similar posts across M rooms in the window. */
  duplicateFloodCount: number;
  duplicateFloodWindowSeconds: number;
  duplicateFloodMinRooms: number;
  /** Appeal SLAs (WS-J.1.3c). */
  appealSlaStandardHours: number;
  appealSlaBanHours: number;
  /** Ban-appeal cooldown (WS-J.1.3a, default 24h). */
  banAppealCooldownHours: number;
  /** Max items per bulk action (WS-J.2.1c, default 100). */
  bulkActionMax: number;
  /** Transparency-export small-cell suppression threshold (WS-J.2.5b). */
  transparencySuppressionThreshold: number;
  /** Version-controlled spam phrase/template patterns (case-insensitive substrings). */
  spamPatterns: string[];
  /** Known-spam content hashes (hex); a match is high-confidence spam. */
  knownSpamHashes: string[];
  /** Bare lower-case malware/phishing/drainer domains (WS-J.2.6b blocklist). */
  malwareDomains: string[];
  /** Max redirect hops the malware fetcher follows (WS-J.2.6b, default 5). */
  malwareRedirectMaxHops: number;
}

export const DEFAULT_MODERATION_CONFIG: ModerationRuntimeConfig = {
  reportsPerHour: 10,
  reportsPerTargetPerDay: 3,
  coordinationWindowSeconds: 300,
  coordinationMinReports: 10,
  coordinationMinDistinctReporters: 8,
  coordinationNewAccountDays: 7,
  coordinationDelayThreshold: 0.7,
  spamVelocityCount: 5,
  spamVelocityWindowSeconds: 600,
  spamBlockThreshold: 0.85,
  duplicateFloodCount: 3,
  duplicateFloodWindowSeconds: 900,
  duplicateFloodMinRooms: 2,
  appealSlaStandardHours: 72,
  appealSlaBanHours: 24,
  banAppealCooldownHours: 24,
  bulkActionMax: 100,
  transparencySuppressionThreshold: 5,
  spamPatterns: [],
  knownSpamHashes: [],
  malwareDomains: [],
  malwareRedirectMaxHops: 5,
};

const CONFIG_PREFIX = 'moderation.';

const VALIDATORS: Readonly<Record<keyof ModerationRuntimeConfig, z.ZodType>> = {
  reportsPerHour: z.number().int().min(1).max(1_000),
  reportsPerTargetPerDay: z.number().int().min(1).max(100),
  coordinationWindowSeconds: z.number().int().min(10).max(86_400),
  coordinationMinReports: z.number().int().min(2).max(10_000),
  coordinationMinDistinctReporters: z.number().int().min(2).max(10_000),
  coordinationNewAccountDays: z.number().int().min(0).max(3_650),
  coordinationDelayThreshold: z.number().min(0).max(1),
  spamVelocityCount: z.number().int().min(2).max(1_000),
  spamVelocityWindowSeconds: z.number().int().min(10).max(86_400),
  spamBlockThreshold: z.number().min(0).max(1),
  duplicateFloodCount: z.number().int().min(2).max(1_000),
  duplicateFloodWindowSeconds: z.number().int().min(10).max(86_400),
  duplicateFloodMinRooms: z.number().int().min(1).max(1_000),
  appealSlaStandardHours: z.number().int().min(1).max(2_160),
  appealSlaBanHours: z.number().int().min(1).max(2_160),
  banAppealCooldownHours: z.number().int().min(0).max(2_160),
  bulkActionMax: z.number().int().min(1).max(1_000),
  transparencySuppressionThreshold: z.number().int().min(1).max(1_000),
  spamPatterns: z.array(z.string().min(1).max(200)).max(5_000),
  knownSpamHashes: z.array(z.string().regex(/^[0-9a-f]{8,128}$/i)).max(100_000),
  malwareDomains: z
    .array(z.string())
    .max(100_000)
    .refine((domains) => domains.every(isValidBlocklistDomain), {
      message: 'every entry must be a bare lower-case domain',
    }),
  malwareRedirectMaxHops: z.number().int().min(0).max(20),
};

export const MODERATION_CONFIG_KEYS = Object.keys(VALIDATORS) as Array<
  keyof ModerationRuntimeConfig
>;

/** Validate one key's candidate value; null ⇒ OK, string ⇒ the problem. */
export function validateModerationConfigValue(key: string, value: unknown): string | null {
  const validator = (VALIDATORS as Record<string, z.ZodType | undefined>)[key];
  if (!validator) return `unknown moderation config key: ${key}`;
  const parsed = validator.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid value');
}

/** Fail-closed loader: invalid stored values are reported and defaults kept. */
export async function loadModerationConfig(
  configStore: PwattConfigStore,
  onInvalid: (key: string, problem: string) => void = () => {},
): Promise<ModerationRuntimeConfig> {
  const config: ModerationRuntimeConfig = { ...DEFAULT_MODERATION_CONFIG };
  for (const key of MODERATION_CONFIG_KEYS) {
    const stored = await configStore.get(`${CONFIG_PREFIX}${key}`);
    if (stored === null || !Object.hasOwn(stored, 'value')) continue;
    const value = stored['value'];
    const problem = validateModerationConfigValue(key, value);
    if (problem !== null) {
      onInvalid(key, problem);
      continue;
    }
    (config as unknown as Record<string, unknown>)[key] = value;
  }
  return config;
}

/** Steward write path (the admin route validates BEFORE calling this). */
export async function storeModerationConfigValue(
  configStore: PwattConfigStore,
  key: string,
  value: unknown,
): Promise<void> {
  await configStore.set(`${CONFIG_PREFIX}${key}`, { value });
}
