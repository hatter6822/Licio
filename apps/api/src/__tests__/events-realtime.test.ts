// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real-time aggregation acceptance (WS-E.3.2): HyperLogLog accuracy within the
// documented error bound, per-signal counters, TTL expiry (counters never
// persist attention beyond the window), full rebuild from the event store
// (no unique state in the acceleration layer), and reconciliation against the
// durable aggregation.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerDefaultConsumers } from '../events/consumers.js';
import { HLL_STANDARD_ERROR, HyperLogLog } from '../events/hll.js';
import { ingestAttentionEvents, ONLINE_ACCEPTANCE } from '../events/ingest.js';
import {
  InMemoryRealtimeAggregator,
  REALTIME_TTL_MS,
  realtimeWindowStart,
  rebuildRealtimeFromEvents,
} from '../events/realtime.js';
import { actorKeyOfPayload } from '../events/services.js';
import { reconcileRealtimeWindow } from '../pwatt/scheduler.js';
import { runPwattWindow } from '../pwatt/scoring.js';
import {
  attentionEvent,
  contentSavedEvent,
  type EventServicesFixture,
  freshEventServices,
  seedUserWithSession,
  sourceOpenEvent,
} from './event-test-helpers.js';

describe('HyperLogLog (WS-E.3.2 bounded-memory unique counts)', () => {
  it('estimates small cardinalities exactly via linear counting', () => {
    const hll = new HyperLogLog();
    for (let i = 0; i < 50; i += 1) hll.add(`user-${i}`);
    expect(Math.abs(hll.estimate() - 50)).toBeLessThanOrEqual(1);
  });

  it('estimates 20k distinct within the documented ~0.81% bound (5σ test margin)', () => {
    const hll = new HyperLogLog();
    const n = 20_000;
    for (let i = 0; i < n; i += 1) hll.add(`actor-${i}`);
    const estimate = hll.estimate();
    const tolerance = 5 * HLL_STANDARD_ERROR * n; // generous, deterministic
    expect(Math.abs(estimate - n)).toBeLessThanOrEqual(tolerance);
  });

  it('is idempotent: re-adding the same elements never changes the estimate', () => {
    const hll = new HyperLogLog();
    for (let i = 0; i < 1_000; i += 1) hll.add(`a-${i}`);
    const first = hll.estimate();
    for (let i = 0; i < 1_000; i += 1) hll.add(`a-${i}`);
    expect(hll.estimate()).toBe(first);
  });
});

