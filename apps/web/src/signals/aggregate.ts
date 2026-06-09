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
  branchDepthBucket,
  type PrivacyLevel,
  returnVisitCountBucket,
} from '@licio/shared';
import { uploadAttentionAggregates } from '../lib/api.js';
import * as queue from '../offline/queue.js';
import { assertNoRawEgress } from './privacy.js';

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Deterministic-enough fallback for environments without crypto.randomUUID.
  return '00000000-0000-4000-8000-000000000000';
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
  /** Distinct branches visited (WS-C.4.3). */
  distinctBranches: number;
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
    branch_depth_bucket: branchDepthBucket(input.distinctBranches),
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
}

async function defaultEnqueue(aggregates: AttentionAggregate[]): Promise<void> {
  await queue.enqueue('attention-aggregate', { aggregates });
}

export class AggregateUploader {
  private readonly pending: AttentionAggregate[] = [];
  private readonly upload: (aggregates: AttentionAggregate[]) => Promise<unknown>;
  private readonly enqueue: (aggregates: AttentionAggregate[]) => Promise<unknown>;

  constructor(options: UploaderOptions = {}) {
    this.upload = options.upload ?? uploadAttentionAggregates;
    this.enqueue = options.enqueue ?? defaultEnqueue;
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
}
