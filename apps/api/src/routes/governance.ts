// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U AI-governed-rooms HTTP surface (SPEC §16.6, §24.6). Authenticated reads
// and writes over the GovernanceService: the steward seat + elections, the
// community model/prompt registry (propose / list / download), the MEMBER
// ratification vote that adopts a model (open / ballot / read), and the "governed
// by" agent view. There is NO direct-activate route — a model becomes the active
// agent ONLY by passing a member ratification vote (the doctrine: members ratify).
// Steward-only writes are service-enforced; the platform-floor freeze is gated by
// the WS-J `restrict` capability; treasury stays behind the fail-closed crypto flag.

import { zValidator } from '@hono/zod-validator';
import { uuidSchema } from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { roomContentVisibleToUser } from '../forum/rooms.js';
import { getForumServices } from '../forum/services.js';
import { checkGovernanceEligibility } from '../governance/eligibility.js';
import { getGovernanceService } from '../governance/services.js';
import { rateLimit } from '../lib/rate-limit.js';
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

/** Ratification voting eligibility: an ACTIVE room member or a room steward. */
async function isRoomMember(roomId: string, userId: string): Promise<boolean> {
  const rooms = getForumServices().rooms;
  const subscription = await rooms.getSubscription(roomId, userId);
  if (subscription?.status === 'active') return true;
  return (await rooms.stewardRolesFor(roomId, userId)).length > 0;
}

/**
 * The WS-Q content read bar for governance reads: a PRIVATE room's governance
 * data (model ids/digests, the downloadable bundle, the agent view) is members/
 * stewards-only — otherwise an authenticated non-member could enumerate and
 * download a private room's policy. A room absent from the forum store is a
 * governance-only fixture with no content bar to apply.
 */
async function governanceReadable(roomId: string, userId: string | null): Promise<boolean> {
  const forum = getForumServices();
  const room = await forum.rooms.getById(roomId);
  if (room === null) return true;
  if (await roomContentVisibleToUser(forum, room, userId)) return true;
  // The elected governance steward always sees their own room's governance, even
  // if they hold no forum subscription/steward role.
  if (userId !== null) {
    const seat = await getGovernanceService().getSeat(roomId);
    if (seat?.holderUserId === userId) return true;
  }
  return false;
}

const proposeBodySchema = z
  .object({
    bundle: z.unknown(),
    prompt_text: z.string().min(1).max(8_000),
  })
  .strict();

// `candidate_user_id` is used as a uuid store key (a knomosis uuid column), so it
// must be uuid-validated for a controlled 422 rather than a Postgres 22P02 / 500.
const voteBodySchema = z.object({ candidate_user_id: uuidSchema }).strict();
const ratificationOpenBodySchema = z
  .object({
    /** Bind a community-proposed law-pack (the agent's bounds); null ⇒ default. */
    law_pack_id: z.string().min(1).max(128).nullable().default(null),
  })
  .strict();
const ballotBodySchema = z.object({ choice: z.enum(['approve', 'reject']) }).strict();
const lawPackBodySchema = z.object({ law_pack: z.unknown() }).strict();
// Secondary uuid path params are also store keys (uuid columns) — validate them
// too, so a malformed id is a controlled 422, never a Postgres-parse 500. Each
// includes roomId so the Hono RPC `param` inference keeps it (a param-only schema
// would otherwise narrow the route's inferred params and break typed callers).
const validateElectionId = zValidator(
  'param',
  z.object({ roomId: uuidSchema, electionId: uuidSchema }),
);
const validateModelId = zValidator('param', z.object({ roomId: uuidSchema, modelId: uuidSchema }));
const validateVoteId = zValidator('param', z.object({ roomId: uuidSchema, voteId: uuidSchema }));
// The proposal is validated by the service (proposalInputSchema), mirroring the
// `bundle: z.unknown()` propose contract.
const lawmakingSummaryBodySchema = z.object({ proposal: z.unknown() }).strict();

