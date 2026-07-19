// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Attention-aggregate builder + uploader (WS-C.4.4, SPEC §22.1/§19.2). The single
// network egress point for attention data. It emits ONLY the bucketed §22.1
// aggregate — never raw traces (asserted by assertNoRawEgress on every add).
// Uploads are batched at intervals (not per-event). A failed upload, or a flush
// while the page is being hidden, durably enqueues the batch to the IndexedDB
// pending queue (WS-C.2.2a), so the final batch is never lost and flushes on the
// next open via the sync processor.
import {
  type AttentionAggregate,
  activeDwellBucket,
  attentionAggregateSchema,
  type PrivacyLevel,
  replyDepthBucket,
  returnVisitCountBucket,
} from '@licio/shared';
import { uploadAttentionAggregates } from '../lib/api.js';
import * as queue from '../offline/queue.js';
import { attentionUploadsCoolingDown } from './attention-cooldown.js';
import { assertNoRawEgress } from './privacy.js';

let fallbackCounter = 0;

/**
 * A fresh RFC 4122 v4 UUID for every aggregate. The server dedupes on
 * `aggregate_id` forever (WS-C.4.4), so a COLLIDING id silently drops every
 * aggregate after the first — a constant fallback would do exactly that. Prefer
 * `crypto.randomUUID` (secure context), then a v4 built from
 * `crypto.getRandomValues` (available even in non-secure contexts), and only as
 * a last resort — no Web Crypto at all, which never happens in a browser secure
 * context — a per-call-unique (never constant) id derived from a clock+counter.
 */
function newId(): string {
  // `Partial<Crypto>` (not `Crypto`) so the optional-method guards below actually
  // narrow at runtime: `Crypto` always declares `randomUUID`, which would make TS
  // treat the getRandomValues fall-through as unreachable (`never`).
  const c: Partial<Crypto> | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40; // version 4
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variant 10
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  fallbackCounter += 1;
  const unique = (Date.now() * 1000 + (fallbackCounter % 1000))
    .toString(16)
    .padStart(12, '0')
    .slice(-12);
  return `ffffffff-ffff-4fff-8fff-${unique}`;
}

export interface AggregateInput {
  storyId: string;
  /** Resolved identifier (user id or coarse privacy bucket). */
  identifier: string;
  privacyLevel: PrivacyLevel;
  /** Coarse session-window label from `sessionBucket(now)`. */
  sessionBucketLabel: string;
  /** Capped active dwell in ms (WS-C.4.1c). */
  cappedDwellMs: number;
  sourceOpened: boolean;
  contextOpened: boolean;
  /** Distinct reply-depth levels viewed (WS-T.8.4). */
  distinctReplyDepthLevels: number;
  /** Genuine return count (already rage-loop-zeroed, WS-C.4.3). */
  returnCount: number;
  /** Upload timestamp (epoch ms). */
  now: number;
}

/** Build a validated §22.1 aggregate from per-item signal state (buckets only). */
export function buildAggregate(input: AggregateInput): AttentionAggregate {
  return attentionAggregateSchema.parse({
    aggregate_id: newId(),
    user_id_or_privacy_bucket: input.identifier,
    story_id: input.storyId,
    session_bucket: input.sessionBucketLabel,
    active_dwell_bucket: activeDwellBucket(input.cappedDwellMs),
    source_opened: input.sourceOpened,
    context_opened: input.contextOpened,
    reply_depth_bucket: replyDepthBucket(input.distinctReplyDepthLevels),
    return_visit_count_bucket: returnVisitCountBucket(input.returnCount),
    privacy_level: input.privacyLevel,
    created_at: new Date(input.now).toISOString(),
  });
}

export interface UploaderOptions {
  /** Override the network upload (tests). */
  upload?: (aggregates: AttentionAggregate[]) => Promise<unknown>;
  /** Override the durable enqueue (tests). */
  enqueue?: (aggregates: AttentionAggregate[]) => Promise<unknown>;
  /** Wall clock for the rate-limit backoff window (epoch ms; tests). */
  now?: () => number;
}

async function defaultEnqueue(aggregates: AttentionAggregate[]): Promise<void> {
  await queue.enqueue('attention-aggregate', { aggregates });
}

export class AggregateUploader {
  private readonly pending: AttentionAggregate[] = [];
  private readonly upload: (aggregates: AttentionAggregate[]) => Promise<unknown>;
  private readonly enqueue: (aggregates: AttentionAggregate[]) => Promise<unknown>;
  private readonly now: () => number;

  constructor(options: UploaderOptions = {}) {
    this.upload = options.upload ?? uploadAttentionAggregates;
    this.enqueue = options.enqueue ?? defaultEnqueue;
    this.now = options.now ?? (() => Date.now());
  }

  /** Buffer an aggregate for the next batch. Rejects any raw-trace payload. */
  add(aggregate: AttentionAggregate): void {
    assertNoRawEgress(aggregate);
    this.pending.push(aggregate);
  }

  get size(): number {
    return this.pending.length;
  }

  /**
   * Send the buffered batch. On failure the batch is durably enqueued for retry
   * rather than dropped. A no-op (sends nothing) when the buffer is empty — never
   * an empty-but-identifying upload.
   */
  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    // Honour the endpoint's backoff (WS-C.4.4): while the rate limit's
    // Retry-After window is open, keep the batch in the in-memory buffer (it
    // coalesces with later captures) instead of POSTing into a 429 or churning
    // it through the durable queue. The page-hide path still flushes it durably.
    if (attentionUploadsCoolingDown(this.now())) return;
    const batch = this.pending.splice(0, this.pending.length);
    try {
      await this.upload(batch);
    } catch {
      await this.enqueue(batch);
    }
  }

  /**
   * Durable flush for page-hide/unload: enqueue the batch to IndexedDB without
   * waiting on the network, so the final batch survives the page closing and is
   * sent on the next app open by the sync processor.
   */
  async flushDurable(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    await this.enqueue(batch);
  }

  /**
   * Discard the buffered batch WITHOUT uploading or enqueuing it. Used by the
   * privacy opt-out (WS-C.4.1d): a captured-but-unflushed aggregate is on-device
   * signal state, so turning collection off must drop it rather than let the
   * interval/page-hide path upload it after the user opted out.
   */
  clear(): void {
    this.pending.length = 0;
  }
}