describe('real-time counters (WS-E.3.2)', () => {
  let fixture: EventServicesFixture;

  beforeEach(() => {
    fixture = freshEventServices();
    registerDefaultConsumers(fixture.events);
  });

  it('updates per-item counters in near-real-time as events are published', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    const event = attentionEvent(userId, { storyId });
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [event],
      ONLINE_ACCEPTANCE,
    );
    const windowStart = realtimeWindowStart(Date.parse(event.timestamp));
    const snapshot = await fixture.events.realtime.snapshot(storyId, windowStart);
    expect(snapshot).toMatchObject({
      uniqueActors: 1,
      attentionItems: 1,
      sourceOpens: 1,
      eventCount: 1,
    });
  });

  it('folds a content.saved (§5.3) event into realtime uniques + eventCount', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    const event = contentSavedEvent(userId, { story_id: storyId });
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [event],
      ONLINE_ACCEPTANCE,
    );
    const windowStart = realtimeWindowStart(Date.parse(event.timestamp));
    const snapshot = await fixture.events.realtime.snapshot(storyId, windowStart);
    // A save must increment the item's uniques + eventCount so a save-heavy
    // window can cross the volume trigger before the hourly tick.
    expect(snapshot).toMatchObject({ uniqueActors: 1, eventCount: 1 });
  });

  it('separates bounces from meaningful source opens', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    const bounce = sourceOpenEvent(userId, { story_id: storyId, bounce: true });
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [bounce],
      ONLINE_ACCEPTANCE,
    );
    const snapshot = await fixture.events.realtime.snapshot(
      storyId,
      realtimeWindowStart(Date.parse(bounce.timestamp)),
    );
    expect(snapshot?.sourceBounces).toBe(1);
    expect(snapshot?.sourceOpens).toBe(0);
  });

  it('expires counters after the TTL — never a long-term attention store', async () => {
    let now = Date.UTC(2026, 5, 10, 12, 30);
    const aggregator = new InMemoryRealtimeAggregator(() => now);
    const event = attentionEvent('33333333-3333-4333-8333-333333333333', {
      timestamp: new Date(now).toISOString(),
    });
    await aggregator.recordAttention(event, 'actor');
    const windowStart = realtimeWindowStart(now);
    expect(await aggregator.snapshot(event.items[0]?.story_id ?? '', windowStart)).not.toBeNull();
    // Advance past the TTL: the window is dropped entirely.
    now += REALTIME_TTL_MS + 3_600_000 + 1;
    expect(await aggregator.snapshot(event.items[0]?.story_id ?? '', windowStart)).toBeNull();
    expect(await aggregator.itemsInWindow(windowStart)).toEqual([]);
  });

  it('is fully rebuildable from the event store (no unique state)', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    const events = [
      attentionEvent(userId, { storyId }),
      sourceOpenEvent(userId, { story_id: storyId }),
    ];
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      events,
      ONLINE_ACCEPTANCE,
    );
    const windowStart = realtimeWindowStart(Date.parse(events[0]?.timestamp ?? ''));
    const original = await fixture.events.realtime.snapshot(storyId, windowStart);
    // Simulate a total cache loss, then rebuild from the durable log.
    await fixture.events.realtime.clear();
    expect(await fixture.events.realtime.snapshot(storyId, windowStart)).toBeNull();
    const stored = await fixture.events.eventStore.listByTopicsBetween(
      ['attention.aggregate', 'source.opened.aggregate', 'contribution.created'],
      new Date(windowStart).toISOString(),
      new Date(windowStart + 3_600_000).toISOString(),
    );
    await rebuildRealtimeFromEvents(fixture.events.realtime, stored, actorKeyOfPayload);
    expect(await fixture.events.realtime.snapshot(storyId, windowStart)).toEqual(original);
  });

  it('resolves a LEGACY contribution payload from its thread during a rolling upgrade', async () => {
    // An old pod emitting `contribution.created` after migration 0111 has run sends
    // a payload with only `thread_id` — the NORMAL state mid-deployment, not a
    // corrupt event.  Both readers used to skip it: the live consumer threw (a
    // permanent dead letter the one-time backfill can never repair, because the
    // event was written after it ran) and the rebuild dropped it, so those
    // contributions reached neither the realtime counters nor the early-aggregation
    // trigger.  The fold's thread → story seam answers the question in both.
    const threadId = randomUUID();
    const storyId = randomUUID();
    const userId = randomUUID();
    const windowStart = realtimeWindowStart(Date.now());
    const legacy = [
      {
        eventId: randomUUID(),
        topic: 'contribution.created',
        timestamp: new Date(windowStart + 1_000).toISOString(),
        payload: { thread_id: threadId, user_id: userId },
      },
    ] as unknown as Parameters<typeof rebuildRealtimeFromEvents>[1];

    // WITHOUT the resolver the rebuild is a no-op, which is the old behaviour…
    await rebuildRealtimeFromEvents(fixture.events.realtime, legacy, actorKeyOfPayload);
    expect(await fixture.events.realtime.snapshot(storyId, windowStart)).toBeNull();

    // …and with it the contribution lands under the OWNING STORY.
    await rebuildRealtimeFromEvents(
      fixture.events.realtime,
      legacy,
      actorKeyOfPayload,
      async (id) => (id === threadId ? storyId : null),
    );
    const snapshot = await fixture.events.realtime.snapshot(storyId, windowStart);
    expect(snapshot?.contributions).toBeGreaterThan(0);
  });

  it('reconciles against the durable aggregation within the HLL bound', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    const event = attentionEvent(userId, { storyId });
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [event],
      ONLINE_ACCEPTANCE,
    );
    const windowStart = realtimeWindowStart(Date.parse(event.timestamp));
    // Compute the durable window (source of truth), then reconcile.
    await runPwattWindow(fixture.events, fixture.identity, windowStart, '1h');
    const report = await reconcileRealtimeWindow(fixture.events, windowStart);
    expect(report.checked).toBe(1);
    expect(report.discrepancies).toBe(0);
  });

  it('fires the volume-threshold trigger exactly once per item-window', async () => {
    const triggered: string[] = [];
    fixture = freshEventServices();
    registerDefaultConsumers(fixture.events, {
      triggerThreshold: 2,
      onVolumeTrigger: (itemId) => triggered.push(itemId),
    });
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    for (let i = 0; i < 4; i += 1) {
      await ingestAttentionEvents(
        fixture.events,
        fixture.identity,
        userId,
        [attentionEvent(userId, { storyId })],
        ONLINE_ACCEPTANCE,
      );
    }
    expect(triggered).toEqual([storyId]); // debounced: once, not thrice
  });

  it('never re-throws a trigger failure out of handle (retry-idempotent recording)', async () => {
    const triggered: string[] = [];
    fixture = freshEventServices();
    registerDefaultConsumers(fixture.events, {
      triggerThreshold: 1,
      onVolumeTrigger: (itemId) => triggered.push(itemId),
    });
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    // The counters commit before the trigger; make the trigger's snapshot read
    // fail so we prove a post-record failure does NOT propagate out of handle
    // (which would replay the already-committed, non-idempotent recordAttention).
    const realtime = fixture.events.realtime;
    const originalSnapshot = realtime.snapshot.bind(realtime);
    realtime.snapshot = () => Promise.reject(new Error('snapshot boom'));

    const event = attentionEvent(userId, { storyId });
    await expect(
      ingestAttentionEvents(fixture.events, fixture.identity, userId, [event], ONLINE_ACCEPTANCE),
    ).resolves.toBeDefined();

    expect(triggered).toEqual([]); // the failing trigger fired nothing

    // Restore the real reader: the recording committed exactly once (no replay).
    realtime.snapshot = originalSnapshot;
    const windowStart = realtimeWindowStart(Date.parse(event.timestamp));
    const snapshot = await realtime.snapshot(storyId, windowStart);
    expect(snapshot?.eventCount).toBe(1);
  });

  it('picks up a runtime-tuned trigger threshold via readTriggerThreshold (no restart)', async () => {
    const triggered: string[] = [];
    let liveThreshold = 1000; // start high — no trigger
    fixture = freshEventServices();
    registerDefaultConsumers(fixture.events, {
      triggerThreshold: liveThreshold,
      readTriggerThreshold: () => Promise.resolve(liveThreshold),
      thresholdRefreshMs: 0, // refresh on every event (test)
      onVolumeTrigger: (itemId) => triggered.push(itemId),
    });
    const { userId } = await seedUserWithSession(fixture.identity);
    const storyId = randomUUID();
    for (let i = 0; i < 2; i += 1) {
      await ingestAttentionEvents(
        fixture.events,
        fixture.identity,
        userId,
        [attentionEvent(userId, { storyId })],
        ONLINE_ACCEPTANCE,
      );
    }
    expect(triggered).toEqual([]); // eventCount 2 < 1000

    // An operator lowers the threshold at runtime; the next event picks it up
    // WITHOUT a restart (previously the boot-captured value would never change).
    liveThreshold = 2;
    await ingestAttentionEvents(
      fixture.events,
      fixture.identity,
      userId,
      [attentionEvent(userId, { storyId })],
      ONLINE_ACCEPTANCE,
    );
    expect(triggered).toEqual([storyId]); // eventCount 3 >= the new threshold 2
  });
});
