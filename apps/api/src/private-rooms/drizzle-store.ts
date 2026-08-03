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
  SignedStubBody,
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
    signedStub: row.signedStub as SignedStubBody,
    stubSignature: row.stubSignature,
    bootstrapBlindId: row.bootstrapBlindId,
    createdByAccountId: row.createdByAccountId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzlePrivateRoomStubStore implements PrivateRoomStubStore {
  constructor(private readonly db: DbExecutor) {}

  async create(input: PrivateRoomStubInsertInput): Promise<StoredPrivateRoomStub> {
    const { name, slug } = shellIdentity(input.roomServerId);
    // An EXPLICIT millisecond timestamp, not the column's `defaultNow()`.
    // Postgres stamps microseconds; `toStub` serializes through
    // `Date.toISOString()`, which truncates to milliseconds — so a keyset cursor
    // built from the last row of a page is EARLIER than a same-millisecond row
    // that follows it, and that row is neither `<` nor `=` the cursor. It would
    // be skipped permanently, not merely reordered. Writing the value the cursor
    // will later carry removes the mismatch at the source.
    const createdAt = new Date();
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
          // DERIVED from the signed body, never sent separately: two copies of
          // one commitment is two copies that can disagree.
          roomPublicKey: input.signedStub.room_public_key,
          manifestKeyCommitment: input.signedStub.manifest_key_commitment,
          latestManifestCommitment: null,
          rendezvousPolicy: input.rendezvousPolicy,
          bootstrapHints: [...input.bootstrapHints],
          signedStub: input.signedStub,
          stubSignature: input.stubSignature,
          bootstrapBlindId: input.bootstrapBlindId,
          createdByAccountId: input.createdByAccountId,
          createdAt,
          updatedAt: createdAt,
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
    options: { readonly requireListed?: boolean } = {},
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
        ...(patch.signedStub !== undefined
          ? {
              signedStub: patch.signedStub,
              // The columns move WITH the body they derive from.
              roomPublicKey: patch.signedStub.room_public_key,
              manifestKeyCommitment: patch.signedStub.manifest_key_commitment,
            }
          : {}),
        ...(patch.stubSignature !== undefined ? { stubSignature: patch.stubSignature } : {}),
        updatedAt: new Date(),
      })
      .where(
        options.requireListed === true
          ? and(
              eq(privateRoomStubs.roomServerId, roomServerId),
              // ATOMIC with the write: a delist committing between the service's
              // mode check and this statement would otherwise make Postgres
              // reject a legal request on the display-only CHECK — a 500 the
              // caller cannot act on. As a predicate it is simply a no-match.
              eq(privateRoomStubs.directoryMode, 'listed'),
            )
          : eq(privateRoomStubs.roomServerId, roomServerId),
      )
      .returning();
    const row = updated[0];
    return row ? toStub(row) : null;
  }

  async delist(
    roomServerId: string,
    options: { readonly requireListed?: boolean } = {},
  ): Promise<StoredPrivateRoomStub | null> {
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
        .where(
          options.requireListed === true
            ? and(
                eq(privateRoomStubs.roomServerId, roomServerId),
                // ATOMIC: the staff arm's authority is over a PUBLIC LISTING, so
                // the write must be the thing that establishes there was one. A
                // separate read moments earlier can observe `listed` while the
                // owner delists in between, and the idempotent write then
                // succeeds against an already-unlisted record — producing a
                // staff-moderation audit entry for a transition the owner
                // performed.
                eq(privateRoomStubs.directoryMode, 'listed'),
              )
            : eq(privateRoomStubs.roomServerId, roomServerId),
        )
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
    //
    // Through a SUBQUERY, not an id list. Materialising every room id and
    // expanding it through `inArray` binds one parameter per stub, so a
    // sufficiently prolific account exceeds the driver's parameter limit — and
    // this runs inside `runDeletionPurge`, BEFORE the tombstone, so the throw
    // would abandon a hard deletion and do so identically on every retry. A
    // deletion that cannot complete is the one kind that must not depend on how
    // much the account did.
    const deleted = await this.db
      .delete(rooms)
      .where(
        inArray(
          rooms.roomId,
          this.db
            .select({ roomServerId: privateRoomStubs.roomServerId })
            .from(privateRoomStubs)
            .where(eq(privateRoomStubs.createdByAccountId, accountId)),
        ),
      )
      .returning({ roomId: rooms.roomId });
    return deleted.length;
  }

  async listForAccount(
    accountId: string,
    options?: {
      readonly limit: number;
      readonly cursor?: { readonly createdAt: string; readonly stubId: string };
    },
  ): Promise<StoredPrivateRoomStub[]> {
    const owned = eq(privateRoomStubs.createdByAccountId, accountId);
    const cursor = options?.cursor;
    const where =
      cursor === undefined
        ? owned
        : and(
            owned,
            or(
              lt(privateRoomStubs.createdAt, new Date(cursor.createdAt)),
              and(
                eq(privateRoomStubs.createdAt, new Date(cursor.createdAt)),
                lt(privateRoomStubs.stubId, cursor.stubId),
              ),
            ),
          );
    const query = this.db
      .select()
      .from(privateRoomStubs)
      .where(where)
      .orderBy(desc(privateRoomStubs.createdAt), desc(privateRoomStubs.stubId));
    const rowsFound = options === undefined ? await query : await query.limit(options.limit);
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
