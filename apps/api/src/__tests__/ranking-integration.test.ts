// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres integration tests for the WS-I ranking Drizzle
// adapters — the same interfaces the in-memory adapters satisfy, against
// the REAL migration chain (incl. 0012's composite PK, CHECKs, and
// retention index, and 0013's audit-enum extension). Run when DATABASE_URL
// is set (the CI test job provisions the service container).
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test

import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import {
  DeniedFinancialFieldError,
  FEATURE_SCHEMA_VERSION,
  type FeatureVector,
  type RankingDecisionLog,
  retentionDeadline,
} from '@licio/ranking';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleDecisionLogStore, DrizzleFeatureStore } from '../ranking/drizzle-ranking-stores.js';

const DB_URL = process.env['DATABASE_URL'];

function vectorOf(itemId: string, revision: number): FeatureVector {
  return {
    item_id: itemId,
    item_type: 'story',
    room_id: null,
    topic_ids: ['civics'],
    source_id: null,
    created_at: '2026-06-10T00:00:00.000Z',
    feature_version: FEATURE_SCHEMA_VERSION,
    revision,
    invariant_versions: {
      MFCI: {
        version_string: '1.0.0',
        computation_timestamp: '2026-06-10T00:30:00.000Z',
        config_hash: 'deadbeefcafef00d',
      },
    },
    updated_at: new Date().toISOString(),
    active_attention: 0.4,
    mfci_risk_state: 'elevated',
  };
}

function logOf(requestId: string, timestampIso: string): RankingDecisionLog {
  return {
    request_id: requestId,
    surface: 'front_page',
    user_privacy_bucket: 'bucket:1f',
    candidate_ids: [randomUUID()],
    selected_ids: [],
    score_components: {},
    feature_revisions: {},
    invariant_versions: {
      MFCI: {
        version_string: '1.0.0',
        computation_timestamp: timestampIso,
        config_hash: 'deadbeefcafef00d',
      },
    },
    constraints_applied: [
      {
        constraint: 'mfci_severe_cross_community',
        item_id: null,
        threshold: 'severe',
        actual: 'severe',
        action: 'excluded',
        enforced: false,
      },
    ],
    safety_exclusions: [],
    quota_outcomes: [],
    explanation_ids: {},
    experiment_ids: ['exp-1'],
    timestamp: timestampIso,
    profile_id: 'evergreen',
    profile_version: '1.0.0',
    feature_version: 1,
    fallback: true,
    fallback_reason: 'kill_switch',
    replay_inputs: null,
    retain_until: retentionDeadline(timestampIso, 180),
  };
}

describe.skipIf(!DB_URL)('WS-I ranking Drizzle adapters (live Postgres)', () => {
  let db: ReturnType<typeof createDbClient>;
  let features: DrizzleFeatureStore;
  let decisions: DrizzleDecisionLogStore;
  const itemIds: string[] = [];
  const requestIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    features = new DrizzleFeatureStore(db);
    decisions = new DrizzleDecisionLogStore(db);
  });

  afterAll(async () => {
    const { rankingDecisionLogs, rankingFeatureVectors } = await import('@licio/db');
    const { inArray } = await import('drizzle-orm');
    if (itemIds.length > 0) {
      await db.delete(rankingFeatureVectors).where(inArray(rankingFeatureVectors.itemId, itemIds));
    }
    if (requestIds.length > 0) {
      await db
        .delete(rankingDecisionLogs)
        .where(inArray(rankingDecisionLogs.requestId, requestIds));
    }
  });

  it('appends monotonic revisions; the PK rejects stale writers; snapshots round-trip', async () => {
    const itemId = randomUUID();
    itemIds.push(itemId);
    const r0 = vectorOf(itemId, 0);
    expect((await features.upsert(r0))?.revision).toBe(0);
    expect((await features.upsert(vectorOf(itemId, 1)))?.revision).toBe(1);
    // Stale writer (revision 1 again) loses on the composite PK.
    expect(await features.upsert(vectorOf(itemId, 1))).toBeNull();
    // Exact snapshots, latest, and the WS-I.2.1c version map round-trip.
    const snapshot = await features.getRevision(itemId, 0);
    expect(snapshot?.invariant_versions['MFCI']?.config_hash).toBe('deadbeefcafef00d');
    expect((await features.getLatest(itemId))?.revision).toBe(1);
    const many = await features.getLatestMany([itemId, randomUUID()]);
    expect(many.size).toBe(1);
  });

  it('the denylist gate holds in front of SQL (no privileged write path)', async () => {
    const itemId = randomUUID();
    itemIds.push(itemId);
    await expect(
      features.upsert({
        ...vectorOf(itemId, 0),
        wallet_balance: 7,
      } as unknown as FeatureVector),
    ).rejects.toThrow(DeniedFinancialFieldError);
    expect(await features.getLatest(itemId)).toBeNull();
  });

  it('decision logs insert once, query on the audit dimensions, and sweep at retention', async () => {
    const now = Date.now();
    const requestId = randomUUID();
    requestIds.push(requestId);
    const log = logOf(requestId, new Date(now).toISOString());
    await decisions.insert(log);
    // Duplicate request id rejected (exactly one log per request).
    await expect(decisions.insert(log)).rejects.toThrow();
    expect((await decisions.getByRequestId(requestId))?.request_id).toBe(requestId);
    // The six audit dimensions (WS-I.2.5c).
    const byItem = await decisions.query({ itemId: log.candidate_ids[0] as string, limit: 10 });
    expect(byItem.logs.map((l) => l.request_id)).toContain(requestId);
    const byBucket = await decisions.query({ userPrivacyBucket: 'bucket:1f', limit: 10 });
    expect(byBucket.logs.map((l) => l.request_id)).toContain(requestId);
    const byInvariant = await decisions.query({
      invariantName: 'MFCI',
      invariantVersion: '1.0.0',
      limit: 10,
    });
    expect(byInvariant.logs.map((l) => l.request_id)).toContain(requestId);
    const byConstraint = await decisions.query({
      constraint: 'mfci_severe_cross_community',
      limit: 10,
    });
    expect(byConstraint.logs.map((l) => l.request_id)).toContain(requestId);
    const byExperiment = await decisions.query({ experimentId: 'exp-1', limit: 10 });
    expect(byExperiment.logs.map((l) => l.request_id)).toContain(requestId);
    const byTime = await decisions.query({
      fromIso: new Date(now - 60_000).toISOString(),
      toIso: new Date(now + 60_000).toISOString(),
      limit: 10,
    });
    expect(byTime.logs.map((l) => l.request_id)).toContain(requestId);
    // §22.4 sweep: past the deadline the row deletes.
    const removed = await decisions.sweepExpired(
      new Date(now + 181 * 24 * 3_600_000).toISOString(),
    );
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await decisions.getByRequestId(requestId)).toBeNull();
  });

  it('the privacy-bucket CHECK rejects raw identifiers at the storage layer', async () => {
    const { rankingDecisionLogs } = await import('@licio/db');
    const requestId = randomUUID();
    requestIds.push(requestId);
    await expect(
      db.insert(rankingDecisionLogs).values({
        requestId,
        surface: 'front_page',
        userPrivacyBucket: randomUUID(), // a raw id shape — must be rejected
        fallback: true,
        profileId: 'evergreen',
        profileVersion: '1.0.0',
        featureVersion: 1,
        payload: {},
        timestamp: new Date(),
        retainUntil: new Date(),
      }),
    ).rejects.toThrow();
  });
});
