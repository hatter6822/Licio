// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.11 audit — server-blind rendezvous privacy (PRIVATE_SPEC §15.3, §15.3.1,
// §15.3.2, §21.5, §27.2).  `private-rendezvous.test.ts` already proves the
// FUNCTIONAL contract (TTL reject-not-clamp, the no-existence-oracle poll, the
// signal round-trip, aggregate-only metrics, the route-level shape/size bounds,
// and the CSRF-exempt full-app mount).  This suite is the PRIVACY AUDIT layered
// on top: it asserts the structural guarantees those tests assume —
//
//   • the server stores ONLY opaque data — a blind id, ciphertext, and a TTL — so
//     a stored record/signal exposes NO IP, account, member, room id, or CID;
//   • the wire schemas are `.strict()`, so a client cannot smuggle an IP/account
//     field onto a record (an unknown key is rejected, not silently stored);
//   • the §8.2 allowlist for `private_rendezvous_records` carries no IP/account/
//     room-linking column (the structural backstop of the above);
//   • the TTL is upper-bounded (the §15.3.2 auto-expiry the server can't defeat);
//   • §15.4 signals are TRANSIENT — drained once and gone, never durable.
//
// New cases here (NOT in the functional suite): the stored-shape opacity audit,
// the strict-schema "no IP/account smuggling" assertion, the §8.2 allowlist
// privacy check, and the GATED live-Postgres assertion that the persisted row
// carries no IP/account column and that signals never reach Postgres.
import { PRIVATE_RENDEZVOUS_ALLOWED_COLUMNS } from '@licio/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RENDEZVOUS_CONFIG, RendezvousService } from '../private-rendezvous/service.js';
import {
  announceRequestSchema,
  InMemoryRendezvousStore,
  type StoredRendezvousRecord,
  signalRequestSchema,
} from '../private-rendezvous/stores.js';

const ROOM_BLIND = 'cm9vbS1ibGluZA';
const PEER_BLIND = 'cGVlci1ibGluZA';
const PEER_BLIND_2 = 'cGVlci1ibGluZC0y';
const ANNOUNCEMENT = 'c2VhbGVkLWFubm91bmNlbWVudA';

function announceBody(over: Record<string, unknown> = {}) {
  return {
    room_blind_id: ROOM_BLIND,
    peer_blind_id: PEER_BLIND,
    encrypted_announcement: ANNOUNCEMENT,
    expires_at: Date.now() + 10 * 60_000,
    ...over,
  };
}

/** Identity-revealing TOKENS (a real IP / account / room linkage).  Matched at
 *  the `_`-delimited TOKEN level so a substring like the "ip" inside `ciphertext`
 *  or the "cid" inside `recipient` is NOT a false positive — only a genuine
 *  `client_ip` / `account_id` / `room_id` token trips the audit. */
const IDENTITY_LEAK_TOKENS = new Set([
  'ip',
  'addr',
  'address',
  'account',
  'user',
  'userid',
  'session',
  'member',
  'device',
  'cid',
  'geo',
  'location',
  'agent',
]);

/** Full field names that are unambiguously identity-linking (a raw room id). */
const IDENTITY_LEAK_NAMES = new Set(['room_id', 'room_server_id', 'roomid', 'roomserverid']);

function leaksIdentity(name: string): boolean {
  const lower = name.toLowerCase();
  // A BLIND id (a `room_blind_id` / `peer_blind_id` / `sender_blind_id`) is the
  // opaque, un-linkable handle the §15.3 design permits — not a raw identity.
  if (lower.endsWith('_blind_id') || lower.endsWith('blindid')) return false;
  if (IDENTITY_LEAK_NAMES.has(lower)) return true;
  return lower.split(/[_]+/).some((token) => IDENTITY_LEAK_TOKENS.has(token));
}

