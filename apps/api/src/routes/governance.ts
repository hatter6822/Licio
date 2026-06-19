// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U AI-governed-rooms HTTP surface (SPEC §16.6, §24.6). Authenticated reads
// and writes over the GovernanceService: the steward seat + elections, the
// community model/prompt registry (propose / list / download / approve), and the
// "governed by" agent view (active binding + recent agent actions). Steward-only
// actions are enforced by the service (seat-holder check); financial/treasury
// surfaces stay behind the fail-closed crypto flag in the service.

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { getGovernanceService } from '../governance/services.js';
import { type AuthEnv, authMiddleware } from '../middleware/auth.js';
import { denyCapability, type StewardActor } from '../moderation/authz.js';

const deny = (code: string, message: string) => ({ error: { code, message } }) as const;

/** Build the WS-J steward actor from the auth context (platform-floor gate). */
function stewardActorOf(auth: NonNullable<AuthEnv['Variables']['auth']>): StewardActor {
  return {
    userId: auth.userId,
    platformRoles: auth.roles,
    stewardRoles: auth.stewardRoles,
    mfaActive: auth.mfaActive,
    mfaVerified: auth.mfaVerified,
  };
}

const proposeBodySchema = z
  .object({
    bundle: z.unknown(),
    prompt_text: z.string().min(1).max(8_000),
  })
  .strict();

const voteBodySchema = z.object({ candidate_user_id: z.string().min(1).max(128) }).strict();
const approveBodySchema = z
  .object({ election_id: z.string().min(1).max(128).nullable().default(null) })
  .strict();

