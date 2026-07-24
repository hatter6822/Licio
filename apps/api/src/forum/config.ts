// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G runtime-tunable forum config (the WS-E/WS-F config pattern): defaults
// live here; stewards may override individual keys through the validated
// admin surface (write-time 422 rejection), and the loader is FAIL-CLOSED —
// an invalid stored value is logged and the default kept, never
// half-applied.  Keys are namespaced `forum.*` in the shared config store.
//
// The drainer blocklist (WS-G.4.2c) lives HERE so it is updatable without an
// app deploy: the public `GET /v1/security/link-blocklist` endpoint serves
// the merged (default ∪ configured) list with a content-hash version for
// client cache-busting.
import { isValidBlocklistDomain } from '@licio/shared';
import { z } from 'zod';
import type { PwattConfigStore } from '../events/stores.js';

export interface ForumRuntimeConfig {
  /** Contribution rate limit (WS-G.3.1: max 10/minute/user). */
  contributionsPerMinute: number;
  contributionsPerHour: number;
  /** Bound on rows fetched for one thread's tree assembly (WS-G.3.3). */
  threadFetchLimit: number;
  /** Branch page size (lazy loading: first N + continuation cursor). */
  branchPageSize: number;
  /** Subtree read bound (WS-G.1.2d-2 benchmark shape: 500 contributions). */
  subtreeLimit: number;
  /** Wallet-drainer domain blocklist (WS-G.4.2c; merged with the default). */
  drainerBlocklist: string[];
  /** Room listing page size bounds (WS-G.2.3a: default 20, max 50). */
  roomPageSize: number;
  roomPageSizeMax: number;
  /** The `/threads` global directory scan (WS-G.3.3): rows per keyset batch and
   *  the max batches scanned per request.  Bounds the work when many non-global
   *  (private/room_only/moderation-removed) threads precede public ones; the
   *  continuation cursor still advances past them, so older public conversations
   *  stay reachable across pages. */
  threadDirectoryScanBatch: number;
  threadDirectoryMaxScanBatches: number;
  /** Structural `active → deepening` thresholds (§15.4 "sustained,
   *  multi-level conversation with evidence accumulating"): evaluated at
   *  contribution creation; ALL three must hold. */
  deepeningMinContributions: number;
  deepeningMinDepth: number;
  deepeningMinEvidence: number;
  /** WS-T challenge policy (§15.4): the per-account open-challenge capacity —
   *  floor for every account; KYC and adjudicated challenger wins raise it
   *  (challenge-policy.ts owns the math).  A slot is an arena pre-verdict
   *  (open/locked/awaiting_verdict); it frees when the verdict lands. */
  challengeBaseCapacity: number;
  challengeKycCapacityBonus: number;
  /** Adjudicated challenger wins per earned capacity tier, and the tier cap. */
  challengeWinsPerTier: number;
  challengeMaxEarnedTiers: number;
  /** Absolute capacity ceilings (non-KYC / KYC-verified). */
  challengeMaxCapacity: number;
  challengeMaxCapacityKyc: number;
  /** Earned tiers require at least this adjudicated win rate (wins over
   *  wins+losses as challenger; concessions and inconclusives count neither). */
  challengeMinWinRate: number;
  /** Velocity backstop: arenas opened per trailing 24h, regardless of slots. */
  challengeOpensPerDay: number;
  /** Withdrawal inside this window with a never-engaged incumbent is FREE
   *  (misclick/instant-regret) — it consumes nothing and cools nothing down. */
  challengeWithdrawGraceMinutes: number;
  /** Escalating cooldowns after the 1st / 2nd / 3rd+ non-grace withdrawal in
   *  the trailing window — priced BELOW losing, so the compute-saving exit
   *  stays rational for a challenger who realizes they are wrong. */
  challengeWithdrawCooldownFirstHours: number;
  challengeWithdrawCooldownSecondHours: number;
  challengeWithdrawCooldownThirdHours: number;
  /** The trailing window for withdrawal counting and capacity penalties. */
  challengeWithdrawWindowDays: number;
  /** Non-grace withdrawals in the window beyond this each cost −1 capacity. */
  challengeFreeWithdrawalsPerWindow: number;
  /** Tier-counted wins are deduped per opponent account at this cap (the
   *  sibling-subdomain rule of standing: a ring cannot mint tiers). */
  challengePerOpponentWinCap: number;
  /** Adjudicated `upheld` defenses (since the target's last material edit)
   *  after which the target is SETTLED — no longer challengeable. */
  challengeSettleThreshold: number;
}

