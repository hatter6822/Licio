// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G room + lens routes (SPEC §16.1/§16.2/§16.5, §23.2 /v1/rooms).
// Listing/discovery (filters; recommendation ordered by RECENCY inputs only
// — no popularity, WS-G.2.3a), detail (lenses, stewards, §16.5 governance
// info only for non-ordinary rooms), creation (per-type authorization),
// subscription management (join/leave/notification preferences, restricted-
// room join requests with steward decisions), and the SCOI lens read
// (WS-G.2.4 — interpretation contexts, never scoreboards).
import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import {
  DEFAULT_ROOM_NOTIFICATION_PREFERENCES,
  lensCreateRequestSchema,
  lensPublicSchema,
  RESERVED_ROOM_SLUGS,
  roomCreateRequestSchema,
  roomDetailSchema,
  roomGovernanceSettingsRequestSchema,
  roomJoinRequestDecisionSchema,
  roomJoinRequestPublicSchema,
  roomJoinResponseSchema,
  roomListResponseSchema,
  roomNotificationPreferencesSchema,
  roomSummarySchema,
  roomTypeSchema,
  roomVisibilityChangeRequestSchema,
  storyLensesResponseSchema,
  uuidSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { getEventPipelineServices } from '../events/services.js';
import { changeRoomVisibility, updateRoomGovernanceSettings } from '../forum/room-visibility.js';
import {
  authorizeRoomCreate,
  compareRecommended,
  isRoomSteward,
  joinRoom,
  mergeNotificationPreferences,
  resolveRoomCreateAxes,
  roomContentVisibleToUser,
  roomMatchesQuery,
  roomTypeMetadata,
  roomVisibleToUser,
  slugify,
  storyReadableByUser,
  toRoomSummary,
} from '../forum/rooms.js';
import { getForumServices } from '../forum/services.js';
import type { LensRecord, RoomRecord } from '../forum/stores.js';
import { getGovernanceService } from '../governance/services.js';
import type { Role } from '../identity/rbac.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { readSessionToken, validateSession } from '../identity/sessions.js';
import { getIngestionServices } from '../ingestion/services.js';
import {
  type AuthEnv,
  authMiddleware,
  getAuth,
  requireVerifiedAccount,
} from '../middleware/auth.js';

const deny = (code: string, message: string) => ({ error: { code, message } });
const notFound = deny('not_found', 'Resource not found');

async function softUserId(
  cookieHeader: string | undefined,
  identity: IdentityServices,
): Promise<string | null> {
  const token = readSessionToken(cookieHeader);
  if (!token) return null;
  try {
    const validated = await validateSession(identity.sessions, token);
    return validated?.record.user_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Soft session resolution that also resolves the requester's PLATFORM roles, so
 * the room summary's `can_post` is computed against the SAME authority the
 * submission guard enforces (a platform expert/steward sees an experts-gated
 * room as postable). The role lookup only fires for an authenticated requester;
 * an anonymous/invalid session resolves to no roles without a store read.
 */
async function softUserContext(
  cookieHeader: string | undefined,
  identity: IdentityServices,
): Promise<{ userId: string | null; roles: readonly Role[] }> {
  const userId = await softUserId(cookieHeader, identity);
  if (userId === null) return { userId: null, roles: [] };
  const user = await identity.store.getUser(userId);
  return { userId, roles: user?.roles ?? [] };
}

function toLensPublic(lens: LensRecord) {
  return {
    lens_id: lens.lensId,
    room_id: lens.roomId,
    name: lens.name,
    lens_type: lens.lensType,
    description: lens.description,
    created_at: lens.createdAt,
  };
}

/** §16.5: governance info present ONLY for non-ordinary rooms. */
function governanceInfo(room: RoomRecord) {
  if (room.governanceMode === 'ordinary') return null;
  return {
    mode: room.governanceMode,
    note: 'This room uses a non-default governance mode. Governance actions are introduced gradually (§16.5) and never affect ranking.',
  };
}

export function createRoomsRoutes() {
  return (
    new Hono<AuthEnv>()
      // --- Listing & discovery (WS-G.2.3a) -----------------------------------
      .get(
        '/rooms',
        zValidator(
          'query',
          z.object({
            type: roomTypeSchema.optional(),
            joined: z.enum(['true', 'false']).optional(),
            recommended: z.enum(['true', 'false']).optional(),
            q: z.string().min(1).max(200).optional(),
            cursor: z.string().min(1).max(512).optional(),
            limit: z.coerce.number().int().min(1).max(50).optional(),
          }),
        ),
        async (c) => {
          const query = c.req.valid('query');
          const forum = getForumServices();
          const ingestion = getIngestionServices();
          const identity = getIdentityServices();
          const { userId, roles } = await softUserContext(c.req.header('cookie'), identity);
          const config = forum.config();
          const pageSize = Math.min(query.limit ?? config.roomPageSize, config.roomPageSizeMax);

          const joinedSet = new Set(
            userId !== null
              ? (await forum.rooms.listSubscriptionsByUser(userId))
                  .filter((s) => s.status === 'active')
                  .map((s) => s.roomId)
              : [],
          );

          let page: RoomRecord[];
          let nextCursor: string | null;

          if (query.joined === 'true' || query.recommended === 'true') {
            // `joined` enumerates the requester's OWN memberships (complete by
            // construction); `recommended` is a bounded recent-rooms SURFACE,
            // not a directory — both order deterministically and page with a
            // findIndex cursor over the assembled list.
            let rows: RoomRecord[] = [];
            if (query.joined === 'true') {
              for (const roomId of joinedSet) {
                const room = await forum.rooms.getById(roomId);
                if (!room) continue;
                if (query.type !== undefined && room.roomType !== query.type) continue;
                if (query.q !== undefined && !roomMatchesQuery(room, query.q)) continue;
                rows.push(room);
              }
              rows.sort((a, b) =>
                a.createdAt === b.createdAt
                  ? a.roomId.localeCompare(b.roomId)
                  : a.createdAt.localeCompare(b.createdAt),
              );
            } else {
              const candidates = await forum.rooms.list({
                ...(query.type !== undefined ? { roomType: query.type } : {}),
                ...(query.q !== undefined ? { query: query.q } : {}),
                limit: 1_000,
              });
              for (const room of candidates) {
                if (joinedSet.has(room.roomId)) continue;
                if (!(await roomVisibleToUser(forum, room, userId))) continue;
                rows.push(room);
              }
              // Recency-only ordering (no popularity inputs — forum/rooms.ts).
              rows = [...rows].sort(compareRecommended);
            }
            const startIndex =
              query.cursor !== undefined
                ? (() => {
                    const at = rows.findIndex((room) => room.roomId === query.cursor);
                    return at >= 0 ? at + 1 : 0;
                  })()
                : 0;
            page = rows.slice(startIndex, startIndex + pageSize);
            const last = page[page.length - 1];
            nextCursor = startIndex + page.length < rows.length && last ? last.roomId : null;
          } else {
            // Directory listing: walk the store-level `(created_at, id)`
            // keyset until a full visible page accumulates — no fixed fetch
            // prefix can strand rooms beyond it.  The cursor is the last room
            // id of the page; the scan is bounded per request and resumes
            // exactly (the keyset survives inserts).
            let after: { createdAt: string; id: string } | null = null;
            if (query.cursor !== undefined) {
              const lastRoom = await forum.rooms.getById(query.cursor);
              if (lastRoom) after = { createdAt: lastRoom.createdAt, id: lastRoom.roomId };
            }
            const visible: RoomRecord[] = [];
            let exhausted = false;
            const BATCH = 200;
            const MAX_BATCHES = 25;
            for (let scan = 0; scan < MAX_BATCHES && visible.length <= pageSize; scan += 1) {
              const batch = await forum.rooms.list({
                ...(query.type !== undefined ? { roomType: query.type } : {}),
                ...(query.q !== undefined ? { query: query.q } : {}),
                after,
                limit: BATCH,
              });
              for (const room of batch) {
                if (visible.length > pageSize) break;
                if (await roomVisibleToUser(forum, room, userId)) visible.push(room);
              }
              const lastScanned = batch[batch.length - 1];
              if (!lastScanned || batch.length < BATCH) {
                exhausted = true;
                break;
              }
              after = { createdAt: lastScanned.createdAt, id: lastScanned.roomId };
            }
            page = visible.slice(0, pageSize);
            const last = page[page.length - 1];
            nextCursor = (visible.length > pageSize || !exhausted) && last ? last.roomId : null;
          }

          const items = [];
          for (const room of page) {
            const threadCount = await ingestion.stories.countThreadsByRoom(room.roomId);
            items.push(await toRoomSummary(forum, room, threadCount, userId, roles));
          }
          return c.json(roomListResponseSchema.parse({ items, nextCursor }));
        },
      )

      // --- Creation (WS-G.2.3c) ----------------------------------------------
      .post(
        '/rooms',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('json', roomCreateRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const request = c.req.valid('json');
          const authz = authorizeRoomCreate(request, auth.roles);
          if (!authz.ok) return c.json(deny(authz.code, authz.message), 403);
          const forum = getForumServices();
          const slug = slugify(request.name);
          // WS-Q.1.6 — the `commons` slug is reserved for the system Commons room.
          if (RESERVED_ROOM_SLUGS.includes(slug)) {
            return c.json(deny('reserved_slug', 'That room name is reserved'), 422);
          }
          // WS-Q.3.3a — apply the documented visibility/join/posting defaults.
          const axes = resolveRoomCreateAxes(request);
          const created = await forum.rooms.insert({
            roomId: randomUUID(),
            name: request.name,
            slug,
            description: request.description,
            roomType: request.room_type,
            visibility: axes.visibility,
            joinModel: axes.joinModel,
            postingPolicy: axes.postingPolicy,
            // WS-S.1.3 — the server room-create endpoint ALWAYS mints a
            // server-storage room; a Private P2P room is created client-side
            // and never through this path (the §8 non-storage contract).
            storageMode: 'server',
            createdBy: auth.userId,
            governanceMode: 'ordinary', // ALWAYS the default (§17.4)
            charterSummary: null,
            typeMetadata: roomTypeMetadata(request),
            latestActivityAt: null,
          });
          if (!created.ok) {
            return c.json(
              deny('duplicate_room', 'A room with this name already exists for this type'),
              409,
            );
          }
          // Creator becomes community steward (WS-G.2.3c acceptance).
          await forum.rooms.addSteward({
            roomId: created.room.roomId,
            userId: auth.userId,
            role: 'community_steward',
            assignedAt: new Date(forum.now()).toISOString(),
          });
          // WS-U §16.6: bootstrap the elected-room-steward seat to the creator
          // (the first member); a Knomosis election re-seats it after the term.
          // BEST-EFFORT + isolated: the seat lives in the separate `knomosis`
          // context (no shared transaction), so a governance-store hiccup must
          // never fail or roll back the room creation. `bootstrapSeat` is
          // idempotent, so a later interaction (or a manual re-bootstrap) heals a
          // missed seat.
          try {
            await getGovernanceService().bootstrapSeat(created.room.roomId, auth.userId);
          } catch (error) {
            forum.log('governance.seat_bootstrap_failed', {
              room_id: created.room.roomId,
              error: String(error),
            });
          }
          const identity = getIdentityServices();
          await identity.audit.append({
            actorUserId: auth.userId,
            eventType: 'room_steward_change',
            targetRef: created.room.roomId,
            context: { setting: 'community_steward', new_value: 'creator_auto_assigned' },
          });
          // Immediate ACTIVE self-subscription — creators are members of
          // their rooms regardless of visibility (a restricted room's
          // creator must never be a pending applicant in their own room).
          await forum.rooms.upsertSubscription({
            roomId: created.room.roomId,
            userId: auth.userId,
            status: 'active',
            requestId: randomUUID(),
            notificationPreferences: { ...DEFAULT_ROOM_NOTIFICATION_PREFERENCES },
            requestedAt: new Date(forum.now()).toISOString(),
            joinedAt: new Date(forum.now()).toISOString(),
          });
          forum.metrics.increment('rooms.created');
          return c.json(
            roomSummarySchema.parse(
              await toRoomSummary(forum, created.room, 0, auth.userId, auth.roles),
            ),
            201,
          );
        },
      )

      // --- Detail (WS-G.2.3b) --------------------------------------------------
      .get('/rooms/:roomId', zValidator('param', z.object({ roomId: uuidSchema })), async (c) => {
        const { roomId } = c.req.valid('param');
        const forum = getForumServices();
        const ingestion = getIngestionServices();
        const identity = getIdentityServices();
        const { userId, roles } = await softUserContext(c.req.header('cookie'), identity);
        const room = await forum.rooms.getById(roomId);
        if (!room) return c.json(notFound, 404);
        // WS-Q.3.1a — TIER ONE (existence) is universal: the room's shell
        // (name, description, visibility, stewards, join affordance) is visible
        // to ALL, so a private room is discoverable and joinable. TIER TWO
        // (content) — the lenses (interpretation contexts) — is members-only;
        // a non-member of a private room sees the shell with NO lens content.
        const canReadContent = await roomContentVisibleToUser(forum, room, userId);
        const threadCount = await ingestion.stories.countThreadsByRoom(roomId);
        const summary = await toRoomSummary(forum, room, threadCount, userId, roles);
        const lenses = canReadContent ? await forum.lenses.listByRoom(roomId) : [];
        const stewards = await forum.rooms.listStewards(roomId);
        const resolveHandles = new Map<string, { handle: string; displayName: string | null }>();
        for (const steward of stewards) {
          if (!resolveHandles.has(steward.userId)) {
            const user = await identity.store.getUser(steward.userId);
            if (user) {
              resolveHandles.set(steward.userId, {
                handle: user.handle,
                displayName: user.displayName,
              });
            }
          }
        }
        const subscription =
          userId !== null ? await forum.rooms.getSubscription(roomId, userId) : null;
        return c.json(
          roomDetailSchema.parse({
            ...summary,
            lenses: lenses.map(toLensPublic),
            stewards: stewards
              .filter((s) => resolveHandles.has(s.userId))
              .map((s) => ({
                user_handle: resolveHandles.get(s.userId)?.handle ?? '',
                display_name: resolveHandles.get(s.userId)?.displayName ?? null,
                role: s.role,
                assigned_at: s.assignedAt,
              })),
            governance: governanceInfo(room),
            charter_summary: room.charterSummary,
            join_pending: subscription?.status === 'pending',
            // WS-Q.5.3c — gates the steward-only room-settings UI.
            is_steward: userId !== null && stewards.some((s) => s.userId === userId),
          }),
        );
      })

      // --- Room threads (paginated, most recent first; WS-G.2.3b) -------------
      .get(
        '/rooms/:roomId/threads',
        zValidator('param', z.object({ roomId: uuidSchema })),
        zValidator('query', z.object({ cursor: z.string().min(1).max(512).optional() })),
        async (c) => {
          const { roomId } = c.req.valid('param');
          const { cursor } = c.req.valid('query');
          const forum = getForumServices();
          const ingestion = getIngestionServices();
          const identity = getIdentityServices();
          const userId = await softUserId(c.req.header('cookie'), identity);
          const room = await forum.rooms.getById(roomId);
          if (!room) return c.json(notFound, 404);
          // WS-Q.3.2 — room threads are CONTENT (tier two): a private-room
          // outsider/pending applicant gets 404 (404-over-403; no membership oracle).
          if (!(await roomContentVisibleToUser(forum, room, userId))) {
            return c.json(notFound, 404);
          }
          let before: { createdAt: string; threadId: string } | null = null;
          if (cursor !== undefined) {
            const [createdAt, threadId] = cursor.split('~');
            if (createdAt && threadId) before = { createdAt, threadId };
          }
          const threads = await ingestion.stories.listThreadsByRoom(roomId, before, 20);
          const items = [];
          for (const thread of threads) {
            const story = await ingestion.stories.getById(thread.storyId);
            if (!story || story.hiddenState !== null) continue;
            const counts = await forum.contributions.countByType(thread.threadId, ['published']);
            items.push({
              thread_id: thread.threadId,
              story_id: thread.storyId,
              room_id: thread.roomId,
              branch_index: thread.branchIndex,
              title: story.title,
              conversation_state: thread.conversationState,
              safety_state: thread.safetyState,
              contribution_count: Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0),
              created_at: thread.createdAt,
              updated_at: thread.updatedAt,
            });
          }
          const last = threads[threads.length - 1];
          const nextCursor =
            threads.length === 20 && last ? `${last.createdAt}~${last.threadId}` : null;
          return c.json({ items, nextCursor });
        },
      )

      // --- Subscription management (WS-G.2.3d) ---------------------------------
      .post(
        '/rooms/:roomId/join',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId } = c.req.valid('param');
          const forum = getForumServices();
          const ingestion = getIngestionServices();
          const room = await forum.rooms.getById(roomId);
          if (!room) return c.json(notFound, 404);
          const outcome = await joinRoom(
            forum,
            room,
            auth.userId,
            new Date(forum.now()).toISOString(),
          );
          if (!outcome.ok) return c.json(notFound, 404);
          const threadCount = await ingestion.stories.countThreadsByRoom(roomId);
          return c.json(
            roomJoinResponseSchema.parse({
              status: outcome.status,
              room: await toRoomSummary(forum, room, threadCount, auth.userId, auth.roles),
            }),
            200,
          );
        },
      )

      .delete(
        '/rooms/:roomId/join',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId } = c.req.valid('param');
          const forum = getForumServices();
          // Leaving removes the subscription AND its preferences (one row).
          await forum.rooms.deleteSubscription(roomId, auth.userId);
          forum.metrics.increment('rooms.left');
          return c.json({ left: true });
        },
      )

      .patch(
        '/rooms/:roomId/notifications',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema })),
        zValidator('json', roomNotificationPreferencesSchema.partial()),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId } = c.req.valid('param');
          const forum = getForumServices();
          const subscription = await forum.rooms.getSubscription(roomId, auth.userId);
          if (!subscription) return c.json(notFound, 404);
          const merged = mergeNotificationPreferences(
            roomNotificationPreferencesSchema.parse({
              ...DEFAULT_ROOM_NOTIFICATION_PREFERENCES,
              ...subscription.notificationPreferences,
            }),
            c.req.valid('json'),
          );
          await forum.rooms.upsertSubscription({
            ...subscription,
            notificationPreferences: merged,
          });
          return c.json(roomNotificationPreferencesSchema.parse(merged));
        },
      )

      // Join-request decisions (stewards of the room; WS-G.2.3d).
      .get(
        '/rooms/:roomId/join-requests',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId } = c.req.valid('param');
          const forum = getForumServices();
          const identity = getIdentityServices();
          if (!(await isRoomSteward(forum, roomId, auth.userId, auth.roles))) {
            return c.json(deny('forbidden', 'Steward role required'), 403);
          }
          const requests = await forum.rooms.listJoinRequests(roomId);
          const items = [];
          for (const request of requests) {
            const user = await identity.store.getUser(request.userId);
            if (!user) continue;
            items.push(
              roomJoinRequestPublicSchema.parse({
                request_id: request.requestId,
                room_id: request.roomId,
                user_handle: user.handle,
                requested_at: request.requestedAt,
              }),
            );
          }
          return c.json({ items });
        },
      )

      .patch(
        '/rooms/:roomId/join-requests/:requestId',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema, requestId: uuidSchema })),
        zValidator('json', roomJoinRequestDecisionSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId, requestId } = c.req.valid('param');
          const { decision } = c.req.valid('json');
          const forum = getForumServices();
          const identity = getIdentityServices();
          if (!(await isRoomSteward(forum, roomId, auth.userId, auth.roles))) {
            return c.json(deny('forbidden', 'Steward role required'), 403);
          }
          const request = await forum.rooms.getJoinRequest(requestId);
          if (!request || request.roomId !== roomId || request.status !== 'pending') {
            return c.json(notFound, 404);
          }
          if (decision === 'approve') {
            await forum.rooms.upsertSubscription({
              ...request,
              status: 'active',
              joinedAt: new Date(forum.now()).toISOString(),
            });
          } else {
            await forum.rooms.deleteSubscription(request.roomId, request.userId);
          }
          await identity.audit.append({
            actorUserId: auth.userId,
            eventType: 'room_steward_change',
            targetRef: roomId,
            context: { setting: 'join_request', new_value: decision },
          });
          forum.metrics.increment(`rooms.join_${decision}`);
          return c.json({ request_id: requestId, decision });
        },
      )

      // --- Governance settings (WS-Q.3.3b): steward join/posting write -------
      .patch(
        '/rooms/:roomId/settings',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema })),
        zValidator('json', roomGovernanceSettingsRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId } = c.req.valid('param');
          const forum = getForumServices();
          if (!(await isRoomSteward(forum, roomId, auth.userId, auth.roles))) {
            return c.json(deny('forbidden', 'Steward role required'), 403);
          }
          const body = c.req.valid('json');
          const outcome = await updateRoomGovernanceSettings(
            forum,
            getIdentityServices(),
            auth.userId,
            roomId,
            {
              ...(body.join_model !== undefined ? { joinModel: body.join_model } : {}),
              ...(body.posting_policy !== undefined ? { postingPolicy: body.posting_policy } : {}),
            },
          );
          if (!outcome.ok) return c.json(deny(outcome.code, outcome.message), outcome.status);
          return c.json({ ok: true });
        },
      )

      // --- Visibility cascade (WS-Q.3.4): steward public⇄private -------------
      .post(
        '/rooms/:roomId/visibility',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema })),
        zValidator('json', roomVisibilityChangeRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId } = c.req.valid('param');
          const forum = getForumServices();
          // Governance-capable steward only; others get 404 (no oracle).
          if (!(await isRoomSteward(forum, roomId, auth.userId, auth.roles))) {
            return c.json(notFound, 404);
          }
          const outcome = await changeRoomVisibility(
            forum,
            getIngestionServices(),
            getEventPipelineServices(),
            getIdentityServices(),
            auth.userId,
            roomId,
            c.req.valid('json').visibility,
          );
          if (!outcome.ok) return c.json(deny(outcome.code, outcome.message), outcome.status);
          return c.json({
            visibility: c.req.valid('json').visibility,
            converted: outcome.converted,
          });
        },
      )

      // --- Lenses (WS-G.2.2 / WS-G.2.4) ----------------------------------------
      .get(
        '/rooms/:roomId/lenses',
        zValidator('param', z.object({ roomId: uuidSchema })),
        async (c) => {
          const { roomId } = c.req.valid('param');
          const forum = getForumServices();
          const identity = getIdentityServices();
          const userId = await softUserId(c.req.header('cookie'), identity);
          const room = await forum.rooms.getById(roomId);
          if (!room) return c.json(notFound, 404);
          // WS-Q.3.2 — lenses are CONTENT (tier two): private-room outsiders 404.
          if (!(await roomContentVisibleToUser(forum, room, userId))) {
            return c.json(notFound, 404);
          }
          const lenses = await forum.lenses.listByRoom(roomId);
          return c.json({
            items: lenses.map((lens) => lensPublicSchema.parse(toLensPublic(lens))),
          });
        },
      )

      .post(
        '/rooms/:roomId/lenses',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema })),
        zValidator('json', lensCreateRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId } = c.req.valid('param');
          const forum = getForumServices();
          const room = await forum.rooms.getById(roomId);
          if (!room) return c.json(notFound, 404);
          if (!(await isRoomSteward(forum, roomId, auth.userId, auth.roles))) {
            return c.json(deny('forbidden', 'Steward role required'), 403);
          }
          const request = c.req.valid('json');
          const created = await forum.lenses.insert({
            lensId: randomUUID(),
            roomId,
            name: request.name,
            lensType: request.lens_type,
            description: request.description ?? null,
          });
          if (!created.ok) {
            return c.json(deny('duplicate_lens', 'This room already has a lens of that type'), 409);
          }
          forum.metrics.increment('lenses.created');
          return c.json(lensPublicSchema.parse(toLensPublic(created.lens)), 201);
        },
      )

      // SCOI lens read (WS-G.2.4): lens-grouped contributions + divergence.
      .get(
        '/stories/:storyId/lenses',
        zValidator('param', z.object({ storyId: uuidSchema })),
        async (c) => {
          const { storyId } = c.req.valid('param');
          const forum = getForumServices();
          const ingestion = getIngestionServices();
          const identity = getIdentityServices();
          const userId = await softUserId(c.req.header('cookie'), identity);
          const story = await ingestion.stories.getById(storyId);
          if (!story || story.hiddenState !== null) return c.json(notFound, 404);
          // WS-Q.3.2 — the item read bar: a room_only story in a private room is
          // 404 to non-members (404-over-403, consistent with the story detail —
          // no existence oracle, unlike the prior empty-200 for outsiders).
          const room = await forum.rooms.getById(story.roomId);
          if (room === null || !(await storyReadableByUser(forum, story, room, userId))) {
            return c.json(notFound, 404);
          }
          const thread = await ingestion.stories.getThreadByStoryId(storyId);
          if (!thread) {
            return c.json(
              storyLensesResponseSchema.parse({ story_id: storyId, groups: [], divergence: null }),
            );
          }
          const lenses = thread.roomId !== null ? await forum.lenses.listByRoom(thread.roomId) : [];
          const tagged = await forum.contributions.listLensTagged([thread.threadId], 700);
          const groups = lenses
            .map((lens) => ({
              lens: toLensPublic(lens),
              contribution_ids: tagged
                .filter((row) => row.metadata.lens_id === lens.lensId)
                .map((row) => row.contributionId)
                .slice(0, 100),
            }))
            .filter((group) => group.contribution_ids.length > 0);
          // SCOI divergence (WS-H.4): absent gracefully until it runs.
          return c.json(
            storyLensesResponseSchema.parse({ story_id: storyId, groups, divergence: null }),
          );
        },
      )
  );
}

export type RoomsRoutes = ReturnType<typeof createRoomsRoutes>;