export function createGovernanceRoutes() {
  return (
    new Hono<AuthEnv>()
      // --- Steward seat + elections ---------------------------------------
      .get('/rooms/:roomId/steward', authMiddleware(), async (c) => {
        const svc = getGovernanceService();
        const seat = await svc.getSeat(c.req.param('roomId'));
        if (!seat) return c.json({ seat: null }, 200);
        return c.json({
          seat: {
            room_id: seat.roomId,
            holder_user_id: seat.holderUserId,
            term_start: seat.termStart,
            term_end: seat.termEnd,
            bootstrap: seat.bootstrap,
            current_election_id: seat.currentElectionId,
          },
        });
      })
      .post(
        '/rooms/:roomId/elections/:electionId/vote',
        authMiddleware(),
        zValidator('json', voteBodySchema),
        async (c) => {
          const auth = c.get('auth');
          if (!auth) return c.json(deny('unauthorized', 'Authentication required.'), 401);
          const { candidate_user_id } = c.req.valid('json');
          const result = await getGovernanceService().castVote(
            c.req.param('electionId'),
            auth.userId,
            candidate_user_id,
          );
          if (!result.ok) return c.json(deny(result.code, result.message), 409);
          return c.json({ ok: true });
        },
      )
      // --- Community model / prompt registry ------------------------------
      .post(
        '/rooms/:roomId/governance/models',
        authMiddleware(),
        zValidator('json', proposeBodySchema),
        async (c) => {
          const auth = c.get('auth');
          if (!auth) return c.json(deny('unauthorized', 'Authentication required.'), 401);
          const { bundle, prompt_text } = c.req.valid('json');
          const result = await getGovernanceService().proposeModel(
            c.req.param('roomId'),
            auth.userId,
            bundle,
            prompt_text,
          );
          if (!result.ok) {
            return c.json(
              deny(result.code, result.message),
              result.code === 'not_steward' ? 403 : 422,
            );
          }
          // Eagerly run the admission gate so the eligibility status is visible.
          await getGovernanceService().evaluateModel(result.value.modelId);
          return c.json({ ...result.value }, 201);
        },
      )
      .get('/rooms/:roomId/governance/models', authMiddleware(), async (c) => {
        const svc = getGovernanceService();
        const seat = await svc.getSeat(c.req.param('roomId'));
        // The model list is part of the in-room transparency surface.
        const models = await svc.listModels(c.req.param('roomId'));
        return c.json({
          steward_user_id: seat?.holderUserId ?? null,
          models: models.map((m) => ({
            model_id: m.modelId,
            artifact_digest: m.artifactDigest,
            status: m.status,
            proposed_by_user_id: m.proposedByUserId,
            created_at: m.createdAt,
          })),
        });
      })
      .get('/rooms/:roomId/governance/models/:modelId/download', authMiddleware(), async (c) => {
        const model = await getGovernanceService().getModel(c.req.param('modelId'));
        if (!model || model.roomId !== c.req.param('roomId')) {
          return c.json(deny('not_found', 'Model not found.'), 404);
        }
        // Member-downloadable, integrity-pinned artifact (the accountability core).
        return c.json({
          model_id: model.modelId,
          artifact_digest: model.artifactDigest,
          bundle: model.bundle,
        });
      })
      .post(
        '/rooms/:roomId/governance/models/:modelId/approve',
        authMiddleware(),
        zValidator('json', approveBodySchema),
        async (c) => {
          const { election_id } = c.req.valid('json');
          const result = await getGovernanceService().approveModel(
            c.req.param('roomId'),
            c.req.param('modelId'),
            election_id,
            null,
          );
          if (!result.ok) return c.json(deny(result.code, result.message), 409);
          return c.json({ active: result.value.active, granted: result.value.descriptor.granted });
        },
      )
      // --- "Governed by" agent view ---------------------------------------
      .get('/rooms/:roomId/governance/agent', authMiddleware(), async (c) => {
        const roomId = c.req.param('roomId');
        const svc = getGovernanceService();
        const binding = await svc.getBinding(roomId);
        const actions = await svc.recentAgentActions(roomId, 20);
        return c.json({
          active: binding?.active ?? false,
          // A binding that exists but is inactive ⇒ the platform floor has paused
          // a community-approved agent (distinct from a room that never had one).
          frozen: binding !== null && !binding.active,
          model_id: binding?.modelId ?? null,
          granted: binding?.capabilityDescriptor.granted ?? [],
          recent_actions: actions.map((a) => ({
            action_id: a.actionId,
            action_type: a.actionType,
            subject_ref: a.subjectRef,
            statement_of_reasons: a.statementOfReasons,
            reversible: a.reversible,
            created_at: a.createdAt,
          })),
        });
      })
      // --- Platform-floor freeze (the non-overridable safety control) ---------
      // Gated by the WS-J `restrict` capability (the ratified steward policy) +
      // verified MFA: a platform safety steward — NOT the room's elected steward —
      // may pause or restore a room's community-approved agent at any time
      // (SPEC §16.6/§24.6). Freezing deactivates the binding, so the agent stops
      // moderating immediately and the room falls back to the platform floor.
      .post('/rooms/:roomId/governance/agent/freeze', authMiddleware(), async (c) => {
        const auth = c.get('auth');
        if (!auth) return c.json(deny('unauthorized', 'Authentication required.'), 401);
        const denial = denyCapability(stewardActorOf(auth), 'restrict');
        if (denial) return c.json(deny(denial.code, denial.message), 403);
        const roomId = c.req.param('roomId');
        const svc = getGovernanceService();
        const binding = await svc.getBinding(roomId);
        if (binding === null) return c.json(deny('no_agent', 'No agent governs this room.'), 404);
        await svc.freezeAgent(roomId);
        return c.json({ active: false, frozen: true });
      })
      .post('/rooms/:roomId/governance/agent/unfreeze', authMiddleware(), async (c) => {
        const auth = c.get('auth');
        if (!auth) return c.json(deny('unauthorized', 'Authentication required.'), 401);
        const denial = denyCapability(stewardActorOf(auth), 'restrict');
        if (denial) return c.json(deny(denial.code, denial.message), 403);
        const result = await getGovernanceService().reactivateAgent(c.req.param('roomId'));
        if (!result.ok || !result.value.reactivated) {
          return c.json(deny('no_agent', 'No agent binding to reactivate.'), 404);
        }
        return c.json({ active: true, frozen: false });
      })
  );
}