export const DEFAULT_FORUM_CONFIG: ForumRuntimeConfig = {
  contributionsPerMinute: 10,
  contributionsPerHour: 120,
  threadFetchLimit: 2_000,
  branchPageSize: 50,
  subtreeLimit: 500,
  drainerBlocklist: [],
  roomPageSize: 20,
  roomPageSizeMax: 50,
  threadDirectoryScanBatch: 200,
  threadDirectoryMaxScanBatches: 25,
  deepeningMinContributions: 12,
  deepeningMinDepth: 2,
  deepeningMinEvidence: 2,
  challengeBaseCapacity: 1,
  challengeKycCapacityBonus: 2,
  challengeWinsPerTier: 3,
  challengeMaxEarnedTiers: 5,
  challengeMaxCapacity: 4,
  challengeMaxCapacityKyc: 8,
  challengeMinWinRate: 0.5,
  challengeOpensPerDay: 5,
  challengeWithdrawGraceMinutes: 5,
  challengeWithdrawCooldownFirstHours: 2,
  challengeWithdrawCooldownSecondHours: 24,
  challengeWithdrawCooldownThirdHours: 72,
  challengeWithdrawWindowDays: 30,
  challengeFreeWithdrawalsPerWindow: 1,
  challengePerOpponentWinCap: 2,
  challengeSettleThreshold: 3,
};

const CONFIG_PREFIX = 'forum.';

const VALIDATORS: Readonly<Record<keyof ForumRuntimeConfig, z.ZodType>> = {
  contributionsPerMinute: z.number().int().min(1).max(120),
  contributionsPerHour: z.number().int().min(1).max(5_000),
  threadFetchLimit: z.number().int().min(100).max(10_000),
  branchPageSize: z.number().int().min(10).max(50),
  subtreeLimit: z.number().int().min(50).max(2_000),
  drainerBlocklist: z
    .array(z.string())
    .max(5_000)
    .refine((domains) => domains.every(isValidBlocklistDomain), {
      message: 'every entry must be a bare lower-case domain',
    }),
  roomPageSize: z.number().int().min(5).max(50),
  roomPageSizeMax: z.number().int().min(5).max(50),
  threadDirectoryScanBatch: z.number().int().min(1).max(1_000),
  threadDirectoryMaxScanBatches: z.number().int().min(1).max(100),
  deepeningMinContributions: z.number().int().min(3).max(500),
  deepeningMinDepth: z.number().int().min(1).max(10),
  deepeningMinEvidence: z.number().int().min(0).max(100),
  challengeBaseCapacity: z.number().int().min(1).max(10),
  challengeKycCapacityBonus: z.number().int().min(0).max(10),
  challengeWinsPerTier: z.number().int().min(1).max(50),
  challengeMaxEarnedTiers: z.number().int().min(0).max(20),
  challengeMaxCapacity: z.number().int().min(1).max(20),
  challengeMaxCapacityKyc: z.number().int().min(1).max(50),
  challengeMinWinRate: z.number().min(0).max(1),
  challengeOpensPerDay: z.number().int().min(1).max(100),
  challengeWithdrawGraceMinutes: z.number().int().min(0).max(60),
  challengeWithdrawCooldownFirstHours: z.number().int().min(0).max(168),
  challengeWithdrawCooldownSecondHours: z.number().int().min(0).max(720),
  challengeWithdrawCooldownThirdHours: z.number().int().min(0).max(720),
  challengeWithdrawWindowDays: z.number().int().min(1).max(365),
  challengeFreeWithdrawalsPerWindow: z.number().int().min(0).max(10),
  challengePerOpponentWinCap: z.number().int().min(1).max(50),
  challengeSettleThreshold: z.number().int().min(1).max(20),
};

export const FORUM_CONFIG_KEYS = Object.keys(VALIDATORS) as Array<keyof ForumRuntimeConfig>;

/** Validate one key's candidate value; null ⇒ OK, string ⇒ the problem. */
export function validateForumConfigValue(key: string, value: unknown): string | null {
  const validator = (VALIDATORS as Record<string, z.ZodType | undefined>)[key];
  if (!validator) return `unknown forum config key: ${key}`;
  const parsed = validator.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid value');
}

/** Fail-closed loader: invalid stored values are reported and defaults kept. */
export async function loadForumConfig(
  configStore: PwattConfigStore,
  onInvalid: (key: string, problem: string) => void = () => {},
): Promise<ForumRuntimeConfig> {
  const config: ForumRuntimeConfig = { ...DEFAULT_FORUM_CONFIG };
  for (const key of FORUM_CONFIG_KEYS) {
    const stored = await configStore.get(`${CONFIG_PREFIX}${key}`);
    if (stored === null || !Object.hasOwn(stored, 'value')) continue;
    const value = stored['value'];
    const problem = validateForumConfigValue(key, value);
    if (problem !== null) {
      onInvalid(key, problem);
      continue;
    }
    (config as unknown as Record<string, unknown>)[key] = value;
  }
  return config;
}

/** Steward write path (the admin route validates BEFORE calling this). */
export async function storeForumConfigValue(
  configStore: PwattConfigStore,
  key: string,
  value: unknown,
): Promise<void> {
  await configStore.set(`${CONFIG_PREFIX}${key}`, { value });
}
