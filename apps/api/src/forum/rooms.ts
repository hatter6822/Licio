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
  RoomPostingPolicy,
  RoomStewardRole,
  RoomSummary,
  RoomVisibility,
  StoryVisibility,
} from '@licio/shared';
import { COMMONS_ROOM_ID, COMMONS_SLUG } from '@licio/shared';
import type { Role } from '../identity/rbac.js';
import type { StoryHiddenState } from '../ingestion/stores.js';
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
    storageMode: 'server',
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
  // A PUBLIC room MUST use the `open` join model (the rooms_public_join_open
  // CHECK). FORCE it whenever the resolved visibility is public — even if the
  // client sent `request_approval`/`invite` while OMITTING visibility (the
  // schema's explicit-public coherence refinement does not fire in that default
  // case), so the resolved axes are always coherent, never a 500 at insert.
  const joinModel: RoomJoinModel =
    visibility === 'public' ? 'open' : (request.join_model ?? 'request_approval');
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
  requesterRoles: readonly Role[] = [],
): Promise<RoomSummary> {
  const memberCount = await forum.rooms.countMembers(room.roomId);
  const subscription =
    requesterUserId !== null
      ? await forum.rooms.getSubscription(room.roomId, requesterUserId)
      : null;
  // can_post: a public room auto-joins on post (so all_members ⇒ postable even
  // unjoined); a private room needs membership; experts_and_stewards needs the
  // steward/expert bar. The requester's PLATFORM roles are passed through so the
  // composer's can_post matches the authoritative submit-time check (a platform
  // expert/steward sees an experts room as postable). The server re-checks at
  // submit either way.
  const canPost =
    requesterUserId !== null &&
    (await userMayPostTopLevel(forum, room, requesterUserId, requesterRoles));
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
    can_post: canPost,
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
 * visibility class, join affordance — is visible to ALL, so private SERVER rooms
 * are DISCOVERABLE and JOINABLE (§16.1). This is a deliberate semantic change
 * from the shipped restricted-room behavior: `roomVisibleToUser` returns true
 * for every server room, public or private, for any user including signed-out.
 * It is NOT gated by subscription. Never use this for content-bearing reads —
 * that is `roomContentVisibleToUser` (tier two).
 *
 * WS-S §8/§21 — a Private P2P room is the ONE exception, and it is not a
 * visibility rule so much as a surface rule: its server row is a bootstrap SHELL
 * with an opaque name (the real display metadata lives on the §8.2 directory
 * stub, `listed`-only), it has no server join/steward/lens/content surface, and
 * its discovery endpoint is `GET /v1/private-rooms/:id/bootstrap`. Listing the
 * shell here would publish the EXISTENCE of every `unlisted` room — the mode's
 * whole purpose — and render a `listed` one through a server room summary whose
 * affordances do not apply to it.
 */
export async function roomVisibleToUser(
  _forum: ForumServices,
  room: RoomRecord,
  _userId: string | null,
): Promise<boolean> {
  return room.storageMode === 'server';
}

/** CONTENT visibility (threads, lenses, detail): public rooms are readable by
 *  all; a PRIVATE room requires ACTIVE membership, a room steward role, or —
 *  the 2026-07 maintainer decision — the platform ADMIN role.  A pending
 *  applicant may know the room exists (tier one) but reads none of its content
 *  until a steward approves the request (§16.2 — the bar `storyReadableByUser`
 *  and `threadVisibleToUser` compose). */
export async function roomContentVisibleToUser(
  forum: ForumServices,
  room: RoomRecord,
  userId: string | null,
): Promise<boolean> {
  // A Private P2P room has no server content to be visible, and answering
  // anything but "no" here is an existence oracle: its shell row exists only to
  // give the §8.2 stub a `room_server_id`, so a surface that resolves an
  // arbitrary id and then asks this question would confirm an `unlisted` room to
  // anyone who guessed or obtained its id — the identical-404 contract
  // `GET /v1/private-rooms/:id/bootstrap` enforces, undone through a different
  // endpoint. FIRST, before the visibility ladder, so the platform ADMIN branch
  // below cannot reach it either: the 2026-07 decision gives admin every server
  // room and explicitly not a member-hosted one.
  if (room.storageMode !== 'server') return false;
  if (room.visibility === 'public') return true;
  if (userId === null) return false;
  const subscription = await forum.rooms.getSubscription(room.roomId, userId);
  if (subscription?.status === 'active') return true;
  const roles = await forum.rooms.stewardRolesFor(room.roomId, userId);
  if (roles.length > 0) return true;
  // Platform-ADMIN arm (2026-07 maintainer decision): admin is the final line
  // of defense and reads every SERVER-hosted area, private rooms included —
  // the platform already holds this data, and admin already carries all five
  // doctrine roles on the moderation console.  STRUCTURALLY scoped to
  // `storageMode === 'server'`: a WS-S member-hosted (p2p) room has no
  // server-side content to read and stays excluded by construction.  The
  // platform `steward` role deliberately does NOT get this arm (its private-
  // room oversight path is the console), and an unwired reader (null seam)
  // fails closed.
  if (room.storageMode !== 'server') return false;
  const platformRoles = (await forum.platformRolesReader?.(userId)) ?? [];
  return platformRoles.includes('admin');
}

/**
 * WS-Q.3.1b — the single chokepoint for "may create top-level content here":
 * the user passes the content bar AND (the room admits all members OR the user
 * is a room/platform steward OR the user holds the platform `expert` role).
 * Consumed by the submission guard (WS-Q.2.1b) and the composer's postable-room
 * filter (WS-Q.5.1a). The `experts_and_stewards` bar is satisfied by room or
 * platform stewards and by platform experts; finer per-user expert-lens
 * assignment remains the WS-J seam.
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
  // experts_and_stewards: room/platform stewards, or a platform expert.
  return (
    platformRoles.includes('expert') || isRoomSteward(forum, room.roomId, userId, platformRoles)
  );
}

/**
 * WS-Q.3.2 — the SINGLE item-level read bar (§14.5.3/§16.1). A story is readable
 * when it is not hidden AND the reader passes the story's ROOM content bar. Per
 * SPEC §16.1, the read bar is by ROOM visibility: public rooms are readable by
 * ALL, private rooms by active members/stewards. Item `visibility`
 * (`public`/`room_only`) is a DISTRIBUTION control (which surfaces carry the
 * item), NOT a per-item read restriction — so a `room_only` item in a PUBLIC
 * room is readable by anyone who reaches that public room (the in-room chip
 * marks it), it is merely excluded from GLOBAL surfaces by the ranking gate +
 * search predicate; a `room_only` item in a PRIVATE room needs membership
 * because the ROOM is private. Item visibility never WIDENS the read bar, so a
 * public item mislabeled into a private room still fails closed for a
 * non-member. Every direct-read path (story, thread, branch, subtree,
 * contribution, the WS-H drawers) calls this; an unknown room/story is 404.
 */
export async function storyReadableByUser(
  forum: ForumServices,
  story: { hiddenState: StoryHiddenState | null; visibility: StoryVisibility },
  room: RoomRecord,
  userId: string | null,
): Promise<boolean> {
  if (story.hiddenState !== null) return false;
  return roomContentVisibleToUser(forum, room, userId);
}

export type JoinOutcome =
  | { ok: true; status: 'active' | 'pending'; subscription: RoomSubscriptionRecord }
  | { ok: false; code: 'not_found'; message: string }
  | { ok: false; code: 'invite_only'; message: string }
  | { ok: false; code: 'invalid_lens'; message: string };

/**
 * WS-G.2.2 — validate a chosen POSTING lens for a room.  `null` is always valid
 * (the default "Undecided" state present in every room); a non-null id must be
 * one of the room's own lenses.  Shared by the join path and the lens-change
 * path so the "lens belongs to this room" rule has ONE enforcement point.
 */
async function lensBelongsToRoom(
  forum: ForumServices,
  roomId: string,
  lensId: string | null,
): Promise<boolean> {
  if (lensId === null) return true;
  const lens = await forum.lenses.getById(lensId);
  return lens !== null && lens.roomId === roomId;
}

/**
 * WS-Q.3.1c — join branches on the room's `join_model` (not visibility):
 *   • `open`             ⇒ immediate `active`;
 *   • `request_approval` ⇒ a `pending` request (steward approves);
 *   • `invite`           ⇒ self-join rejected (invitations are a separate
 *                          steward action — the WS-J seam).
 * Idempotent: re-joining returns the existing subscription unchanged (the lens
 * is changed later ONLY through setMembershipLens, never a repeat join).  A
 * fresh IMMEDIATE (open) join records the member's chosen POSTING lens (WS-G.2.2)
 * — `null` (the default) means "Undecided"; a non-null lens must belong to the
 * room.  A `pending` request (a private room the applicant cannot yet read)
 * always joins as Undecided and IGNORES any supplied lens: it picks a lens later
 * via the content-gated setMembershipLens once active.  This keeps the join path
 * from validating a supplied lens against a room the applicant cannot see —
 * closing the lens-existence oracle the PUT /lens path deliberately avoids (§8.3;
 * a private room's lens ids never leak to an outsider).
 */
export async function joinRoom(
  forum: ForumServices,
  room: RoomRecord,
  userId: string,
  nowIso: string,
  lensId: string | null = null,
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
  // Only an immediate ACTIVE join (a public/open room, whose lenses the joiner
  // can already see) records the chosen lens; a pending private-room request
  // joins Undecided and validates nothing about the lens (no outsider oracle).
  const effectiveLensId = status === 'active' ? lensId : null;
  if (!(await lensBelongsToRoom(forum, room.roomId, effectiveLensId))) {
    return { ok: false, code: 'invalid_lens', message: 'The lens must belong to this room.' };
  }
  const subscription = await forum.rooms.upsertSubscription({
    roomId: room.roomId,
    userId,
    status,
    lensId: effectiveLensId,
    requestId: randomUUID(),
    requestedAt: nowIso,
    joinedAt: status === 'active' ? nowIso : null,
  });
  forum.metrics.increment(status === 'active' ? 'rooms.joined' : 'rooms.join_requested');
  return { ok: true, status, subscription };
}

export type SetMembershipLensOutcome =
  | { ok: true; subscription: RoomSubscriptionRecord }
  | { ok: false; code: 'not_member'; message: string }
  | { ok: false; code: 'invalid_lens'; message: string };

/**
 * WS-G.2.2 — set the caller's POSTING lens for a room they belong to.  This is
 * the SOLE mutation of a member's posting lens (the reading/filter lens never
 * touches it), so a member never accidentally posts as a lens they were only
 * viewing.  `null` returns them to the default "Undecided"; a non-null lens must
 * belong to the room.  Requires an existing subscription (a non-member has no
 * membership to carry a lens).
 */
export async function setMembershipLens(
  forum: ForumServices,
  room: RoomRecord,
  userId: string,
  lensId: string | null,
): Promise<SetMembershipLensOutcome> {
  if (!(await lensBelongsToRoom(forum, room.roomId, lensId))) {
    return { ok: false, code: 'invalid_lens', message: 'The lens must belong to this room.' };
  }
  const updated = await forum.rooms.setSubscriptionLens(room.roomId, userId, lensId);
  if (!updated) {
    return { ok: false, code: 'not_member', message: 'Join this room to choose a posting lens.' };
  }
  forum.metrics.increment('rooms.lens_set');
  return { ok: true, subscription: updated };
}

/** Steward gate for room-scoped actions: any of the five WS-A.2.2 roles in
 *  THIS room, a platform ADMIN (the 2026-07 final-line-of-defense decision:
 *  admin reaches everything server-hosted, and the read bar grants it the
 *  matching visibility), or a platform steward who can SEE the room.  The
 *  platform-steward arm is VISIBILITY-COUPLED: you cannot govern what you
 *  cannot read, and a platform steward's private-room oversight path is the
 *  moderation console — so its blanket arm covers public rooms and rooms it
 *  is a member of, while per-room grants stay unconditional. */
/**
 * May this account PARTICIPATE IN GOVERNANCE in this room — vote, propose, delegate,
 * or submit a knomosis action?
 *
 * Deliberately NOT `isRoomSteward`.  The governance membership check used to fall
 * through to it, and its first line is an unconditional `platformRoles.includes('admin')`
 * — so a platform admin was a member of every server room and could cast a ballot in
 * all of them, which is not what the platform intends.  The platform-`steward` arm has
 * the same effect for every room it can see, and `roomContentVisibleToUser` is true for
 * every PUBLIC room.
 *
 * `isRoomSteward` is not the wrong function, it is the wrong QUESTION: it answers "may
 * this account administer this room", where a platform-wide role is exactly the point
 * (13 call sites depend on that, and admin reach is intentional).  Governance
 * participation is a different question, and the answer is stake in the room: an active
 * subscription, or a PER-ROOM steward grant — the latter because a room steward signs
 * proposals and deposits without needing a separate subscription (WS-L.3.1a).
 *
 * This is the SAME SET the electorate roster enumerates (`listEligibleVoterIds`:
 * `room_subscriptions WHERE status='active'` UNION `room_stewards`), which is what
 * makes the ballot gate and the frozen quorum denominator agree by construction rather
 * than by two lists kept in step by hand.  `governance-membership-parity.test.ts` holds
 * the two together.
 */
export async function isGovernanceMember(
  forum: ForumServices,
  roomId: string,
  userId: string,
): Promise<boolean> {
  const subscription = await forum.rooms.getSubscription(roomId, userId);
  if (subscription !== null && subscription.status === 'active') return true;
  return (await forum.rooms.stewardRolesFor(roomId, userId)).length > 0;
}

export async function isRoomSteward(
  forum: ForumServices,
  roomId: string,
  userId: string,
  platformRoles: readonly Role[],
  requiredRoles?: readonly RoomStewardRole[],
): Promise<boolean> {
  if (platformRoles.includes('admin')) return true;
  if (platformRoles.includes('steward')) {
    const room = await forum.rooms.getById(roomId);
    if (room !== null && (await roomContentVisibleToUser(forum, room, userId))) return true;
  }
  const roles = await forum.rooms.stewardRolesFor(roomId, userId);
  if (roles.length === 0) return false;
  if (!requiredRoles) return true;
  return roles.some((role) => requiredRoles.includes(role));
}
