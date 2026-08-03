// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.2b — the GATED live-Postgres contract for the directory-stub store
// (PRIVATE_SPEC §21.1–§21.4, §8.2).  `private-rooms-stub.test.ts` proves the
// service semantics against the in-memory adapter; this proves the Drizzle
// adapter honours the SAME contract against a real database — which is the only
// place four of the guarantees actually live:
//
//   • the four §4.1 axes are written TOGETHER, so the `rooms_*` coherence CHECKs
//     accept the row (a partial write would be rejected by the database, not by
//     the call site);
//   • the `private_room_stubs_listed_display_only` CHECK holds through a delist
//     (demotion + metadata drop must be ONE statement);
//   • DELETE removes the shell as well as the stub, so no row survives asserting
//     that an account created a private room at time T;
//   • the persisted row carries no §8.1 column — the structural backstop.
//
// Skips without DATABASE_URL, like every other gated suite.  Cleanup is by the
// ids THIS run created (never a prefix), so a parallel run is unaffected.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrivateRoomStubStore } from '../private-rooms/stores.js';

const DB_URL = process.env['DATABASE_URL'];

/** A base64url-safe commitment fixture. */
/** 32 bytes base64url — the exact shape a commitment/public key/blind id has. */
const COMMITMENT = 'HxxbL613hDQCTxU3mGNGknkX9HVabn0_2R8iZTt8MTI';
/** 64 bytes base64url — an Ed25519 signature. */
const SIGNATURE =
  'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ';
const TOKEN = 'PEaenWxYddN6Q_NT1PiOYfz4EsZu7jRXRlpAsNpBU-A';

