// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Default consumer wiring (WS-E.1.5). Two named consumers demonstrate the two
// router policies in production shape:
//
//   `realtime-aggregation` — a SCORING consumer (public + aggregated access
//     only; the firewall subject): folds attention/contribution events into
//     the Redis-shaped real-time counters and fires the volume-threshold
//     trigger for early aggregation (WS-E.2.1a "triggered computation").
//
//   `integrity-intake` — a RESTRICTED-authorized, non-scoring consumer:
//     forwards integrity signals to the MFCI and review-queue hooks
//     (WS-E.2.2a). Restricted topics are deliverable ONLY to consumers like
//     this one holding the corresponding access (WS-E.1.5 acceptance).
import type {
  AttentionAggregateEvent,
  ContentSavedAggregateEvent,
  IntegritySignalDetectedEvent,
  SourceOpenedAggregateEvent,
} from '@licio/shared';
import { REALTIME_TTL_MS, REALTIME_WINDOW_MS, realtimeWindowStart } from './realtime.js';
import { actorKeyOfPayload, type EventPipelineServices } from './services.js';

export interface TriggerOptions {
  /** Called when an item's real-time volume crosses the trigger threshold. */
  onVolumeTrigger?: (itemId: string, windowStartMs: number) => void;
  /** The threshold (kept in sync with pwatt config by the boot wiring). */
  triggerThreshold?: number;
}

/** Register the default consumers on the services' router. */
export function registerDefaultConsumers(
  events: EventPipelineServices,
  options: TriggerOptions = {},
): void {
  const threshold = options.triggerThreshold ?? 500;
  /** Items that already fired the early-aggregation trigger, bucketed by window
   *  start.  Bounded to the live-window horizon (evicted below on the SAME
   *  boundary the aggregator uses) so it can never grow for the process lifetime. */
  const fired = new Map<number, Set<string>>();

  events.router.register({
    name: 'realtime-aggregation',
    topics: [
      'attention.aggregate',
      'source.opened.aggregate',
      'contribution.created',
      'content.saved',
    ],
    accessClassifications: ['public', 'aggregated'],
    scoring: true,
    handle: async (event) => {
      const payload = event as unknown as Record<string, unknown>;
      const actorKey = actorKeyOfPayload(payload);
      const itemIds: string[] = [];
      if (event.event_type === 'attention.aggregate') {
        const attention = event as AttentionAggregateEvent;
        await events.realtime.recordAttention(attention, actorKey);
        itemIds.push(...attention.items.map((item) => item.story_id));
      } else if (event.event_type === 'source.opened.aggregate') {
        const sourceOpen = event as SourceOpenedAggregateEvent;
        await events.realtime.recordSourceOpen(sourceOpen, actorKey);
        itemIds.push(sourceOpen.story_id);
      } else if (event.event_type === 'contribution.created') {
        const contribution = event as { thread_id: string; user_id: string; timestamp: string };
        await events.realtime.recordContribution(
          contribution.thread_id,
          contribution.user_id,
          contribution.timestamp,
        );
        itemIds.push(contribution.thread_id);
      } else if (event.event_type === 'content.saved') {
        const saved = event as ContentSavedAggregateEvent;
        await events.realtime.recordSave(saved, actorKey);
        itemIds.push(saved.story_id);
      }
      // Volume-threshold trigger for early aggregation (WS-E.2.1a).
      if (options.onVolumeTrigger) {
        // Evict debounce buckets whose window's realtime counters are already
        // gone, mirroring InMemoryRealtimeAggregator#expire so a key is dropped
        // only AFTER its counter — never a window early enough for a late event
        // to re-fire the trigger.
        const oldest = Date.now() - REALTIME_TTL_MS;
        for (const windowStart of fired.keys()) {
          if (windowStart + REALTIME_WINDOW_MS <= oldest) fired.delete(windowStart);
        }
        for (const itemId of itemIds) {
          const windowStartMs = realtimeWindowStart(Date.parse(event.timestamp));
          let bucket = fired.get(windowStartMs);
          if (bucket?.has(itemId)) continue;
          const snapshot = await events.realtime.snapshot(itemId, windowStartMs);
          if (snapshot && snapshot.eventCount >= threshold) {
            if (bucket === undefined) {
              bucket = new Set();
              fired.set(windowStartMs, bucket);
            }
            bucket.add(itemId);
            options.onVolumeTrigger(itemId, windowStartMs);
          }
        }
      }
    },
  });

  events.router.register({
    name: 'integrity-intake',
    topics: ['integrity.signal.detected'],
    accessClassifications: ['restricted'],
    scoring: false,
    // Durable: missed integrity signals are replayed from the event log at
    // startup (events/recovery.ts) — the MFCI/review hooks must not lose
    // detections to a crash between store and publish.
    durable: true,
    handle: async (event) => {
      const signal = event as IntegritySignalDetectedEvent;
      await events.hooks.mfci?.(signal);
      await events.hooks.reviewQueue?.(signal);
    },
  });
}