export function createGovernanceRoutes() {
  // Identity-free per-endpoint cost ceilings (SPEC §19.1): governance writes are
  // low-frequency by construction, so a global fixed-window budget sheds load
  // before auth/validation cost. Per-account fairness comes from the steward-only
  // gates (propose/open/law-pack) and the composite-PK ballot idempotency.
  // Member ballots get a roomier budget than steward proposals (more voters).
  const stewardWriteLimit = rateLimit({ limit: 120, windowMs: 60_000 });
  const voteLimit = rateLimit({ limit: 600, windowMs: 60_000 });
  return (
    new Hono<AuthEnv>()
      // Every governance route is room-scoped: reject a non-UUID roomId with a
      // controlled 422 BEFORE it reaches the (uuid-typed) knomosis stores, so a
      // malformed path can never raise a Postgres parse error / 500.
      .use('/rooms/:roomId/*', zValidator('param', z.object({ roomId: uuidSchema })))
      // --- Steward seat + elections ---------------------------------------
      .get('/rooms/:roomId/steward', authMiddleware(), async (c) => {
        const roomId = c.req.param('roomId');
        // Apply the WS-Q content read bar (parity with the other governance reads):
        // a PRIVATE room's steward identity/term is members/stewards-only, so an
        // authenticated non-member cannot enumerate who governs a private room.
        if (!(await governanceReadable(roomId, c.get('auth')?.userId ?? null))) {
          return c.json(deny('not_found', 'Room governance not found.'), 404);
        }
        const svc = getGovernanceService();
        const seat = await svc.getSeat(roomId);
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
        voteLimit,
        authMiddleware(),
        validateElectionId,
        zValidator('json', voteBodySchema),
        async (c) => {
          const auth = c.get('auth');
          if (!auth) return c.json(deny('unauthorized', 'Authentication required.'), 401);
          // Bot-prevention layer 3 (platform floor): only KYC-verified accounts
          // participate in room governance — checked BEFORE membership so an
          // unverified prober learns nothing about room composition.
          const denial = await checkGovernanceEligibility(auth.userId);
          if (denial) return c.json({ error: denial }, 403);
          const roomId = c.req.param('roomId');
          const { candidate_user_id } = c.req.valid('json');
          // Membership-gate the voter (the soft cross-context read); the candidate
          // must be a room member too — a steward is elected from among the room's
          // own members, never an outsider. The candidate check is passed INTO
          // castVote so it runs AFTER the election is validated, so a bogus/foreign
          // election id can't turn this endpoint into a membership oracle (it 404s
          // regardless of whether the candidate is a member).
          const eligible = await isRoomMember(roomId, auth.userId);
          if (!eligible) {
            return c.json(
              deny('not_member', 'Only room members may vote in a steward election.'),
              403,
            );
          }
          // The seat itself is governance power: a candidate must hold the same
          // KYC-verified standing as the voters electing them.
          const candidateEligible =
            (await isRoomMember(roomId, candidate_user_id)) &&
            (await checkGovernanceEligibility(candidate_user_id)) === null;
          const result = await getGovernanceService().castVote(
            roomId,
            c.req.param('electionId'),
            auth.userId,
            candidate_user_id,
            eligible,
            candidateEligible,
          );
          if (!result.ok) {
            const status =
              result.code === 'not_found' ? 404 : result.code === 'invalid_candidate' ? 422 : 409;
            return c.json(deny(result.code, result.message), status);
          }
          return c.json({ ok: true });
        },
      )
      // --- Community model / prompt registry ------------------------------
      .post(
        '/rooms/:roomId/governance/models',
        stewardWriteLimit,
        authMiddleware(),
        zValidator('json', proposeBodySchema),
        async (c) => {
          const auth = c.get('auth');
          if (!auth) return c.json(deny('unauthorized', 'Authentication required.'), 401);
          // Bot-prevention layer 3: proposing the room's model is governance power.
          const denial = await checkGovernanceEligibility(auth.userId);
          if (denial) return c.json({ error: denial }, 403);
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
        const roomId = c.req.param('roomId');
        if (!(await governanceReadable(roomId, c.get('auth')?.userId ?? null))) {
          return c.json(deny('not_found', 'Room governance not found.'), 404);
        }
        const svc = getGovernanceService();
        const seat = await svc.getSeat(roomId);
        // The model list is part of the in-room transparency surface.
        const models = await svc.listModels(roomId);
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
      .get(
        '/rooms/:roomId/governance/models/:modelId/download',
        authMiddleware(),
        validateModelId,
        async (c) => {
          const roomId = c.req.param('roomId');
          if (!(await governanceReadable(roomId, c.get('auth')?.userId ?? null))) {
            return c.json(deny('not_found', 'Model not found.'), 404);
          }
          const model = await getGovernanceService().getModel(c.req.param('modelId'));
          if (!model || model.roomId !== roomId) {
            return c.json(deny('not_found', 'Model not found.'), 404);
          }
          // Member-downloadable, integrity-pinned artifact (the accountability core).
          return c.json({
            model_id: model.modelId,
            artifact_digest: model.artifactDigest,
            bundle: model.bundle,
          });
        },
      )
      // --- Member ratification vote (the ONLY path to an active agent) ---------
      // The steward opens a vote on an eligible model (optionally binding a
      // law-pack); members cast yes/no ballots; the scheduler settles it at the
      // window close and activates the model ONLY on a quorum-meeting approving
      // majority (fail-safe otherwise). No member can unilaterally activate.
      .post(
        '/rooms/:roomId/governance/models/:modelId/ratification',
        stewardWriteLimit,
        authMiddleware(),
        validateModelId,
        zValidator('json', ratificationOpenBodySchema),
        async (c) => {
          const auth = c.get('auth');
          if (!auth) return c.json(deny('unauthorized', 'Authentication required.'), 401);
          // Bot-prevention layer 3: opening a ratification is governance power.
          const denial = await checkGovernanceEligibility(auth.userId);
          if (denial) return c.json({ error: denial }, 403);
          const { law_pack_id } = c.req.valid('json');
          const roomId = c.req.param('roomId');
          // Pass the electorate reader as a callback so the service invokes it ONLY
          // after its steward/model/law-pack checks pass — an unauthorized caller
          // can never force the count query. It counts the SAME set that may vote
          // (active subscribers ∪ stewards, matching isRoomMember), frozen as the
          // turnout denominator (M4).
          const result = await getGovernanceService().openRatification(
            roomId,
            auth.userId,
            c.req.param('modelId'),
            law_pack_id,
            () => getForumServices().rooms.countEligibleVoters(roomId),
          );
          if (!result.ok) {
            return c.json(
              deny(result.code, result.message),
              result.code === 'not_steward' ? 403 : result.code === 'not_found' ? 404 : 409,
            );
          }
          return c.json({ vote_id: result.value.voteId }, 201);
        },
      )
      .post(
        '/rooms/:roomId/governance/ratifications/:voteId/ballot',
        voteLimit,
        authMiddleware(),
        validateVoteId,
        zValidator('json', ballotBodySchema),
        async (c) => {
          const auth = c.get('auth');
          if (!auth) return c.json(deny('unauthorized', 'Authentication required.'), 401);
          // Bot-prevention layer 3: a ratification ballot is governance power —
          // checked BEFORE membership so an unverified prober learns nothing.
          const denial = await checkGovernanceEligibility(auth.userId);
          if (denial) return c.json({ error: denial }, 403);
          const eligible = await isRoomMember(c.req.param('roomId'), auth.userId);
          const result = await getGovernanceService().castRatificationBallot(
            c.req.param('roomId'),
            c.req.param('voteId'),
            auth.userId,
            c.req.valid('json').choice,
            eligible,
          );
          if (!result.ok) {
            const status =
              result.code === 'not_member' ? 403 : result.code === 'not_found' ? 404 : 409;
            return c.json(deny(result.code, result.message), status);
          }
          return c.json({ ok: true });
        },
      )
      .get('/rooms/:roomId/governance/ratification', authMiddleware(), async (c) => {
        const roomId = c.req.param('roomId');
        if (!(await governanceReadable(roomId, c.get('auth')?.userId ?? null))) {
          return c.json(deny('not_found', 'Room governance not found.'), 404);
        }
        const svc = getGovernanceService();
        const vote = await svc.getOpenRatification(roomId);
        if (!vote) return c.json({ vote: null }, 200);
        // Live tally (governance data, not applause): in-favor / opposed counts.
        const ballots = await svc.ratificationBallots(vote.voteId);
        let inFavor = 0;
        let opposed = 0;
        for (const b of ballots) {
          if (b.choice === 'approve') inFavor += 1;
          else opposed += 1;
        }
        return c.json({
          vote: {
            vote_id: vote.voteId,
            model_id: vote.modelId,
            opens_at: vote.opensAt,
            closes_at: vote.closesAt,
            min_quorum: vote.minQuorum,
            in_favor: inFavor,
            opposed,
          },
        });
      })
      // --- Community-voted bounds (the law-pack the agent runs within) ---------
      .post(
        '/rooms/:roomId/governance/law-packs',
        stewardWriteLimit,
        authMiddleware(),
        zValidator('json', lawPackBodySchema),
        async (c) => {
          const auth = c.get('auth');
          if (!auth) return c.json(deny('unauthorized', 'Authentication required.'), 401);
          // Bot-prevention layer 3: proposing the agent's bounds is governance power.
          const denial = await checkGovernanceEligibility(auth.userId);
          if (denial) return c.json({ error: denial }, 403);
          const result = await getGovernanceService().proposeLawPack(
            c.req.param('roomId'),
            auth.userId,
            c.req.valid('json').law_pack,
          );
          if (!result.ok) {
            return c.json(
              deny(result.code, result.message),
              result.code === 'not_steward' ? 403 : 422,
            );
          }
          return c.json({ lawPackId: result.value.lawPackId }, 201);
        },
      )
      // --- Lawmaking facilitation (Stage 4) -----------------------------------
      // The elected steward asks the room's agent to produce a NEUTRAL,
      // deterministic summary of a proposal — performed ONLY if the community
      // granted the agent `lawmaking.summarize` (else 409 no_capability). The
      // agent has no vote/tally capability, so it can never compute an outcome.
      .post(
        '/rooms/:roomId/governance/lawmaking/summarize',
        stewardWriteLimit,
        authMiddleware(),
        zValidator('json', lawmakingSummaryBodySchema),
        async (c) => {
          const auth = c.get('auth');
          if (!auth) return c.json(deny('unauthorized', 'Authentication required.'), 401);
          // Bot-prevention layer 3: lawmaking facilitation is governance power.
          const denial = await checkGovernanceEligibility(auth.userId);
          if (denial) return c.json({ error: denial }, 403);
          const roomId = c.req.param('roomId');
          const svc = getGovernanceService();
          const seat = await svc.getSeat(roomId);
          if (!seat || seat.holderUserId !== auth.userId) {
            return c.json(
              deny('not_steward', 'Only the elected room steward may facilitate.'),
              403,
            );
          }
          const result = await svc.facilitateSummary(roomId, c.req.valid('json').proposal);
          if (!result.ok) {
            const status =
              result.code === 'no_agent' || result.code === 'no_capability' ? 409 : 422;
            return c.json(deny(result.code, result.message), status);
          }
          return c.json({ summary: result.value });
        },
      )
      // --- "Governed by" agent view ---------------------------------------
      .get('/rooms/:roomId/governance/agent', authMiddleware(), async (c) => {
        const roomId = c.req.param('roomId');
        if (!(await governanceReadable(roomId, c.get('auth')?.userId ?? null))) {
          return c.json(deny('not_found', 'Room governance not found.'), 404);
        }
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
