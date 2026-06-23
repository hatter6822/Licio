// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Room, steward, subscription, and lens entities (WS-G.2.1/2.2/2.3d, SPEC
// §16.1/§16.2/§16.3/§17.4).  Steward assignment is a NORMALIZED join table
// (referential integrity + per-role queries), never a UUID array.  Lenses are
// interpretation contexts: `(room_id, lens_type)` is unique and nothing in
// this schema counts per-lens applause (no-applause doctrine).
//
// `governance_mode` defaults to `ordinary` and is read-only in WS-G — mode
// transitions are owned by WS-L/M behind the §16.5 readiness checklist.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './user.js';

export const roomTypeEnum = pgEnum('room_type', [
  'global_topic',
  'local_geographic',
  'professional_domain',
  'event',
  'learning',
  'steward',
]);

// WS-Q.1.2 — binary visibility (§16.1); the legacy three-value enum is
// recreated by migration 0014, deriving the two orthogonal axes below from the
// old value BEFORE collapsing it (mirrors @licio/shared mapLegacyRoomVisibility).
export const roomVisibilityEnum = pgEnum('room_visibility', ['public', 'private']);

/** §16.2 join model — how a member is admitted (orthogonal to visibility). */
export const joinModelEnum = pgEnum('room_join_model', ['open', 'request_approval', 'invite']);

/** §16.2 posting policy — who may create top-level content (orthogonal). */
export const postingPolicyEnum = pgEnum('room_posting_policy', [
  'all_members',
  'experts_and_stewards',
]);

// WS-S.1.1 — the three private-room axes (PRIVATE_SPEC §4.1/§23.2).  Added
// ALONGSIDE the existing axes; the coherence CHECKs below mirror the
// `@licio/shared` `roomAxesSchema` superRefine exactly so the storage layer and
// the wire schema agree.  P2P content NEVER touches the server (§8); these
// columns only ever describe the room's class + (optionally) a directory stub.

/** §4.1 — WHERE the room's content lives. */
export const roomStorageModeEnum = pgEnum('room_storage_mode', ['server', 'p2p']);
/** §4.1 — WHO holds authority (platform vs room cryptographic capabilities). */
export const roomAuthorityModelEnum = pgEnum('room_authority_model', ['platform', 'room_keys']);
/** §4.2 — how discoverable a P2P room's existence is (NULL for server rooms). */
export const roomDirectoryModeEnum = pgEnum('room_directory_mode', [
  'listed',
  'unlisted',
  'detached',
]);

/** §17.4 governance lifecycle; `ordinary` is always the default. */
export const governanceModeEnum = pgEnum('governance_mode', [
  'ordinary',
  'simulated',
  'testnet',
  'capped_production',
  'mature_production',
  'frozen',
  'migrating',
]);

/** The five WS-A.2.2 steward roles (1:1 with the ROLE_* policy ids). */
export const roomStewardRoleEnum = pgEnum('room_steward_role', [
  'community_steward',
  'evidence_steward',
  'safety_moderator',
  'appeals_reviewer',
  'integrity_analyst',
]);

export const lensTypeEnum = pgEnum('lens_type', [
  'local_resident',
  'beginner',
  'expert',
  'affected_community',
  'skeptical',
  'policy',
  'historical',
]);

