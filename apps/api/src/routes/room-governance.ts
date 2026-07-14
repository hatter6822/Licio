// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.4 governance-simulation routes (SPEC §23.4 /rooms/:id/governance/*):
// the governance tab bundle, proposal templates + voting + execution, the
// simulated treasury, the append-only audit log, the comprehension quiz, and
// the WS-L.4.1g readiness gate + mode transitions.  These paths COMPOSE with
// the WS-U surface (models/prompts/ratification/agent) — no overlap.
//
// Simulation is gated by the governance flag (NOT the crypto flag — SPEC
// §16.5: simulated governance without a treasury runs independently of the
// crypto gate); room membership gates participation; comprehension gates the
// first action (enforced in the simulation service).

import { zValidator } from '@hono/zod-validator';
import {
  comprehensionQuizResponseSchema,
  comprehensionSubmitRequestSchema,
  comprehensionSubmitResponseSchema,
  type GovernanceProposal,
  governanceAuditLogResponseSchema,
  governanceProposalCreateSchema,
  governanceProposalListResponseSchema,
  governanceTabResponseSchema,
  modeTransitionRequestSchema,
  type ProductionProposal,
  productionProposalCreateSchema,
  productionProposalListResponseSchema,
  productionProposalResponseSchema,
  proposalVoteRequestSchema,
  READINESS_TARGET_MODES,
  type ReadinessTargetMode,
  roomReadinessResponseSchema,
  simTreasuryDepositRequestSchema,
  simTreasuryResponseSchema,
  treasuryDashboardResponseSchema,
  uuidSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  evaluateReadiness,
  type ReadinessDeps,
  requestModeTransition,
} from '../knomosis/readiness.js';
import {
  getKnomosisServices,
  type KnomosisServices,
  simulationDeps,
} from '../knomosis/services.js';
import {
  COMPREHENSION_QUIZ_VERSION,
  castSimVote,
  createSimProposal,
  executeSimProposal,
  hasPassedComprehension,
  quizQuestions,
  simDeposit,
  simTreasuryView,
  submitComprehension,
} from '../knomosis/simulation.js';
import type {
  AuditLogCursor,
  GovernanceProposalRecord,
  ProposalVoteStore,
} from '../knomosis/stores.js';
import {
  type AuthEnv,
  authMiddleware,
  requireAuth,
  requireVerifiedAccount,
} from '../middleware/auth.js';
import { denyCapability } from '../moderation/authz.js';
import { createProductionProposal, executeProposal } from '../treasury/proposals.js';
import { evaluateWsmReadiness, requestWsmModeTransition } from '../treasury/readiness.js';
import { getTreasuryServices, treasuryServicesConfigured } from '../treasury/services.js';
import { treasuryDashboard } from '../treasury/treasury.js';

const deny = (code: string, message: string) => ({ error: { code, message } });
const notFound = { error: { code: 'not_found', message: 'Resource not found' } };

/** Decode the composite `${created_at}|${entry_id}` audit-log keyset cursor;
 *  null ⇒ malformed (the handler answers 400 rather than silently paging from
 *  the top, which would loop a client) (WS-L.4.1f). */
function parseAuditCursor(raw: string): AuditLogCursor | null {
  const sep = raw.indexOf('|');
  if (sep <= 0) return null;
  const createdAt = raw.slice(0, sep);
  const entryId = raw.slice(sep + 1);
  const shape = z.object({
    createdAt: z.string().datetime(),
    entryId: z.string().uuid(),
  });
  const parsed = shape.safeParse({ createdAt, entryId });
  return parsed.success ? parsed.data : null;
}

function readinessDeps(services: KnomosisServices): ReadinessDeps | null {
  if (services.roomMode === null) return null;
  return {
    checklist: services.readinessChecklist,
    roomMode: services.roomMode,
    governanceAudit: services.governanceAudit,
    comprehension: services.comprehension,
    audit: services.audit,
    config: services.config,
    now: services.now,
    uuid: services.uuid,
  };
}

