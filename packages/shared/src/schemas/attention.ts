// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AttentionAggregate (SPEC §22.1) — the SINGLE network egress shape for
// attention data (WS-C.4.4). The client extracts raw scroll/visibility/focus
// events in-browser, discards them, and uploads only this bucketed aggregate
// (SPEC §19.2 "process in browser; discard after extraction"). Buckets — not
// raw traces — are what cross the wire, so a single item can never reveal raw
// browsing behaviour (re-identification resistance, WS-C.4.1d).
//
// The bucketing functions below are the mathematical core. Each is:
//   • total       — defined for every finite or non-finite numeric input,
//   • monotone    — a larger input never maps to an earlier bucket, and
//   • deterministic — no clock or randomness inside the pure mapping.
// These properties are asserted exhaustively in __tests__/attention.test.ts.
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';

// ---------------------------------------------------------------------------
// Privacy level (WS-C.4.1d) — collection coarsens monotonically toward
// `minimum`, at which the user identifier is replaced by a coarse privacy
// bucket rather than the user id (SPEC §19.2, no re-identification).
// ---------------------------------------------------------------------------
export const PRIVACY_LEVELS = ['standard', 'reduced', 'minimum'] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];
export const privacyLevelSchema = z.enum(PRIVACY_LEVELS);

// ---------------------------------------------------------------------------
// Active-dwell bucket (SIG-ATT-DWELL). Upper-exclusive boundaries in
// milliseconds. The final `extended` bucket is unbounded above, but the
// per-item cap (WS-C.4.1c) means real inputs never exceed the cap.
// ---------------------------------------------------------------------------
export const DWELL_BUCKETS = ['none', 'glance', 'short', 'medium', 'long', 'extended'] as const;
export type DwellBucket = (typeof DWELL_BUCKETS)[number];
export const dwellBucketSchema = z.enum(DWELL_BUCKETS);

/** Upper-exclusive millisecond boundaries between adjacent dwell buckets. */
export const DWELL_BUCKET_BOUNDARIES_MS = [10_000, 30_000, 120_000, 300_000] as const;

/**
 * Map active-dwell milliseconds to a coarse bucket. NaN and non-positive inputs
 * collapse to `none`; `Infinity` lands in `extended`. Monotone non-decreasing.
 */
export function activeDwellBucket(ms: number): DwellBucket {
  if (Number.isNaN(ms) || ms <= 0) return 'none';
  if (ms < 10_000) return 'glance';
  if (ms < 30_000) return 'short';
  if (ms < 120_000) return 'medium';
  if (ms < 300_000) return 'long';
  return 'extended';
}

// ---------------------------------------------------------------------------
// Branch-depth bucket (SIG-ATT-TRAVERSE). Input is the number of DISTINCT
// branches a reader visited within a thread (0..6 — there are six branches).
// Nonredundant traversal is what counts; revisiting the same branch does not
// raise the input (enforced upstream in WS-C.4.3).
// ---------------------------------------------------------------------------
export const BRANCH_DEPTH_BUCKETS = ['none', 'shallow', 'moderate', 'deep'] as const;
export type BranchDepthBucket = (typeof BRANCH_DEPTH_BUCKETS)[number];
export const branchDepthBucketSchema = z.enum(BRANCH_DEPTH_BUCKETS);

/** Map a count of distinct branches visited to a coarse depth bucket. */
export function branchDepthBucket(distinctBranches: number): BranchDepthBucket {
  const n = toCount(distinctBranches);
  if (n <= 0) return 'none';
  if (n === 1) return 'shallow';
  if (n <= 3) return 'moderate';
  return 'deep';
}

// ---------------------------------------------------------------------------
// Return-visit bucket (SIG-ATT-RETURN). Input is the number of genuine return
// visits after the time-away threshold. Rage-loop returns are excluded BEFORE
// this count is formed (WS-C.4.3 / SIG-ANTI-RAGELOOP), so a hostile loop never
// inflates the bucket — there is deliberately no rage-loop field in §22.1.
// ---------------------------------------------------------------------------
export const RETURN_VISIT_BUCKETS = ['none', 'few', 'several', 'many'] as const;
export type ReturnVisitBucket = (typeof RETURN_VISIT_BUCKETS)[number];
export const returnVisitBucketSchema = z.enum(RETURN_VISIT_BUCKETS);

