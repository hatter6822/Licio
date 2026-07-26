// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L runtime-tunable config (the house WS-E/F/G/J pattern): defaults live
// here; admins override individual keys through the validated admin surface;
// the loader is FAIL-CLOSED — an invalid stored value is reported and the
// default kept, never half-applied.  Keys are namespaced `knomosis.*` in the
// shared config store.
//
// `cryptoEnabled` here is THE single runtime source of truth for the crypto
// feature flag (SPEC §0.5 constraint 10): the `/v1/feature-flags` route, the
// WS-E event pipeline's `cryptoFlagEnabled` closure, and the WS-U governance
// service all read the value resolved from this loader.  It defaults FALSE and
// only a validated boolean `true` in the config store can enable it; any read
// or parse failure keeps it false (fail-closed in the OFF direction).

import { PAYMENT_INTENT_DEFAULT_MAX_RETRIES } from '@licio/governance';
import { DEFAULT_SIM_ASSET, simAssetCodeSchema } from '@licio/shared';
import { z } from 'zod';
import type { PwattConfigStore } from '../events/stores.js';

export interface KnomosisRuntimeConfig {
  /** THE crypto flag (SPEC §0.5 c.10).  Default false; fail-closed. */
  cryptoEnabled: boolean;
  /** Room-governance plane flag.  Default false; fail-closed. */
  governanceEnabled: boolean;
  /** Per-region availability flags served to clients (absent ⇒ false). */
  regionFlags: Record<string, boolean>;
  /** SIWE link-nonce TTL (WS-L.2.3a, default 5 minutes). */
  siweNonceTtlMs: number;
  /** SIWE clock-skew tolerance (WS-L.2.3c, default 30 s). */
  siweClockSkewMs: number;
  /** Preflight-token TTL (WS-L.3.1c, default 5 minutes). */
  preflightTokenTtlMs: number;
  /** Signed-action expiration window the server will accept (seconds). */
  actionExpirationMaxSeconds: number;
  /** Wallet abuse limits (WS-L.2.5d). */
  maxWalletsPerUser: number;
  relinkCooldownDays: number;
  linkAttemptsPerHour: number;
  unlinkRequestsPerDay: number;
  /** Unlink cooling-off before finalization (WS-L.2.5b, default 24 h). */
  unlinkCoolingOffHours: number;
  /** Minor-unit amount at/above which signing requires step-up (WS-L.2.6e). */
  highValueThresholdMinorUnits: string;
  /** Simulated-treasury bootstrap (WS-L.4.1c; default 10,000 SIM-USDC @6dp). */
  simStartingAsset: string;
  simStartingBalanceMinorUnits: string;
  /** Simulation vote rules (WS-L.4.1d MVP defaults; law-pack overrides later). */
  simQuorumMinVoters: number;
  simApprovalThresholdPercent: number;
  simTimelockSeconds: number;
  /** Minimum audit-log track record required by the readiness gate (WS-L.4.1g). */
  readinessMinSimActions: number;
  /** Periodic three-source reconciliation cadence (WS-L.3.4a, default 15 min). */
  reconciliationIntervalMs: number;
  /** Unexplained-delta threshold (minor units) that classifies as critical. */
  divergenceCriticalThresholdMinorUnits: string;
  // --- WS-M treasury-and-governance tunables (WS-M.3.1b timeouts, WS-M.4 windows).
  /** Payment-intent per-state TTLs (created/preflighted/quoted/signed). */
  wsmIntentCreatedTtlMs: number;
  wsmIntentPreflightedTtlMs: number;
  wsmIntentQuotedTtlMs: number;
  wsmIntentSignedTtlMs: number;
  /** Bounded retries for failed/reverted intents (WS-M.3.1b). */
  wsmIntentMaxRetries: number;
  /** Grace window for a `reorged` intent to re-confirm on the canonical chain
   *  before it is abandoned for a clean terminal audit trail (WS-M.3.1d). */
  wsmIntentReorgRecoveryMs: number;
  /** Default proposal windows where the law-pack sets none (WS-M.4.2a/2d/3a). */
  wsmDeliberationSeconds: number;
  wsmVotingSeconds: number;
  wsmChallengeWindowSeconds: number;
  /** A passed proposal expires if unexecuted this long after clearance. */
  wsmExecutionWindowSeconds: number;
  /** Flat estimated network fee shown in deposit/payout quotes (minor units). */
  wsmEstimatedFeeMinorUnits: string;
}

