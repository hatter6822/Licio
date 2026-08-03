// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.1.2 — the ONLY two server tables a Private P2P room (PRIVATE_SPEC §4)
// may touch (§8.2, §15.3, §23.2).  The §8.1 forbiddance list is the COLUMN
// DENYLIST for both tables: no private content, CID, operation head, story/
// thread/contribution id, thread title, body, media, manifest, search index,
// embedding, topic, URL, content event, ranking candidate, attention
// aggregate, member list, member count, activity time, unread count, push
// content, key material, invite secret, or recovery secret may EVER appear as a
// column here.  Only the §8.2 commitments (public keys / hash commitments),
// blind ids, ciphertext announcements, listed-room display metadata, and
// bootstrap policy are allowed.  `check:private-rendezvous-schema` (WS-S.1.5)
// + the unit denylist test pin this structurally.
//
// These tables are the EXPLICIT exception to the §8.3 database guard ("every
// server table that can reference a room MUST reject P2P room ids unless it is
// the stub/rendezvous table"): the stub references a P2P room's server-side
// shell id, and the rendezvous record is DELIBERATELY un-linkable to any room
// (the server cannot map a blind id to a room/account/CID — §15.3.1).
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { roomDirectoryModeEnum, rooms } from './room.js';
import { users } from './user.js';

/** §8.2 — the rendezvous/bootstrap policy a stub advertises.  This is policy,
 *  NOT private content: it names HOW peers find each other, never WHO they are. */
export const privateRendezvousPolicyEnum = pgEnum('private_rendezvous_policy', [
  'licio_blind',
  'member_rendezvous',
  'manual_only',
]);

/**
 * §8.2 — the optional directory stub for a `listed`/`unlisted` P2P room.  A
 * `detached` room stores NO stub at all, so a stub row never carries the
 * `detached` mode (the `private_room_stubs_not_detached` CHECK).  Every column
 * is a §8.2-allowed field: cryptographic commitments (NOT decrypting material),
 * a rendezvous policy, bootstrap hints, the signed stub + its signature, and —
 * for `listed` rooms ONLY — public display metadata.
 */
export const privateRoomStubs = pgTable(
  'private_room_stubs',
  {
    stubId: uuid('stub_id').primaryKey().defaultRandom(),
    /** The P2P room's server-side shell id (the §8.3-allowed room reference). */
    roomServerId: uuid('room_server_id')
      .notNull()
      .references(() => rooms.roomId, { onDelete: 'cascade' }),
    /** `listed` | `unlisted` only — `detached` rooms store no stub (CHECK below). */
    directoryMode: roomDirectoryModeEnum('directory_mode').notNull(),

    // Present ONLY for `listed` rooms (NULL for `unlisted`).
    displayName: text('display_name'),
    displayDescription: text('display_description'),
    /** A PUBLIC avatar CID — `listed` rooms only; never a private CID. */
    displayAvatarPublicCid: text('display_avatar_public_cid'),

    // Cryptographic commitments — NOT decrypting material (§8.2).
    roomPublicKey: text('room_public_key').notNull(),
    manifestKeyCommitment: text('manifest_key_commitment').notNull(),
    latestManifestCommitment: text('latest_manifest_commitment'),

    // Bootstrap/rendezvous policy — NOT private content (§8.2).
    rendezvousPolicy: privateRendezvousPolicyEnum('rendezvous_policy').notNull(),
    /** Array of { kind: 'licio_blind'|'member_relay'|'manual'; value: string }. */
    bootstrapHints: jsonb('bootstrap_hints')
      .$type<Array<{ kind: 'licio_blind' | 'member_relay' | 'manual'; value: string }>>()
      .notNull()
      .default([]),

    /**
     * The re-signed §8.2 stub (public fields only) + its detached signature.
     *
     * "Public fields only" is now structural rather than aspirational: the one
     * secret this blob used to carry — the §21.2 bootstrap capability — lives in
     * its own column below.  A jsonb blob is projected wholesale or not at all,
     * so anything inside it is disclosed everywhere it is disclosed anywhere.
     */
    signedStub: jsonb('signed_stub').$type<Record<string, unknown>>().notNull(),
    stubSignature: text('stub_signature').notNull(),

    /**
     * §21.2 — the invite-derived capability that gates an `unlisted` bootstrap
     * read.  NEVER projected: it is compared, in constant time, against the
     * `?token=` a reader presents, and appears in no response type.
     *
     * NOT NULL because a stub without one is unresolvable for its members the
     * moment it is delisted — the §21.4 guarantee that delisting keeps the
     * record reachable is only as strong as every stub having a capability.
     */
    bootstrapBlindId: text('bootstrap_blind_id').notNull(),

    /** The Licio account that created the stub (for §27.2 rate limiting only). */
    createdByAccountId: uuid('created_by_account_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** At most one stub per P2P room shell — enforced STRUCTURALLY (unique),
     *  not just by convention. */
    uniqueIndex('private_room_stubs_room_uq').on(t.roomServerId),
    /** `detached` rooms store no stub (§8.2). */
    check('private_room_stubs_not_detached', sql`${t.directoryMode} <> 'detached'`),
    /** Display metadata exists only for `listed` rooms (unlisted leaks no name). */
    check(
      'private_room_stubs_listed_display_only',
      sql`${t.directoryMode} = 'listed' OR (${t.displayName} IS NULL AND ${t.displayDescription} IS NULL AND ${t.displayAvatarPublicCid} IS NULL)`,
    ),
  ],
);

export type PrivateRoomStubRow = typeof privateRoomStubs.$inferSelect;
export type PrivateRoomStubInsert = typeof privateRoomStubs.$inferInsert;

/**
 * §15.3 — a short-lived blind rendezvous record.  The ONLY thing the server
 * sees for an `unlisted`/`detached` room.  It carries blind ids (HMAC-derived,
 * rotate per epoch + time bucket) + a ciphertext announcement + a TTL — and
 * has DELIBERATELY no foreign key to `rooms` (the server MUST NOT be able to
 * map a record to a room/account/member/CID, §15.3.1).  Knowledge of the
 * `rendezvous_key` IS the rendezvous capability; a removed member loses it at
 * the next epoch.
 */
export const privateRendezvousRecords = pgTable(
  'private_rendezvous_records',
  {
    rendezvousId: uuid('rendezvous_id').primaryKey().defaultRandom(),
    /** HMAC(rendezvous_key, ["room", epoch, time_bucket]) — unlinkable to a room. */
    roomBlindId: text('room_blind_id').notNull(),
    /** HMAC(rendezvous_key, ["peer", device_id, epoch, time_bucket]). */
    peerBlindId: text('peer_blind_id').notNull(),
    /** Sealed under `rendezvous_key`; the server never decodes it. */
    encryptedAnnouncement: text('encrypted_announcement').notNull(),
    /** Short TTL (5–30 min); expired rows are never returned + are swept. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Poll-by-room-blind-id; the only query shape the rendezvous service needs. */
    index('private_rendezvous_room_blind_idx').on(t.roomBlindId),
    /** TTL sweep support. */
    index('private_rendezvous_expires_idx').on(t.expiresAt),
  ],
);

export type PrivateRendezvousRecordRow = typeof privateRendezvousRecords.$inferSelect;
export type PrivateRendezvousRecordInsert = typeof privateRendezvousRecords.$inferInsert;
