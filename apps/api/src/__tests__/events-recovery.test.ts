// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Recovery + redrive + crypto-flag gate acceptance (WS-E.1.5 / WS-E.1.2 made
// operational): durable consumers replay from persisted checkpoints after a
// crash between store-insert and delivery; the real-time layer recovers by
// exact rebuild; dead letters can be re-driven after the cause is fixed; and
// the fail-closed crypto flag withholds Knomosis topics from EVERY consumer.

import { randomUUID } from 'node:crypto';
import {
  type IntegritySignalDetectedEvent,
  integritySignalDetectedEventSchema,
  type LicioEvent,
  licioEventSchema,
  TOPIC_REGISTRY,
} from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerDefaultConsumers } from '../events/consumers.js';
import { ingestAttentionEvents, ONLINE_ACCEPTANCE } from '../events/ingest.js';
import { realtimeWindowStart } from '../events/realtime.js';
import { recoverEventPipeline, redriveDeadLetters } from '../events/recovery.js';
import {
  attentionEvent,
  freshWsEServices,
  seedUserWithSession,
  type WsEFixture,
} from './ws-e-helpers.js';

function integritySignal(
  targetId: string,
  timestamp = new Date().toISOString(),
): IntegritySignalDetectedEvent {
  return integritySignalDetectedEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'integrity.signal.detected',
    timestamp,
    schema_version: '1',
    signal_type: 'coordinated_burst',
    target_ids: [targetId],
    confidence: 0.7,
    evidence_summary: 'synthetic burst for recovery tests',
    privacy_classification: 'restricted',
    retention_tier: 'security_log',
  });
}

async function storeEvent(fixture: WsEFixture, event: LicioEvent): Promise<void> {
  const entry = TOPIC_REGISTRY[event.event_type];
  await fixture.events.eventStore.insertMany([
    {
      eventId: event.event_id,
      eventType: event.event_type,
      topic: event.event_type,
      timestamp: event.timestamp,
      privacyClassification: entry.privacy_classification,
      retentionTier: entry.retention_tier,
      payload: event as unknown as Record<string, unknown>,
      ownerUserId: null,
      purgeAfter: null,
    },
  ]);
}

let fixture: WsEFixture;
let mfciIntake: string[];

beforeEach(() => {
  mfciIntake = [];
  fixture = freshWsEServices({
    hooks: {
      mfci: (signal) => {
        mfciIntake.push(signal.event_id);
      },
    },
  });
  registerDefaultConsumers(fixture.events);
});

describe('durable-consumer recovery (WS-E.1.5 at-least-once)', () => {
  it('replays an event stored but never delivered (the crash window)', async () => {
    // Simulate a crash between store-insert and publish: the integrity event
    // exists in the durable log, but integrity-intake never saw it.
    const signal = integritySignal(randomUUID());
    await storeEvent(fixture, signal);
    expect(mfciIntake).toEqual([]);

    const report = await recoverEventPipeline(fixture.events);
    expect(report.replayed['integrity-intake']).toBe(1);
    expect(mfciIntake).toEqual([signal.event_id]);
  });

  it('advances the checkpoint on delivery and replays nothing when healthy', async () => {
    const signal = integritySignal(randomUUID());
    await storeEvent(fixture, signal);
    await fixture.events.router.publish(signal); // delivered normally
    expect(await fixture.events.checkpoints.get('integrity-intake')).toBe(signal.timestamp);

    const report = await recoverEventPipeline(fixture.events);
    // The router's idempotency set + the strictly-after checkpoint filter
    // mean a healthy instance re-delivers nothing.
    expect(report.replayed['integrity-intake']).toBe(0);
    expect(mfciIntake).toEqual([signal.event_id]); // exactly once end to end
  });

  it('rebuilds the real-time layer for the live window from the durable log', async () => {
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
    const before = await fixture.events.realtime.snapshot(storyId, windowStart);
    await fixture.events.realtime.clear(); // simulated cache loss
    const report = await recoverEventPipeline(fixture.events);
    expect(report.realtimeRebuilt).toBeGreaterThan(0);
    expect(await fixture.events.realtime.snapshot(storyId, windowStart)).toEqual(before);
  });

  it('replays an undelivered event sharing the checkpointed timestamp (inclusive boundary)', async () => {
    // Batched/system emissions stamp one nowIso across several events. If the
    // process crashes after delivering only the first, the second must still
    // replay — a strictly-after checkpoint filter would drop it forever.
    const sharedTs = new Date().toISOString();
    const delivered = integritySignal(randomUUID(), sharedTs);
    const missed = integritySignal(randomUUID(), sharedTs);
    await storeEvent(fixture, delivered);
    await storeEvent(fixture, missed);
    await fixture.events.router.publish(delivered); // checkpoint advances to sharedTs
    expect(await fixture.events.checkpoints.get('integrity-intake')).toBe(sharedTs);
    expect(mfciIntake).toEqual([delivered.event_id]);

    const report = await recoverEventPipeline(fixture.events);
    // The missed neighbor re-delivers; the already-delivered one is suppressed
    // by the router's idempotency set (at-least-once, converging on exactly-once).
    expect(report.replayed['integrity-intake']).toBe(1);
    expect(mfciIntake).toEqual([delivered.event_id, missed.event_id]);
  });

  it('clears stale real-time counters even when the durable log holds nothing', async () => {
    // Phantom counters with no durable backing (e.g. Redis outliving a
    // `none`-preference purge) must not survive recovery as fake volume.
    const storyId = randomUUID();
    const now = Date.now();
    await fixture.events.realtime.recordContribution(
      storyId,
      'stale-actor',
      new Date(now).toISOString(),
    );
    const windowStart = realtimeWindowStart(now);
    expect(await fixture.events.realtime.snapshot(storyId, windowStart)).not.toBeNull();
    const report = await recoverEventPipeline(fixture.events, now);
    expect(report.realtimeRebuilt).toBe(0);
    expect(await fixture.events.realtime.snapshot(storyId, windowStart)).toBeNull();
  });
});

