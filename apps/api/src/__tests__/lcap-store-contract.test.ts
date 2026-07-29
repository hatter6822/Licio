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
  lcapCapabilityUsage,
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

  it('answers membership for MANY cids in one lookup, agreeing with hasObject', async () => {
    // `POST /exchange` resolves the client pulse's referenced CIDs — up to 4096
    // — into a `have` predicate.  Per-CID `hasObject` made that one round-trip
    // apiece: a single well-formed request from an unauthenticated peer driving
    // thousands of sequential queries, which is the amplifier the §27.1 cap
    // bounds the COUNT of.
    const store = makeStore();
    await store.storeObject('h1', 'record', enc.encode('one'));
    await store.storeObject('h2', 'record', enc.encode('two'));
    const held = await store.hasObjects(['h1', 'missing', 'h2', 'also-missing']);
    expect([...held].sort()).toEqual(['h1', 'h2']);
    // Row for row with the single-CID reader, which is what the route's
    // behaviour must be unchanged against.
    for (const cid of ['h1', 'h2', 'missing', 'also-missing']) {
      expect(held.has(cid)).toBe(await store.hasObject(cid));
    }
    // Duplicates collapse rather than double-count, and an empty ask is not a
    // query at all.
    expect([...(await store.hasObjects(['h1', 'h1', 'h1']))]).toEqual(['h1']);
    expect((await store.hasObjects([])).size).toBe(0);
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

  it('accepts contributions within the capability quotas and rejects over-budget ones (§18.3 step 9)', async () => {
    const store = makeStore();
    const quota = { capabilityId: 'cap-A', maxEvents: 2, maxTotalBytes: 100, maxMediaBytes: 0 };
    expect(await store.acceptContribution('room', 'e0', 40, 0, quota)).toEqual({
      ok: true,
      seq: 0,
    });
    expect(await store.acceptContribution('room', 'e1', 40, 0, quota)).toEqual({
      ok: true,
      seq: 1,
    });
    // A third event exceeds max_offline_events (2) → rejected, not appended.
    expect(await store.acceptContribution('room', 'e2', 10, 0, quota)).toEqual({
      ok: false,
      reason: 'offline_event_quota',
    });
    expect(await store.roomSize('room')).toBe(2);
    expect(await store.isAccepted('e2')).toBe(false);
  });

  it('rejects a contribution that would exceed max_total_payload_bytes', async () => {
    const store = makeStore();
    const quota = { capabilityId: 'cap-B', maxEvents: 10, maxTotalBytes: 100, maxMediaBytes: 0 };
    expect(await store.acceptContribution('room', 'e0', 60, 0, quota)).toEqual({
      ok: true,
      seq: 0,
    });
    // 60 + 50 = 110 > 100 → the total-payload quota.
    expect(await store.acceptContribution('room', 'e1', 50, 0, quota)).toEqual({
      ok: false,
      reason: 'total_payload_quota',
    });
    // A smaller event still fits (60 + 40 = 100 ≤ 100).
    expect(await store.acceptContribution('room', 'e2', 40, 0, quota)).toEqual({
      ok: true,
      seq: 1,
    });
  });

  it('rejects a contribution that would exceed max_media_bytes (§18.3 step 9)', async () => {
    const store = makeStore();
    const quota = {
      capabilityId: 'cap-M',
      maxEvents: 10,
      maxTotalBytes: 1_000_000,
      maxMediaBytes: 100,
    };
    // The event body fits; the referenced-media charge is the second positional cost.
    expect(await store.acceptContribution('room', 'm0', 5, 60, quota)).toEqual({
      ok: true,
      seq: 0,
    });
    // 60 + 50 = 110 > 100 media → the media quota (the event-payload budget is untouched).
    expect(await store.acceptContribution('room', 'm1', 5, 50, quota)).toEqual({
      ok: false,
      reason: 'media_payload_quota',
    });
    expect(await store.isAccepted('m1')).toBe(false);
    // A smaller media charge still fits (60 + 40 = 100 ≤ 100).
    expect(await store.acceptContribution('room', 'm2', 5, 40, quota)).toEqual({
      ok: true,
      seq: 1,
    });
    expect(await store.roomSize('room')).toBe(2);
  });

  it('debits the event, payload, and media budgets independently', async () => {
    const store = makeStore();
    // A roomy event/payload budget but a tight media budget — only the media quota bites.
    const quota = {
      capabilityId: 'cap-MX',
      maxEvents: 10,
      maxTotalBytes: 1_000_000,
      maxMediaBytes: 30,
    };
    expect(await store.acceptContribution('rx', 'x0', 500, 20, quota)).toEqual({
      ok: true,
      seq: 0,
    });
    // 20 + 20 = 40 > 30 media, even though events (2 ≤ 10) and payload (1000 ≤ 1e6) are fine.
    expect(await store.acceptContribution('rx', 'x1', 500, 20, quota)).toEqual({
      ok: false,
      reason: 'media_payload_quota',
    });
    // A zero-media event still posts (the media budget is not consumed by text-only events).
    expect(await store.acceptContribution('rx', 'x2', 500, 0, quota)).toEqual({ ok: true, seq: 1 });
  });

  it('re-accepting a record is idempotent and never re-debits the capability budget', async () => {
    const store = makeStore();
    const quota = { capabilityId: 'cap-C', maxEvents: 1, maxTotalBytes: 1000, maxMediaBytes: 100 };
    expect(await store.acceptContribution('room', 'e0', 100, 50, quota)).toEqual({
      ok: true,
      seq: 0,
    });
    // Re-accept the SAME record: idempotent (same seq), and it must NOT consume the budget twice.
    expect(await store.acceptContribution('room', 'e0', 100, 50, quota)).toEqual({
      ok: true,
      seq: 0,
    });
    // A DIFFERENT record now exceeds maxEvents=1 — proving the budget was debited exactly once.
    expect(await store.acceptContribution('room', 'e1', 100, 0, quota)).toEqual({
      ok: false,
      reason: 'offline_event_quota',
    });
    expect(await store.roomSize('room')).toBe(1);
  });

  it('re-accepting a record never re-debits the media budget either', async () => {
    const store = makeStore();
    // Media budget allows exactly one 50-byte charge; a re-accept must not exhaust it.
    const quota = {
      capabilityId: 'cap-MI',
      maxEvents: 10,
      maxTotalBytes: 1_000_000,
      maxMediaBytes: 60,
    };
    expect(await store.acceptContribution('rmi', 'i0', 1, 50, quota)).toEqual({ ok: true, seq: 0 });
    expect(await store.acceptContribution('rmi', 'i0', 1, 50, quota)).toEqual({ ok: true, seq: 0 });
    // 50 (debited once) + 20 = 70 > 60 confirms the re-accept did not re-debit (else it would be 100).
    expect(await store.acceptContribution('rmi', 'i1', 1, 20, quota)).toEqual({
      ok: false,
      reason: 'media_payload_quota',
    });
    // …but a 10-byte charge fits (50 + 10 = 60 ≤ 60), proving exactly 50 was debited.
    expect(await store.acceptContribution('rmi', 'i2', 1, 10, quota)).toEqual({ ok: true, seq: 1 });
  });

  it('enforces max_offline_events under concurrent accepts — never over budget', async () => {
    const store = makeStore();
    const quota = {
      capabilityId: 'cap-D',
      maxEvents: 5,
      maxTotalBytes: 1_000_000,
      maxMediaBytes: 1_000_000,
    };
    const cids = Array.from({ length: 20 }, (_, i) => `cc${i}`);
    const results = await Promise.all(
      cids.map((cid) => store.acceptContribution('roomD', cid, 10, 0, quota)),
    );
    const acceptedSeqs = results.flatMap((r) => (r.ok ? [r.seq] : []));
    // Exactly maxEvents accepted, with distinct gap-free seqs; the rest fail the event quota.
    expect([...acceptedSeqs].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    for (const r of results) if (!r.ok) expect(r.reason).toBe('offline_event_quota');
    expect(await store.roomSize('roomD')).toBe(5);
  });

  it('enforces max_media_bytes under concurrent accepts — never over budget', async () => {
    const store = makeStore();
    // Budget for exactly 5 × 10-byte media charges; 20 concurrent accepts must not exceed it.
    const quota = {
      capabilityId: 'cap-DM',
      maxEvents: 1_000_000,
      maxTotalBytes: 1_000_000,
      maxMediaBytes: 50,
    };
    const cids = Array.from({ length: 20 }, (_, i) => `dm${i}`);
    const results = await Promise.all(
      cids.map((cid) => store.acceptContribution('roomDM', cid, 1, 10, quota)),
    );
    const acceptedSeqs = results.flatMap((r) => (r.ok ? [r.seq] : []));
    expect([...acceptedSeqs].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    for (const r of results) if (!r.ok) expect(r.reason).toBe('media_payload_quota');
    expect(await store.roomSize('roomDM')).toBe(5);
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
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
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
    await db.delete(lcapCapabilityUsage);
    await db.delete(lcapObjects);
    await db.delete(lcapRecordClosure);
  });

  contract(() => new DrizzleLcapServerStore(db));
});
