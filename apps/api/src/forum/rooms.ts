// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Room service (WS-G.2.3a–d, SPEC §16.1/§16.3/§16.5).  Listing/discovery,
// detail, creation authorization, and subscription management.
//
// No-applause recommendation contract (WS-G.2.3a): the `recommended`
// ordering reads EXACTLY the inputs in {@link RecommendationInputs} —
// activity recency and creation recency (timestamps), never member counts,
// like/follower counts (none exist), or any SIG-PROH-* signal.  A unit test
// asserts the input keys against the WS-A.1.1 denylist.

import { randomUUID } from 'node:crypto';
import type {
  RoomCreateRequest,
  RoomJoinModel,
  RoomNotificationPreferences,
  RoomPostingPolicy,
  RoomStewardRole,
  RoomSummary,
  RoomType,
  RoomVisibility,
  StoryVisibility,
} from '@licio/shared';
import {
  COMMONS_ROOM_ID,
  COMMONS_SLUG,
  DEFAULT_ROOM_NOTIFICATION_PREFERENCES,
} from '@licio/shared';
import type { Role } from '../identity/rbac.js';
import type { ForumServices } from './services.js';
import type { RoomRecord, RoomSubscriptionRecord } from './stores.js';

/** The ONLY signals the room recommendation may read (no-applause). */
export interface RecommendationInputs {
  /** Epoch ms of the room's latest thread/contribution activity (0 = none). */
  activityRecencyMs: number;
  /** Epoch ms of room creation (new rooms get discovered). */
  createdAtMs: number;
}

export const RECOMMENDATION_INPUT_KEYS = ['activityRecencyMs', 'createdAtMs'] as const;

export function recommendationInputs(room: RoomRecord): RecommendationInputs {
  return {
    activityRecencyMs: room.latestActivityAt !== null ? Date.parse(room.latestActivityAt) : 0,
    createdAtMs: Date.parse(room.createdAt),
  };
}

/** Recommendation order: most-recent activity first, then newest rooms. */
export function compareRecommended(a: RoomRecord, b: RoomRecord): number {
  const ia = recommendationInputs(a);
  const ib = recommendationInputs(b);
  if (ia.activityRecencyMs !== ib.activityRecencyMs) {
    return ib.activityRecencyMs - ia.activityRecencyMs;
  }
  if (ia.createdAtMs !== ib.createdAtMs) return ib.createdAtMs - ia.createdAtMs;
  return a.roomId.localeCompare(b.roomId);
}

/**
 * WS-Q.1.6 — boot-time idempotent ensure of the system Commons room (the
 * application-level analogue of the Postgres 0015 seed; the in-memory store
 * self-seeds it in its constructor). Safe to call repeatedly: returns early if
 * Commons already exists, and tolerates a concurrent insert race (the unique
 * index turns a lost race into a no-op).
 */
export async function ensureCommonsRoom(forum: ForumServices): Promise<void> {
  if ((await forum.rooms.getById(COMMONS_ROOM_ID)) !== null) return;
  await forum.rooms.insert({
    roomId: COMMONS_ROOM_ID,
    name: 'Commons',
    slug: COMMONS_SLUG,
    description:
      'The shared public square — the default home for content without a more specific room.',
    roomType: 'global_topic',
    visibility: 'public',
    joinModel: 'open',
    postingPolicy: 'all_members',
    createdBy: null,
    governanceMode: 'ordinary',
    charterSummary: null,
    typeMetadata: {},
    latestActivityAt: null,
  });
}

/** Build a slug from a room name (stable, URL-safe). */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return slug.length > 0 ? slug : 'room';
}

export type RoomCreateAuthz =
  | { ok: true }
  | { ok: false; code: 'forbidden_steward_room'; message: string };

/**
 * WS-Q.3.3a authorization: any verified account may create a PUBLIC or PRIVATE
 * room (private-room creation is no longer steward-gated — §16.1 makes private
 * rooms a first-class user affordance, rate-limited like public). Only
 * `steward` rooms still require platform staff (admin).
 */
export function authorizeRoomCreate(
  request: RoomCreateRequest,
  roles: readonly Role[],
): RoomCreateAuthz {
  const staff = roles.includes('admin');
  if (request.room_type === 'steward' && !staff) {
    return {
      ok: false,
      code: 'forbidden_steward_room',
      message: 'Steward rooms require platform staff',
    };
  }
  return { ok: true };
}

/**
 * WS-Q.3.3a — apply the documented room-axis defaults (the schema is a pure
 * validator; defaults live here). Steward rooms default to private; everything
 * else to public. `join_model` defaults per visibility (public→open,
 * private→request_approval); `posting_policy` defaults to `all_members`. The
 * shared coherence refinement has already rejected incoherent EXPLICIT combos.
 */
