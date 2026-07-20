// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J user-facing trust & safety routes (SPEC §18.3/§18.4/§23.2): reports
// (WS-J.1.1), blocks (WS-J.1.2a), mutes (WS-J.1.2b), appeals (WS-J.1.3),
// the published support contact (WS-J.1.1e, UNAUTHENTICATED), and the user
// moderation-notice inbox (WS-J.1.3d).  Reporter identity is never returned.
// Every response is re-validated against the shared schema on egress.
import { zValidator } from '@hono/zod-validator';
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
import { getForumServices } from '../forum/services.js';
import { getIdentityServices } from '../identity/services.js';
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

const deny = (code: string, message: string) => ({ error: { code, message } });

/** Single-param path validator (`:id` → `{ [name]: uuid }`). */
const uuidParam = <K extends string>(name: K) =>
  z.object({ [name]: uuidSchema } as Record<K, typeof uuidSchema>);

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
            const room = await getForumServices().rooms.getById(request.target_id);
            if (!room) return c.json(deny('target_not_found', 'Target not found'), 404);
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
          return c.json(
            blockListResponseSchema.parse(await listBlocks(mod, auth.userId, cursor ?? null, 50)),
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
          const { blocked_user_id } = c.req.valid('json');
          if (blocked_user_id === auth.userId) {
            return c.json(deny('cannot_block_self', 'You cannot block yourself'), 400);
          }
          const target = await getIdentityServices().store.getUser(blocked_user_id);
          if (!target) return c.json(deny('user_not_found', 'User not found'), 404);
          const block = await createBlock(getModerationServices(), auth.userId, blocked_user_id);
          return c.json(blockRecordSchema.parse(block), 201);
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
          return c.json(
            muteListResponseSchema.parse(
              await listMutes(getModerationServices(), auth.userId, cursor ?? null, 50),
            ),
          );
        },
      )
      .post('/mutes', authMiddleware(), zValidator('json', createMuteRequestSchema), async (c) => {
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
        const { muted_user_id, duration } = c.req.valid('json');
        if (muted_user_id === auth.userId) {
          return c.json(deny('cannot_mute_self', 'You cannot mute yourself'), 400);
        }
        const target = await getIdentityServices().store.getUser(muted_user_id);
        if (!target) return c.json(deny('user_not_found', 'User not found'), 404);
        const mute = await createMute(
          getModerationServices(),
          auth.userId,
          muted_user_id,
          duration,
        );
        return c.json(muteRecordSchema.parse(mute), 201);
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
