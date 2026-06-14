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
    createdBy: uuid('created_by').references(() => users.userId, { onDelete: 'set null' }),
    governanceMode: governanceModeEnum('governance_mode').notNull().default('ordinary'),
    charterSummary: text('charter_summary'),
    /** Per-type creation fields (initial_topics / geographic_scope / …). */
    typeMetadata: jsonb('type_metadata').$type<Record<string, unknown>>().notNull().default({}),
    /** Activity recency for listing — a timestamp, never a popularity count. */
    latestActivityAt: timestamp('latest_activity_at', { withTimezone: true }),
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
