// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N runtime-tunable config (the house WS-E/F/G/J/L pattern): defaults live
// here; the compliance role overrides individual keys through the validated
// admin surface; the loader is FAIL-CLOSED — an invalid stored value is
// reported and the default kept, never half-applied.  Keys are namespaced
// `compliance.*` in the shared config store.
//
// Velocity limits are exact minor-unit integer STRINGS (never floats, never
// IEEE numbers): the reserve math runs on BigInt (in-memory) / decimal-string
// addition (Redis Lua), so 18-decimal assets can never overflow or round.
// NOTE (WS-N.2.2b counting model): the limiter counts COMPLIANCE CHECKS, not
// settled transactions — preflight and submit each reserve once, so an action
// typically costs ~2 checks.  Over-counting is the deliberate fail-safe
// direction (a retry can only tighten the window, never widen it); defaults
// carry the 2x factor.
import { regionCodeSchema } from '@licio/shared';
import { z } from 'zod';
import type { PwattConfigStore } from '../events/stores.js';

export interface VelocityLimit {
  /** Sliding-window length in seconds. */
  periodSeconds: number;
  /** Max compliance checks in the window (count dimension). */
  maxCount: number;
  /** Max summed minor units in the window (volume dimension). */
  maxVolumeMinorUnits: string;
}

export interface ComplianceRuntimeConfig {
  /** Policy-cache TTL (WS-N.1.1e; hot-reload upper bound). */
  policyCacheTtlMs: number;
  /** Sanctions screening result cache TTL (WS-N.2.2a; default 24 h). */
  screeningCacheTtlMs: number;
  /** Partial-match results cache far shorter (a review may clear them). */
  screeningPartialCacheTtlMs: number;
  /** Sanctions provider HTTP timeout. */
  screeningTimeoutMs: number;
  /** Global velocity limits (checks; see the counting-model note above). */
  velocityLimits: VelocityLimit[];
  /** Per-region overrides keyed by region code (WS-N.2.2b "per jurisdiction"). */
  velocityRegionOverrides: Record<string, VelocityLimit[]>;
  /** At/above this minor-unit amount a check is `elevated` ⇒ the fraud queue
   *  (WS-N.2.2c high-value manual review; distinct from the WS-L.2.6e
   *  signing step-up threshold). */
  highValueReviewThresholdMinorUnits: string;
  /** Counsel-approved retention schedule reference (recorded, WS-N.2.1d). */
  retentionScheduleRef: string;
  /** Retention days per case trigger type (WS-N.2.1d). */
  retentionDaysByTrigger: Record<string, number>;
  /** Triggers whose expired cases are ANONYMIZED instead of deleted. */
  retentionAnonymizeTriggers: string[];
  /** Retention sweep cadence (lease-guarded scheduler). */
  retentionSweepIntervalMs: number;
  /** Case SLA hours by risk level (queue targets, WS-N.2.2c). */
  slaHoursByRisk: Record<string, number>;
  /** WS-E.1.4 jurisdictional retention overrides: tier → max days (SHORTENS only). */
  eventRetentionOverrides: Record<string, number>;
}

export const DEFAULT_COMPLIANCE_CONFIG: ComplianceRuntimeConfig = {
  policyCacheTtlMs: 5 * 60_000,
  screeningCacheTtlMs: 24 * 3_600_000,
  screeningPartialCacheTtlMs: 15 * 60_000,
  screeningTimeoutMs: 5_000,
  velocityLimits: [
    // ~10 actions/hour and ~50 actions/day at the 2x check factor;
    // volume 10,000 / 50,000 units at 6 decimals.
    { periodSeconds: 3_600, maxCount: 20, maxVolumeMinorUnits: '10000000000' },
    { periodSeconds: 86_400, maxCount: 100, maxVolumeMinorUnits: '50000000000' },
  ],
  velocityRegionOverrides: {},
  highValueReviewThresholdMinorUnits: '1000000000', // 1,000 units at 6 decimals
  retentionScheduleRef: 'PENDING-COUNSEL-APPROVAL',
  retentionDaysByTrigger: {
    velocity: 730,
    pattern: 730,
    sanctions: 1_825,
    manual: 730,
    fraud: 1_825,
    scam: 1_825,
    impersonation: 730,
    bribery: 1_825,
    coercion: 1_825,
  },
  retentionAnonymizeTriggers: [],
  retentionSweepIntervalMs: 24 * 3_600_000,
  slaHoursByRisk: { low: 24, medium: 4, high: 1, critical: 1 },
  eventRetentionOverrides: {},
};