export function resolveRoomCreateAxes(request: RoomCreateRequest): {
  visibility: RoomVisibility;
  joinModel: RoomJoinModel;
  postingPolicy: RoomPostingPolicy;
} {
  const visibility: RoomVisibility =
    request.visibility ?? (request.room_type === 'steward' ? 'private' : 'public');
  const joinModel: RoomJoinModel =
    request.join_model ?? (visibility === 'public' ? 'open' : 'request_approval');
  const postingPolicy: RoomPostingPolicy = request.posting_policy ?? 'all_members';
  return { visibility, joinModel, postingPolicy };
}

/** Per-type creation fields → the room's type_metadata JSONB. */
export function roomTypeMetadata(request: RoomCreateRequest): Record<string, unknown> {
  switch (request.room_type) {
    case 'global_topic':
      return { initial_topics: request.initial_topics };
    case 'local_geographic':
      return { geographic_scope: request.geographic_scope };
    case 'professional_domain':
      return { domain_descriptor: request.domain_descriptor };
    case 'event':
      return { event_start: request.event_start, event_end: request.event_end };
    case 'learning':
      return { curriculum_outline: request.curriculum_outline };
    case 'steward':
      return {};
  }
}

/** Project a room to the public summary shape for a given requester. */
export async function toRoomSummary(
  forum: ForumServices,
  room: RoomRecord,
  threadCount: number,
  requesterUserId: string | null,
): Promise<RoomSummary> {
  const memberCount = await forum.rooms.countMembers(room.roomId);
  const subscription =
    requesterUserId !== null
      ? await forum.rooms.getSubscription(room.roomId, requesterUserId)
      : null;
  return {
    room_id: room.roomId,
    name: room.name,
    slug: room.slug,
    room_type: room.roomType,
    visibility: room.visibility,
    join_model: room.joinModel,
    posting_policy: room.postingPolicy,
    description: room.description,
    thread_count: threadCount,
    member_count: memberCount,
    latest_activity_at: room.latestActivityAt,
    governance_mode: room.governanceMode,
    joined: subscription?.status === 'active',
    created_at: room.createdAt,
  };
}

/** The store's `q` semantics as a pure predicate (case-insensitive
 *  substring on name/description) — for paths that assemble candidate
 *  lists outside the store, e.g. the requester's own memberships. */
export function roomMatchesQuery(room: RoomRecord, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    room.name.toLowerCase().includes(needle) ||
    (room.description ?? '').toLowerCase().includes(needle)
  );
}

/**
 * WS-Q.3.1a — TIER ONE (room EXISTENCE): the room's shell — name, description,
 * visibility class, join affordance — is visible to ALL, so private rooms are
 * DISCOVERABLE and JOINABLE (§16.1). This is a deliberate semantic change from
 * the shipped restricted-room behavior: `roomVisibleToUser` now returns true
 * for every room, public or private, for any user including signed-out. It is
 * NOT gated by subscription. Never use this for content-bearing reads — that is
 * `roomContentVisibleToUser` (tier two). ("Unlisted/secret" rooms would be a
 * new SPEC axis, out of WS-Q scope.)
 */
export async function roomVisibleToUser(
  _forum: ForumServices,
  _room: RoomRecord,
  _userId: string | null,
): Promise<boolean> {
  return true;
}

/** CONTENT visibility (threads, lenses, detail): public rooms are readable by
 *  all; a PRIVATE room requires ACTIVE membership or a steward role. A pending
 *  applicant may know the room exists (tier one) but reads none of its content
 *  until a steward approves the request (§16.2 — the bar `storyReadableByUser`
 *  and `threadVisibleToUser` compose). */
export async function roomContentVisibleToUser(
  forum: ForumServices,
  room: RoomRecord,
  userId: string | null,
): Promise<boolean> {
  if (room.visibility === 'public') return true;
  if (userId === null) return false;
  const subscription = await forum.rooms.getSubscription(room.roomId, userId);
  if (subscription?.status === 'active') return true;
  const roles = await forum.rooms.stewardRolesFor(room.roomId, userId);
  return roles.length > 0;
}

/**
 * WS-Q.3.1b — the single chokepoint for "may create top-level content here":
 * the user passes the content bar AND (the room admits all members OR the user
 * holds a steward role / is an expert-lens assignee). Consumed by the
 * submission guard (WS-Q.2.1b) and the composer's postable-room filter
 * (WS-Q.5.1a). (Per-user expert-lens assignment is the WS-J seam; today the
 * `experts_and_stewards` bar is satisfied by room or platform stewards.)
 */
