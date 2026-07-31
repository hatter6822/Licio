// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Startup recovery + dead-letter re-drive (WS-E.1.5 at-least-once semantics
// made real). The durable Postgres event log is the source of truth; this
// module closes the crash window between store-insert and in-process delivery:
//
//   • DURABLE consumers (e.g. `integrity-intake`) are replayed from their
//     persisted checkpoint: events newer than the checkpoint re-deliver
//     through the router's normal guards (policy re-checks, idempotency,
//     retry → DLQ). Downstream intakes key on the deterministic event id, so
//     at-least-once re-delivery never double-counts.
//   • The REAL-TIME aggregation layer recovers by REBUILD, not replay: its
//     counters are short-lived and rebuildable by design (WS-E.3.2), so the
//     live window is reconstructed exactly from the log. (With multiple API
//     instances the layer is advisory and hourly-reconciled; the durable
//     aggregation remains authoritative either way.)
//
// `redriveDeadLetters` retries poisoned events after their cause is fixed —
// the operational complement to dead-lettering, exposed to stewards via the
// /v1/events/admin surface.
import { type LicioEvent, parseEvent } from '@licio/shared';
import { REALTIME_WINDOW_MS, realtimeWindowStart, rebuildRealtimeFromEvents } from './realtime.js';
import { actorKeyOfPayload, type EventPipelineServices } from './services.js';
import type { StoredEvent } from './stores.js';

/** How far back a durable consumer with NO checkpoint replays (first boot). */
export const REPLAY_FALLBACK_MS = 3_600_000;

/** Parse stored rows back into validated events (skips any corrupt row). */
function toEvents(rows: readonly StoredEvent[]): LicioEvent[] {
  const events: LicioEvent[] = [];
  for (const row of rows) {
    const parsed = parseEvent(row.payload);
    if (parsed.ok) events.push(parsed.event);
  }
  return events;
}

export interface RecoveryReport {
  /** Events re-delivered per durable consumer. */
  replayed: Record<string, number>;
  /** Events folded into the rebuilt real-time windows. */
  realtimeRebuilt: number;
}

/**
 * Run startup recovery: replay durable consumers from their checkpoints and
 * rebuild the real-time layer for the previous + current 1-hour windows.
 * Idempotent — running it on a healthy instance re-delivers nothing (the
 * router's idempotency set and checkpoint advance make replays converge).
 */
export async function recoverEventPipeline(
  events: EventPipelineServices,
  now: number = events.now(),
): Promise<RecoveryReport> {
  const report: RecoveryReport = { replayed: {}, realtimeRebuilt: 0 };

  // 1. Durable-consumer replay from checkpoints.
  for (const consumer of events.router.consumers()) {
    if (!consumer.durable) continue;
    const checkpoint = await events.checkpoints.get(consumer.name);
    const sinceIso = checkpoint ?? new Date(now - REPLAY_FALLBACK_MS).toISOString();
    const rows = await events.eventStore.listByTopicsBetween(
      consumer.topics,
      sinceIso,
      new Date(now + 1).toISOString(),
    );
    // INCLUSIVE at the checkpoint: an undelivered event sharing the
    // checkpointed timestamp (batched/system events stamp one nowIso) must
    // still replay — dropping equal-timestamp rows would violate
    // at-least-once. The already-delivered event may re-deliver once after a
    // restart; downstream intakes key on the event id, so that is safe.
    const candidates = toEvents(rows);
    const delivered = await events.router.replayConsumer(consumer.name, candidates);
    report.replayed[consumer.name] = delivered;
    if (delivered > 0) {
      events.log('events.recovery.replayed', { consumer: consumer.name, delivered });
    }
  }

  // 2. Real-time rebuild for the live and previous windows (WS-E.3.2:
  //    "fully rebuildable from the event store — no unique state"). The clear
  //    is UNCONDITIONAL: stale counters surviving in Redis while the durable
  //    log holds nothing (e.g. after a `none`-preference purge) would
  //    otherwise report phantom volume until their TTL.
  const currentWindowStart = realtimeWindowStart(now);
  const rows = await events.eventStore.listByTopicsBetween(
    ['attention.aggregate', 'source.opened.aggregate', 'contribution.created', 'content.saved'],
    new Date(currentWindowStart - REALTIME_WINDOW_MS).toISOString(),
    new Date(now + 1).toISOString(),
  );
  await events.realtime.clear();
  if (rows.length > 0) {
    // PASS THE RESOLVER.  Leaving it off would make the rebuild reproduce exactly
    // the gap it exists to repair: a pre-0111 payload carries only `thread_id`, and
    // an unwired seam is a guarantee that exists and is consulted by nobody.
    await rebuildRealtimeFromEvents(
      events.realtime,
      rows,
      actorKeyOfPayload,
      events.storyIdForThread,
    );
    report.realtimeRebuilt = rows.length;
    events.log('events.recovery.realtime_rebuilt', { events: rows.length });
  }
  return report;
}

export interface RedriveReport {
  attempted: number;
  succeeded: number;
  /** Event ids that dead-lettered again (still poisoned). */
  stillPoisoned: string[];
}

/**
 * Re-drive a consumer's dead letters: each event is re-read from the durable
 * log (the DLQ stores references, never payload copies), re-validated, and
 * re-delivered once through the router. Successes leave the queue; failures
 * stay dead-lettered for the next attempt after a further fix.
 */
export async function redriveDeadLetters(
  events: EventPipelineServices,
  consumerName: string,
): Promise<RedriveReport> {
  const report: RedriveReport = { attempted: 0, succeeded: 0, stillPoisoned: [] };
  for (const letter of await events.deadLetters.list(consumerName)) {
    report.attempted += 1;
    // The event row outlives the dead letter (retention permitting); a purged
    // row simply clears the letter — there is nothing left to deliver.
    const row = await events.eventStore.getById(letter.eventId);
    const parsed = row ? parseEvent(row.payload) : null;
    if (!parsed?.ok) {
      await events.deadLetters.delete(consumerName, letter.eventId);
      continue;
    }
    if (await events.router.redrive(consumerName, parsed.event)) {
      report.succeeded += 1;
    } else {
      report.stillPoisoned.push(letter.eventId);
    }
  }
  events.log('events.deadletters.redrive', {
    consumer: consumerName,
    attempted: report.attempted,
    succeeded: report.succeeded,
  });
  return report;
}