describe('WS-S.11 — stored-record opacity (§15.3.1)', () => {
  it('a polled record exposes ONLY a blind id + ciphertext + TTL (no IP/account/room)', async () => {
    const svc = new RendezvousService(new InMemoryRendezvousStore());
    await svc.announce(announceBody());
    const { records } = await svc.poll(ROOM_BLIND);
    expect(records).toHaveLength(1);
    const record = records[0];
    if (!record) throw new Error('expected a record');
    // EXACT key set — nothing else may be returned.
    expect(Object.keys(record).sort()).toStrictEqual([
      'encrypted_announcement',
      'expires_at',
      'peer_blind_id',
    ]);
    // The room blind id is the poll KEY, not echoed in the record (un-linkable).
    expect(Object.keys(record)).not.toContain('room_blind_id');
    for (const key of Object.keys(record)) {
      expect(leaksIdentity(key), `record key "${key}" must not leak identity`).toBe(false);
    }
  });

  it('a drained signal exposes ONLY blind ids + ciphertext + TTL', async () => {
    const svc = new RendezvousService(new InMemoryRendezvousStore());
    await svc.signal({
      room_blind_id: ROOM_BLIND,
      sender_blind_id: PEER_BLIND,
      recipient_blind_id: PEER_BLIND_2,
      ciphertext: 'c2lnbmFs',
      expires_at: Date.now() + 60_000,
    });
    const { signals } = await svc.drainSignals(PEER_BLIND_2);
    expect(signals).toHaveLength(1);
    const signal = signals[0];
    if (!signal) throw new Error('expected a signal');
    expect(Object.keys(signal).sort()).toStrictEqual([
      'ciphertext',
      'expires_at',
      'room_blind_id',
      'sender_blind_id',
    ]);
    for (const key of Object.keys(signal)) {
      expect(leaksIdentity(key), `signal key "${key}" must not leak identity`).toBe(false);
    }
  });
});

describe('WS-S.11 — the wire schema cannot smuggle an identity field (.strict)', () => {
  it('rejects an announce body carrying an IP / account field (no silent store)', () => {
    for (const extra of ['ip', 'client_ip', 'account_id', 'user_id', 'room_id', 'member_id']) {
      const parsed = announceRequestSchema.safeParse(announceBody({ [extra]: 'leak' }));
      expect(parsed.success, `extra field "${extra}" must be rejected`).toBe(false);
    }
  });

  it('rejects a signal body carrying an identity field', () => {
    const base = {
      room_blind_id: ROOM_BLIND,
      sender_blind_id: PEER_BLIND,
      recipient_blind_id: PEER_BLIND_2,
      ciphertext: 'c2ln',
      expires_at: Date.now() + 60_000,
    };
    for (const extra of ['ip', 'account_id', 'session_id']) {
      const parsed = signalRequestSchema.safeParse({ ...base, [extra]: 'leak' });
      expect(parsed.success, `extra field "${extra}" must be rejected`).toBe(false);
    }
  });

  it('the accepted announce wire fields are exactly the opaque set', () => {
    const parsed = announceRequestSchema.parse(announceBody());
    expect(Object.keys(parsed).sort()).toStrictEqual([
      'encrypted_announcement',
      'expires_at',
      'peer_blind_id',
      'room_blind_id',
    ]);
  });
});

describe('WS-S.11 — the §8.2 server-table allowlist carries no identity column', () => {
  it('PRIVATE_RENDEZVOUS_ALLOWED_COLUMNS contains no IP/account/room-linking name', () => {
    for (const col of PRIVATE_RENDEZVOUS_ALLOWED_COLUMNS) {
      expect(leaksIdentity(col), `allowed column "${col}" must not leak identity`).toBe(false);
    }
    // Positive shape: only the opaque presence columns are permitted.
    expect([...PRIVATE_RENDEZVOUS_ALLOWED_COLUMNS].sort()).toStrictEqual([
      'created_at',
      'encrypted_announcement',
      'expires_at',
      'peer_blind_id',
      'rendezvous_id',
      'room_blind_id',
    ]);
  });
});

