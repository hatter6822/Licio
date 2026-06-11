// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F runtime-tunable ingestion config (the WS-E pwatt/config.ts pattern):
// defaults live here; stewards may override individual keys through the
// validated admin surface (write-time 422 rejection), and the loader is
// FAIL-CLOSED — an invalid stored value is logged and the default kept, never
// half-applied. Keys are namespaced `ingestion.*` in the shared config store.
//
// NOT runtime-tunable by design: the MinHash family/banding parameters
// (persisted signatures would silently stop matching — changing them is a
// versioned re-signature migration) and the embedding dimension (a table
// migration).
import { z } from 'zod';
import type { PwattConfigStore } from '../events/stores.js';

export interface IngestionRuntimeConfig {
  /** Per-account submission limits (WS-F.1.4c; sliding windows, no IP). */
  submissionPerHour: number;
  submissionPerDay: number;
  /** Minimum account age before submissions are accepted (WS-F.1.4c). */
  minAccountAgeMinutes: number;
  /** Identical normalized titles within the window ⇒ spam pattern. */
  duplicateTitleLimit: number;
  duplicateTitleWindowMinutes: number;
  /** Locally-maintained malware/phishing domain denylist (WS-F.1.4c §19.1:
   *  no external scanning API — URLs never leave the platform). */
  malwareDomains: string[];
  /** Additional tracker query params beyond the shared default denylist. */
  extraTrackerParams: string[];
  /** Near-duplicate decision threshold on the estimated Jaccard (WS-F.1.3c). */
  nearDuplicateThreshold: number;
  /** Default copyright excerpt bound (chars); publishers may tighten it. */
  excerptMaxChars: number;
  /** robots.txt cache TTL (WS-F.1.4f). */
  robotsCacheTtlMinutes: number;
  /** Crawler identity for robots matching + the fetch User-Agent. */
  crawlerUserAgent: string;
  /** SSRF-hardened fetch bounds (WS-F.1.4e). */
  fetchTimeoutMs: number;
  fetchMaxBytes: number;
  fetchMaxRedirects: number;
  /** Lifecycle low-activity archival window (WS-F.1.1c sweep). */
  lifecycleIdleDays: number;
  /** Sustained-participation threshold (contributions within 24h). */
  lifecycleSustainedContributions: number;
  /** Claim-extraction confidence floor; below ⇒ review queue (WS-F.1.2b). */
  claimConfidenceFloor: number;
  /**
   * Cosine threshold above which a candidate claim links to an existing one
   * by EMBEDDING similarity instead of being created (WS-F.1.2b dedup beyond
   * exact-text). High by design: with the lexical provider it catches
   * reorderings/rephrasings the text hash misses; true semantic-paraphrase
   * dedup needs the self-hosted model (WS-F.3.2a).
   */
  claimDedupSimilarity: number;
  /** The ACTIVE embedding model version similarity consumers use (WS-F.3.2f
   *  cutover switch). */
  embeddingActiveVersion: string;
  /** Backfill batch size per scheduler tick (rate limit, WS-F.3.2f). */
  embeddingBackfillBatch: number;
  /** Superseded-version cleanup retention window (days, WS-F.3.2f). */
  embeddingCleanupRetentionDays: number;
}

export const DEFAULT_INGESTION_CONFIG: IngestionRuntimeConfig = {
  submissionPerHour: 10,
  submissionPerDay: 50,
  minAccountAgeMinutes: 60,
  duplicateTitleLimit: 3,
  duplicateTitleWindowMinutes: 60,
  malwareDomains: [],
  extraTrackerParams: [],
  nearDuplicateThreshold: 0.7,
  excerptMaxChars: 500,
  robotsCacheTtlMinutes: 360,
  crawlerUserAgent: 'LicioBot/1.0 (+https://licio.app/bot)',
  fetchTimeoutMs: 10_000,
  fetchMaxBytes: 2 * 1024 * 1024,
  fetchMaxRedirects: 5,
  lifecycleIdleDays: 14,
  lifecycleSustainedContributions: 3,
  claimConfidenceFloor: 0.5,
  claimDedupSimilarity: 0.92,
  embeddingActiveVersion: 'lexical-fnv-v1',
  embeddingBackfillBatch: 200,
  embeddingCleanupRetentionDays: 30,
};

