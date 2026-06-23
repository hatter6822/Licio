// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gate-19 (WS-R.15.7) — the GATED Postgres test for the takedown oracle's REAL DB binding:
// the `DrizzleBlockProvenanceStore` (the `lcap_block_provenance` linkage, migration 0046)
// joined to live `takedown_requests` rows through `DrizzleTakedownStatusReader`.  Runs only
// when DATABASE_URL is set (CI provisions Postgres); otherwise it skips.  The assertions
// mirror the in-memory unit suite but exercise the actual SQL join + the migration chain.

import { createDbClient, lcapBlockProvenance, migrationsFolder, takedownRequests } from '@licio/db';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DrizzleBlockProvenanceStore,
  DrizzleTakedownStatusReader,
  makeTakedownOracle,
} from '../takedown-oracle.js';

const DB_URL = process.env['DATABASE_URL'];
type Db = ReturnType<typeof createDbClient>;

// Valid uuids — `takedown_requests.target_id` is a uuid column, so the provenance text id
// must be a valid uuid string for the join to bind (the real content-entity ids are uuids).
const STORY_ID = '11111111-1111-1111-1111-111111111111';
const SOURCE_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_STORY_ID = '33333333-3333-3333-3333-333333333333';

describe.skipIf(!DB_URL)('Gate-19 — DrizzleTakedownOracle over live Postgres', () => {
  let db: Db;
  // A distinct block CID prefix per test run avoids cross-row interference within the table.
  let nonce = 0;
  const blockCid = (label: string): string => `lcapb_test_${label}_${nonce}`;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
  });

  afterAll(async () => {
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  beforeEach(async () => {
    nonce += 1;
    await db.delete(lcapBlockProvenance);
    await db.delete(takedownRequests);
  });

  function oracle() {
    return makeTakedownOracle(
      new DrizzleBlockProvenanceStore(db),
      new DrizzleTakedownStatusReader(db),
    );
  }

  /** Insert a takedown row at the given status (the public-intake shape). */
  async function insertTakedown(
    targetType: 'story' | 'source' | 'evidence',
    targetId: string,
    status: 'received' | 'under_review' | 'actioned' | 'rejected',
  ): Promise<void> {
    await db.insert(takedownRequests).values({
      targetType,
      targetId,
      requesterContact: 'rights@example.test',
      legalBasis: 'copyright',
      claimDetail: 'a sufficiently long claim detail for the CHECK constraint',
      status,
    });
  }

  it('records the linkage idempotently and resolves a block to its targets', async () => {
    const store = new DrizzleBlockProvenanceStore(db);
    const cid = blockCid('linkage');
    await store.link(cid, { targetType: 'story', targetId: STORY_ID });
    await store.link(cid, { targetType: 'story', targetId: STORY_ID }); // idempotent (PK)
    expect(await store.targetsOf(cid)).toEqual([{ targetType: 'story', targetId: STORY_ID }]);
  });

  it('an ACTIONED takedown over the linked story HALTS; absence ALLOWS', async () => {
    const cid = blockCid('actioned');
    await new DrizzleBlockProvenanceStore(db).link(cid, {
      targetType: 'story',
      targetId: STORY_ID,
    });
    // No takedown yet → not halted.
    expect(await oracle()(cid)).toBe(false);
    // A received/under_review/rejected takedown does NOT halt (only `actioned` is in force).
    await insertTakedown('story', STORY_ID, 'received');
    await insertTakedown('story', STORY_ID, 'rejected');
    expect(await oracle()(cid)).toBe(false);
    // The story is actioned → HALT.
    await insertTakedown('story', STORY_ID, 'actioned');
    expect(await oracle()(cid)).toBe(true);
  });

  it('an UNKNOWN block (no provenance) is not halted even with an actioned takedown', async () => {
    await insertTakedown('story', STORY_ID, 'actioned');
    expect(await oracle()(blockCid('unknown'))).toBe(false);
  });

  it('HALTS when ANY of a block’s multiple targets is actioned (union over types)', async () => {
    const cid = blockCid('multi');
    const store = new DrizzleBlockProvenanceStore(db);
    await store.link(cid, { targetType: 'story', targetId: STORY_ID });
    await store.link(cid, { targetType: 'source', targetId: SOURCE_ID });
    expect(await oracle()(cid)).toBe(false);
    // Only the SOURCE is actioned — the block still halts (it derives from both).
    await insertTakedown('source', SOURCE_ID, 'actioned');
    expect(await oracle()(cid)).toBe(true);
  });

  it('an actioned takedown over a DIFFERENT entity does not halt (precise targeting)', async () => {
    const cid = blockCid('precise');
    await new DrizzleBlockProvenanceStore(db).link(cid, {
      targetType: 'story',
      targetId: STORY_ID,
    });
    await insertTakedown('story', OTHER_STORY_ID, 'actioned'); // a different story
    expect(await oracle()(cid)).toBe(false);
  });
});