describe('WS-S.11 — TTL upper bound + signal transience', () => {
  it('rejects a record whose TTL exceeds the server retention bound (auto-expiry, §15.3.2)', async () => {
    const clock = 2_000_000;
    const svc = new RendezvousService(
      new InMemoryRendezvousStore(),
      DEFAULT_RENDEZVOUS_CONFIG,
      () => clock,
    );
    const overBound =
      clock +
      DEFAULT_RENDEZVOUS_CONFIG.maxTtlMs +
      DEFAULT_RENDEZVOUS_CONFIG.clockSkewToleranceMs +
      1;
    expect((await svc.announce(announceBody({ expires_at: overBound }))).stored).toBe(false);
    // The exact ceiling is accepted (the bound is inclusive of maxTtl + skew).
    const atCeiling =
      clock + DEFAULT_RENDEZVOUS_CONFIG.maxTtlMs + DEFAULT_RENDEZVOUS_CONFIG.clockSkewToleranceMs;
    expect((await svc.announce(announceBody({ expires_at: atCeiling }))).stored).toBe(true);
    // The accepted record is stored VERBATIM (not clamped — it is AAD-bound).
    expect((await svc.poll(ROOM_BLIND)).records[0]?.expires_at).toBe(atCeiling);
  });

  it('a §15.4 signal is transient — drained exactly once, then gone', async () => {
    const svc = new RendezvousService(new InMemoryRendezvousStore());
    await svc.signal({
      room_blind_id: ROOM_BLIND,
      sender_blind_id: PEER_BLIND,
      recipient_blind_id: PEER_BLIND_2,
      ciphertext: 'c2ln',
      expires_at: Date.now() + 60_000,
    });
    expect((await svc.drainSignals(PEER_BLIND_2)).signals).toHaveLength(1);
    expect((await svc.drainSignals(PEER_BLIND_2)).signals).toHaveLength(0);
  });

  it('metrics are aggregate-only — the snapshot carries NO room/peer identity', async () => {
    const svc = new RendezvousService(new InMemoryRendezvousStore());
    await svc.announce(announceBody());
    await svc.poll(ROOM_BLIND);
    const metrics = svc.metrics();
    // Only numeric aggregate counters; every key is an opaque counter name.
    for (const [key, value] of Object.entries(metrics)) {
      expect(typeof value).toBe('number');
      expect(leaksIdentity(key), `metric key "${key}" must not leak identity`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// GATED — the persisted Postgres row carries no identity; signals never persist.
// ---------------------------------------------------------------------------

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)(
  'WS-S.11 — persisted rendezvous row is identity-free (live Postgres)',
  () => {
    let db: Awaited<ReturnType<typeof import('@licio/db')['createDbClient']>>;
    const usedRoomBlinds: string[] = [];

    beforeAll(async () => {
      const { createDbClient, migrationsFolder } = await import('@licio/db');
      const { migrate } = await import('drizzle-orm/postgres-js/migrator');
      db = createDbClient(DB_URL as string);
      await migrate(db, { migrationsFolder: migrationsFolder() });
    });

    afterAll(async () => {
      if (!db) return;
      const { privateRendezvousRecords } = await import('@licio/db');
      const { inArray } = await import('drizzle-orm');
      if (usedRoomBlinds.length > 0) {
        await db
          .delete(privateRendezvousRecords)
          .where(inArray(privateRendezvousRecords.roomBlindId, usedRoomBlinds));
      }
      const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
      await client.end();
    });

    it('a persisted presence row exposes only opaque columns; signals are NOT persisted', async () => {
      const { DrizzleRendezvousStore } = await import('../private-rendezvous/drizzle-store.js');
      const { privateRendezvousRecords } = await import('@licio/db');
      const { eq } = await import('drizzle-orm');
      const store = new DrizzleRendezvousStore(db);

      const roomBlind = `audit-room-${Date.now().toString(36)}`;
      usedRoomBlinds.push(roomBlind);
      const now = Date.now();
      const record: StoredRendezvousRecord = {
        roomBlindId: roomBlind,
        peerBlindId: 'audit-peer',
        encryptedAnnouncement: 'opaque-ciphertext',
        expiresAt: now + 5 * 60_000,
      };
      await store.announce(record);

      // The raw persisted row: every column name is opaque (no IP/account), and
      // the only payload columns are the blind ids + ciphertext + the expiry.
      const rows = await db
        .select()
        .from(privateRendezvousRecords)
        .where(eq(privateRendezvousRecords.roomBlindId, roomBlind));
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error('expected a persisted row');
      for (const key of Object.keys(row)) {
        expect(leaksIdentity(key), `persisted column "${key}" must not leak identity`).toBe(false);
      }
      expect((row as { encryptedAnnouncement: string }).encryptedAnnouncement).toBe(
        'opaque-ciphertext',
      );

      // §15.4 signals are TRANSIENT: a queued signal lives in the in-memory mailbox,
      // never the durable table — so it drains once and the table holds only presence.
      await store.putSignal({
        roomBlindId: roomBlind,
        senderBlindId: 'audit-peer',
        recipientBlindId: 'audit-peer-2',
        ciphertext: 'sig',
        expiresAt: now + 60_000,
      });
      const drained = await store.drainSignals('audit-peer-2', now, 256);
      expect(drained).toHaveLength(1);
      expect(await store.drainSignals('audit-peer-2', now, 256)).toHaveLength(0);
      // The presence table is unchanged by the signal traffic (signals are not persisted).
      const stillOne = await db
        .select()
        .from(privateRendezvousRecords)
        .where(eq(privateRendezvousRecords.roomBlindId, roomBlind));
      expect(stillOne).toHaveLength(1);
    });
  },
);