const CONFIG_PREFIX = 'compliance.';

const minorUnits = z.string().regex(/^\d{1,78}$/);
const velocityLimitSchema = z
  .object({
    periodSeconds: z.number().int().min(60).max(31_536_000),
    maxCount: z.number().int().min(1).max(1_000_000),
    maxVolumeMinorUnits: minorUnits,
  })
  .strict();

const VALIDATORS: Readonly<Record<keyof ComplianceRuntimeConfig, z.ZodType>> = {
  policyCacheTtlMs: z.number().int().min(1_000).max(3_600_000),
  screeningCacheTtlMs: z
    .number()
    .int()
    .min(60_000)
    .max(7 * 86_400_000),
  screeningPartialCacheTtlMs: z.number().int().min(10_000).max(86_400_000),
  screeningTimeoutMs: z.number().int().min(500).max(60_000),
  velocityLimits: z.array(velocityLimitSchema).min(1).max(10),
  // The KEY must be a canonical region code (`regionCodeSchema`, e.g. `US`,
  // `US-CA`, `EU`), NOT any 2–64 char string: `limitsForRegion` does an EXACT
  // lookup with the resolved region code, so a non-canonical key (`us`, a typo)
  // would validate, store, and then silently fall back to the global limits —
  // a jurisdiction-specific fraud control that looks configured but never fires.
  velocityRegionOverrides: z.record(regionCodeSchema, z.array(velocityLimitSchema).min(1).max(10)),
  highValueReviewThresholdMinorUnits: minorUnits,
  retentionScheduleRef: z.string().min(1).max(256),
  retentionDaysByTrigger: z.record(z.string().min(1).max(32), z.number().int().min(1).max(36_500)),
  retentionAnonymizeTriggers: z.array(z.string().min(1).max(32)).max(16),
  retentionSweepIntervalMs: z
    .number()
    .int()
    .min(3_600_000)
    .max(7 * 86_400_000),
  slaHoursByRisk: z.record(z.string().min(1).max(16), z.number().int().min(1).max(720)),
  eventRetentionOverrides: z.record(z.string().min(1).max(64), z.number().int().min(1).max(3_650)),
};

export const COMPLIANCE_CONFIG_KEYS = Object.keys(VALIDATORS) as Array<
  keyof ComplianceRuntimeConfig
>;

/** Validate one key's candidate value; null ⇒ OK, string ⇒ the problem. */
export function validateComplianceConfigValue(key: string, value: unknown): string | null {
  const validator = (VALIDATORS as Record<string, z.ZodType | undefined>)[key];
  if (!validator) return `unknown compliance config key: ${key}`;
  const parsed = validator.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid value');
}

/** Fail-closed loader: invalid stored values are reported and defaults kept. */
export async function loadComplianceConfig(
  configStore: PwattConfigStore,
  onInvalid: (key: string, problem: string) => void = () => {},
): Promise<ComplianceRuntimeConfig> {
  const config: ComplianceRuntimeConfig = structuredClone(DEFAULT_COMPLIANCE_CONFIG);
  for (const key of COMPLIANCE_CONFIG_KEYS) {
    let stored: Record<string, unknown> | null;
    try {
      stored = await configStore.get(`${CONFIG_PREFIX}${key}`);
    } catch {
      // A store outage never loosens a compliance control: the default holds.
      onInvalid(key, 'config store unreadable');
      continue;
    }
    if (stored === null || !Object.hasOwn(stored, 'value')) continue;
    const value = stored['value'];
    const problem = validateComplianceConfigValue(key, value);
    if (problem !== null) {
      onInvalid(key, problem);
      continue;
    }
    (config as unknown as Record<string, unknown>)[key] = value;
  }
  return config;
}

/** Admin write path (the route validates BEFORE calling this). */
export async function storeComplianceConfigValue(
  configStore: PwattConfigStore,
  key: string,
  value: unknown,
): Promise<void> {
  await configStore.set(`${CONFIG_PREFIX}${key}`, { value });
}
