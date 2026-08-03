// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J user-facing trust & safety routes (SPEC §18.3/§18.4/§23.2): reports
// (WS-J.1.1), blocks (WS-J.1.2a), mutes (WS-J.1.2b), appeals (WS-J.1.3),
// the published support contact (WS-J.1.1e, UNAUTHENTICATED), and the user
// moderation-notice inbox (WS-J.1.3d).  Reporter identity is never returned.
// Every response is re-validated against the shared schema on egress.

import {
  appealCreatedResponseSchema,
  appealEligibilityViewSchema,
  blockListResponseSchema,
  blockRecordSchema,
  createAppealRequestSchema,
  createBlockRequestSchema,
  createMuteRequestSchema,
  createReportRequestSchema,
  moderationNoticeListResponseSchema,
  muteListResponseSchema,
  muteRecordSchema,
  okResponseSchema,
  reportCreatedResponseSchema,
  supportContactResponseSchema,
  uuidSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { roomVisibleToUser } from '../forum/rooms.js';
import { getForumServices } from '../forum/services.js';
import { getIdentityServices } from '../identity/services.js';
import { zValidator } from '../lib/validate.js';
import { type AuthEnv, authMiddleware, getAuth } from '../middleware/auth.js';
import { checkEligibility, submitAppeal } from '../moderation/appeals.js';
import { listNotices } from '../moderation/notices.js';
import {
  createBlock,
  createMute,
  listBlocks,
  listMutes,
  removeBlock,
  removeMute,
} from '../moderation/relations.js';
import { submitReport } from '../moderation/reports.js';
import { getModerationServices } from '../moderation/services.js';
import { buildSupportContact } from '../moderation/support.js';
import { getPrivateRoomStubService } from '../private-rooms/service.js';

const deny = (code: string, message: string) => ({ error: { code, message } });

/** Single-param path validator (`:id` → `{ [name]: uuid }`). */
const uuidParam = <K extends string>(name: K) =>
  z.object({ [name]: uuidSchema } as Record<K, typeof uuidSchema>);

/**
 * Resolve a block/mute target given EITHER form of the request (WS-J.1.2).  A
 * reader on a content surface holds the author's public handle and never a user
 * id (§19.5 keeps `author_user_id` off the public projection), so the handle form
 * is the one the UI uses; both collapse to the same `{ userId, handle }` here so
 * the self-target guard and the create path stay single-implementation.
 * Returns null when no such account exists (the caller answers 404).
 */
async function resolveTargetUser(
  ref: { userId: string } | { handle: string },
): Promise<{ userId: string; handle: string } | null> {
  const store = getIdentityServices().store;
  const user =
    'userId' in ref ? await store.getUser(ref.userId) : await store.getUserByHandle(ref.handle);
  return user ? { userId: user.userId, handle: user.handle } : null;
}

/**
 * Decorate a block/mute page with each target's public handle so the management
 * list can NAME who is blocked or muted rather than printing a truncated opaque
 * id.  Handles are looked up once per DISTINCT target — a page holds at most 50
 * rows of indexed point lookups, and the dedupe keeps it O(distinct) by
 * construction.  A deleted account still resolves: `tombstoneUser` REPLACES the
 * handle with a `deleted_<hash>` form rather than dropping the row, so the list
 * never loses a block that is still in force.  The placeholder is reachable only
 * if a relation row outlives its user row (an FK violation), and a named row is
 * still better there than a dropped one.
 */
async function withHandles<K extends string, H extends string, T extends Record<K, string>>(
  rows: readonly T[],
  idKey: K,
  handleKey: H,
): Promise<Array<T & Record<H, string>>> {
  const handles = new Map<string, string>();
  await Promise.all(
    [...new Set(rows.map((row) => row[idKey]))].map(async (userId) => {
      const user = await getIdentityServices().store.getUser(userId);
      if (user) handles.set(userId, user.handle);
    }),
  );
  return rows.map(
    (row) =>
      ({ ...row, [handleKey]: handles.get(row[idKey]) ?? 'unknown' }) as T & Record<H, string>,
  );
}

export function createTrustSafetyRoutes() {
  return (
    new Hono<AuthEnv>()
      // --- Support contact (UNAUTHENTICATED; WS-J.1.1e) --------------------
      .get(
        '/support-contact',
        zValidator(
          'query',
          z.object({
            jurisdiction: z
              .string()
              .regex(/^[A-Za-z]{2}$/)
              .optional(),
          }),
        ),
        (c) => {
          const { jurisdiction } = c.req.valid('query');
          return c.json(
            supportContactResponseSchema.parse(buildSupportContact(jurisdiction ?? null)),
          );
        },
      )

      // --- Reports (WS-J.1.1a) --------------------------------------------
      .post(
        '/reports',
        authMiddleware(),
        zValidator('json', createReportRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const request = c.req.valid('json');
          const mod = getModerationServices();
          // Resolve target existence (against a tombstone where applicable).  For
          // content, the resolver also yields the AUTHORITATIVE kind (story/
          // thread/contribution); we forward it so the case/report/event record
          // the resolved kind, never a missing or misstated client hint.
          let resolvedContentKind: Awaited<
            ReturnType<typeof mod.content.resolveTarget>
          >['contentKind'] = null;
          // The user the case is about — the account itself, or the content's
          // author — stored on the case for the `target_user` queue filter.
          let resolvedSubjectUserId: string | null = null;
          if (request.target_type === 'account') {
            const target = await getIdentityServices().store.getUser(request.target_id);
            if (!target) return c.json(deny('target_not_found', 'Target not found'), 404);
            resolvedSubjectUserId = request.target_id;
          } else if (request.target_type === 'content') {
            const resolution = await mod.content.resolveTarget('content', request.target_id);
            if (!resolution.exists)
              return c.json(deny('target_not_found', 'Target not found'), 404);
            // 404-over-403 read bar (WS-Q.3.2): a reporter who cannot READ the
            // content cannot file against it — else existence of private /
            // `room_only` content leaks through the report endpoint.  Resolved
            // through the SAME visibility gate as a direct content read; an
            // unreadable target is 404, identical to a nonexistent one.  A port
            // without the gate (in-memory/e2e) treats content as readable.
            if (mod.content.canUserReadContent) {
              const readable = await mod.content.canUserReadContent(
                request.target_id,
                resolution.contentKind,
                auth.userId,
              );
              if (!readable) return c.json(deny('target_not_found', 'Target not found'), 404);
            }
            resolvedContentKind = resolution.contentKind;
            resolvedSubjectUserId = resolution.subjectUserId;
          } else if (request.target_type === 'room') {
            // A room report must reference a real room — otherwise a user could
            // open a moderation case against an arbitrary/nonexistent UUID.
            //
            // "Real" means a SERVER room — OR a P2P room whose directory record
            // is publicly LISTED.
            //
            // Rejecting every p2p shell closed an oracle and closed the only
            // intake for the remedy §11.4 actually specifies: staff delisting an
            // abusive public name. A listed room publishes that name to anyone
            // browsing, so a report about it can reach moderation without
            // telling anyone anything they could not already read — and the
            // report is about the LISTING, which is the only thing staff can
            // act on.
            //
            // `unlisted` stays rejected, identically to an unknown id: its
            // existence is what the blind token protects, and it publishes no
            // name to be abusive with.
            const forum = getForumServices();
            const room = await forum.rooms.getById(request.target_id);
            if (!room) return c.json(deny('target_not_found', 'Target not found'), 404);
            const reportable =
              (await roomVisibleToUser(forum, room, auth.userId)) ||
              (await getPrivateRoomStubService().isPubliclyListed(request.target_id));
            if (!reportable) return c.json(deny('target_not_found', 'Target not found'), 404);
          }
          const outcome = await submitReport(
            mod,
            auth.userId,
            request,
            resolvedContentKind,
            resolvedSubjectUserId,
          );
          if (!outcome.ok) {
            // WS-N.2.3e: key-like material blocked with the standing warning
            // (the matched value was discarded, never stored or echoed).
            if (outcome.code === 'key_material_blocked') {
              return c.json(
                { error: { code: 'key_material_blocked', message: outcome.message } },
                422,
              );
            }
            return c.json(
              {
                error: {
                  code: 'rate_limited',
                  message: 'Too many reports',
                  retry_after: outcome.retryAfter,
                },
              },
              429,
            );
          }
          return c.json(
            reportCreatedResponseSchema.parse(outcome.response),
            outcome.response.idempotent ? 200 : 201,
          );
        },
      )

      // --- Blocks (WS-J.1.2a) ---------------------------------------------
      .get(
        '/blocks',
        authMiddleware(),
        zValidator('query', z.object({ cursor: z.string().min(1).max(512).optional() })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { cursor } = c.req.valid('query');
          const mod = getModerationServices();
          const page = await listBlocks(mod, auth.userId, cursor ?? null, 50);
          return c.json(
            blockListResponseSchema.parse({
              ...page,
              blocks: await withHandles(page.blocks, 'blocked_user_id', 'blocked_user_handle'),
            }),
          );
        },
      )
      .post(
        '/blocks',
        authMiddleware(),
        zValidator('json', createBlockRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const body = c.req.valid('json');
          const target = await resolveTargetUser(
            'blocked_user_id' in body
              ? { userId: body.blocked_user_id }
              : { handle: body.blocked_user_handle },
          );
          if (!target) return c.json(deny('user_not_found', 'User not found'), 404);
          if (target.userId === auth.userId) {
            return c.json(deny('cannot_block_self', 'You cannot block yourself'), 400);
          }
          const block = await createBlock(getModerationServices(), auth.userId, target.userId);
          return c.json(
            blockRecordSchema.parse({ ...block, blocked_user_handle: target.handle }),
            201,
          );
        },
      )
      .delete(
        '/blocks/:blockId',
        authMiddleware(),
        zValidator('param', uuidParam('blockId')),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { blockId } = c.req.valid('param');
          const ok = await removeBlock(getModerationServices(), blockId, auth.userId);
          if (!ok) return c.json(deny('not_found', 'Block not found'), 404);
          return c.json(okResponseSchema.parse({ ok: true }));
        },
      )

      // --- Mutes (WS-J.1.2b) ----------------------------------------------
      .get(
        '/mutes',
        authMiddleware(),
        zValidator('query', z.object({ cursor: z.string().min(1).max(512).optional() })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { cursor } = c.req.valid('query');
          const page = await listMutes(getModerationServices(), auth.userId, cursor ?? null, 50);
          return c.json(
            muteListResponseSchema.parse({
              ...page,
              mutes: await withHandles(page.mutes, 'muted_user_id', 'muted_user_handle'),
            }),
          );
        },
      )
      .post('/mutes', authMiddleware(), zValidator('json', createMuteRequestSchema), async (c) => {
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
        const body = c.req.valid('json');
        const target = await resolveTargetUser(
          'muted_user_id' in body
            ? { userId: body.muted_user_id }
            : { handle: body.muted_user_handle },
        );
        if (!target) return c.json(deny('user_not_found', 'User not found'), 404);
        if (target.userId === auth.userId) {
          return c.json(deny('cannot_mute_self', 'You cannot mute yourself'), 400);
        }
        const mute = await createMute(
          getModerationServices(),
          auth.userId,
          target.userId,
          body.duration,
        );
        return c.json(muteRecordSchema.parse({ ...mute, muted_user_handle: target.handle }), 201);
      })
      .delete(
        '/mutes/:muteId',
        authMiddleware(),
        zValidator('param', uuidParam('muteId')),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { muteId } = c.req.valid('param');
          const ok = await removeMute(getModerationServices(), muteId, auth.userId);
          if (!ok) return c.json(deny('not_found', 'Mute not found'), 404);
          return c.json(okResponseSchema.parse({ ok: true }));
        },
      )

      // --- Appeals (WS-J.1.3b) --------------------------------------------
      .get(
        '/appeals/eligibility/:actionId',
        authMiddleware(),
        zValidator('param', uuidParam('actionId')),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { actionId } = c.req.valid('param');
          const view = await checkEligibility(getModerationServices(), actionId, auth.userId);
          if (!view) return c.json(deny('action_not_found', 'Action not found'), 404);
          return c.json(appealEligibilityViewSchema.parse(view));
        },
      )
      .post(
        '/appeals',
        authMiddleware(),
        zValidator('json', createAppealRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const request = c.req.valid('json');
          const outcome = await submitAppeal(getModerationServices(), auth.userId, request);
          if (!outcome.ok) {
            // WS-N.2.3e: the SAME answer the report edge gives — an appeal is
            // the other free-text lane into this queue.
            if (outcome.code === 'key_material_blocked') {
              return c.json(
                { error: { code: 'key_material_blocked', message: outcome.message } },
                422,
              );
            }
            if (outcome.code === 'action_not_found') {
              return c.json(deny('action_not_found', 'Action not found'), 404);
            }
            if (outcome.code === 'appeal_already_exists') {
              return c.json(
                {
                  error: {
                    code: 'appeal_already_exists',
                    message: 'Already appealed',
                    appeal_id: outcome.appealId,
                  },
                },
                409,
              );
            }
            return c.json(
              {
                error: {
                  code: 'action_not_appealable',
                  message: 'This action is not appealable',
                  reason: outcome.reason,
                  ...(outcome.availableAt ? { available_at: outcome.availableAt } : {}),
                },
              },
              403,
            );
          }
          return c.json(appealCreatedResponseSchema.parse(outcome.response), 201);
        },
      )

      // --- Moderation notice inbox (WS-J.1.3d) ----------------------------
      .get(
        '/moderation/notices',
        authMiddleware(),
        zValidator('query', z.object({ cursor: z.string().min(1).max(512).optional() })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { cursor } = c.req.valid('query');
          return c.json(
            moderationNoticeListResponseSchema.parse(
              await listNotices(getModerationServices(), auth.userId, cursor ?? null, 30),
            ),
          );
        },
      )
      .post(
        '/moderation/notices/:noticeId/read',
        authMiddleware(),
        zValidator('param', uuidParam('noticeId')),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { noticeId } = c.req.valid('param');
          const ok = await getModerationServices().notices.markRead(
            noticeId,
            auth.userId,
            new Date(getModerationServices().now()).toISOString(),
          );
          if (!ok) return c.json(deny('not_found', 'Notice not found'), 404);
          return c.json(okResponseSchema.parse({ ok: true }));
        },
      )
  );
}

export type TrustSafetyRoutes = ReturnType<typeof createTrustSafetyRoutes>;