async function toWireProposal(
  record: GovernanceProposalRecord,
  votes: ProposalVoteStore,
): Promise<GovernanceProposal> {
  const tally = await votes.tally(record.proposalId);
  return {
    proposal_id: record.proposalId,
    room_id: record.roomId,
    proposer_user_id: record.proposerUserId,
    proposal_type: record.proposalType,
    title: record.title,
    plain_language_summary: record.plainLanguageSummary,
    requested_amount: record.requestedAmount,
    asset: record.asset as GovernanceProposal['asset'],
    recipient_ref: record.recipientRef,
    conflict_disclosures: record.conflictDisclosures,
    risk_assessment: record.riskAssessment,
    requested_action: record.requestedAction,
    expected_deliverable: record.expectedDeliverable,
    preflight_state: record.preflightState,
    voting_state: record.votingState,
    challenge_state: record.challengeState,
    execution_state: record.executionState,
    votes_approve: tally.approve,
    votes_reject: tally.reject,
    votes_abstain: tally.abstain,
    executable_after: record.executableAfter,
    simulation_mode: record.simulationMode,
    created_at: record.createdAt,
    executed_at: record.executedAt,
  };
}

/** WS-M production wire projection (production rows: simulationMode=false). */
function toWireProductionProposal(record: GovernanceProposalRecord): ProductionProposal {
  return {
    proposal_id: record.proposalId,
    room_id: record.roomId,
    proposer_user_id: record.proposerUserId,
    proposal_type: record.proposalType,
    title: record.title,
    plain_language_summary: record.plainLanguageSummary,
    category: record.category ?? null,
    requested_amount: record.requestedAmount,
    asset: record.asset,
    recipient_ref: record.recipientRef,
    conflict_disclosures: record.conflictDisclosures,
    risk_assessment: record.riskAssessment,
    requested_action: record.requestedAction,
    expected_deliverable: record.expectedDeliverable,
    law_pack_version_id: record.lawPackVersionId ?? null,
    preflight_state: record.preflightState,
    voting_state:
      record.votingState === 'open'
        ? 'open'
        : (record.votingState as ProductionProposal['voting_state']),
    challenge_state: record.challengeState,
    execution_state: record.executionState,
    tally: (record.tallySnapshot as ProductionProposal['tally']) ?? null,
    deliberation_ends_at: record.deliberationEndsAt ?? null,
    voting_ends_at: record.votingEndsAt ?? null,
    challenge_window_ends_at: record.challengeWindowEndsAt ?? null,
    executable_after: record.executableAfter,
    created_at: record.createdAt,
    executed_at: record.executedAt,
  };
}

/** The default readiness target: the next escalation step from the current mode. */
function defaultReadinessTarget(mode: string): ReadinessTargetMode {
  if (mode === 'ordinary') return 'simulated';
  if (mode === 'simulated') return 'testnet';
  if (mode === 'testnet') return 'capped_production';
  return 'mature_production';
}

/** Availability + membership gate shared by the simulation surfaces. */
async function simGate(
  services: KnomosisServices,
  roomId: string,
  userId: string,
  needsMembership: boolean,
): Promise<
  { ok: true; mode: string } | { ok: false; status: 403 | 404 | 503; code: string; message: string }
> {
  if (!services.config().governanceEnabled) {
    return {
      ok: false,
      status: 503,
      code: 'governance_disabled',
      message: 'Room governance features are not enabled.',
    };
  }
  if (services.rooms === null) {
    return { ok: false, status: 503, code: 'unavailable', message: 'Governance data unavailable.' };
  }
  const room = await services.rooms.roomGovernance(roomId);
  if (room === null) {
    return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
  }
  // The simulation surface exists only for non-ordinary rooms (WS-L.4.1a).
  if (room.mode === 'ordinary') {
    return { ok: false, status: 404, code: 'not_found', message: 'Resource not found' };
  }
  // WS-Q §16.1 content bar — closes the private-room governance READ: a private
  // room's governance content (active proposals, simulated treasury) is visible
  // only to active members/stewards.  For a public room this is always true, so
  // public reads stay open; for a private room a non-member is blocked here,
  // BEFORE any proposal/treasury data is assembled.  Applies to reads and writes
  // (writes additionally require membership below).
  if (!(await services.rooms.contentVisibleToUser(roomId, userId))) {
    return {
      ok: false,
      status: 403,
      code: 'membership_required',
      message: 'This room’s governance is visible to members only.',
    };
  }
  if (needsMembership && !(await services.rooms.isMember(roomId, userId))) {
    return {
      ok: false,
      status: 403,
      code: 'membership_required',
      message: 'Room membership is required for governance participation.',
    };
  }
  return { ok: true, mode: room.mode };
}

