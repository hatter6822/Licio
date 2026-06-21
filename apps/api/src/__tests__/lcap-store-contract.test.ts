// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.12.2 — the `LcapServerStore` contract, run against BOTH adapters: the
// in-memory adapter (always) verifies the contract locally, and the gated Drizzle
// adapter (DATABASE_URL) runs the SAME assertions against live Postgres + the real
// migration chain.  The store keys objects/acceptance/device-seq by opaque strings,
// so the contract needs no crypto — it exercises persistence semantics only.

import {
  createDbClient,
  lcapAcceptance,
  lcapDeviceSeq,
  lcapForkEvidence,
  lcapObjects,
  lcapRecordClosure,
  migrationsFolder,
} from '@licio/db';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleLcapServerStore } from '../lcap/drizzle-store.js';
import { InMemoryLcapServerStore, type LcapServerStore } from '../lcap/store.js';

const enc = new TextEncoder();
const DB_URL = process.env['DATABASE_URL'];
type Db = ReturnType<typeof createDbClient>;

function contract(makeStore: () => LcapServerStore): void {
  it('stores + reads objects idempotently, preserving kind + bytes', async () => {
    const store = makeStore();
    expect(await store.hasObject('o1')).toBe(false);
    expect(await store.getObject('o1')).toBeUndefined();
    await store.storeObject('o1', 'record', enc.encode('hello'));
    await store.storeObject('o1', 'record', enc.encode('ignored-second-write')); // idempotent
    expect(await store.hasObject('o1')).toBe(true);
    const got = await store.getObject('o1');
    expect(got?.kind).toBe('record');
    expect(got && new Uint8Array(got.bytes)).toEqual(enc.encode('hello'));
  });

  it('appends acceptance with a monotonic per-room seq + isAccepted/roomSize/roomSeqOf', async () => {
    const store = makeStore();
    expect(await store.isAccepted('a')).toBe(false);
    expect(await store.roomSize('r1')).toBe(0);
    expect(await store.appendAcceptance('r1', 'a')).toBe(0);
    expect(await store.appendAcceptance('r1', 'b')).toBe(1);
    expect(await store.appendAcceptance('r2', 'c')).toBe(0); // seq is per-room
    expect(await store.appendAcceptance('r1', 'a')).toBe(0); // idempotent: keeps the first seq
    expect(await store.isAccepted('a')).toBe(true);
    expect(await store.roomSize('r1')).toBe(2); // the re-append did NOT add a second leaf
    expect(await store.roomSeqOf('r1', 'b')).toBe(1);
    expect(await store.roomSeqOf('r1', 'absent')).toBeUndefined();
  });

  it('lists exactly the rooms that have accepted records (drives the sync frontier)', async () => {
    const store = makeStore();
    expect(await store.listRooms()).toEqual([]);
    await store.appendAcceptance('r1', 'a');
    await store.appendAcceptance('r1', 'b'); // same room counts once
    await store.appendAcceptance('r2', 'c');
    expect([...(await store.listRooms())].sort()).toEqual(['r1', 'r2']);
  });

  it('returns the room log in canonical acceptance order (the §19.1 Merkle leaves)', async () => {
    const store = makeStore();
    expect(await store.roomLog('r1')).toEqual([]);
    await store.appendAcceptance('r1', 'a');
    await store.appendAcceptance('r1', 'b');
    await store.appendAcceptance('r2', 'c');
    expect(await store.roomLog('r1')).toEqual(['a', 'b']); // order = seq, scoped per room
    expect(await store.roomLog('r2')).toEqual(['c']);
  });

  it('claims the first device-(key,seq) atomically and reports the winner to losers', async () => {
    const store = makeStore();
    expect(await store.getDeviceClaimant('k', 5)).toBeUndefined();
    expect(await store.claimDeviceSeq('k', 5, 'cidA')).toBe('cidA'); // first claimant wins
    expect(await store.claimDeviceSeq('k', 5, 'cidB')).toBe('cidA'); // loser learns the winner
    expect(await store.claimDeviceSeq('k', 5, 'cidA')).toBe('cidA'); // idempotent re-claim
    expect(await store.getDeviceClaimant('k', 5)).toBe('cidA');
    expect(await store.getDeviceClaimant('k', 6)).toBeUndefined();
  });

  it('allocates distinct, gap-free seqs under concurrent accepts — no phantom seq (#2)', async () => {
    const store = makeStore();
    const cids = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const seqs = await Promise.all(cids.map((cid) => store.appendAcceptance('rc', cid)));
    // Together the returned seqs are exactly 0..19 (distinct + gap-free), and EACH seq is the
    // cid's REAL position in the canonical log — never a phantom seq for an absent record.
    expect([...seqs].sort((a, b) => a - b)).toEqual(cids.map((_, i) => i));
    const log = await store.roomLog('rc');
    for (let i = 0; i < cids.length; i++) expect(log[seqs[i] as number]).toBe(cids[i]);
    expect(await store.roomSize('rc')).toBe(20);
  });

  it('admits exactly one winner under concurrent claims for one (key, seq) (#3)', async () => {
    const store = makeStore();
    const cids = Array.from({ length: 20 }, (_, i) => `d${i}`);
    const winners = await Promise.all(cids.map((cid) => store.claimDeviceSeq('kx', 9, cid)));
    // Every claim reports the SAME winner, and that winner is one of the contenders.
    const winner = winners[0] as string;
    expect(new Set(winners)).toEqual(new Set([winner]));
    expect(cids).toContain(winner);
    expect(await store.getDeviceClaimant('kx', 9)).toBe(winner);
  });

  it('indexes record→proof / record→block closure edges idempotently, scoped by relation', async () => {
    const store = makeStore();
    expect(await store.recordEdges('rec', 'proof')).toEqual([]);
    await store.indexRecordEdge('rec', 'proofA', 'proof');
    await store.indexRecordEdge('rec', 'proofA', 'proof'); // idempotent
    await store.indexRecordEdge('rec', 'blockA', 'block');
    await store.indexRecordEdge('rec', 'blockB', 'block');
    await store.indexRecordEdge('other', 'proofZ', 'proof');
    expect(await store.recordEdges('rec', 'proof')).toEqual(['proofA']);
    expect([...(await store.recordEdges('rec', 'block'))].sort()).toEqual(['blockA', 'blockB']);
    expect(await store.recordEdges('other', 'proof')).toEqual(['proofZ']);
    expect(await store.recordEdges('rec', 'proof')).not.toContain('proofZ');
  });

  it('appends + lists fork evidence in insertion order', async () => {
    const store = makeStore();
    expect(await store.listForkEvidence()).toEqual([]);
    await store.appendForkEvidence({
      authorDeviceKeyId: 'k',
      deviceSeq: 5,
      existingCid: 'x',
      conflictingCid: 'y',
    });
    await store.appendForkEvidence({
      authorDeviceKeyId: 'k',
      deviceSeq: 6,
      existingCid: 'p',
      conflictingCid: 'q',
    });
    expect(await store.listForkEvidence()).toEqual([
      { authorDeviceKeyId: 'k', deviceSeq: 5, existingCid: 'x', conflictingCid: 'y' },
      { authorDeviceKeyId: 'k', deviceSeq: 6, existingCid: 'p', conflictingCid: 'q' },
    ]);
  });
}

describe('InMemoryLcapServerStore (contract)', () => {
  contract(() => new InMemoryLcapServerStore());
});

describe.skipIf(!DB_URL)('DrizzleLcapServerStore (contract, live Postgres)', () => {
  let db: Db;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
  });

  afterAll(async () => {
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  beforeEach(async () => {
    // A clean slate per test (the contract's `makeStore` assumes an empty store).
    await db.delete(lcapForkEvidence);
    await db.delete(lcapDeviceSeq);
    await db.delete(lcapAcceptance);
    await db.delete(lcapObjects);
    await db.delete(lcapRecordClosure);
  });

  contract(() => new DrizzleLcapServerStore(db));
});