export async function userMayPostTopLevel(
  forum: ForumServices,
  room: RoomRecord,
  userId: string | null,
  platformRoles: readonly Role[] = [],
): Promise<boolean> {
  if (!(await roomContentVisibleToUser(forum, room, userId))) return false;
  if (room.postingPolicy === 'all_members') return true;
  if (userId === null) return false;
  return isRoomSteward(forum, room.roomId, userId, platformRoles);
}

/**
 * WS-Q.3.2 — the SINGLE item-level read bar (§14.5.3/§15.3). A story is
 * readable when it is not hidden AND the reader passes the room CONTENT bar.
 * Both visibility tiers gate on the room bar: a `public` story is readable by
 * anyone who can reach its (necessarily public) room; a `room_only` story
 * requires active membership of its room. Item visibility governs DISTRIBUTION
 * (global surfaces), enforced by the ranking gate + search predicate — it never
 * WIDENS the read bar, so a public story mislabeled into a private room fails
 * closed for a non-member. Every direct-read path (story, thread, branch,
 * subtree, contribution) calls this; an unknown room/story is unreadable (404).
 */
export async function storyReadableByUser(
  forum: ForumServices,
  story: { hiddenState: 'takedown' | 'safety' | null; visibility: StoryVisibility },
  room: RoomRecord,
  userId: string | null,
): Promise<boolean> {
  if (story.hiddenState !== null) return false;
  return roomContentVisibleToUser(forum, room, userId);
}

export type JoinOutcome =
  | { ok: true; status: 'active' | 'pending'; subscription: RoomSubscriptionRecord }
  | { ok: false; code: 'not_found'; message: string }
  | { ok: false; code: 'invite_only'; message: string };

/**
 * WS-Q.3.1c — join branches on the room's `join_model` (not visibility):
 *   • `open`             ⇒ immediate `active`;
 *   • `request_approval` ⇒ a `pending` request (steward approves);
 *   • `invite`           ⇒ self-join rejected (invitations are a separate
 *                          steward action — the WS-J seam).
 * Idempotent: re-joining returns the existing subscription unchanged.
 */
export async function joinRoom(
  forum: ForumServices,
  room: RoomRecord,
  userId: string,
  nowIso: string,
): Promise<JoinOutcome> {
  const existing = await forum.rooms.getSubscription(room.roomId, userId);
  if (existing) return { ok: true, status: existing.status, subscription: existing };
  if (room.joinModel === 'invite') {
    forum.metrics.increment('rooms.join_invite_only');
    return {
      ok: false,
      code: 'invite_only',
      message: 'This room is invite-only; ask a steward for an invitation',
    };
  }
  const status: RoomSubscriptionRecord['status'] = room.joinModel === 'open' ? 'active' : 'pending';
  const subscription = await forum.rooms.upsertSubscription({
    roomId: room.roomId,
    userId,
    status,
    requestId: randomUUID(),
    notificationPreferences: { ...DEFAULT_ROOM_NOTIFICATION_PREFERENCES },
    requestedAt: nowIso,
    joinedAt: status === 'active' ? nowIso : null,
  });
  forum.metrics.increment(status === 'active' ? 'rooms.joined' : 'rooms.join_requested');
  return { ok: true, status, subscription };
}

/** Steward gate for room-scoped actions: any of the five WS-A.2.2 roles in
 *  THIS room, or a platform steward/admin. */
export async function isRoomSteward(
  forum: ForumServices,
  roomId: string,
  userId: string,
  platformRoles: readonly Role[],
  requiredRoles?: readonly RoomStewardRole[],
): Promise<boolean> {
  if (platformRoles.includes('steward') || platformRoles.includes('admin')) return true;
  const roles = await forum.rooms.stewardRolesFor(roomId, userId);
  if (roles.length === 0) return false;
  if (!requiredRoles) return true;
  return roles.some((role) => requiredRoles.includes(role));
}

/** Merge a partial notification-preferences patch over the stored values. */
export function mergeNotificationPreferences(
  current: RoomNotificationPreferences,
  patch: { [K in keyof RoomNotificationPreferences]?: RoomNotificationPreferences[K] | undefined },
): RoomNotificationPreferences {
  return {
    threads: patch.threads ?? current.threads,
    new_evidence: patch.new_evidence ?? current.new_evidence,
    bridge_requests: patch.bridge_requests ?? current.bridge_requests,
    steward_announcements: patch.steward_announcements ?? current.steward_announcements,
  };
}

/** List filter for GET /v1/rooms (WS-G.2.3a). */
export interface RoomListFilter {
  roomType?: RoomType | undefined;
  joined?: boolean | undefined;
  recommended?: boolean | undefined;
  query?: string | undefined;
  visibilitiesForAnonymous: readonly RoomVisibility[];
}
