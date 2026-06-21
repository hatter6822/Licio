// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Durable outbox pin classification + retry scheduling (OFFLINE_SPEC §20.5,
// §21.2, WS-R.10.3, pure core).  Local drafts, signed outbox records, their
// required proofs/body blocks, export history, and server receipts are HARD
// pins — never evicted by normal LCAP GC (only explicit account/app-data
// deletion removes them).  Each unsent outbox entry carries an exponential
// retry schedule.  The IndexedDB binding (WS-R.11) persists this; here is the
// classification + scheduling logic.

/** Categories of locally-held data and whether they are hard-pinned (§20.5). */
export type PinClass =
  | 'draft'
  | 'outbox_record'
  | 'required_proof'
  | 'body_block'
  | 'export_history'
  | 'receipt'
  | 'ambient_cache';

const HARD_PINNED: ReadonlySet<PinClass> = new Set<PinClass>([
  'draft',
  'outbox_record',
  'required_proof',
  'body_block',
  'export_history',
  'receipt',
]);

/** Hard-pinned data survives normal eviction; only `ambient_cache` is GC-able. */
export function isHardPinned(pinClass: PinClass): boolean {
  return HARD_PINNED.has(pinClass);
}

/** Filter a set of (cid, class) entries to those that survive an eviction sweep. */
export function survivesEviction<T extends { readonly pinClass: PinClass }>(
  entries: readonly T[],
): T[] {
  return entries.filter((entry) => isHardPinned(entry.pinClass));
}

export interface OutboxEntry {
  readonly cid: string;
  readonly attempts: number;
  readonly lastAttemptMs?: number;
  readonly nextRetryMs?: number;
}

export interface RetryPolicy {
  /** Base backoff in ms (the first retry delay). */
  readonly baseMs: number;
  /** Maximum backoff in ms (the cap). */
  readonly maxMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseMs: 30_000,
  maxMs: 6 * 60 * 60 * 1000,
};

/**
 * Schedule the next retry for an outbox entry after an attempt at `nowMs`:
 * exponential backoff `base × 2^attempts`, capped at `maxMs`.
 */
export function scheduleRetry(
  entry: OutboxEntry,
  nowMs: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): OutboxEntry {
  const attempts = entry.attempts + 1;
  const backoff = Math.min(policy.maxMs, policy.baseMs * 2 ** entry.attempts);
  return { cid: entry.cid, attempts, lastAttemptMs: nowMs, nextRetryMs: nowMs + backoff };
}

/** Entries whose next retry is due at or before `nowMs` (C0/P1 first is the caller's job). */
export function dueForRetry(entries: readonly OutboxEntry[], nowMs: number): OutboxEntry[] {
  return entries.filter((entry) => entry.nextRetryMs === undefined || entry.nextRetryMs <= nowMs);
}
