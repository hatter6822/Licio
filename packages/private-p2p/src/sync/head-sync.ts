// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.4 — head announcement + missing-block protocol + sync priority
// (PRIVATE_SPEC §15.6, §15.7, §15.8).  The PURE decision plane that runs over
// the pairwise channel (the encrypted carriage is WS-S.6.2; the live transport
// is the browser follow-up):
//
//   • §15.6 head announcement — a peer announces its accepted-DAG heads, latest
//     verified snapshot, and a COARSE op-count bucket (never an exact count).
//   • §15.7 missing-block reconciliation — frontier-first: a peer requests the
//     announced heads it lacks, then their still-missing ancestors, until the
//     causal closure is held.  Every fetched block is verified by CID +
//     signature + AEAD (the existing `openOp` wire-intake) BEFORE use — this
//     module decides WHAT to fetch, never confers trust on a fetched block.
//   • §15.8 fetch order — manifest → membership → heads/ancestors → thread/story
//     index → visible text → summaries → media manifests → media chunks →
//     snapshots, so a usable thread list arrives before media (media is lazy).

import { z } from 'zod';
import { privateCidSchema, privateIdSchema } from '../schemas/common.js';

// --- §15.6 head announcement ------------------------------------------------

/** An op as the head computation sees it (id + causal parents). */
export interface OpHeadView {
  readonly op_id: string;
  readonly parents: readonly string[];
}

/** §5.4 — the coarse op-count granularity (the announcement reveals only the
 *  bucket index `floor(count / granularity)`, never the exact op count). */
export const OP_COUNT_BUCKET_GRANULARITY = 64;

/** The coarse op-count bucket for `count` (never the exact count, §5.4). */
export function opCountBucket(count: number): number {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`opCountBucket: invalid count ${count}`);
  }
  return Math.floor(count / OP_COUNT_BUCKET_GRANULARITY);
}

/**
 * The accepted-DAG heads: op ids that are NOT a parent of any other accepted op
 * (the causal frontier).  Pure + deterministic (sorted); a peer announces these
 * so the counterpart can reconcile toward them.
 */
