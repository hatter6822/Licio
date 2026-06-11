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
