// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Steward-gated WS-I operational surface (requireSteward — the same
// per-session-MFA bar as every steward action):
//
//   GET  /v1/ranking/admin/decisions            — the WS-I.2.5c audit query
//     over decision logs (six dimensions: time range, privacy bucket, item,
//     invariant name/version, constraint, experiment), keyset-paginated.
//     EVERY query is itself audited (`ranking_decision_query` meta-audit).
//   GET  /v1/ranking/admin/decisions/:requestId — one full decision log.
//   POST /v1/ranking/admin/replay/:requestId    — replay the decision at its
//     recorded versions (WS-I.2.5b); audited.
//   GET  /v1/ranking/admin/killswitch           — current kill-switch state.
//   PUT  /v1/ranking/admin/killswitch           — engage/release with the
//     §30.8 release-card fields (owner, trigger, rollback, review date);
//     audited; takes effect on the next request — no deployment.
//   PUT  /v1/ranking/admin/config               — validated runtime-config
//     writes (422 at configuration time); audited.
//   GET  /v1/ranking/admin/profiles             — active validated profiles.
//   GET  /v1/ranking/admin/health               — pipeline health snapshot.

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { getIdentityServices } from '../identity/services.js';
import { type AuthEnv, authMiddleware, getAuth, requireSteward } from '../middleware/auth.js';
import { RANKING_CONFIG_KEYS, validateRankingConfigValue } from '../ranking/config.js';
import { engageKillSwitch, readKillSwitchState, releaseKillSwitch } from '../ranking/killswitch.js';
import { replayDecision } from '../ranking/service.js';
import { getRankingServices, type RankingServices } from '../ranking/services.js';

const deny = (code: string, message: string) => ({ error: { code, message } }) as const;

const decisionsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  bucket: z.string().min(1).max(64).optional(),
  item_id: z.string().uuid().optional(),
  invariant: z.string().min(1).max(64).optional(),
  invariant_version: z.string().min(1).max(32).optional(),
  constraint: z.string().min(1).max(64).optional(),
  experiment_id: z.string().min(1).max(64).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const killSwitchBodySchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('engage'),
      global: z.boolean(),
      surfaces: z.array(z.enum(['front_page', 'room', 'topic'])).default([]),
      profile_ids: z.array(z.string().min(1).max(64)).default([]),
      owner: z.string().min(1).max(128),
      trigger_condition: z.string().min(1).max(512),
      rollback_path: z.string().min(1).max(512),
      review_date: z.string().datetime(),
    })
    .strict(),
  z.object({ action: z.literal('release') }).strict(),
]);

const configBodySchema = z
  .object({
    key: z.enum(RANKING_CONFIG_KEYS),
    value: z.record(z.string(), z.unknown()),
  })
  .strict();