export function computeHeads(acceptedOps: readonly OpHeadView[]): string[] {
  const referencedAsParent = new Set<string>();
  for (const op of acceptedOps) {
    for (const parent of op.parents) referencedAsParent.add(parent);
  }
  const heads: string[] = [];
  for (const op of acceptedOps) {
    if (!referencedAsParent.has(op.op_id)) heads.push(op.op_id);
  }
  return heads.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** §15.6 — the encrypted head announcement carried on the pairwise channel. */
export const headAnnouncementSchema = z
  .object({
    schema: z.literal('licio.private.head_announcement.v1'),
    heads: z.array(privateIdSchema).max(4_096),
    latest_snapshot_id: privateIdSchema.optional(),
    op_count_bucket: z.number().int().nonnegative(),
  })
  .strict();
export type HeadAnnouncement = z.infer<typeof headAnnouncementSchema>;

export interface BuildHeadAnnouncementParams {
  readonly acceptedOps: readonly OpHeadView[];
  readonly latestSnapshotId?: string;
}

/** Build a peer's §15.6 head announcement from its accepted ops. */
export function buildHeadAnnouncement(params: BuildHeadAnnouncementParams): HeadAnnouncement {
  return headAnnouncementSchema.parse({
    schema: 'licio.private.head_announcement.v1',
    heads: computeHeads(params.acceptedOps),
    op_count_bucket: opCountBucket(params.acceptedOps.length),
    // `undefined` is dropped by zod's optional, so an absent snapshot stays absent.
    latest_snapshot_id: params.latestSnapshotId,
  });
}

// --- §15.7 frontier-first reconciliation ------------------------------------

/**
 * The op ids a peer WANTS from a counterpart's announcement: the announced heads
 * it does not already hold.  The first reconciliation step; fetched heads then
 * feed `missingParents` to walk back the causal DAG.  Deterministic (sorted,
 * deduped).
 */
export function wantedHeads(
  knownOpIds: ReadonlySet<string>,
  announcement: HeadAnnouncement,
): string[] {
  const wanted = new Set<string>();
  for (const head of announcement.heads) {
    if (!knownOpIds.has(head)) wanted.add(head);
  }
  return [...wanted].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The still-missing parents after receiving a batch of ops: parent ids the
 * batch references that are neither already known nor present in the batch
 * itself.  Iterating `fetch(wanted) → missingParents → fetch` reaches the causal
 * closure frontier-first.  Deterministic (sorted, deduped).
 */
export function missingParents(
  knownOpIds: ReadonlySet<string>,
  batch: readonly OpHeadView[],
): string[] {
  const inBatch = new Set(batch.map((op) => op.op_id));
  const missing = new Set<string>();
  for (const op of batch) {
    for (const parent of op.parents) {
      if (!knownOpIds.has(parent) && !inBatch.has(parent)) missing.add(parent);
    }
  }
  return [...missing].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// --- §15.8 fetch order + §15.7 block request/response -----------------------

/** §15.8 — the client-side fetch order (a usable thread list before media). */
export const FETCH_ORDER = [
  'manifest',
  'membership',
  'heads',
  'thread_index',
  'visible_text',
  'summaries',
  'media_manifest',
  'media_chunk',
  'snapshot',
] as const;
export type FetchCategory = (typeof FETCH_ORDER)[number];

/** The §15.8 rank of a fetch category (lower = fetched earlier). */
export function fetchOrderRank(category: FetchCategory): number {
  return FETCH_ORDER.indexOf(category);
}

/** Stable-sort items by their §15.8 fetch-order rank (earlier categories first). */
export function orderByFetchPriority<T extends { readonly category: FetchCategory }>(
  items: readonly T[],
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const byRank = fetchOrderRank(a.item.category) - fetchOrderRank(b.item.category);
      return byRank !== 0 ? byRank : a.index - b.index; // stable within a category
    })
    .map((e) => e.item);
}

/** §15.7 — the coarse wire priority on a block request. */
export const BLOCK_REQUEST_PRIORITIES = ['manifest', 'ops', 'thread', 'media', 'snapshot'] as const;
export type BlockRequestPriority = (typeof BLOCK_REQUEST_PRIORITIES)[number];

/** Map a fine §15.8 fetch category to its coarse §15.7 wire priority. */
export function blockPriorityForCategory(category: FetchCategory): BlockRequestPriority {
  switch (category) {
    case 'manifest':
      return 'manifest';
    case 'membership':
    case 'heads':
      return 'ops';
    case 'thread_index':
    case 'visible_text':
    case 'summaries':
      return 'thread';
    case 'media_manifest':
    case 'media_chunk':
      return 'media';
    case 'snapshot':
      return 'snapshot';
  }
}

/** §15.7 — the largest block request a peer will serve (a DoS/backpressure cap). */
export const MAX_CIDS_PER_BLOCK_REQUEST = 1_024;

export const blockRequestSchema = z
  .object({
    schema: z.literal('licio.private.block_request.v1'),
    cids: z.array(privateCidSchema).min(1).max(MAX_CIDS_PER_BLOCK_REQUEST),
    priority: z.enum(BLOCK_REQUEST_PRIORITIES),
    max_bytes: z.number().int().positive(),
  })
  .strict();
export type BlockRequest = z.infer<typeof blockRequestSchema>;

/** A peer's response: served CIDs (verified-before-use by the importer) +
 *  refused CIDs (too large / throttled), so the requester can back off. */
export const blockResponseSchema = z
  .object({
    schema: z.literal('licio.private.block_response.v1'),
    served_cids: z.array(privateCidSchema).max(MAX_CIDS_PER_BLOCK_REQUEST),
    refused_cids: z.array(privateCidSchema).max(MAX_CIDS_PER_BLOCK_REQUEST),
    retry_after_ms: z.number().int().nonnegative().optional(),
  })
  .strict();
export type BlockResponse = z.infer<typeof blockResponseSchema>;

/** The serving peer's resource limits (§15.7 refuse-large/backoff). */
export interface BlockServeLimits {
  readonly maxBytesPerRequest: number;
  readonly maxCidsPerRequest: number;
}

export type BlockServeDecision =
  | { readonly serve: true }
  | { readonly serve: false; readonly reason: 'too_many_cids' | 'max_bytes_exceeds_capacity' };

/**
 * §15.7 — whether to serve a block request or refuse it (the peer may refuse or
 * throttle large requests).  Refuses when the request asks for more CIDs than
 * the cap, or its `max_bytes` exceeds the serving peer's per-request capacity.
 */
export function decideBlockServe(
  request: BlockRequest,
  limits: BlockServeLimits,
): BlockServeDecision {
  if (request.cids.length > limits.maxCidsPerRequest) {
    return { serve: false, reason: 'too_many_cids' };
  }
  if (request.max_bytes > limits.maxBytesPerRequest) {
    return { serve: false, reason: 'max_bytes_exceeds_capacity' };
  }
  return { serve: true };
}

/**
 * Exponential backoff (with a cap) for a refused/throttled request: `base *
 * 2^attempt`, clamped to `maxMs`.  `attempt` is 0-based.
 */
export function backoffDelayMs(attempt: number, baseMs = 1_000, maxMs = 60_000): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError(`backoffDelayMs: invalid attempt ${attempt}`);
  }
  // Cap the exponent so 2 ** attempt cannot overflow before the min clamp.
  const exponent = Math.min(attempt, 31);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