export const DEFAULT_KNOMOSIS_CONFIG: KnomosisRuntimeConfig = {
  cryptoEnabled: false,
  governanceEnabled: false,
  regionFlags: {},
  siweNonceTtlMs: 5 * 60_000,
  siweClockSkewMs: 30_000,
  preflightTokenTtlMs: 5 * 60_000,
  actionExpirationMaxSeconds: 15 * 60,
  maxWalletsPerUser: 5,
  relinkCooldownDays: 7,
  linkAttemptsPerHour: 10,
  unlinkRequestsPerDay: 5,
  unlinkCoolingOffHours: 24,
  highValueThresholdMinorUnits: '100000000', // 100 units at 6 decimals
  // The shared asset registry OWNS the `SIM-` vocabulary; spelling the code
  // again here made the canonical prefix changeable in one place while this
  // default kept minting ledger assets under the old one.
  simStartingAsset: DEFAULT_SIM_ASSET,
  simStartingBalanceMinorUnits: '10000000000', // 10,000.000000 SIM-USDC
  simQuorumMinVoters: 3,
  simApprovalThresholdPercent: 50,
  simTimelockSeconds: 3_600,
  readinessMinSimActions: 5,
  reconciliationIntervalMs: 15 * 60_000,
  divergenceCriticalThresholdMinorUnits: '1',
  wsmIntentCreatedTtlMs: 30 * 60_000,
  wsmIntentPreflightedTtlMs: 10 * 60_000,
  wsmIntentQuotedTtlMs: 5 * 60_000,
  wsmIntentSignedTtlMs: 5 * 60_000,
  // The WS-M lifecycle package OWNS this bound (it is the retry edge
  // `failed`/`reverted` → `created` in the payment-intent state machine); this
  // is only where an operator may override it.  Spelling `3` again here made
  // the domain constant a dead duplicate that could silently disagree with the
  // value actually enforced.
  wsmIntentMaxRetries: PAYMENT_INTENT_DEFAULT_MAX_RETRIES,
  wsmIntentReorgRecoveryMs: 60 * 60_000,
  wsmDeliberationSeconds: 24 * 3600,
  wsmVotingSeconds: 3 * 24 * 3600,
  wsmChallengeWindowSeconds: 2 * 24 * 3600,
  wsmExecutionWindowSeconds: 14 * 24 * 3600,
  wsmEstimatedFeeMinorUnits: '0',
};

const CONFIG_PREFIX = 'knomosis.';

const minorUnits = z.string().regex(/^\d{1,78}$/);

