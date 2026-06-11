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
  RoomNotificationPreferences,
  RoomStewardRole,
  RoomSummary,
  RoomType,
  RoomVisibility,
} from '@licio/shared';
import { DEFAULT_ROOM_NOTIFICATION_PREFERENCES } from '@licio/shared';
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
  | { ok: false; code: 'forbidden_visibility' | 'forbidden_steward_room'; message: string };

/**
 * WS-G.2.3c authorization: authenticated users create PUBLIC rooms;
 * restricted/expert_led visibility requires an elevated role (platform
 * steward/moderator/admin); `steward` rooms require platform staff (admin).
 */
export function authorizeRoomCreate(
  request: RoomCreateRequest,
  roles: readonly Role[],
): RoomCreateAuthz {
  const elevated =
    roles.includes('steward') || roles.includes('moderator') || roles.includes('admin');
  const staff = roles.includes('admin');
  if (request.room_type === 'steward' && !staff) {
    return {
      ok: false,
      code: 'forbidden_steward_room',
      message: 'Steward rooms require platform staff',
    };
  }
  if (request.visibility !== 'public' && !elevated) {
    return {
      ok: false,
      code: 'forbidden_visibility',
      message: 'Restricted and expert-led rooms require a steward role',
    };
  }
  return { ok: true };
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

/** EXISTENCE visibility (listings, join status): anonymous and non-members
 *  see PUBLIC rooms only; members/stewards AND pending applicants see their
 *  own non-public rooms — an applicant must be able to find the room they
 *  applied to.  Never use this for content-bearing reads: that is
 *  `roomContentVisibleToUser`. */
export async function roomVisibleToUser(
  forum: ForumServices,
  room: RoomRecord,
  userId: string | null,
): Promise<boolean> {
  if (room.visibility === 'public') return true;
  if (userId === null) return false;
  const subscription = await forum.rooms.getSubscription(room.roomId, userId);
  if (subscription !== null) return true; // active OR pending (they applied)
  const roles = await forum.rooms.stewardRolesFor(room.roomId, userId);
  return roles.length > 0;
}

/** CONTENT visibility (threads, lenses, detail): ACTIVE membership or a
 *  steward role.  A pending applicant may know the room exists but reads
 *  none of its content until a steward approves the request
 *  (WS-G.2.3b/§16.2 — the same bar `threadVisibleToUser` enforces). */
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

export type JoinOutcome =
  | { ok: true; status: 'active' | 'pending'; subscription: RoomSubscriptionRecord }
  | { ok: false; code: 'not_found'; message: string };

/** WS-G.2.3d join: public rooms join immediately; restricted/expert_led
 *  create a pending request.  Idempotent: re-joining returns the existing
 *  subscription unchanged. */
export async function joinRoom(
  forum: ForumServices,
  room: RoomRecord,
  userId: string,
  nowIso: string,
): Promise<JoinOutcome> {
  const existing = await forum.rooms.getSubscription(room.roomId, userId);
  if (existing) return { ok: true, status: existing.status, subscription: existing };
  const status: RoomSubscriptionRecord['status'] =
    room.visibility === 'public' ? 'active' : 'pending';
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