describe.skipIf(!DB_URL)('DrizzlePrivateRoomStubStore — live Postgres contract', () => {
  let db: Awaited<ReturnType<typeof import('@licio/db')['createDbClient']>>;
  let store: PrivateRoomStubStore;
  const createdRooms: string[] = [];

  const newRoomId = (): string => {
    const id = crypto.randomUUID();
    createdRooms.push(id);
    return id;
  };

  beforeAll(async () => {
    const { createDbClient, migrationsFolder } = await import('@licio/db');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const { DrizzlePrivateRoomStubStore } = await import('../private-rooms/drizzle-store.js');
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    store = new DrizzlePrivateRoomStubStore(db);
  });

  afterAll(async () => {
    if (!db) return;
    const { rooms } = await import('@licio/db');
    const { inArray } = await import('drizzle-orm');
    // By the ids THIS run created — never a prefix, which would reach into a
    // concurrent run's rows.  The stub cascades with its room.
    if (createdRooms.length > 0) {
      await db.delete(rooms).where(inArray(rooms.roomId, createdRooms));
    }
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  async function createListed(roomServerId: string) {
    return await store.create({
      stubId: crypto.randomUUID(),
      roomServerId,
      directoryMode: 'listed',
      displayName: 'Gated listed room',
      displayDescription: 'A description',
      displayAvatarPublicCid: 'bafkreiabc123',
      rendezvousPolicy: 'licio_blind',
      bootstrapHints: [{ kind: 'manual', value: 'paste-me' }],
      signedStub: {
        schema: 'licio.private.directory_stub.v2',
        room_public_key: COMMITMENT,
        manifest_key_commitment: COMMITMENT,
      },
      stubSignature: SIGNATURE,
      bootstrapBlindId: TOKEN,
      createdByAccountId: null,
    });
  }

  it('writes the four §4.1 axes together, so the coherence CHECKs accept the shell', async () => {
    const roomId = newRoomId();
    const stub = await createListed(roomId);
    expect(stub.roomServerId).toBe(roomId);

    const { rooms } = await import('@licio/db');
    const { eq } = await import('drizzle-orm');
    const [row] = await db.select().from(rooms).where(eq(rooms.roomId, roomId)).limit(1);
    expect(row).toBeDefined();
    expect(row?.storageMode).toBe('p2p');
    expect(row?.authorityModel).toBe('room_keys');
    expect(row?.visibility).toBe('private');
    expect(row?.joinModel).toBe('invite');
    expect(row?.directoryMode).toBe('listed');
    // The shell's identity is OPAQUE — a private room's real title must never
    // reach the generated `search_vector`.
    expect(row?.name).not.toContain('Gated listed room');
  });

  it('round-trips the stub, including the jsonb bootstrap hints and signed stub', async () => {
    const roomId = newRoomId();
    await createListed(roomId);
    const read = await store.getByRoomId(roomId);
    expect(read?.displayName).toBe('Gated listed room');
    expect(read?.bootstrapHints).toEqual([{ kind: 'manual', value: 'paste-me' }]);
    expect(read?.signedStub).toEqual({
      schema: 'licio.private.directory_stub.v2',
      room_public_key: COMMITMENT,
      manifest_key_commitment: COMMITMENT,
    });
    // The capability is its OWN column, never inside the projected body.
    expect(read?.bootstrapBlindId).toBe(TOKEN);
    // …and the commitment columns are DERIVED from that body, not sent beside it.
    expect(read?.roomPublicKey).toBe(COMMITMENT);
    expect(read?.manifestKeyCommitment).toBe(COMMITMENT);
    expect(read?.latestManifestCommitment).toBe(null);
  });

  it('applies a patch and leaves everything else alone', async () => {
    const roomId = newRoomId();
    await createListed(roomId);
    const updated = await store.update(roomId, {
      latestManifestCommitment: 'Muh7CwUy5QuoJ8Hj5dzRVLOgJxwBRE-fnw7RkinJrAE',
      rendezvousPolicy: 'manual_only',
    });
    expect(updated?.latestManifestCommitment).toBe('Muh7CwUy5QuoJ8Hj5dzRVLOgJxwBRE-fnw7RkinJrAE');
    expect(updated?.rendezvousPolicy).toBe('manual_only');
    expect(updated?.displayName).toBe('Gated listed room');
  });

  it('delists in ONE statement — the listed-display-only CHECK never sees a half state', async () => {
    const roomId = newRoomId();
    await createListed(roomId);
    const delisted = await store.delist(roomId);
    expect(delisted?.directoryMode).toBe('unlisted');
    expect(delisted?.displayName).toBe(null);
    expect(delisted?.displayDescription).toBe(null);
    expect(delisted?.displayAvatarPublicCid).toBe(null);

    // The room shell follows the stub's mode.
    const { rooms } = await import('@licio/db');
    const { eq } = await import('drizzle-orm');
    const [row] = await db.select().from(rooms).where(eq(rooms.roomId, roomId)).limit(1);
    expect(row?.directoryMode).toBe('unlisted');
  });

  it('DELETE removes the shell too — no row survives saying a private room existed', async () => {
    const roomId = newRoomId();
    await createListed(roomId);
    expect(await store.remove(roomId)).toBe(true);
    expect(await store.getByRoomId(roomId)).toBe(null);

    const { privateRoomStubs, rooms } = await import('@licio/db');
    const { eq } = await import('drizzle-orm');
    const roomRows = await db.select().from(rooms).where(eq(rooms.roomId, roomId));
    const stubRows = await db
      .select()
      .from(privateRoomStubs)
      .where(eq(privateRoomStubs.roomServerId, roomId));
    expect(roomRows).toHaveLength(0);
    expect(stubRows).toHaveLength(0);
    // Removing twice is a false, not a crash.
    expect(await store.remove(roomId)).toBe(false);
  });

  it('rejects an incoherent P2P shell at the DATABASE, not just at the call site', async () => {
    const { rooms } = await import('@licio/db');
    // `storage_mode='p2p'` with `authority_model='platform'` violates
    // `rooms_storage_authority_coherence`.  The point of the test is that the
    // guarantee does not depend on the store remembering to set the axis.
    await expect(
      db.insert(rooms).values({
        roomId: crypto.randomUUID(),
        name: `incoherent-${crypto.randomUUID()}`,
        slug: `incoherent-${crypto.randomUUID()}`,
        description: null,
        roomType: 'global_topic',
        visibility: 'private',
        joinModel: 'invite',
        postingPolicy: 'all_members',
        storageMode: 'p2p',
        authorityModel: 'platform',
        directoryMode: 'listed',
        createdBy: null,
        governanceMode: 'ordinary',
        charterSummary: null,
        typeMetadata: {},
        latestActivityAt: null,
      }),
    ).rejects.toThrow();
  });

  it('persists no §8.1 column on the stub table', async () => {
    const { PRIVATE_ROOM_STUB_ALLOWED_COLUMNS } = await import('@licio/db');
    const forbidden = ['story', 'thread', 'contribution', 'member', 'op_head', 'private_cid'];
    for (const column of PRIVATE_ROOM_STUB_ALLOWED_COLUMNS) {
      for (const segment of forbidden) {
        expect(column.includes(segment), `${column} contains ${segment}`).toBe(false);
      }
    }
  });
});