const VALIDATORS: Readonly<Record<keyof KnomosisRuntimeConfig, z.ZodType>> = {
  cryptoEnabled: z.boolean(),
  governanceEnabled: z.boolean(),
  regionFlags: z.record(z.string().min(2).max(64), z.boolean()),
  siweNonceTtlMs: z.number().int().min(10_000).max(3_600_000),
  siweClockSkewMs: z.number().int().min(0).max(300_000),
  preflightTokenTtlMs: z.number().int().min(10_000).max(3_600_000),
  actionExpirationMaxSeconds: z.number().int().min(60).max(86_400),
  maxWalletsPerUser: z.number().int().min(1).max(100),
  relinkCooldownDays: z.number().int().min(0).max(365),
  linkAttemptsPerHour: z.number().int().min(1).max(1_000),
  unlinkRequestsPerDay: z.number().int().min(1).max(1_000),
  unlinkCoolingOffHours: z.number().int().min(0).max(720),
  highValueThresholdMinorUnits: minorUnits,
  // The same validator the WIRE schema applies: an operator override that the
  // gateway would then reject is not a valid config value.
  simStartingAsset: simAssetCodeSchema,
  simStartingBalanceMinorUnits: minorUnits,
  simQuorumMinVoters: z.number().int().min(1).max(100_000),
  simApprovalThresholdPercent: z.number().int().min(1).max(100),
  simTimelockSeconds: z.number().int().min(0).max(2_592_000),
  readinessMinSimActions: z.number().int().min(0).max(10_000),
  reconciliationIntervalMs: z.number().int().min(60_000).max(86_400_000),
  divergenceCriticalThresholdMinorUnits: minorUnits,
  wsmIntentCreatedTtlMs: z.number().int().min(60_000).max(86_400_000),
  wsmIntentPreflightedTtlMs: z.number().int().min(60_000).max(86_400_000),
  wsmIntentQuotedTtlMs: z.number().int().min(60_000).max(86_400_000),
  wsmIntentSignedTtlMs: z.number().int().min(60_000).max(86_400_000),
  wsmIntentMaxRetries: z.number().int().min(0).max(10),
  wsmIntentReorgRecoveryMs: z.number().int().min(60_000).max(604_800_000),
  wsmDeliberationSeconds: z
    .number()
    .int()
    .min(60)
    .max(90 * 24 * 3600),
  wsmVotingSeconds: z
    .number()
    .int()
    .min(60)
    .max(90 * 24 * 3600),
  wsmChallengeWindowSeconds: z
    .number()
    .int()
    .min(60)
    .max(90 * 24 * 3600),
  wsmExecutionWindowSeconds: z
    .number()
    .int()
    .min(3600)
    .max(90 * 24 * 3600),
  wsmEstimatedFeeMinorUnits: z.string().regex(/^\d{1,78}$/),
};

export const KNOMOSIS_CONFIG_KEYS = Object.keys(VALIDATORS) as Array<keyof KnomosisRuntimeConfig>;

/** Validate one key's candidate value; null ⇒ OK, string ⇒ the problem. */
export function validateKnomosisConfigValue(key: string, value: unknown): string | null {
  const validator = (VALIDATORS as Record<string, z.ZodType | undefined>)[key];
  if (!validator) return `unknown knomosis config key: ${key}`;
  const parsed = validator.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid value');
}

/** Fail-closed loader: invalid stored values are reported and defaults kept. */
export async function loadKnomosisConfig(
  configStore: PwattConfigStore,
  onInvalid: (key: string, problem: string) => void = () => {},
): Promise<KnomosisRuntimeConfig> {
  const config: KnomosisRuntimeConfig = { ...DEFAULT_KNOMOSIS_CONFIG };
  for (const key of KNOMOSIS_CONFIG_KEYS) {
    let stored: Record<string, unknown> | null;
    try {
      stored = await configStore.get(`${CONFIG_PREFIX}${key}`);
    } catch {
      // A store outage never turns a crypto flag ON: the default (false) holds.
      onInvalid(key, 'config store unreadable');
      continue;
    }
    if (stored === null || !Object.hasOwn(stored, 'value')) continue;
    const value = stored['value'];
    const problem = validateKnomosisConfigValue(key, value);
    if (problem !== null) {
      onInvalid(key, problem);
      continue;
    }
    (config as unknown as Record<string, unknown>)[key] = value;
  }
  return config;
}

/** Admin write path (the route validates BEFORE calling this). */
export async function storeKnomosisConfigValue(
  configStore: PwattConfigStore,
  key: string,
  value: unknown,
): Promise<void> {
  await configStore.set(`${CONFIG_PREFIX}${key}`, { value });
}