/** Map a count of genuine return visits to a coarse bucket. */
export function returnVisitCountBucket(count: number): ReturnVisitBucket {
  const n = toCount(count);
  if (n <= 0) return 'none';
  if (n <= 2) return 'few';
  if (n <= 5) return 'several';
  return 'many';
}

// ---------------------------------------------------------------------------
// Session bucket. A coarse, non-identifying time window (SPEC §22.1
// `session_bucket`). The client and server agree on the window so caps
// (WS-C.4.1c) and server-side session accounting line up. Default 1 hour.
// ---------------------------------------------------------------------------
export const SESSION_BUCKET_WINDOW_MS = 3_600_000;

/**
 * Floor an epoch-millisecond instant to its session window and label it with
 * the window-start ISO timestamp. Deterministic and coarsening: every instant
 * inside the same window yields the same label, so the bucket reveals only the
 * window, never the exact time.
 */
export function sessionBucket(
  epochMs: number,
  windowMs: number = SESSION_BUCKET_WINDOW_MS,
): string {
  const safeWindow = windowMs > 0 ? windowMs : SESSION_BUCKET_WINDOW_MS;
  const instant = Number.isFinite(epochMs) ? epochMs : 0;
  const floored = Math.floor(instant / safeWindow) * safeWindow;
  // Clamp to the valid ECMAScript Date range (±8.64e15 ms); beyond it
  // `toISOString` throws, which would break the function's totality guarantee.
  const MAX_TIME_MS = 8.64e15;
  const clamped = Math.min(MAX_TIME_MS, Math.max(-MAX_TIME_MS, floored));
  return new Date(clamped).toISOString();
}

/**
 * Coerce arbitrary numeric input to a safe non-negative integer count. NaN,
 * negatives, and -Infinity collapse to 0; +Infinity maps to the maximum count so
 * it lands in the TOP bucket (monotone with `activeDwellBucket`, not an earlier
 * bucket).
 */
function toCount(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// The aggregate itself — exactly the eleven §22.1 fields, no more. Validated by
// zod before upload (WS-C.4.4 acceptance criteria) and again server-side.
// ---------------------------------------------------------------------------
export const attentionAggregateSchema = z.object({
  /** Client-generated unique id for idempotent ingestion / dedup. */
  aggregate_id: uuidSchema,
  /** User id (standard/reduced) or a coarse privacy bucket (minimum). */
  user_id_or_privacy_bucket: z.string().min(1).max(128),
  /** The item under attention. */
  story_id: uuidSchema,
  /** Coarse session-window label (see {@link sessionBucket}). */
  session_bucket: z.string().min(1),
  /** Capped, bucketed active dwell (SIG-ATT-DWELL + WS-C.4.1c cap). */
  active_dwell_bucket: dwellBucketSchema,
  /** Whether the original source was opened in a meaningful session (deduped). */
  source_opened: z.boolean(),
  /** Whether a context card was opened in a meaningful session (deduped). */
  context_opened: z.boolean(),
  /** Bucketed count of distinct branches traversed. */
  branch_depth_bucket: branchDepthBucketSchema,
  /** Bucketed count of genuine return visits (rage-loops excluded). */
  return_visit_count_bucket: returnVisitBucketSchema,
  /** Privacy level governing identifier granularity and collection. */
  privacy_level: privacyLevelSchema,
  /** Upload time (ISO-8601). */
  created_at: isoTimestampSchema,
});

export type AttentionAggregate = z.infer<typeof attentionAggregateSchema>;

/** A batch of aggregates uploaded together to `attention.aggregate` (§21.3).
 *  Non-empty: an empty upload would spend a rate-limit token for nothing (the
 *  client uploader and sync queue never send empty batches). */
export const attentionAggregateBatchSchema = z.object({
  aggregates: z.array(attentionAggregateSchema).min(1).max(200),
});
export type AttentionAggregateBatch = z.infer<typeof attentionAggregateBatchSchema>;

/** Server acknowledgement of an ingested batch (count accepted as hints, §6.11). */
export const attentionIngestAckSchema = z.object({ accepted: z.number().int().nonnegative() });
export type AttentionIngestAck = z.infer<typeof attentionIngestAckSchema>;
