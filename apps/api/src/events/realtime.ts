// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real-time aggregation acceleration layer (WS-E.3.2, SPEC §5.4/§21.3).
// Short-lived, per-item rolling counters for the 1-hour PWAtt window:
//   • unique actors via HyperLogLog (bounded memory, documented ~0.81% error);
//   • per-signal-kind counters (attention items, source opens, bounces,
//     context opens, contributions);
//   • TTL aligned to the real-time window — counters NEVER persist attention
//     beyond it, so a real-time cache cannot outlive the user's chosen
//     retention (`none` events feed counters here and leave no durable trace);
//   • fully rebuildable from the event store (no unique state) — Redis (the
//     production adapter) is an acceleration layer, never a shadow attention
//     database. The durable PostgreSQL aggregation (WS-E.2.1a) is the source
//     of truth; reconciliation compares the two within the HLL error bound.
import type {
  AttentionAggregateEvent,
  ContentSavedAggregateEvent,
  SourceOpenedAggregateEvent,
} from '@licio/shared';
import { HyperLogLog } from './hll.js';
import type { StoredEvent } from './stores.js';

/** The 1-hour real-time window (aligned with the shared session bucket). */
export const REALTIME_WINDOW_MS = 3_600_000;
/** Counter lifetime: the live window plus one window of slack. */
export const REALTIME_TTL_MS = 2 * REALTIME_WINDOW_MS;

export interface RealtimeItemCounts {
  uniqueActors: number;
  attentionItems: number;
  sourceOpens: number;
  sourceBounces: number;
  contextOpens: number;
  contributions: number;
  /** Total events folded for the item (the trigger-threshold metric). */
  eventCount: number;
}

export interface RealtimeAggregator {
  recordAttention(event: AttentionAggregateEvent, actorKey: string): Promise<void>;
  recordSourceOpen(event: SourceOpenedAggregateEvent, actorKey: string): Promise<void>;
  recordContribution(itemId: string, actorKey: string, timestampIso: string): Promise<void>;
  recordSave(event: ContentSavedAggregateEvent, actorKey: string): Promise<void>;
  snapshot(itemId: string, windowStartMs: number): Promise<RealtimeItemCounts | null>;
  /** Items with any activity in the window (reconciliation enumeration). */
  itemsInWindow(windowStartMs: number): Promise<string[]>;
  clear(): Promise<void>;
}

/** Floor an instant to its real-time window start. */
export function realtimeWindowStart(epochMs: number): number {
  return Math.floor(epochMs / REALTIME_WINDOW_MS) * REALTIME_WINDOW_MS;
}

interface ItemCounters {
  hll: HyperLogLog;
  attentionItems: number;
  sourceOpens: number;
  sourceBounces: number;
  contextOpens: number;
  contributions: number;
  eventCount: number;
}

