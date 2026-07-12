// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres integration tests for the WS-E Drizzle adapters. These
// run ONLY when DATABASE_URL points at a real Postgres (`docker compose up
// postgres`); CI has no database service and skips them.
//
// The suite creates and migrates its OWN database (licio_events_it) through
// the REAL migration chain — which proves the hand-tuned partitioned `events`
// DDL (0003_ws_e_events.sql) applies cleanly — then exercises every adapter
// against live SQL, including partition routing.
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../../identity/drizzle-store.js';
import {
  DrizzleAggregationWindowStore,
  DrizzleAttentionAggregateStore,
  DrizzleConsumerCheckpointStore,
  DrizzleDeadLetterStore,
  DrizzleEventStore,
  DrizzleInvariantOutputStore,
  DrizzleItemSafetyStateStore,
  DrizzlePwattConfigStore,
  DrizzleSignalLedgerStore,
} from '../drizzle-event-stores.js';
import { type NewStoredEvent, PRIVACY_BUCKET } from '../stores.js';

const DB_URL = process.env['DATABASE_URL'];
const IT_DB = 'licio_events_it';
const DAY = 86_400_000;

function eventRow(overrides: Partial<NewStoredEvent> = {}): NewStoredEvent {
  return {
    eventId: randomUUID(),
    eventType: 'attention.aggregate',
    topic: 'attention.aggregate',
    timestamp: new Date().toISOString(),
    privacyClassification: 'aggregated',
    retentionTier: 'attention_aggregated',
    payload: { probe: true },
    ownerUserId: null,
    purgeAfter: null,
    ...overrides,
  };
}