const roomParam = zValidator('param', z.object({ roomId: uuidSchema }));
const proposalParams = zValidator(
  'param',
  z.object({ roomId: uuidSchema, proposalId: uuidSchema }),
);

export function createRoomGovernanceSimRoutes() {
  return (
    new Hono<AuthEnv>()
      // --- GET /rooms/:roomId/governance (the tab bundle, WS-L.4.1a) -------
      .get('/rooms/:roomId/governance', authMiddleware(), roomParam, async (c) => {
        const auth = requireAuth(c);
        const services = getKnomosisServices();
        const roomId = c.req.valid('param').roomId;
        const gate = await simGate(services, roomId, auth.userId, false);
        if (!gate.ok) return c.json(deny(gate.code, gate.message), gate.status);
        const sim = simulationDeps(services);
        const proposals = await services.proposals.listByRoom(roomId, 50);
        const active = proposals.filter(
          (p) => p.votingState === 'open' || p.executionState === 'timelocked',
        );
        const isSimulated = gate.mode === 'simulated';
        return c.json(
          governanceTabResponseSchema.parse({
            room_id: roomId,
            governance_mode: gate.mode,
            simulation_mode: isSimulated,
            charter_summary: null,
            active_proposals: await Promise.all(
              active.map((p) => toWireProposal(p, services.votes)),
            ),
            treasury: isSimulated ? await simTreasuryView(sim, roomId) : null,
          }),
        );
      })

      // --- Proposals (WS-L.4.1b/d) -----------------------------------------
      .get('/rooms/:roomId/governance/proposals', authMiddleware(), roomParam, async (c) => {
        const auth = requireAuth(c);
        const services = getKnomosisServices();
        const roomId = c.req.valid('param').roomId;
        const gate = await simGate(services, roomId, auth.userId, false);
        if (!gate.ok) return c.json(deny(gate.code, gate.message), gate.status);
        const proposals = await services.proposals.listByRoom(roomId, 100);
        if (gate.mode !== 'simulated') {
          // Real-asset modes list the PRODUCTION lifecycle (WS-M.4.1a); the
          // room's simulated practice history stays on the sim wire below.
          return c.json(
            productionProposalListResponseSchema.parse({
              proposals: proposals
                .filter((p) => !p.simulationMode)
                .map((p) => toWireProductionProposal(p)),
            }),
          );
        }
        return c.json(
          governanceProposalListResponseSchema.parse({
            proposals: await Promise.all(
              proposals
                .filter((p) => p.simulationMode)
                .map((p) => toWireProposal(p, services.votes)),
            ),
          }),
        );
      })
      .post(
        '/rooms/:roomId/governance/proposals',
        authMiddleware(),
        requireVerifiedAccount(),
        roomParam,
        // The body shape is MODE-DEPENDENT (sim template vs WS-M production
        // draft), so validation happens in the handler after the mode read.
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          const roomId = c.req.valid('param').roomId;
          const gate = await simGate(services, roomId, auth.userId, true);
          if (!gate.ok) return c.json(deny(gate.code, gate.message), gate.status);
          const body: unknown = await c.req.json().catch(() => null);
          if (gate.mode !== 'simulated') {
            // WS-M production proposals (real-asset modes; WS-M.4.1a-c + 4.2a).
            if (!treasuryServicesConfigured()) {
              return c.json(
                deny('mode_invalid', 'Proposal templates are available in simulated mode.'),
                409,
              );
            }
            const parsed = productionProposalCreateSchema.safeParse(body);
            if (!parsed.success) {
              return c.json(
                deny('invalid_request', parsed.error.issues[0]?.message ?? 'Invalid proposal.'),
                400,
              );
            }
            const result = await createProductionProposal(getTreasuryServices(), {
              roomId,
              userId: auth.userId,
              create: parsed.data,
            });
            if ('code' in result) return c.json(deny(result.code, result.message), result.status);
            return c.json(
              productionProposalResponseSchema.parse({
                proposal: toWireProductionProposal(result.proposal),
              }),
              201,
            );
          }
          const parsed = governanceProposalCreateSchema.safeParse(body);
          if (!parsed.success) {
            return c.json(
              deny('invalid_request', parsed.error.issues[0]?.message ?? 'Invalid proposal.'),
              400,
            );
          }
          const result = await createSimProposal(simulationDeps(services), {
            roomId,
            userId: auth.userId,
            create: parsed.data,
          });
          if (!result.ok) return c.json(deny(result.code, result.message), result.status);
          return c.json({ proposal: await toWireProposal(result.proposal, services.votes) }, 201);
        },
      )
      .get(
        '/rooms/:roomId/governance/proposals/:proposalId',
        authMiddleware(),
        proposalParams,
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          const params = c.req.valid('param');
          const gate = await simGate(services, params.roomId, auth.userId, false);
          if (!gate.ok) return c.json(deny(gate.code, gate.message), gate.status);
          const proposal = await services.proposals.getById(params.proposalId);
          if (proposal === null || proposal.roomId !== params.roomId) {
            return c.json(notFound, 404);
          }
          return c.json({ proposal: await toWireProposal(proposal, services.votes) });
        },
      )
      .post(
        '/rooms/:roomId/governance/proposals/:proposalId/vote',
        authMiddleware(),
        requireVerifiedAccount(),
        proposalParams,
        zValidator('json', proposalVoteRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          const params = c.req.valid('param');
          const gate = await simGate(services, params.roomId, auth.userId, true);
          if (!gate.ok) return c.json(deny(gate.code, gate.message), gate.status);
          // Simulated voting exists only in simulated mode: once a room moves to
          // testnet/capped, old simulated proposals can no longer be voted on or
          // have their state/timelocks mutated through the simulation store.
          if (gate.mode !== 'simulated') {
            return c.json(deny('mode_invalid', 'Voting here exists in simulated mode.'), 409);
          }
          const result = await castSimVote(simulationDeps(services), {
            roomId: params.roomId,
            proposalId: params.proposalId,
            userId: auth.userId,
            choice: c.req.valid('json').choice,
          });
          if (!result.ok) return c.json(deny(result.code, result.message), result.status);
          return c.json({ proposal: await toWireProposal(result.proposal, services.votes) });
        },
      )
      .post(
        '/rooms/:roomId/governance/proposals/:proposalId/execute',
        authMiddleware(),
        requireVerifiedAccount(),
        proposalParams,
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          const params = c.req.valid('param');
          const gate = await simGate(services, params.roomId, auth.userId, true);
          if (!gate.ok) return c.json(deny(gate.code, gate.message), gate.status);
          if (gate.mode !== 'simulated') {
            // WS-M production execution (WS-M.4.3b): the explicit steward
            // trigger through the shipped fail-closed treasury executor.
            if (!treasuryServicesConfigured()) {
              return c.json(deny('mode_invalid', 'Execution here exists in simulated mode.'), 409);
            }
            const result = await executeProposal(getTreasuryServices(), {
              roomId: params.roomId,
              proposalId: params.proposalId,
              userId: auth.userId,
            });
            if ('code' in result) return c.json(deny(result.code, result.message), result.status);
            return c.json(
              productionProposalResponseSchema.parse({
                proposal: toWireProductionProposal(result.proposal),
              }),
            );
          }
          const result = await executeSimProposal(simulationDeps(services), {
            roomId: params.roomId,
            proposalId: params.proposalId,
            actorUserId: auth.userId,
          });
          if (!result.ok) return c.json(deny(result.code, result.message), result.status);
          return c.json({ proposal: await toWireProposal(result.proposal, services.votes) });
        },
      )

      // --- Simulated treasury (WS-L.4.1c) -----------------------------------
      .get('/rooms/:roomId/governance/treasury', authMiddleware(), roomParam, async (c) => {
        const auth = requireAuth(c);
        const services = getKnomosisServices();
        const roomId = c.req.valid('param').roomId;
        const gate = await simGate(services, roomId, auth.userId, false);
        if (!gate.ok) return c.json(deny(gate.code, gate.message), gate.status);
        if (gate.mode !== 'simulated') {
          // Real-asset modes serve the WS-M dashboard: last-RECONCILED balances
          // plus reservation headroom (WS-M.2.2c), never the simulated ledger.
          if (!treasuryServicesConfigured()) {
            return c.json(
              deny('mode_invalid', 'The simulated treasury exists in simulated mode.'),
              409,
            );
          }
          const dashboard = await treasuryDashboard(getTreasuryServices(), roomId);
          return c.json(treasuryDashboardResponseSchema.parse({ treasury: dashboard }));
        }
        return c.json(
          simTreasuryResponseSchema.parse(await simTreasuryView(simulationDeps(services), roomId)),
        );
      })
      .post(
        '/rooms/:roomId/governance/treasury/deposits',
        authMiddleware(),
        requireVerifiedAccount(),
        roomParam,
        zValidator('json', simTreasuryDepositRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          const roomId = c.req.valid('param').roomId;
          const gate = await simGate(services, roomId, auth.userId, true);
          if (!gate.ok) return c.json(deny(gate.code, gate.message), gate.status);
          if (gate.mode !== 'simulated') {
            return c.json(deny('mode_invalid', 'Deposits here exist in simulated mode.'), 409);
          }
          const body = c.req.valid('json');
          const result = await simDeposit(simulationDeps(services), {
            roomId,
            userId: auth.userId,
            asset: body.asset,
            amount: body.amount,
            // REQUIRED by the schema — a deposit is idempotent by this client key.
            idempotencyKey: body.idempotency_key,
          });
          if (!result.ok) return c.json(deny(result.code, result.message), result.status);
          return c.json(simTreasuryResponseSchema.parse(result.treasury));
        },
      )

      // --- Audit log (WS-L.4.1f) ---------------------------------------------
      .get(
        '/rooms/:roomId/governance/audit-log',
        authMiddleware(),
        roomParam,
        // The keyset cursor is the COMPOSITE `${created_at}|${entry_id}` emitted
        // as `next_cursor` — createdAt alone is not unique, so paging by it skips
        // or duplicates same-millisecond rows (WS-L.4.1f).
        zValidator('query', z.object({ before: z.string().min(1).max(512).optional() }).strict()),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          const roomId = c.req.valid('param').roomId;
          const gate = await simGate(services, roomId, auth.userId, true);
          if (!gate.ok) return c.json(deny(gate.code, gate.message), gate.status);
          const rawCursor = c.req.valid('query').before;
          let before: AuditLogCursor | undefined;
          if (rawCursor !== undefined) {
            const parsed = parseAuditCursor(rawCursor);
            if (parsed === null) {
              return c.json(deny('invalid_cursor', 'The pagination cursor is malformed.'), 400);
            }
            before = parsed;
          }
          const entries = await services.governanceAudit.listByRoom(roomId, 50, before);
          const oldest = entries[entries.length - 1];
          return c.json(
            governanceAuditLogResponseSchema.parse({
              entries: entries.map((e) => ({
                entry_id: e.entryId,
                action_type: e.actionType,
                room_id: e.roomId,
                actor_user_id: e.actorUserId,
                action_details: e.actionDetails,
                simulation_mode: e.simulationMode,
                created_at: e.createdAt,
              })),
              next_cursor:
                entries.length === 50 && oldest ? `${oldest.createdAt}|${oldest.entryId}` : null,
            }),
          );
        },
      )

      // --- Comprehension quiz (WS-L.4.1e) ------------------------------------
      .get('/rooms/:roomId/governance/comprehension', authMiddleware(), roomParam, async (c) => {
        const auth = requireAuth(c);
        const services = getKnomosisServices();
        const roomId = c.req.valid('param').roomId;
        const gate = await simGate(services, roomId, auth.userId, false);
        if (!gate.ok) return c.json(deny(gate.code, gate.message), gate.status);
        return c.json(
          comprehensionQuizResponseSchema.parse({
            quiz_version: COMPREHENSION_QUIZ_VERSION,
            questions: quizQuestions(),
            already_passed: await hasPassedComprehension(services, auth.userId),
          }),
        );
      })
      .post(
        '/rooms/:roomId/governance/comprehension',
        authMiddleware(),
        requireVerifiedAccount(),
        roomParam,
        zValidator('json', comprehensionSubmitRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          const roomId = c.req.valid('param').roomId;
          const gate = await simGate(services, roomId, auth.userId, false);
          if (!gate.ok) return c.json(deny(gate.code, gate.message), gate.status);
          const body = c.req.valid('json');
          const result = await submitComprehension(simulationDeps(services), {
            userId: auth.userId,
            quizVersion: body.quiz_version,
            answers: body.answers,
          });
          if (!result.ok) return c.json(deny(result.code, result.message), result.status);
          return c.json(
            comprehensionSubmitResponseSchema.parse({
              passed: result.passed,
              corrections: result.corrections,
            }),
          );
        },
      )

      // --- Readiness + mode transition (WS-L.4.1g) ---------------------------
      .get('/rooms/:roomId/governance/readiness', authMiddleware(), roomParam, async (c) => {
        const auth = requireAuth(c);
        const services = getKnomosisServices();
        const roomId = c.req.valid('param').roomId;
        const gate = await simGate(services, roomId, auth.userId, false);
        if (!gate.ok) return c.json(deny(gate.code, gate.message), gate.status);
        // WS-M.1.2e: the EXTENDED per-item checklist with `requiredFor`
        // semantics, evaluated LIVE for the requested (or next) target mode.
        if (treasuryServicesConfigured()) {
          const rawTarget = c.req.query('target_mode');
          const target = (READINESS_TARGET_MODES as readonly string[]).includes(rawTarget ?? '')
            ? (rawTarget as ReadinessTargetMode)
            : defaultReadinessTarget(gate.mode);
          const wsm = await evaluateWsmReadiness(
            getTreasuryServices(),
            roomId,
            auth.userId,
            target,
          );
          return c.json(
            roomReadinessResponseSchema.parse({
              room_id: roomId,
              current_mode: gate.mode,
              target_mode: target,
              ready: wsm.ready,
              unmet: wsm.unmet,
              items: wsm.items,
            }),
          );
        }
        const deps = readinessDeps(services);
        if (deps === null) {
          return c.json(deny('unavailable', 'Governance data unavailable.'), 503);
        }
        const readiness = await evaluateReadiness(deps, roomId, auth.userId);
        return c.json(
          roomReadinessResponseSchema.parse({
            room_id: roomId,
            current_mode: gate.mode,
            ready: readiness.ready,
            unmet: readiness.unmet.map((u) => ({
              requirement: u.requirement,
              description: u.description,
            })),
          }),
        );
      })
      .post(
        '/rooms/:roomId/governance/mode',
        authMiddleware(),
        requireVerifiedAccount(),
        roomParam,
        zValidator('json', modeTransitionRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          const roomId = c.req.valid('param').roomId;
          if (!services.config().governanceEnabled) {
            return c.json(deny('governance_disabled', 'Governance is not enabled.'), 503);
          }
          // Transitions are steward/staff-only (WS-L.4.1g), audited in the gate.
          if (services.rooms === null || !(await services.rooms.isSteward(roomId, auth.userId))) {
            return c.json(notFound, 404); // 404-over-403 (no steward oracle)
          }
          const body = c.req.valid('json');
          // WS-M.1.1b: the FULL edge table (rollbacks, production escalations,
          // emergency freeze, frozen→migrating recovery) with live per-target
          // readiness and a CAS mode write.  Falls back to the WS-L.4.1g
          // two-edge gate when the WS-M container is not wired.
          if (treasuryServicesConfigured()) {
            const platformStaff =
              denyCapability(
                {
                  userId: auth.userId,
                  platformRoles: auth.roles,
                  stewardRoles: auth.stewardRoles,
                  mfaActive: auth.mfaActive,
                  mfaVerified: auth.mfaVerified,
                },
                'restrict',
              ) === null;
            const outcome = await requestWsmModeTransition(getTreasuryServices(), {
              roomId,
              targetMode: body.target_mode,
              userId: auth.userId,
              reason: body.reason,
              isPlatformStaff: platformStaff,
            });
            if (!('mode' in outcome)) {
              return c.json(
                {
                  error: { code: outcome.code, message: outcome.message },
                  unmet: outcome.unmet ?? [],
                },
                outcome.status,
              );
            }
            return c.json({ governance_mode: outcome.mode });
          }
          const deps = readinessDeps(services);
          if (deps === null) {
            return c.json(deny('unavailable', 'Governance data unavailable.'), 503);
          }
          const outcome = await requestModeTransition(deps, {
            roomId,
            targetMode: body.target_mode,
            userId: auth.userId,
            reason: body.reason,
          });
          if (!outcome.ok) {
            return c.json(
              {
                error: { code: outcome.code, message: outcome.message },
                unmet: outcome.unmet ?? [],
              },
              outcome.status,
            );
          }
          return c.json({ governance_mode: outcome.mode });
        },
      )
  );
}

export type RoomGovernanceSimRoutes = ReturnType<typeof createRoomGovernanceSimRoutes>;