export const rooms = pgTable(
  'rooms',
  {
    roomId: uuid('room_id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    roomType: roomTypeEnum('room_type').notNull(),
    visibility: roomVisibilityEnum('visibility').notNull().default('public'),
    // WS-Q.1.2 — the two orthogonal §16.2 axes. Defaults match the documented
    // service defaults (public→open; all_members) as a NOT-NULL backstop; the
    // route/service still sets them explicitly per visibility.
    joinModel: joinModelEnum('join_model').notNull().default('open'),
    postingPolicy: postingPolicyEnum('posting_policy').notNull().default('all_members'),
    // WS-S.1.1 — the §4.1 private-room axes.  Existing rooms (and every
    // server-created room) are `server`/`platform` with a NULL directory mode
    // and no stub; only a client-created P2P room is `p2p`/`room_keys`.
    storageMode: roomStorageModeEnum('storage_mode').notNull().default('server'),
    authorityModel: roomAuthorityModelEnum('authority_model').notNull().default('platform'),
    directoryMode: roomDirectoryModeEnum('directory_mode'),
    /** Opaque pointer to the optional §8.2 directory stub (P2P rooms only). */
    p2pStubId: uuid('p2p_stub_id'),
    createdBy: uuid('created_by').references(() => users.userId, { onDelete: 'set null' }),
    governanceMode: governanceModeEnum('governance_mode').notNull().default('ordinary'),
    charterSummary: text('charter_summary'),
    /** Per-type creation fields (initial_topics / geographic_scope / …). */
    typeMetadata: jsonb('type_metadata').$type<Record<string, unknown>>().notNull().default({}),
    /** Activity recency for listing — a timestamp, never a popularity count. */
    latestActivityAt: timestamp('latest_activity_at', { withTimezone: true }),
    // WS-S.9 (PRIVATE_SPEC §24, phase 5) — a Members-only server room is FROZEN
    // read-only during/after migration to a Private P2P replacement: all new
    // submissions/contributions are rejected (fail-closed at the service layer),
    // existing content stays readable until phase-6 purge. `frozen` defaults
    // false (no existing room is read-only); `migratedToRoomId` is the OPAQUE
    // client-side P2P room id (a UUID, never a server FK — a P2P room has no
    // server row) the old room points at, surfaced honestly in the §8 disclosure.
    frozen: boolean('frozen').notNull().default(false),
    migratedToRoomId: text('migrated_to_room_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rooms_type_slug_uq').on(t.roomType, t.slug),
    /** Race-safe duplicate-name detection (the API maps violations to 409). */
    uniqueIndex('rooms_type_name_uq').on(t.roomType, sql`lower(${t.name})`),
    index('rooms_type_idx').on(t.roomType),
    index('rooms_visibility_idx').on(t.visibility),
    index('rooms_governance_idx').on(t.governanceMode),
    index('rooms_created_idx').on(t.createdAt),
    index('rooms_activity_idx').on(t.latestActivityAt),
    check('rooms_name_len', sql`char_length(${t.name}) between 1 and 100`),
    check('rooms_slug_len', sql`char_length(${t.slug}) between 1 and 120`),
    check(
      'rooms_description_len',
      sql`${t.description} is null or char_length(${t.description}) <= 2000`,
    ),
    check(
      'rooms_charter_len',
      sql`${t.charterSummary} is null or char_length(${t.charterSummary}) <= 5000`,
    ),
    // WS-Q.1.2 coherence (§16.2): a PUBLIC room is openly joinable; only a
    // private room may gate membership (request_approval/invite).
    check('rooms_public_join_open', sql`${t.visibility} = 'private' OR ${t.joinModel} = 'open'`),
    // WS-Q.1.2 (§16.1): steward rooms are private.
    check('rooms_steward_private', sql`${t.roomType} <> 'steward' OR ${t.visibility} = 'private'`),
    // WS-S.1.1 — the §4.1 coherence rules, STRUCTURALLY enforced (PRIVATE_SPEC
    // §23.2).  These mirror the `@licio/shared` `roomAxesSchema` superRefine, so
    // no direct write / migration / old API path can persist an incoherent row
    // (e.g. a P2P room with `platform` authority, a non-private or `open` P2P
    // room, or a server room carrying a P2P stub) that the wire schema rejects.
    check(
      'rooms_storage_authority_coherence',
      sql`(${t.storageMode} = 'server' AND ${t.authorityModel} = 'platform')
          OR (${t.storageMode} = 'p2p' AND ${t.authorityModel} = 'room_keys')`,
    ),
    check(
      'rooms_p2p_requires_directory_mode',
      sql`${t.storageMode} = 'server' OR ${t.directoryMode} IS NOT NULL`,
    ),
    // A server room never carries a directory mode (it is NULL for them); this
    // is the storage-layer half of the shared schema's same rule.
    check(
      'rooms_server_no_directory_mode',
      sql`${t.storageMode} = 'p2p' OR ${t.directoryMode} IS NULL`,
    ),
    check(
      'rooms_p2p_visibility_private',
      sql`${t.storageMode} = 'server' OR ${t.visibility} = 'private'`,
    ),
    // Reuses the WS-Q `join_model` column: closes the gap where a direct write
    // could persist a P2P room with `open`/`request_approval`.
    check(
      'rooms_p2p_join_model_invite',
      sql`${t.storageMode} = 'server' OR ${t.joinModel} = 'invite'`,
    ),
    check('rooms_server_has_no_stub', sql`${t.storageMode} = 'p2p' OR ${t.p2pStubId} IS NULL`),
  ],
);

export type RoomRow = typeof rooms.$inferSelect;
export type RoomInsert = typeof rooms.$inferInsert;

export const roomStewards = pgTable(
  'room_stewards',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.roomId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    role: roomStewardRoleEnum('role').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** A user may hold multiple roles in a room (WS-G.2.1 acceptance). */
    primaryKey({ columns: [t.roomId, t.userId, t.role] }),
    index('room_stewards_user_idx').on(t.userId),
  ],
);

export type RoomStewardRow = typeof roomStewards.$inferSelect;

export const roomSubscriptionStatusEnum = pgEnum('room_subscription_status', ['active', 'pending']);

export const roomSubscriptions = pgTable(
  'room_subscriptions',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.roomId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    /** `pending` = a restricted-room join request awaiting steward approval. */
    status: roomSubscriptionStatusEnum('status').notNull(),
    /** Stable id so stewards can address PATCH /join-requests/:requestId. */
    requestId: uuid('request_id').notNull().defaultRandom(),
    /** WS-G.2.3d per-room notification preferences. */
    notificationPreferences: jsonb('notification_preferences')
      .$type<Record<string, unknown>>()
      .notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.roomId, t.userId] }),
    uniqueIndex('room_subscriptions_request_uq').on(t.requestId),
    index('room_subscriptions_user_idx').on(t.userId),
    index('room_subscriptions_room_status_idx').on(t.roomId, t.status),
  ],
);

export type RoomSubscriptionRow = typeof roomSubscriptions.$inferSelect;

export const lenses = pgTable(
  'lenses',
  {
    lensId: uuid('lens_id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.roomId, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    lensType: lensTypeEnum('lens_type').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('lenses_room_type_uq').on(t.roomId, t.lensType),
    check('lenses_name_len', sql`char_length(${t.name}) between 1 and 100`),
    check(
      'lenses_description_len',
      sql`${t.description} is null or char_length(${t.description}) <= 1000`,
    ),
  ],
);

export type LensRow = typeof lenses.$inferSelect;
export type LensInsert = typeof lenses.$inferInsert;
