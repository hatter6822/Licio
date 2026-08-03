// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.2 / §21.1–§21.4 — the gated Postgres adapter for the directory-stub
// store, behind the same `PrivateRoomStubStore` interface the in-memory adapter
// satisfies.  Only the §8.2-allowed columns of `private_room_stubs` are written;
// the `rooms` shell carries the four coherent §4.1 P2P axes and NOTHING that
// describes the room's contents.
//
// The room shell's `name`/`slug` are DELIBERATELY opaque, for both directory
// modes.  They are NOT NULL columns feeding a generated `search_vector`, so
// writing a real title there would put a private room's name into the server's
// full-text index — the exact leak §8.1 forbids — and for an `unlisted` room it
// would defeat the mode outright.  A `listed` room's display metadata lives
// where §8.2 puts it: on the stub, read through `GET /bootstrap`, never through
// a server room surface.
//
// Every write is Drizzle's parameterized builder (no string-SQL), and the shell
// + stub are one transaction: a shell without a stub is an orphan the directory
// can neither reach nor clean up.
import { type DbExecutor, privateRoomStubs, rooms } from '@licio/db';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import type {
  BootstrapHint,
  PrivateRoomStubInsertInput,
  PrivateRoomStubPatch,
  PrivateRoomStubStore,
  RendezvousPolicy,
  StoredPrivateRoomStub,
} from './stores.js';

/** The opaque shell name/slug for a P2P room (§8.1 — never the real title). */
function shellIdentity(roomServerId: string): { name: string; slug: string } {
  return { name: `Private room ${roomServerId}`, slug: `p2p-${roomServerId}` };
}

type StubRow = typeof privateRoomStubs.$inferSelect;