const positiveInt = z.number().int().min(1);

/** Per-key validators (write-time 422 + load-time fail-closed). */
const KEY_SCHEMAS: Record<keyof IngestionRuntimeConfig, z.ZodType<unknown>> = {
  submissionPerHour: positiveInt.max(1_000),
  submissionPerDay: positiveInt.max(10_000),
  minAccountAgeMinutes: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60),
  duplicateTitleLimit: positiveInt.max(100),
  duplicateTitleWindowMinutes: positiveInt.max(24 * 60),
  malwareDomains: z.array(z.string().min(1).max(253)).max(50_000),
  extraTrackerParams: z.array(z.string().min(1).max(64)).max(1_000),
  nearDuplicateThreshold: z.number().min(0.3).max(1),
  excerptMaxChars: z.number().int().min(50).max(2_000),
  robotsCacheTtlMinutes: positiveInt.max(7 * 24 * 60),
  crawlerUserAgent: z.string().min(3).max(200),
  fetchTimeoutMs: z.number().int().min(1_000).max(60_000),
  fetchMaxBytes: z
    .number()
    .int()
    .min(64 * 1024)
    .max(16 * 1024 * 1024),
  fetchMaxRedirects: z.number().int().min(0).max(10),
  lifecycleIdleDays: positiveInt.max(365),
  lifecycleSustainedContributions: positiveInt.max(1_000),
  claimConfidenceFloor: z.number().min(0).max(1),
  claimDedupSimilarity: z.number().min(0.5).max(1),
  embeddingActiveVersion: z.string().min(1).max(128),
  embeddingBackfillBatch: positiveInt.max(10_000),
  embeddingCleanupRetentionDays: positiveInt.max(365),
};

export const INGESTION_CONFIG_KEYS = Object.keys(KEY_SCHEMAS) as ReadonlyArray<
  keyof IngestionRuntimeConfig
>;

const CONFIG_PREFIX = 'ingestion.';

/** Validate one steward write; returns an error message (→ 422) or null. */
export function validateIngestionConfigValue(key: string, value: unknown): string | null {
  if (!Object.hasOwn(KEY_SCHEMAS, key)) {
    return `unknown ingestion config key "${key}"`;
  }
  const parsed = KEY_SCHEMAS[key as keyof IngestionRuntimeConfig].safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? `invalid value for "${key}"`;
  }
  return null;
}

/**
 * Load the effective config: defaults overlaid with stored valid overrides.
 * Values are stored as `{ value }` envelopes (the shared config store's
 * record-shaped interface). Fail-closed: any invalid stored value is reported
 * via `onInvalid` and the default for that key is kept.
 */
export async function loadIngestionConfig(
  configStore: PwattConfigStore,
  onInvalid: (key: string, problem: string) => void = () => {},
): Promise<IngestionRuntimeConfig> {
  const config: IngestionRuntimeConfig = { ...DEFAULT_INGESTION_CONFIG };
  for (const key of INGESTION_CONFIG_KEYS) {
    const stored = await configStore.get(`${CONFIG_PREFIX}${key}`);
    if (stored === null || !Object.hasOwn(stored, 'value')) continue;
    const value = stored['value'];
    const problem = validateIngestionConfigValue(key, value);
    if (problem !== null) {
      onInvalid(key, problem);
      continue;
    }
    (config as unknown as Record<string, unknown>)[key] = value;
  }
  return config;
}

/** Persist one validated override (the steward admin surface writes here). */
export async function storeIngestionConfigValue(
  configStore: PwattConfigStore,
  key: keyof IngestionRuntimeConfig,
  value: unknown,
): Promise<void> {
  await configStore.set(`${CONFIG_PREFIX}${key}`, { value } as Record<string, unknown>);
}