/** Single-process adapter (tests / dev); production uses Redis (PFADD/HINCRBY). */
export class InMemoryRealtimeAggregator implements RealtimeAggregator {
  /** windowStartMs → itemId → counters. */
  readonly #windows = new Map<number, Map<string, ItemCounters>>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #counters(windowStartMs: number, itemId: string): ItemCounters {
    this.#expire();
    let window = this.#windows.get(windowStartMs);
    if (!window) {
      window = new Map();
      this.#windows.set(windowStartMs, window);
    }
    let item = window.get(itemId);
    if (!item) {
      item = {
        hll: new HyperLogLog(),
        attentionItems: 0,
        sourceOpens: 0,
        sourceBounces: 0,
        contextOpens: 0,
        contributions: 0,
        eventCount: 0,
      };
      window.set(itemId, item);
    }
    return item;
  }

  /** Drop windows older than the TTL — counters never outlive the window. */
  #expire(): void {
    const oldest = this.#now() - REALTIME_TTL_MS;
    for (const windowStart of this.#windows.keys()) {
      if (windowStart + REALTIME_WINDOW_MS <= oldest) this.#windows.delete(windowStart);
    }
  }

  async recordAttention(event: AttentionAggregateEvent, actorKey: string): Promise<void> {
    const windowStart = realtimeWindowStart(Date.parse(event.timestamp));
    for (const item of event.items) {
      const counters = this.#counters(windowStart, item.story_id);
      counters.hll.add(actorKey);
      counters.eventCount += 1;
      counters.attentionItems += 1;
      if (item.source_opened) counters.sourceOpens += 1;
      if (item.context_opened) counters.contextOpens += 1;
    }
  }

  async recordSourceOpen(event: SourceOpenedAggregateEvent, actorKey: string): Promise<void> {
    const windowStart = realtimeWindowStart(Date.parse(event.timestamp));
    const counters = this.#counters(windowStart, event.story_id);
    counters.hll.add(actorKey);
    counters.eventCount += 1;
    if (event.bounce) counters.sourceBounces += 1;
    else counters.sourceOpens += 1;
  }

  async recordContribution(itemId: string, actorKey: string, timestampIso: string): Promise<void> {
    const windowStart = realtimeWindowStart(Date.parse(timestampIso));
    const counters = this.#counters(windowStart, itemId);
    counters.hll.add(actorKey);
    counters.eventCount += 1;
    counters.contributions += 1;
  }

  async recordSave(event: ContentSavedAggregateEvent, actorKey: string): Promise<void> {
    // A save is a scoring event (§5.3): count it toward the item's uniques +
    // eventCount so a save-heavy window can cross the volume trigger promptly
    // (the durable hourly fold still computes the actual savedForLater score).
    const windowStart = realtimeWindowStart(Date.parse(event.timestamp));
    const counters = this.#counters(windowStart, event.story_id);
    counters.hll.add(actorKey);
    counters.eventCount += 1;
  }

  async snapshot(itemId: string, windowStartMs: number): Promise<RealtimeItemCounts | null> {
    this.#expire();
    const counters = this.#windows.get(windowStartMs)?.get(itemId);
    if (!counters) return null;
    return {
      uniqueActors: counters.hll.estimate(),
      attentionItems: counters.attentionItems,
      sourceOpens: counters.sourceOpens,
      sourceBounces: counters.sourceBounces,
      contextOpens: counters.contextOpens,
      contributions: counters.contributions,
      eventCount: counters.eventCount,
    };
  }

  async itemsInWindow(windowStartMs: number): Promise<string[]> {
    this.#expire();
    return [...(this.#windows.get(windowStartMs)?.keys() ?? [])];
  }

  async clear(): Promise<void> {
    this.#windows.clear();
  }
}

/**
 * Rebuild the acceleration layer from durable events (WS-E.3.2 acceptance:
 * "fully rebuildable from the event store"). Used after a cache loss; also the
 * proof in tests that Redis holds no unique state.
 */
export async function rebuildRealtimeFromEvents(
  aggregator: RealtimeAggregator,
  events: readonly StoredEvent[],
  actorKeyOf: (payload: Record<string, unknown>) => string,
): Promise<void> {
  for (const event of events) {
    if (event.topic === 'attention.aggregate') {
      await aggregator.recordAttention(
        event.payload as unknown as AttentionAggregateEvent,
        actorKeyOf(event.payload),
      );
    } else if (event.topic === 'source.opened.aggregate') {
      await aggregator.recordSourceOpen(
        event.payload as unknown as SourceOpenedAggregateEvent,
        actorKeyOf(event.payload),
      );
    } else if (event.topic === 'contribution.created') {
      const payload = event.payload as { thread_id?: string; user_id?: string; timestamp?: string };
      if (payload.thread_id && payload.user_id) {
        await aggregator.recordContribution(
          payload.thread_id,
          actorKeyOf(event.payload),
          event.timestamp,
        );
      }
    } else if (event.topic === 'content.saved') {
      await aggregator.recordSave(
        event.payload as unknown as ContentSavedAggregateEvent,
        actorKeyOf(event.payload),
      );
    }
  }
}