function toStub(row: StubRow): StoredPrivateRoomStub {
  return {
    stubId: row.stubId,
    roomServerId: row.roomServerId,
    // The `private_room_stubs_not_detached` CHECK makes `detached` unreachable
    // on a stored row, so narrowing here cannot lose a real value.
    directoryMode: row.directoryMode === 'listed' ? 'listed' : 'unlisted',
    displayName: row.displayName,
    displayDescription: row.displayDescription,
    displayAvatarPublicCid: row.displayAvatarPublicCid,
    roomPublicKey: row.roomPublicKey,
    manifestKeyCommitment: row.manifestKeyCommitment,
    latestManifestCommitment: row.latestManifestCommitment,
    rendezvousPolicy: row.rendezvousPolicy as RendezvousPolicy,
    bootstrapHints: row.bootstrapHints as readonly BootstrapHint[],
    signedStub: row.signedStub,
    stubSignature: row.stubSignature,
    createdByAccountId: row.createdByAccountId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzlePrivateRoomStubStore implements PrivateRoomStubStore {
  constructor(private readonly db: DbExecutor) {}

  async create(input: PrivateRoomStubInsertInput): Promise<StoredPrivateRoomStub> {
    const { name, slug } = shellIdentity(input.roomServerId);
    return await this.db.transaction(async (tx) => {
      // The four §4.1 axes are set TOGETHER: the `rooms_storage_authority_coherence`,
      // `rooms_p2p_requires_directory_mode`, `rooms_p2p_visibility_private`, and
      // `rooms_p2p_join_model_invite` CHECKs reject any partial combination, so the
      // database refuses an incoherent P2P room rather than trusting this call site.
      await tx.insert(rooms).values({
        roomId: input.roomServerId,
        name,
        slug,
        description: null,
        roomType: 'global_topic',
        visibility: 'private',
        joinModel: 'invite',
        postingPolicy: 'all_members',
        storageMode: 'p2p',
        authorityModel: 'room_keys',
        directoryMode: input.directoryMode,
        p2pStubId: input.stubId,
        createdBy: input.createdByAccountId,
        governanceMode: 'ordinary',
        charterSummary: null,
        typeMetadata: {},
        latestActivityAt: null,
      });
      const inserted = await tx
        .insert(privateRoomStubs)
        .values({
          stubId: input.stubId,
          roomServerId: input.roomServerId,
          directoryMode: input.directoryMode,
          displayName: input.displayName,
          displayDescription: input.displayDescription,
          displayAvatarPublicCid: input.displayAvatarPublicCid,
          roomPublicKey: input.roomPublicKey,
          manifestKeyCommitment: input.manifestKeyCommitment,
          latestManifestCommitment: null,
          rendezvousPolicy: input.rendezvousPolicy,
          bootstrapHints: [...input.bootstrapHints],
          signedStub: input.signedStub,
          stubSignature: input.stubSignature,
          createdByAccountId: input.createdByAccountId,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('private room stub insert returned no row');
      return toStub(row);
    });
  }

  async getByRoomId(roomServerId: string): Promise<StoredPrivateRoomStub | null> {
    const rowsFound = await this.db
      .select()
      .from(privateRoomStubs)
      .where(eq(privateRoomStubs.roomServerId, roomServerId))
      .limit(1);
    const row = rowsFound[0];
    return row ? toStub(row) : null;
  }

  async update(
    roomServerId: string,
    patch: PrivateRoomStubPatch,
  ): Promise<StoredPrivateRoomStub | null> {
    const updated = await this.db
      .update(privateRoomStubs)
      .set({
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.displayDescription !== undefined
          ? { displayDescription: patch.displayDescription }
          : {}),
        ...(patch.displayAvatarPublicCid !== undefined
          ? { displayAvatarPublicCid: patch.displayAvatarPublicCid }
          : {}),
        ...(patch.rendezvousPolicy !== undefined
          ? { rendezvousPolicy: patch.rendezvousPolicy }
          : {}),
        ...(patch.bootstrapHints !== undefined
          ? { bootstrapHints: [...patch.bootstrapHints] }
          : {}),
        ...(patch.latestManifestCommitment !== undefined
          ? { latestManifestCommitment: patch.latestManifestCommitment }
          : {}),
        ...(patch.signedStub !== undefined ? { signedStub: patch.signedStub } : {}),
        ...(patch.stubSignature !== undefined ? { stubSignature: patch.stubSignature } : {}),
        updatedAt: new Date(),
      })
      .where(eq(privateRoomStubs.roomServerId, roomServerId))
      .returning();
    const row = updated[0];
    return row ? toStub(row) : null;
  }

  async delist(roomServerId: string): Promise<StoredPrivateRoomStub | null> {
    return await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(privateRoomStubs)
        .set({
          directoryMode: 'unlisted',
          // The `private_room_stubs_listed_display_only` CHECK requires these to
          // be NULL once the mode is no longer `listed`, so the demotion and the
          // metadata drop are ONE statement — a two-step would violate it midway.
          displayName: null,
          displayDescription: null,
          displayAvatarPublicCid: null,
          updatedAt: new Date(),
        })
        .where(eq(privateRoomStubs.roomServerId, roomServerId))
        .returning();
      const row = updated[0];
      if (!row) return null;
      await tx
        .update(rooms)
        .set({ directoryMode: 'unlisted', updatedAt: new Date() })
        .where(eq(rooms.roomId, roomServerId));
      return toStub(row);
    });
  }

  async remove(roomServerId: string): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(privateRoomStubs)
        .where(eq(privateRoomStubs.roomServerId, roomServerId))
        .returning({ stubId: privateRoomStubs.stubId });
      if (deleted.length === 0) return false;
      // The SHELL goes too, not just the stub.  Keeping it would leave a durable
      // server row whose creator and timestamp assert "this account created a
      // private room at time T" — a §8.1 activity trace that survives the very
      // action taken to remove the server's record.  The room is unaffected:
      // it lives on members' devices, and the §8.3 trigger guarantees no other
      // server table ever referenced this id, so the stub is the only dependent
      // row (and it is already gone).
      //
      // This is a DELETE of Licio's bootstrap record, never of the room — the
      // route's response says exactly that, per §21.4.
      await tx.delete(rooms).where(eq(rooms.roomId, roomServerId));
      return true;
    });
  }

  async purgeForAccount(accountId: string): Promise<number> {
    // Delete the SHELLS; the stubs cascade with them (`room_server_id` is
    // `onDelete: cascade`). Deleting the stub alone would leave an orphan shell
    // that still says an account created a private room at time T.
    const targets = await this.db
      .select({ roomServerId: privateRoomStubs.roomServerId })
      .from(privateRoomStubs)
      .where(eq(privateRoomStubs.createdByAccountId, accountId));
    if (targets.length === 0) return 0;
    await this.db.delete(rooms).where(
      inArray(
        rooms.roomId,
        targets.map((row) => row.roomServerId),
      ),
    );
    return targets.length;
  }

  async listForAccount(accountId: string): Promise<StoredPrivateRoomStub[]> {
    const rowsFound = await this.db
      .select()
      .from(privateRoomStubs)
      .where(eq(privateRoomStubs.createdByAccountId, accountId))
      .orderBy(desc(privateRoomStubs.createdAt), desc(privateRoomStubs.stubId));
    return rowsFound.map(toStub);
  }

  async listListed(options: {
    readonly limit: number;
    readonly cursor?: { readonly createdAt: string; readonly stubId: string };
  }): Promise<StoredPrivateRoomStub[]> {
    const listed = eq(privateRoomStubs.directoryMode, 'listed');
    const { cursor } = options;
    // Strict keyset: everything ordered after (createdAt, stubId) descending.
    // The `createdAt` tie branch is not decoration — stubs minted in the same
    // millisecond would otherwise repeat or vanish across a page boundary.
    const where =
      cursor === undefined
        ? listed
        : and(
            listed,
            or(
              lt(privateRoomStubs.createdAt, new Date(cursor.createdAt)),
              and(
                eq(privateRoomStubs.createdAt, new Date(cursor.createdAt)),
                lt(privateRoomStubs.stubId, cursor.stubId),
              ),
            ),
          );
    const rowsFound = await this.db
      .select()
      .from(privateRoomStubs)
      .where(where)
      .orderBy(desc(privateRoomStubs.createdAt), desc(privateRoomStubs.stubId))
      .limit(options.limit);
    return rowsFound.map(toStub);
  }

  async ownerOf(roomServerId: string): Promise<string | null> {
    const rowsFound = await this.db
      .select({ createdByAccountId: privateRoomStubs.createdByAccountId })
      .from(privateRoomStubs)
      .where(eq(privateRoomStubs.roomServerId, roomServerId))
      .limit(1);
    return rowsFound[0]?.createdByAccountId ?? null;
  }
}