export function createRankingAdminRoutes(
  resolveRanking: () => RankingServices = getRankingServices,
  resolveIdentity = getIdentityServices,
) {
  return new Hono<AuthEnv>()
    .use('*', authMiddleware(), requireSteward())

    .get('/decisions', zValidator('query', decisionsQuerySchema), async (c) => {
      const auth = getAuth(c);
      if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
      const ranking = resolveRanking();
      const query = c.req.valid('query');
      const result = await ranking.decisionLogs.query({
        ...(query.from !== undefined ? { fromIso: query.from } : {}),
        ...(query.to !== undefined ? { toIso: query.to } : {}),
        ...(query.bucket !== undefined ? { userPrivacyBucket: query.bucket } : {}),
        ...(query.item_id !== undefined ? { itemId: query.item_id } : {}),
        ...(query.invariant !== undefined ? { invariantName: query.invariant } : {}),
        ...(query.invariant_version !== undefined
          ? { invariantVersion: query.invariant_version }
          : {}),
        ...(query.constraint !== undefined ? { constraint: query.constraint } : {}),
        ...(query.experiment_id !== undefined ? { experimentId: query.experiment_id } : {}),
        ...(query.cursor !== undefined ? { afterRequestId: query.cursor } : {}),
        limit: query.limit,
      });
      // WS-I.2.5c meta-audit: who queried, what criteria, when.
      await resolveIdentity().audit.append({
        actorUserId: auth.userId,
        eventType: 'ranking_decision_query',
        context: {
          setting: 'decisions',
          new_value: JSON.stringify({
            from: query.from ?? null,
            to: query.to ?? null,
            item_id: query.item_id ?? null,
            constraint: query.constraint ?? null,
            results: result.logs.length,
          }).slice(0, 256),
        },
      });
      return c.json({ decisions: result.logs, nextCursor: result.nextCursor });
    })

    .get(
      '/decisions/:requestId',
      zValidator('param', z.object({ requestId: z.string().uuid() })),
      async (c) => {
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
        const { requestId } = c.req.valid('param');
        const log = await resolveRanking().decisionLogs.getByRequestId(requestId);
        if (log === null) return c.json(deny('not_found', 'Decision log not found'), 404);
        await resolveIdentity().audit.append({
          actorUserId: auth.userId,
          eventType: 'ranking_decision_query',
          targetRef: requestId,
          context: { setting: 'decision_detail' },
        });
        return c.json({ decision: log });
      },
    )

    .post(
      '/replay/:requestId',
      zValidator('param', z.object({ requestId: z.string().uuid() })),
      async (c) => {
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
        const { requestId } = c.req.valid('param');
        const result = await replayDecision(resolveRanking(), requestId);
        await resolveIdentity().audit.append({
          actorUserId: auth.userId,
          eventType: 'ranking_replay_run',
          targetRef: requestId,
          context: { setting: 'replay', new_value: result.match ? 'match' : 'mismatch' },
        });
        if (result.problems.includes('decision log not found')) {
          return c.json(deny('not_found', 'Decision log not found'), 404);
        }
        return c.json({ replay: result });
      },
    )

    .get('/killswitch', async (c) => {
      const state = await readKillSwitchState(resolveRanking().events);
      return c.json({
        state: state === 'invalid' ? null : state,
        unreadable: state === 'invalid',
      });
    })

    .put('/killswitch', zValidator('json', killSwitchBodySchema), async (c) => {
      const auth = getAuth(c);
      if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
      const ranking = resolveRanking();
      const body = c.req.valid('json');
      if (body.action === 'engage') {
        if (!body.global && body.surfaces.length === 0 && body.profile_ids.length === 0) {
          return c.json(
            deny('invalid_scope', 'Engage requires a global, surface, or profile scope'),
            422,
          );
        }
        const state = await engageKillSwitch(
          ranking.events,
          {
            global: body.global,
            surfaces: body.surfaces,
            profileIds: body.profile_ids,
            owner: body.owner,
            triggerCondition: body.trigger_condition,
            rollbackPath: body.rollback_path,
            reviewDate: body.review_date,
          },
          new Date(ranking.now()).toISOString(),
        );
        await resolveIdentity().audit.append({
          actorUserId: auth.userId,
          eventType: 'ranking_killswitch_change',
          context: {
            setting: 'engage',
            new_value: JSON.stringify({
              global: state.global,
              surfaces: state.surfaces,
              profile_ids: state.profile_ids,
              reason: state.trigger_condition,
            }).slice(0, 256),
          },
        });
        return c.json({ engaged: true, state });
      }
      await releaseKillSwitch(ranking.events, auth.userId);
      await resolveIdentity().audit.append({
        actorUserId: auth.userId,
        eventType: 'ranking_killswitch_change',
        context: { setting: 'release' },
      });
      return c.json({ engaged: false });
    })

    .put('/config', zValidator('json', configBodySchema), async (c) => {
      const auth = getAuth(c);
      if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
      const { key, value } = c.req.valid('json');
      // Config-time rejection (the house rule): an invalid value never lands.
      const problem = validateRankingConfigValue(key, value);
      if (problem !== null) return c.json(deny('invalid_config', problem), 422);
      const ranking = resolveRanking();
      await ranking.events.configStore.set(key, value);
      await ranking.reloadConfig();
      await resolveIdentity().audit.append({
        actorUserId: auth.userId,
        eventType: 'ranking_config_change',
        context: { setting: key },
      });
      ranking.log('ranking.config.changed', { key });
      return c.json({ key, ok: true });
    })

    .get('/profiles', (c) => {
      const config = resolveRanking().config();
      return c.json({
        profiles: config.profiles.map((p) => ({
          profile_id: p.profile_id,
          profile_version: p.profile_version,
          weights: p.weights,
          penalties: p.penalties,
          selector: p.selector,
        })),
      });
    })

    .get('/health', async (c) => {
      const ranking = resolveRanking();
      const killSwitch = await readKillSwitchState(ranking.events);
      return c.json({
        decision_logs: await ranking.decisionLogs.count(),
        profiles_loaded: ranking.config().profiles.length,
        retrievers: ranking.retrievers.origins(),
        killswitch_engaged:
          killSwitch === 'invalid' ||
          (killSwitch !== null &&
            (killSwitch.global ||
              killSwitch.surfaces.length > 0 ||
              killSwitch.profile_ids.length > 0)),
      });
    });
}