describe.skipIf(!DB_URL)('Drizzle event-pipeline stores integration (WS-E.3.1)', () => {
  let db: ReturnType<typeof createDbClient>;
  let events: DrizzleEventStore;
  let aggregates: DrizzleAttentionAggregateStore;
  let windows: DrizzleAggregationWindowStore;
  let invariants: DrizzleInvariantOutputStore;
  let ledger: DrizzleSignalLedgerStore;
  let safety: DrizzleItemSafetyStateStore;
  let config: DrizzlePwattConfigStore;
  let deadLetters: DrizzleDeadLetterStore;
  let checkpoints: DrizzleConsumerCheckpointStore;
  let identity: DrizzleIdentityStore;
  let ownerId: string;

  beforeAll(async () => {
    const admin = postgres(DB_URL as string, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${IT_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${IT_DB}`);
    await admin.end();

    const itUrl = new URL(DB_URL as string);
    itUrl.pathname = `/${IT_DB}`;
    const migrationClient = postgres(itUrl.href, { max: 1 });
    // The REAL migration chain, including the partitioned events DDL.
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsFolder() });
    await migrationClient.end();

    db = createDbClient(itUrl.href);
    events = new DrizzleEventStore(db);
    aggregates = new DrizzleAttentionAggregateStore(db);
    windows = new DrizzleAggregationWindowStore(db);
    invariants = new DrizzleInvariantOutputStore(db);
    ledger = new DrizzleSignalLedgerStore(db);
    safety = new DrizzleItemSafetyStateStore(db);
    config = new DrizzlePwattConfigStore(db);
    deadLetters = new DrizzleDeadLetterStore(db);
    checkpoints = new DrizzleConsumerCheckpointStore(db);
    identity = new DrizzleIdentityStore(db);
    const user = await identity.createUser({
      handle: `evt_${randomUUID().slice(0, 8)}`,
      displayName: 'Events IT User',
      email: null,
      accountState: 'active',
      locale: null,
      ageBand: 'adult',
      privacySettings: defaultPrivacySettings(),
      personalizationSettings: defaultPersonalizationSettings(),
      roles: ['user'],
    });
    ownerId = user.userId;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await events.clear();
    await aggregates.clear();
    await windows.clear();
    await invariants.clear();
    await ledger.clear();
    await safety.clear();
    await config.clear();
    await deadLetters.clear();
    await checkpoints.clear();
  });

  it('the events table is LIST-partitioned with one partition per tier + default', async () => {
    const partitions = await db.execute(sql`
      select c.relname from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_class p on p.oid = i.inhparent
      where p.relname = 'events' order by c.relname
    `);
    const names = (partitions as unknown as Array<{ relname: string }>).map((r) => r.relname);
    expect(names).toEqual([
      'events_account_active',
      'events_attention_aggregated',
      'events_attention_raw',
      'events_default',
      'events_moderation_legal',
      'events_public_contribution',
      'events_ranking_log',
      'events_security_log',
    ]);
  });

  it('routes rows to the tier partition and dedups by event id (replay backstop)', async () => {
    const row = eventRow({ ownerUserId: ownerId });
    expect(await events.insertMany([row])).toEqual({ inserted: 1, duplicateIds: [] });
    expect(await events.insertMany([row])).toEqual({ inserted: 0, duplicateIds: [row.eventId] });
    const inPartition = await db.execute(
      sql`select count(*)::int as n from events_attention_aggregated`,
    );
    expect((inPartition as unknown as Array<{ n: number }>)[0]?.n).toBe(1);
  });

  it('rejects an unclassified write at the storage layer (defense in depth)', async () => {
    // Drizzle wraps the postgres error; assert the write FAILED and that the
    // underlying cause is the NOT NULL constraint on privacy_classification.
    let thrown: unknown;
    try {
      await db.execute(sql`
        insert into events (event_id, event_type, topic, timestamp, privacy_classification, retention_tier, payload)
        values (${randomUUID()}::uuid, 'x', 'x', now(), NULL, 'attention_raw', '{}'::jsonb)
      `);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const cause = (thrown as { cause?: unknown }).cause ?? thrown;
    expect(String(cause)).toMatch(/null value|not-null|violates/i);
  });

  it('supports the four access patterns: replay, owner, purge, tier sweeps', async () => {
    const now = Date.now();
    const owned = eventRow({ ownerUserId: ownerId });
    const old = eventRow({
      retentionTier: 'attention_raw',
      timestamp: new Date(now - 10 * DAY).toISOString(),
    });
    const purgeDue = eventRow({ purgeAfter: new Date(now - 1_000).toISOString() });
    const moderation = eventRow({
      eventType: 'moderation.case.created',
      topic: 'moderation.case.created',
      privacyClassification: 'restricted',
      retentionTier: 'moderation_legal',
      timestamp: new Date(now - 400 * DAY).toISOString(),
    });
    await events.insertMany([owned, old, purgeDue, moderation]);

    // Replay by topic + window.
    const replayed = await events.listByTopicsBetween(
      ['attention.aggregate'],
      new Date(now - 60_000).toISOString(),
      new Date(now + 60_000).toISOString(),
    );
    expect(replayed.map((r) => r.eventId).sort()).toEqual([owned.eventId, purgeDue.eventId].sort());

    // Owner access + deletion (SPEC §19.3).
    expect((await events.listByOwner(ownerId)).map((r) => r.eventId)).toEqual([owned.eventId]);
    expect(await events.listOwnersWithTier('attention_aggregated')).toEqual([ownerId]);

    // Tier sweep with batching.
    expect(await events.countTierOlderThan('attention_raw', new Date(now).toISOString())).toBe(1);
    expect(
      await events.deleteTierOlderThan('attention_raw', new Date(now - 7 * DAY).toISOString(), 100),
    ).toBe(1);

    // Purge-due sweep.
    expect(await events.deletePurgeDue(new Date(now).toISOString(), 100)).toBe(1);

    // Moderation review flag is idempotent and never deletes.
    expect(await events.flagModerationForReview(new Date(now - 365 * DAY).toISOString(), 100)).toBe(
      1,
    );
    expect(await events.flagModerationForReview(new Date(now - 365 * DAY).toISOString(), 100)).toBe(
      0,
    );
    expect(await events.countTierOlderThan('moderation_legal', new Date(now).toISOString())).toBe(
      1,
    );

    // Purge tightening only ever shortens.
    const deadline = new Date(now + 1_000).toISOString();
    expect(await events.tightenOwnerPurge(ownerId, 'attention_aggregated', deadline)).toBe(1);
    expect(
      await events.tightenOwnerPurge(
        ownerId,
        'attention_aggregated',
        new Date(now + DAY).toISOString(),
      ),
    ).toBe(0);
    expect(await events.deleteByOwner(ownerId)).toBe(1);
  });

  it('attention aggregates: §22.1 rows, anonymization, and identifiable counts', async () => {
    const old = new Date(Date.now() - 200 * DAY).toISOString();
    const row = {
      aggregate_id: randomUUID(),
      user_id_or_privacy_bucket: ownerId,
      story_id: randomUUID(),
      session_bucket: '2026-06-10T10:00:00.000Z',
      active_dwell_bucket: 'medium',
      source_opened: true,
      context_opened: false,
      branch_depth_bucket: 'shallow',
      return_visit_count_bucket: 'none',
      privacy_level: 'standard',
      created_at: old,
    };
    expect(await aggregates.insertMany([row, row])).toBe(1); // idempotent
    expect(await aggregates.listIdentifiableOwners()).toEqual([ownerId]);
    expect(await aggregates.countIdentifiableOlderThan(new Date().toISOString())).toBe(1);
    expect(await aggregates.anonymizeOwnedOlderThan(ownerId, new Date().toISOString())).toBe(1);
    const anonymized = await aggregates.listByUser(PRIVACY_BUCKET);
    expect(anonymized).toHaveLength(1);
    expect(anonymized[0]?.privacy_level).toBe('minimum');
    expect(await aggregates.deleteAnonymizedOlderThan(new Date().toISOString())).toBe(1);
  });

  it('aggregation windows: composite-key upsert and trailing-window reads', async () => {
    const itemId = randomUUID();
    const start = new Date(Date.UTC(2026, 5, 10, 10)).toISOString();
    const record = {
      itemId,
      windowStart: start,
      windowSize: '1h' as const,
      uniqueActiveUsers: 3,
      sourceOpens: 2,
      contextOpens: 1,
      returnVisits: 0,
      contributionCounts: { question: 1 },
      antiSignalCounts: {},
      eventCount: 7,
      computedAt: new Date().toISOString(),
    };
    await windows.upsert(record);
    await windows.upsert({ ...record, uniqueActiveUsers: 4 }); // idempotent re-run wins
    expect((await windows.get(itemId, start, '1h'))?.uniqueActiveUsers).toBe(4);
    const trailing = await windows.listForItemBefore(
      itemId,
      '1h',
      new Date(Date.UTC(2026, 5, 10, 11)).toISOString(),
      5,
    );
    expect(trailing).toHaveLength(1);
    expect(await windows.deleteOlderThan(new Date().toISOString())).toBe(1);
  });

  it('invariant outputs: natural-key upsert, latest, shadow flag round-trip', async () => {
    const targetId = randomUUID();
    const base = {
      invariantType: 'PWAtt_v0',
      targetType: 'story',
      targetId,
      timeWindow: { start: '2026-06-10T10:00:00.000Z', end: '2026-06-10T11:00:00.000Z' },
      version: 'v0',
      scoreVector: { score: 0.4 },
      explanationSummary: null,
      confidence: 0.6,
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: true,
      createdAt: new Date().toISOString(),
    };
    await invariants.upsert(base);
    await invariants.upsert({ ...base, scoreVector: { score: 0.5 } });
    const rows = await invariants.listForTarget(targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scoreVector['score']).toBe(0.5);
    expect(rows[0]?.shadowMode).toBe(true);
    expect((await invariants.latest('PWAtt_v0', targetId))?.version).toBe('v0');
    expect(await invariants.countOlderThan(new Date(Date.now() + 1_000).toISOString())).toBe(1);
    expect(await invariants.deleteOlderThan(new Date(Date.now() + 1_000).toISOString())).toBe(1);
  });

  it('signal ledger: owner-scoped keyset pagination and purge coupling', async () => {
    const mk = (i: number) => ({
      entryId: randomUUID(),
      ownerUserId: ownerId,
      itemId: randomUUID(),
      storyTitle: `Story ${i}`,
      windowStart: new Date(Date.UTC(2026, 5, 10, 10)).toISOString(),
      windowSize: '1h' as const,
      signals: { active_dwell_bucket: 'short' },
      antiSignals: ['rapid_repetition_dampened'],
      pwattScore: 0.25,
      summary: 'You read this for a short while.',
      recordedAt: new Date(Date.UTC(2026, 5, 10, 10, i)).toISOString(),
      purgeAfter: new Date(Date.now() + 30 * DAY).toISOString(),
    });
    await ledger.upsertMany([mk(0), mk(1), mk(2)]);
    const page1 = await ledger.listForUser(ownerId, 2);
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await ledger.listForUser(ownerId, 2, page1.nextCursor ?? undefined);
    expect(page2.entries).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(await ledger.tightenOwnerPurge(ownerId, new Date(Date.now() + DAY).toISOString())).toBe(
      3,
    );
    expect(await ledger.countOverRetained(new Date(Date.now() + 2 * DAY).toISOString())).toBe(3);
    expect(await ledger.deleteByUser(ownerId)).toBe(3);
  });

  it('safety states, config, dead letters, and checkpoints round-trip', async () => {
    const itemId = randomUUID();
    await safety.set({
      itemId,
      safetyState: 'frozen',
      frozenScore: 0.3,
      caseId: randomUUID(),
      updatedBy: 'system:test',
      updatedAt: new Date().toISOString(),
    });
    expect((await safety.get(itemId))?.safetyState).toBe('frozen');

    await config.set('burst', { minVolume: 25 });
    await config.set('burst', { minVolume: 30 });
    expect(await config.get('burst')).toEqual({ minVolume: 30 });
    expect(await config.get('missing')).toBeNull();

    await deadLetters.append({
      consumerName: 'scoring',
      eventId: randomUUID(),
      topic: 'contribution.created',
      error: 'poisoned',
      attempts: 3,
      failedAt: new Date().toISOString(),
    });
    expect(await deadLetters.list('scoring')).toHaveLength(1);
    expect(await deadLetters.list('other')).toHaveLength(0);

    await checkpoints.set('agg', new Date().toISOString());
    expect(await checkpoints.get('agg')).not.toBeNull();
  });
});
