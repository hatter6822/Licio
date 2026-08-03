// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G room + lens routes (SPEC §16.1/§16.2/§16.5, §23.2 /v1/rooms).
// Listing/discovery (filters; recommendation ordered by RECENCY inputs only
// — no popularity, WS-G.2.3a), detail (lenses, stewards, §16.5 governance
// info only for non-ordinary rooms), creation (per-type authorization),
// subscription management (join/leave, restricted-
// room join requests with steward decisions), and the SCOI lens read
// (WS-G.2.4 — interpretation contexts, never scoreboards).
import { randomUUID } from 'node:crypto';
import {
  lensCreateRequestSchema,
  lensPublicSchema,
  migrationExportResponseSchema,
  migrationFreezeRequestSchema,
  migrationFreezeResponseSchema,
  migrationPurgeRequestSchema,
  migrationPurgeResponseSchema,
  RESERVED_ROOM_SLUGS,
  ROOM_CLASS_UI_LABELS,
  roomCreateRequestSchema,
  roomDetailSchema,
  roomGovernanceSettingsRequestSchema,
  roomJoinRequestBodySchema,
  roomJoinRequestDecisionSchema,
  roomJoinRequestPublicSchema,
  roomJoinResponseSchema,
  roomLensSelectionSchema,
  roomListResponseSchema,
  roomSummarySchema,
  roomTypeSchema,
  roomVisibilityChangeRequestSchema,
  roomVisibilityConflictSchema,
  storyLensesResponseSchema,
  uuidSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { getEventPipelineServices } from '../events/services.js';
import {
  exportRoomForMigration,
  freezeRoomForMigration,
  purgeRoomForMigration,
} from '../forum/migration-export.js';
import { changeRoomVisibility, updateRoomGovernanceSettings } from '../forum/room-visibility.js';
import {
  authorizeRoomCreate,
  compareRecommended,
  isRoomSteward,
  joinRoom,
  resolveRoomCreateAxes,
  roomContentVisibleToUser,
  roomMatchesQuery,
  roomTypeMetadata,
  roomVisibleToUser,
  setMembershipLens,
  slugify,
  storyReadableByUser,
  toRoomSummary,
} from '../forum/rooms.js';
import { getForumServices } from '../forum/services.js';
import type { LensRecord, RoomRecord } from '../forum/stores.js';
import { checkGovernanceEligibility } from '../governance/eligibility.js';
import { getGovernanceService } from '../governance/services.js';
import type { Role } from '../identity/rbac.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { readSessionToken, validateSession } from '../identity/sessions.js';
import { getIngestionServices } from '../ingestion/services.js';
import { zValidator } from '../lib/validate.js';
import {
  type AuthEnv,
  authMiddleware,
  getAuth,
  requireUnrestricted,
  requireVerifiedAccount,
} from '../middleware/auth.js';
import { isPlatformStaff } from '../moderation/authz.js';

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
  // A non-active account resolves as ANONYMOUS (codex on PR #146): these soft
  // read paths never run authMiddleware's account-state check, and a
  // suspended account's still-valid session must not keep member/steward/
  // admin visibility the authenticated routes would refuse it.
  //
  // `restricted` IS ADMITTED, because the restrict sanction costs the WRITE
  // paths and not the account: `authMiddleware` lets it through, `/auth/status`
  // reports it authenticated, and the member is allowed in precisely so they can
  // read, appeal, and exercise data rights.  Collapsing it to anonymous here
  // hid member-only lenses and steward state from a member who still holds
  // both — the authenticated routes and this soft resolver disagreeing about
  // the same account.  Suspended, deleted, and deactivated stay anonymous.
  if (user?.accountState !== 'active' && user?.accountState !== 'restricted') {
    return { userId: null, roles: [] };
  }
  return { userId, roles: user.roles };
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
                // WS-S §8 — never list a P2P shell, on any path. A p2p room has
                // no server subscription row so this should be unreachable; the
                // guard keeps the rule uniform rather than resting on that.
                if (room.storageMode !== 'server') continue;
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
              // A cursor that RESOLVES starts the page after it; one that does
              // not starts at the beginning — so accepting any room id here
              // lets a caller probe existence by watching where the page
              // begins. Only a server room may position this keyset, which
              // makes a P2P id indistinguishable from a nonexistent one.
              if (lastRoom && lastRoom.storageMode === 'server') {
                after = { createdAt: lastRoom.createdAt, id: lastRoom.roomId };
              }
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
        // WS-J restrict sanction: a restricted account may not create public
        // content, and a public room is a public-facing artifact others post
        // into. authorizeRoomCreate only gates by ROLE, so without this a
        // restricted user could keep spinning up public rooms.
        requireUnrestricted(),
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
            // WS-G.2.2 — a new room's creator starts Undecided (they can pick a
            // posting lens later via the room's lens control).
            lensId: null,
            requestId: randomUUID(),
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
        // WS-S §8/§21 — a Private P2P shell is NOT a server room surface, and
        // this read resolves an arbitrary id directly. Without the guard,
        // anyone holding or probing an `unlisted` `room_server_id` could
        // confirm the room exists and read its shell here, which defeats the
        // identical-404 contract `GET /v1/private-rooms/:id/bootstrap` enforces
        // one route away. The same `notFound` the unknown-id case returns, so
        // this adds no oracle of its own. (The list paths reach the same
        // conclusion through `roomVisibleToUser`; this path never calls it.)
        if (room.storageMode !== 'server') return c.json(notFound, 404);
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
        // ONE read for the whole steward list, not a serial point lookup each:
        // the batch getter already exists, and this is the room-shell path every
        // visitor hits.  A steward whose account is gone is simply absent from
        // the result and filtered out below, exactly as before.
        const resolveHandles = new Map<string, { handle: string; displayName: string | null }>();
        for (const user of await identity.store.getUsersByIds(
          stewards.map((steward) => steward.userId),
        )) {
          resolveHandles.set(user.userId, { handle: user.handle, displayName: user.displayName });
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
            // WS-Q.5.3c — gates the steward-only room-settings UI.  Mirrors
            // the ACTION gate (`isRoomSteward`) — the flag must render the
            // affordances for whoever the settings routes actually authorize —
            // and stays false on a p2p stub, whose server action surface is
            // absent (WS-S §8).
            is_steward:
              userId !== null &&
              room.storageMode === 'server' &&
              (await isRoomSteward(forum, roomId, userId, roles)),
            // WS-G.2.2 — the member's chosen POSTING lens (null = Undecided, the
            // default). Drives the composer's posting lens + the lens control.
            my_lens_id: subscription?.lensId ?? null,
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
        // WS-G.2.2 — the join body carries the member's chosen POSTING lens
        // (`lens_id` omitted/null = the default "Undecided").  The web client
        // (the sole caller) always sends a body; an empty `{}` joins as Undecided.
        zValidator('json', roomJoinRequestBodySchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId } = c.req.valid('param');
          const { lens_id } = c.req.valid('json');
          const forum = getForumServices();
          const ingestion = getIngestionServices();
          const room = await forum.rooms.getById(roomId);
          if (!room) return c.json(notFound, 404);
          const outcome = await joinRoom(
            forum,
            room,
            auth.userId,
            new Date(forum.now()).toISOString(),
            lens_id ?? null,
          );
          if (!outcome.ok) {
            if (outcome.code === 'invalid_lens') {
              return c.json(deny('invalid_lens', outcome.message), 400);
            }
            return c.json(notFound, 404);
          }
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

      // --- Posting lens (WS-G.2.2): the SOLE way to change the lens a member
      // posts through — decoupled from the reading/filter lens so a member never
      // accidentally posts as a lens they were only viewing.  `null` = Undecided.
      .put(
        '/rooms/:roomId/lens',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema })),
        zValidator('json', roomLensSelectionSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId } = c.req.valid('param');
          const { lens_id } = c.req.valid('json');
          const forum = getForumServices();
          const room = await forum.rooms.getById(roomId);
          if (!room) return c.json(notFound, 404);
          // Lenses are tier-two CONTENT: a private-room outsider gets 404 (no
          // membership oracle), matching the lens read + detail bars.
          if (!(await roomContentVisibleToUser(forum, room, auth.userId))) {
            return c.json(notFound, 404);
          }
          const outcome = await setMembershipLens(forum, room, auth.userId, lens_id);
          if (!outcome.ok) {
            if (outcome.code === 'not_member') {
              return c.json(deny('not_member', outcome.message), 409);
            }
            return c.json(deny('invalid_lens', outcome.message), 400);
          }
          return c.json(
            roomLensSelectionSchema.parse({ lens_id: outcome.subscription.lensId }),
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
          // WS-S §8: a p2p stub has no server-side join surface (joins bounce
          // invite_only, membership is MLS on the members' devices).
          const joinRoomRecord = await forum.rooms.getById(roomId);
          if (joinRoomRecord?.storageMode !== 'server') {
            return c.json(notFound, 404);
          }
          if (!(await isRoomSteward(forum, roomId, auth.userId, auth.roles))) {
            return c.json(deny('forbidden', 'Steward role required'), 403);
          }
          const requests = await forum.rooms.listJoinRequests(roomId);
          // ONE read for the whole queue: the pending set is populated by third
          // parties (any account may request to join), so its size is
          // attacker-influenceable — a serial `getUser` per row turns a sock-
          // puppet flood into thousands of round trips holding a pooled
          // connection.  A requester whose account is gone is absent from the
          // batch and skipped, exactly as the per-row `if (!user) continue` did.
          const users = new Map(
            (await identity.store.getUsersByIds(requests.map((r) => r.userId))).map((user) => [
              user.userId,
              user,
            ]),
          );
          const items = [];
          for (const request of requests) {
            const user = users.get(request.userId);
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
          // WS-S §8: no server-side join surface for a p2p stub (see the list route).
          const decideRoomRecord = await forum.rooms.getById(roomId);
          if (decideRoomRecord?.storageMode !== 'server') {
            return c.json(notFound, 404);
          }
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
          // Bot-prevention layer 3: a STEWARD rewriting the room's join/posting
          // policy exercises governance power, so it clears the KYC floor;
          // platform staff act as operators (enforcement) and are not gated.
          if (!isPlatformStaff(auth)) {
            const denial = await checkGovernanceEligibility(auth.userId);
            if (denial) return c.json({ error: denial }, 403);
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
          // Bot-prevention layer 3: flipping room visibility is steward
          // governance power → clears the KYC floor; platform staff (operators)
          // are exempt (same discipline as the treasury/governance routes).
          if (!isPlatformStaff(auth)) {
            const denial = await checkGovernanceEligibility(auth.userId);
            if (denial) return c.json({ error: denial }, 403);
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
          if (!outcome.ok) {
            // NAME the blockers.  The cascade identified every public story a
            // tier-unique collision refused to contain precisely so a steward
            // could resolve each one; serializing only `{ error }` handed back a
            // count and no way to act on it.
            if (outcome.code === 'duplicate_story') {
              return c.json(
                roomVisibilityConflictSchema.parse({
                  ...deny(outcome.code, outcome.message),
                  blocked_story_ids: outcome.blockedStoryIds,
                }),
                outcome.status,
              );
            }
            return c.json(deny(outcome.code, outcome.message), outcome.status);
          }
          return c.json({
            visibility: c.req.valid('json').visibility,
            converted: outcome.converted,
          });
        },
      )

      // --- WS-S.9 server-room → Private-P2P-room migration (PRIVATE_SPEC §24) ---
      // The destructive steps (freeze/purge) are server-enforced; the client
      // creates the P2P room + re-authors locally. Steward-only; outsiders 404.
      //
      // Phase 1/3 — export the old room's content for local re-encryption. The
      // §24.3 blocking warning rides the response so the wizard always shows the
      // honest "migration cannot make past server access impossible" disclosure.
      .post(
        '/rooms/:roomId/migration/export',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId } = c.req.valid('param');
          const outcome = await exportRoomForMigration(
            getForumServices(),
            getIngestionServices(),
            auth.userId,
            auth.roles,
            roomId,
          );
          if (!outcome.ok) return c.json(deny(outcome.code, outcome.message), outcome.status);
          return c.json(
            migrationExportResponseSchema.parse({
              room_id: outcome.roomId,
              room_name: outcome.roomName,
              room_label: ROOM_CLASS_UI_LABELS.restricted_server,
              items: outcome.items.map((item) => ({
                id: item.id,
                kind: item.kind,
                ...(item.title !== undefined ? { title: item.title } : {}),
                ...(item.summary !== undefined ? { summary: item.summary } : {}),
                ...(item.body !== undefined ? { body: item.body } : {}),
                ...(item.threadRef !== undefined ? { threadRef: item.threadRef } : {}),
                ...(item.parentRef !== undefined ? { parentRef: item.parentRef } : {}),
              })),
              frozen: outcome.frozen,
              migrated_to_room_id: outcome.migratedToRoomId,
            }),
          );
        },
      )

      // Phase 5 — freeze the old server room READ-ONLY (fail-closed: writes are
      // rejected) and record the OPAQUE P2P destination id.
      .post(
        '/rooms/:roomId/migration/freeze',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema })),
        zValidator('json', migrationFreezeRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId } = c.req.valid('param');
          const body = c.req.valid('json');
          const outcome = await freezeRoomForMigration(
            getForumServices(),
            auth.userId,
            auth.roles,
            roomId,
            body.migrated_to_room_id ?? null,
          );
          if (!outcome.ok) return c.json(deny(outcome.code, outcome.message), outcome.status);
          return c.json(
            migrationFreezeResponseSchema.parse({
              room_id: outcome.roomId,
              frozen: true,
              migrated_to_room_id: outcome.migratedToRoomId,
            }),
          );
        },
      )

      // Phase 6 — purge/minimize the old server content (gated on the room being
      // frozen first, so the §8 disclosure stays honest).
      .post(
        '/rooms/:roomId/migration/purge',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema })),
        zValidator('json', migrationPurgeRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { roomId } = c.req.valid('param');
          const { mode } = c.req.valid('json');
          const outcome = await purgeRoomForMigration(
            getForumServices(),
            getIngestionServices(),
            auth.userId,
            auth.roles,
            roomId,
            mode,
          );
          if (!outcome.ok) return c.json(deny(outcome.code, outcome.message), outcome.status);
          return c.json(
            migrationPurgeResponseSchema.parse({
              room_id: outcome.roomId,
              mode: outcome.mode,
              stories_affected: outcome.storiesAffected,
            }),
          );
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
          // WS-S §8: a p2p stub carries NO server-side lens rows (its
          // interpretation contexts live in the members' MLS-governed state) —
          // the action surface behaves as absent.
          if (room.storageMode !== 'server') return c.json(notFound, 404);
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