describe('dead-letter redrive (WS-E.1.5 operational complement)', () => {
  it('re-drives a poisoned event after the cause is fixed and clears the DLQ', async () => {
    let healthy = false;
    const received: string[] = [];
    fixture.events.router.register({
      name: 'flaky',
      topics: ['integrity.signal.detected'],
      accessClassifications: ['restricted'],
      scoring: false,
      handle: async (event) => {
        if (!healthy) throw new Error('downstream outage');
        received.push(event.event_id);
      },
    });
    const signal = integritySignal(randomUUID());
    await storeEvent(fixture, signal);
    await fixture.events.router.publish(signal);
    expect(await fixture.events.deadLetters.list('flaky')).toHaveLength(1);

    // Still broken: the redrive reports it as still poisoned, DLQ keeps it.
    const failed = await redriveDeadLetters(fixture.events, 'flaky');
    expect(failed).toMatchObject({ attempted: 1, succeeded: 0 });
    expect(failed.stillPoisoned).toEqual([signal.event_id]);
    expect(await fixture.events.deadLetters.list('flaky')).toHaveLength(1);

    // Fixed: the redrive delivers and clears the letter.
    healthy = true;
    const fixed = await redriveDeadLetters(fixture.events, 'flaky');
    expect(fixed).toMatchObject({ attempted: 1, succeeded: 1, stillPoisoned: [] });
    expect(received).toEqual([signal.event_id]);
    expect(await fixture.events.deadLetters.list('flaky')).toHaveLength(0);
  });

  it('clears a letter whose event row no longer exists (nothing to deliver)', async () => {
    await fixture.events.deadLetters.append({
      consumerName: 'integrity-intake',
      eventId: randomUUID(), // never stored
      topic: 'integrity.signal.detected',
      error: 'poisoned',
      attempts: 3,
      failedAt: new Date().toISOString(),
    });
    const report = await redriveDeadLetters(fixture.events, 'integrity-intake');
    expect(report).toMatchObject({ attempted: 1, succeeded: 0, stillPoisoned: [] });
    expect(await fixture.events.deadLetters.list('integrity-intake')).toHaveLength(0);
  });
});

describe('crypto feature flag gate (WS-E.1.2, fail-closed)', () => {
  function walletLinked(): LicioEvent {
    return licioEventSchema.parse({
      event_id: randomUUID(),
      event_type: 'wallet.linked',
      timestamp: new Date().toISOString(),
      schema_version: '1',
      user_id: randomUUID(),
      wallet_ref: 'a'.repeat(64),
      chain_id: 1,
      wallet_type: 'eoa',
      privacy_classification: 'restricted',
      retention_tier: 'account_active',
    });
  }

  it('withholds Knomosis topics from EVERY consumer while the flag is off', async () => {
    const received: string[] = [];
    fixture.events.router.register({
      name: 'wallet-indexer',
      topics: ['wallet.linked'],
      accessClassifications: ['restricted'],
      scoring: false,
      handle: async (event) => {
        received.push(event.event_type);
      },
    });
    await fixture.events.router.publish(walletLinked());
    expect(received).toEqual([]); // authorized, but the flag is off
    expect(fixture.events.router.metrics().get('wallet-indexer')?.withheldByCryptoFlag).toBe(1);
  });

  it('delivers to authorized non-scoring consumers when the flag is on', async () => {
    let enabled = false;
    fixture = freshWsEServices({ cryptoFlagEnabled: () => enabled });
    const received: string[] = [];
    fixture.events.router.register({
      name: 'wallet-indexer',
      topics: ['wallet.linked'],
      accessClassifications: ['restricted'],
      scoring: false,
      handle: async (event) => {
        received.push(event.event_type);
      },
    });
    await fixture.events.router.publish(walletLinked());
    expect(received).toEqual([]);
    enabled = true; // a live flag flip applies to the next event
    await fixture.events.router.publish(walletLinked());
    expect(received).toEqual(['wallet.linked']);
  });
});
