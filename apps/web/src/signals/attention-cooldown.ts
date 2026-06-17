// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared attention-upload backoff gate (WS-C.4.4, SPEC §25.5). The attention
// ingestion endpoint enforces a per-account sliding-window rate limit and answers
// a 429 with a `Retry-After`. Attention aggregates are idempotent, durable HINTS
// (every aggregate_id is a single-use nonce the server dedupes forever), so the
// correct client response to backpressure is to STOP uploading until the window
// clears — never to keep POSTing, which is precisely the hammering the limit
// exists to stop.
//
// Both attention upload paths consult this ONE gate so backoff is honoured
// uniformly: the processor's batched interval flush (`AggregateUploader.flush`)
// and the offline-sync replay (`processPendingQueue`). The single network egress
// (`uploadAttentionAggregates`) also enforces it, so any caller backs off by
// construction. This is a module singleton because the rate limit is per-account
// across the whole tab, not per upload site.

let suppressedUntilMs = 0;

/**
 * True while the endpoint has asked us to back off (the current time is before
 * the last 429's `Retry-After` deadline). Callers must NOT upload attention
 * while this holds; the buffered/queued aggregates wait for the window to clear.
 */
export function attentionUploadsCoolingDown(now: number = Date.now()): boolean {
  return now < suppressedUntilMs;
}

/**
 * Record a 429: suppress attention uploads for `retryAfterSec` seconds from
 * `now` (a 1 s floor guards a missing/garbage header). Monotonic — a longer
 * outstanding cooldown is never shortened by a shorter, later one.
 */
export function noteAttentionRateLimited(retryAfterSec: number, now: number = Date.now()): void {
  const seconds = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 1;
  suppressedUntilMs = Math.max(suppressedUntilMs, now + seconds * 1_000);
}

/** Clear the cooldown after a successful (or otherwise non-rate-limited) upload. */
export function noteAttentionUploadOk(): void {
  suppressedUntilMs = 0;
}

/** Reset the gate (tests). */
export function resetAttentionCooldown(): void {
  suppressedUntilMs = 0;
}
