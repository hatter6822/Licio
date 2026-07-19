// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M treasury-and-governance routes (SPEC §23.4; the A.3 surface of
// docs/planning/14-treasury-and-governance.md).  The PRODUCTION-only paths:
// charters, law-pack registration/validation/adoption, readiness attestations,
// freeze/pause, the governance profile, the real-asset treasury (creation,
// dashboard, payment intents), grants, delegations, budgets, proposal signing/
// challenges, and the accounting export.  The mode-aware EXTENSIONS of the
// shipped WS-L.4 paths (readiness, mode transitions, proposal create/execute,
// the treasury tab read) live in `room-governance.ts` — one path, one surface.
//
// Authorization: room membership/stewardship via the knomosis room port; the
// platform legal floor (`restrict` capability — the same guard as the WS-U
// agent freeze) marks PLATFORM STAFF for unfreeze, external-audit attestations,
// and legal/capture challenge dispositions.  Everything is flag-gated
// fail-closed: governance surfaces need `governanceEnabled`, fund-moving
// surfaces additionally need `cryptoEnabled`.

import { zValidator } from '@hono/zod-validator';
import {
  accountingExportResponseSchema,
  challengeResolveRequestSchema,
  charterCreateRequestSchema,
  charterHistoryResponseSchema,
  delegationCreateRequestSchema,
  delegationListResponseSchema,
  grantListResponseSchema,
  grantMilestoneUpdateRequestSchema,
  lawPackHistoryResponseSchema,
  lawPackRegisterRequestSchema,
  paymentIntentCreateRequestSchema,
  proposalChallengeRequestSchema,
  proposalSignRequestSchema,
  readinessAttestationRequestSchema,
  roomGovernanceProfileResponseSchema,
  treasuryCreateRequestSchema,
  treasuryDashboardResponseSchema,
  treasuryFreezeRequestSchema,
  treasuryPauseRequestSchema,
  uuidSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { createCase } from '../compliance/cases.js';
import { disclosureGate } from '../compliance/disclosures.js';
import {
  buildCaseDeps,
  buildDisclosureDeps,
  complianceServicesConfigured,
  getComplianceServices,
} from '../compliance/services.js';
import { getKnomosisServices } from '../knomosis/services.js';
import {
  type AuthEnv,
  authMiddleware,
  requireAdult,
  requireAuth,
  requireVerifiedAccount,
} from '../middleware/auth.js';
import { denyCapability, type StewardActor } from '../moderation/authz.js';
import { verifyAuditChain } from '../treasury/audit-chain.js';
import { createCharterVersion } from '../treasury/charter.js';
import { createDelegation, revokeDelegation } from '../treasury/delegations.js';
import { buildAccountingExport } from '../treasury/export.js';
import { markGrantClawedBack, setGrantReview, updateGrantMilestone } from '../treasury/grants.js';
import {
  attachIntentSubmission,
  createPaymentIntent,
  disputeIntent,
  markIntentSigned,
  preflightIntent,
  quoteIntent,
  retryIntent,
} from '../treasury/intents.js';
import { adoptLawPack, registerLawPack, validateLawPackDocument } from '../treasury/law-packs.js';
import {
  assertGovernanceWritable,
  ensureProfile,
  setGovernanceFreeze,
  setGovernancePause,
  type TreasuryGovernanceError,
} from '../treasury/profile.js';
import { fileChallenge, resolveChallenge, signProposal } from '../treasury/proposals.js';
import { recordReadinessAttestation } from '../treasury/readiness.js';
import { getTreasuryServices } from '../treasury/services.js';
import { createTreasury, treasuryDashboard } from '../treasury/treasury.js';

const deny = (code: string, message: string) => ({ error: { code, message } });
const notFound = { error: { code: 'not_found', message: 'Resource not found' } };

const roomParam = zValidator('param', z.object({ roomId: uuidSchema }));

function stewardActorOf(auth: NonNullable<AuthEnv['Variables']['auth']>): StewardActor {
  return {
    userId: auth.userId,
    platformRoles: auth.roles,
    stewardRoles: auth.stewardRoles,
    mfaActive: auth.mfaActive,
    mfaVerified: auth.mfaVerified,
  };
}

/** Platform staff = the WS-J `restrict` capability (the platform legal floor). */
function isPlatformStaff(auth: NonNullable<AuthEnv['Variables']['auth']>): boolean {
  return denyCapability(stewardActorOf(auth), 'restrict') === null;
}

function tgError(
  c: { json: (body: unknown, status: never) => Response },
  error: TreasuryGovernanceError,
) {
  return c.json(deny(error.code, error.message), error.status as never);
}

/** Governance surfaces need the governance flag; fund movement needs crypto. */
function flagGate(kind: 'governance' | 'crypto'): { code: string; message: string } | null {
  const config = getKnomosisServices().config();
  if (!config.governanceEnabled) {
    return { code: 'governance_disabled', message: 'Governance is not enabled.' };
  }
  if (kind === 'crypto' && !config.cryptoEnabled) {
    return { code: 'crypto_disabled', message: 'Crypto features are disabled.' };
  }
  return null;
}

export function createTreasuryGovernanceRoutes() {
  return (
    new Hono<AuthEnv>()
      // --- Governance profile (WS-M.1.1a) --------------------------------------
      .get('/rooms/:roomId/governance/profile', authMiddleware(), roomParam, async (c) => {
        const auth = requireAuth(c);
        const gate = flagGate('governance');
        if (gate) return c.json(deny(gate.code, gate.message), 503);
        const services = getTreasuryServices();
        const roomId = c.req.valid('param').roomId;
        const rooms = getKnomosisServices().rooms;
        if (rooms === null || !(await rooms.contentVisibleToUser(roomId, auth.userId))) {
          return c.json(notFound, 404);
        }
        const mode = await services.roomMode.currentMode(roomId);
        if (mode === null) return c.json(notFound, 404);
        const profile = await ensureProfile(services, roomId);
        return c.json(
          roomGovernanceProfileResponseSchema.parse({
            profile: {
              room_id: profile.roomId,
              governance_mode: mode,
              law_pack_id: profile.lawPackId,
              charter_version_id: profile.charterVersionId,
              treasury_id: profile.treasuryId,
              freeze_state: profile.freezeState,
              freeze_reason: profile.freezeReason,
              pause_flags: profile.pauseFlags,
              updated_at: profile.updatedAt,
            },
          }),
        );
      })

      // --- Charters (WS-M.1.2a) -------------------------------------------------
      .post(
        '/rooms/:roomId/governance/charter',
        authMiddleware(),
        roomParam,
        zValidator('json', charterCreateRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const roomId = c.req.valid('param').roomId;
          if (!(await services.rooms.isSteward(roomId, auth.userId))) {
            return c.json(notFound, 404); // 404-over-403 (no steward oracle)
          }
          // Post-enablement charter changes go through the charter_update
          // PROPOSAL (whose execution publishes the version); the direct
          // route is the pre-enablement drafting path only — mirrors the
          // law-pack adoption gate below (PR #144 W10).
          const mode = await services.roomMode.currentMode(roomId);
          if (mode !== 'ordinary' && mode !== 'simulated') {
            return c.json(
              deny('proposal_required', 'Governed rooms change charters via a proposal.'),
              409,
            );
          }
          const result = await createCharterVersion(services, {
            roomId,
            sections: c.req.valid('json').sections,
            actorUserId: auth.userId,
          });
          if ('code' in result) return tgError(c, result);
          const charter = result.charter;
          return c.json(
            {
              charter_version_id: charter.charterVersionId,
              version: charter.version,
              content_hash: charter.contentHash,
            },
            201,
          );
        },
      )
      .get('/rooms/:roomId/governance/charter', authMiddleware(), roomParam, async (c) => {
        const auth = requireAuth(c);
        const gate = flagGate('governance');
        if (gate) return c.json(deny(gate.code, gate.message), 503);
        const services = getTreasuryServices();
        const roomId = c.req.valid('param').roomId;
        const rooms = getKnomosisServices().rooms;
        if (rooms === null || !(await rooms.contentVisibleToUser(roomId, auth.userId))) {
          return c.json(notFound, 404);
        }
        const versions = await services.charters.listByRoom(roomId);
        return c.json(
          charterHistoryResponseSchema.parse({
            versions: versions.map((v) => ({
              charter_version_id: v.charterVersionId,
              room_id: v.roomId,
              version: v.version,
              sections: v.sections,
              content_hash: v.contentHash,
              created_by_user_id: v.createdByUserId,
              created_at: v.createdAt,
            })),
          }),
        );
      })

      // --- Law-packs (WS-M.1.3) ---------------------------------------------------
      .post(
        '/rooms/:roomId/governance/law-packs/wsm',
        authMiddleware(),
        roomParam,
        zValidator('json', lawPackRegisterRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const roomId = c.req.valid('param').roomId;
          if (!(await services.rooms.isSteward(roomId, auth.userId))) {
            return c.json(notFound, 404);
          }
          const body = c.req.valid('json');
          const result = await registerLawPack(services, {
            roomId,
            document: body.document,
            fixtures: body.fixtures,
            actorUserId: auth.userId,
          });
          if ('code' in result) return tgError(c, result);
          return c.json(
            {
              law_pack_id: result.record.lawPackId,
              version: result.record.version,
              hash_commitment: result.hashCommitment,
            },
            201,
          );
        },
      )
      .post(
        '/rooms/:roomId/governance/law-packs/validate',
        authMiddleware(),
        roomParam,
        zValidator('json', lawPackRegisterRequestSchema),
        async (c) => {
          requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const body = c.req.valid('json');
          const report = validateLawPackDocument(body.document, body.fixtures);
          return c.json({
            structural_problems: report.structuralProblems,
            real_asset_problems: report.realAssetProblems,
            fixture_failures: report.fixtureFailures,
            coverage_problems: report.coverageProblems,
          });
        },
      )
      .get(
        '/rooms/:roomId/governance/law-packs/history',
        authMiddleware(),
        roomParam,
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const roomId = c.req.valid('param').roomId;
          const rooms = getKnomosisServices().rooms;
          if (rooms === null || !(await rooms.contentVisibleToUser(roomId, auth.userId))) {
            return c.json(notFound, 404);
          }
          const versions = await services.lawPacks.listByRoom(roomId);
          return c.json(
            lawPackHistoryResponseSchema.parse({
              versions: versions.map((v) => ({
                law_pack_id: v.lawPackId,
                version: v.version,
                hash_commitment: v.hashCommitment ?? null,
                supersedes_law_pack_id: v.supersedesLawPackId ?? null,
                audit_state: v.auditState ?? 'draft',
                published: v.published ?? false,
                created_at: v.createdAt,
              })),
            }),
          );
        },
      )
      .post(
        '/rooms/:roomId/governance/law-packs/:lawPackId/adopt',
        authMiddleware(),
        zValidator('param', z.object({ roomId: uuidSchema, lawPackId: uuidSchema })),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const { roomId, lawPackId } = c.req.valid('param');
          if (!(await services.rooms.isSteward(roomId, auth.userId))) {
            return c.json(notFound, 404);
          }
          // Post-enablement upgrades go through the law_pack_upgrade PROPOSAL;
          // direct adoption is the pre-enablement configuration path only.
          const mode = await services.roomMode.currentMode(roomId);
          if (mode !== 'ordinary' && mode !== 'simulated') {
            return c.json(
              deny('proposal_required', 'Adopted rooms upgrade law-packs via a proposal.'),
              409,
            );
          }
          const result = await adoptLawPack(services, {
            roomId,
            lawPackId,
            actorUserId: auth.userId,
          });
          if ('code' in result) return tgError(c, result);
          return c.json({ law_pack_id: result.record.lawPackId, version: result.record.version });
        },
      )

      // --- Readiness attestations (WS-M.1.2d/e) ---------------------------------
      .post(
        '/rooms/:roomId/governance/attestations',
        authMiddleware(),
        roomParam,
        zValidator('json', readinessAttestationRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const roomId = c.req.valid('param').roomId;
          const body = c.req.valid('json');
          const staff = isPlatformStaff(auth);
          // Staff bypass isSteward, so the SERVER-room existence gate must run
          // explicitly: attestations create WS-M state, and a p2p/unknown room
          // holds none (W15).
          if ((await services.rooms.roomGovernance(roomId)) === null) {
            return c.json(notFound, 404);
          }
          if (!staff && !(await services.rooms.isSteward(roomId, auth.userId))) {
            return c.json(notFound, 404);
          }
          const result = await recordReadinessAttestation(services, {
            roomId,
            item: body.item,
            note: body.note,
            actorUserId: auth.userId,
            isPlatformStaff: staff,
          });
          if ('code' in result) return tgError(c, result);
          return c.json({ ok: true }, 201);
        },
      )

      // --- Freeze / pause (WS-M.2.4a/b) ------------------------------------------
      .post(
        '/rooms/:roomId/governance/freeze',
        authMiddleware(),
        roomParam,
        zValidator('json', treasuryFreezeRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const roomId = c.req.valid('param').roomId;
          const body = c.req.valid('json');
          const staff = isPlatformStaff(auth);
          // Freeze bootstraps the room's profile — never for a p2p/unknown
          // room, staff included (W15).
          if ((await services.rooms.roomGovernance(roomId)) === null) {
            return c.json(notFound, 404);
          }
          if (!staff && !(await services.rooms.isSteward(roomId, auth.userId))) {
            return c.json(notFound, 404);
          }
          const result = await setGovernanceFreeze(services, {
            roomId,
            action: body.action,
            scope: body.scope,
            source: body.source,
            reason: body.reason,
            actorUserId: auth.userId,
            isPlatformStaff: staff,
          });
          if ('code' in result) return tgError(c, result);
          return c.json({ freeze_state: result.profile.freezeState });
        },
      )
      .post(
        '/rooms/:roomId/governance/pause',
        authMiddleware(),
        roomParam,
        zValidator('json', treasuryPauseRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const roomId = c.req.valid('param').roomId;
          const body = c.req.valid('json');
          // Pause bootstraps the room's profile — never for a p2p/unknown
          // room, staff included (W15).
          if ((await services.rooms.roomGovernance(roomId)) === null) {
            return c.json(notFound, 404);
          }
          if (!isPlatformStaff(auth) && !(await services.rooms.isSteward(roomId, auth.userId))) {
            return c.json(notFound, 404);
          }
          const patch: Record<string, boolean> = {};
          if (body.deposits !== undefined) patch['deposits'] = body.deposits;
          if (body.proposals !== undefined) patch['proposals'] = body.proposals;
          if (body.executions !== undefined) patch['executions'] = body.executions;
          const result = await setGovernancePause(services, {
            roomId,
            patch,
            reason: body.reason,
            actorUserId: auth.userId,
          });
          if ('code' in result) return tgError(c, result);
          return c.json({ pause_flags: result.profile.pauseFlags });
        },
      )

      // --- Real-asset treasury (WS-M.2.1a + 2.2) ---------------------------------
      .post(
        '/rooms/:roomId/treasury',
        authMiddleware(),
        requireVerifiedAccount(),
        requireAdult(),
        roomParam,
        zValidator('json', treasuryCreateRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('crypto');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const roomId = c.req.valid('param').roomId;
          if (!(await services.rooms.isSteward(roomId, auth.userId))) {
            return c.json(notFound, 404);
          }
          // An emergency/platform freeze blocks provisioning too — the guard is
          // documented as covering EVERY WS-M mutation (WS-M.2.4a-1).
          const frozen = await assertGovernanceWritable(services, roomId, 'configuration');
          if (frozen !== null) return tgError(c, frozen);
          const body = c.req.valid('json');
          const result = await createTreasury(services, {
            roomId,
            deploymentId: body.deployment_id,
            treasuryAddress: body.treasury_address,
            acceptedAssets: body.accepted_assets,
            depositLimits: {
              perUserPerPeriod: body.deposit_limits.per_user_per_period,
              perRoomPerPeriod: body.deposit_limits.per_room_per_period,
              perDepositMax: body.deposit_limits.per_deposit_max,
              periodSeconds: body.deposit_limits.period_seconds,
            },
            actorUserId: auth.userId,
          });
          if ('code' in result) return tgError(c, result);
          return c.json({ treasury_id: result.treasury.treasuryId }, 201);
        },
      )
      .get('/rooms/:roomId/treasury/dashboard', authMiddleware(), roomParam, async (c) => {
        const auth = requireAuth(c);
        const gate = flagGate('governance');
        if (gate) return c.json(deny(gate.code, gate.message), 503);
        const services = getTreasuryServices();
        const roomId = c.req.valid('param').roomId;
        const rooms = getKnomosisServices().rooms;
        if (rooms === null || !(await rooms.contentVisibleToUser(roomId, auth.userId))) {
          return c.json(notFound, 404);
        }
        const dashboard = await treasuryDashboard(services, roomId);
        return c.json(treasuryDashboardResponseSchema.parse({ treasury: dashboard }));
      })

      // --- Payment intents (WS-M.3.1) --------------------------------------------
      .post(
        '/rooms/:roomId/treasury/payment-intents',
        authMiddleware(),
        requireVerifiedAccount(),
        requireAdult(),
        roomParam,
        zValidator('json', paymentIntentCreateRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const services = getTreasuryServices();
          const roomId = c.req.valid('param').roomId;
          if (!(await services.rooms.isMember(roomId, auth.userId))) {
            return c.json(notFound, 404);
          }
          const body = c.req.valid('json');
          // The member-facing path CONTRIBUTES only: payout-class intents
          // (grant_payout/steward_compensation) are minted exclusively by the
          // grant-milestone service against an accepted milestone — a public
          // payout intent with an arbitrary target/amount would become a
          // disbursement the moment a matching signed action attaches.
          if (
            body.target_type !== 'treasury_deposit' &&
            body.target_type !== 'bounty_contribution'
          ) {
            return c.json(
              deny('target_not_allowed', 'Only deposit-class intents can be created here.'),
              403,
            );
          }
          // Is this a RETRY of an intent that already exists?  `createPaymentIntent`
          // answers a replay from the idempotency key before its own gates —
          // "a replay of an ALREADY-CREATED intent has no new side effects" —
          // but the disclosure gate below sits in front of it, which undoes
          // that: a disclosure published after the original create would hand
          // the retry `disclosure_ack_required` instead of the existing
          // `payment_intent_id`, so the client never learns its intent id and
          // the in-flight intent strands behind an unrelated new gate.  Gates
          // decide whether a NEW intent may be created.
          const replay = await services.intents.findByIdempotencyKey(
            auth.userId,
            roomId,
            body.idempotency_key,
          );
          // The crypto flag gates CREATING an intent, so it sits with the
          // gates rather than ahead of the replay.  Ahead of it, a retry after
          // a lost response — with crypto disabled in between — got a 503
          // instead of the existing `payment_intent_id`, and there is no way to
          // recover that id afterwards: the intent sat orphaned until it
          // expired.  Returning it creates nothing.
          if (replay === null) {
            const gate = flagGate('crypto');
            if (gate) return c.json(deny(gate.code, gate.message), 503);
          }
          // WS-N.1.2d — the first-financial-action disclosure gate: where the
          // user's region policy lists risk disclosures, the CURRENT version
          // of each must be acknowledged before any intent is created here
          // (fail-closed: an unreadable ack store reports them missing).
          if (replay === null && complianceServicesConfigured()) {
            const disclosureCheck = await disclosureGate(
              buildDisclosureDeps(getComplianceServices()),
              auth.userId,
            );
            if (disclosureCheck.unavailable) {
              // Policy-store OUTAGE: the disclosure requirement is unreadable, so
              // fail closed rather than mint an allowance-consuming intent on an
              // unverified gate.
              return c.json(
                deny('disclosure_unavailable', 'Risk disclosures cannot be verified right now.'),
                503,
              );
            }
            if (disclosureCheck.required) {
              return c.json(
                {
                  error: {
                    code: 'disclosure_ack_required',
                    message:
                      'Acknowledge the current risk disclosures before your first financial action.',
                  },
                  missing: disclosureCheck.missing,
                },
                403,
              );
            }
          }
          const result = await createPaymentIntent(services, {
            userId: auth.userId,
            actorUserId: auth.userId,
            roomId,
            targetType: body.target_type,
            targetId: body.target_id,
            asset: body.asset,
            amount: body.amount,
            idempotencyKey: body.idempotency_key,
          });
          if ('code' in result) return tgError(c, result);
          return c.json(
            { payment_intent_id: result.intent.paymentIntentId, existing: result.existing },
            result.existing ? 200 : 201,
          );
        },
      )
      .get(
        '/rooms/:roomId/treasury/payment-intents/:paymentIntentId',
        authMiddleware(),
        zValidator('param', z.object({ roomId: uuidSchema, paymentIntentId: uuidSchema })),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const { roomId, paymentIntentId } = c.req.valid('param');
          const intent = await services.intents.getById(paymentIntentId);
          if (intent === null || intent.roomId !== roomId) return c.json(notFound, 404);
          // Owner or steward only — intents carry the actor's financial activity.
          if (
            intent.userId !== auth.userId &&
            !(await services.rooms.isSteward(roomId, auth.userId))
          ) {
            return c.json(notFound, 404);
          }
          return c.json({
            intent: {
              payment_intent_id: intent.paymentIntentId,
              user_id: intent.userId,
              room_id: intent.roomId,
              target_type: intent.targetType,
              target_id: intent.targetId,
              asset: intent.asset,
              amount: intent.amount,
              jurisdiction_state: intent.jurisdictionState,
              compliance_state: intent.complianceState,
              execution_state: intent.executionState,
              retry_count: intent.retryCount,
              action_record_id: intent.actionRecordId,
              receipt_id: intent.receiptId,
              expires_at: intent.expiresAt,
              created_at: intent.createdAt,
              updated_at: intent.updatedAt,
            },
          });
        },
      )
      .post(
        '/rooms/:roomId/treasury/payment-intents/:paymentIntentId/advance',
        authMiddleware(),
        requireVerifiedAccount(),
        requireAdult(),
        zValidator('param', z.object({ roomId: uuidSchema, paymentIntentId: uuidSchema })),
        zValidator(
          'json',
          z
            .object({
              step: z.enum(['preflight', 'quote', 'signed', 'retry']),
              action_record_id: uuidSchema.optional(),
            })
            .strict(),
        ),
        async (c) => {
          const auth = requireAuth(c);
          const services = getTreasuryServices();
          const { roomId, paymentIntentId } = c.req.valid('param');
          const body = c.req.valid('json');
          // A lifecycle step mutates SOMEONE'S financial intent: it must belong
          // to this room and to the caller (or a room steward) — an intent id
          // alone is never authorization (mirrors the GET above).  Authorization
          // FIRST, before the mint gate.
          const target = await services.intents.getById(paymentIntentId);
          if (target === null || target.roomId !== roomId) return c.json(notFound, 404);
          if (
            target.userId !== auth.userId &&
            !(await services.rooms.isSteward(roomId, auth.userId))
          ) {
            return c.json(notFound, 404);
          }
          // The crypto flag gates a NEW fund movement — every step EXCEPT the
          // ATTACH (`signed` + action_record_id).  That step is BOOKKEEPING for an
          // action `/actions/submit` already placed on chain (attachIntentSubmission
          // carries no writability guard for exactly this reason, W15), so an
          // operator disabling crypto between submit and attach must not reject it
          // with 503 and strand the signed intent outside the ledger/export until
          // background reconciliation catches it.
          const isAttach = body.step === 'signed' && body.action_record_id !== undefined;
          if (!isAttach) {
            const gate = flagGate('crypto');
            if (gate) return c.json(deny(gate.code, gate.message), 503);
          }
          const result =
            body.step === 'preflight'
              ? await preflightIntent(services, paymentIntentId, auth.userId)
              : body.step === 'quote'
                ? await quoteIntent(services, paymentIntentId, auth.userId)
                : body.step === 'retry'
                  ? await retryIntent(services, paymentIntentId, auth.userId)
                  : body.action_record_id !== undefined
                    ? await attachIntentSubmission(
                        services,
                        paymentIntentId,
                        body.action_record_id,
                        auth.userId,
                      )
                    : await markIntentSigned(services, paymentIntentId, auth.userId);
          if ('code' in result) return tgError(c, result);
          // The quote rides back with the state so the client preview can show
          // every fee upfront (WS-L.2.6c) — never a fee discovered at signing.
          return c.json({
            execution_state: result.intent.executionState,
            quote: result.intent.quoteRef ?? null,
          });
        },
      )
      .post(
        // WS-M.4.3d post-finality dispute: the owner or a steward flags a
        // FINALIZED payment for review — the only edge out of `finalized`.
        '/rooms/:roomId/treasury/payment-intents/:paymentIntentId/dispute',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema, paymentIntentId: uuidSchema })),
        zValidator('json', z.object({ reason: z.string().trim().min(1).max(2000) }).strict()),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const { roomId, paymentIntentId } = c.req.valid('param');
          const { reason } = c.req.valid('json');
          // Authorization FIRST: owner or steward, room match (an intent id is
          // never authorization — mirrors the advance/read handlers above).
          const target = await services.intents.getById(paymentIntentId);
          if (target === null || target.roomId !== roomId) return c.json(notFound, 404);
          if (
            target.userId !== auth.userId &&
            !(await services.rooms.isSteward(roomId, auth.userId))
          ) {
            return c.json(notFound, 404);
          }
          const result = await disputeIntent(services, paymentIntentId, auth.userId);
          if ('code' in result) return tgError(c, result);
          // Open a human-initiated compliance review carrying the reason.  The
          // dispute is already committed + audited on-chain, so a case-open
          // failure must NOT fail the request (the case is a secondary artifact).
          if (complianceServicesConfigured()) {
            const subject =
              target.userId !== null
                ? { kind: 'user' as const, ref: target.userId }
                : { kind: 'room' as const, ref: target.roomId };
            await createCase(buildCaseDeps(getComplianceServices()), {
              subjectKind: subject.kind,
              subjectRef: subject.ref,
              triggerType: 'manual',
              riskLevel: 'medium',
              note: `Finalized payment intent ${paymentIntentId} disputed: ${reason}`,
              idempotencyKey: `intent-dispute:${paymentIntentId}`,
              actorUserId: auth.userId,
            });
          }
          return c.json({ execution_state: result.intent.executionState });
        },
      )

      // --- Grants (WS-M.5.1a) ------------------------------------------------------
      .get('/rooms/:roomId/treasury/grants', authMiddleware(), roomParam, async (c) => {
        const auth = requireAuth(c);
        const gate = flagGate('governance');
        if (gate) return c.json(deny(gate.code, gate.message), 503);
        const services = getTreasuryServices();
        const roomId = c.req.valid('param').roomId;
        const rooms = getKnomosisServices().rooms;
        if (rooms === null || !(await rooms.contentVisibleToUser(roomId, auth.userId))) {
          return c.json(notFound, 404);
        }
        const grants = await services.grants.listByRoom(roomId, 100);
        return c.json(
          grantListResponseSchema.parse({
            grants: grants.map((g) => ({
              grant_id: g.grantId,
              room_id: g.roomId,
              treasury_id: g.treasuryId,
              proposal_id: g.proposalId,
              recipient_ref: g.recipientRef,
              purpose: g.purpose,
              amount: g.amount,
              asset: g.asset,
              milestones: g.milestones.map((m) => ({
                milestone_id: m.milestoneId,
                description: m.description,
                amount: m.amount,
                state: m.state,
                payment_intent_id: m.paymentIntentId,
              })),
              milestone_state: g.milestoneState,
              review_state: g.reviewState,
              payout_state: g.payoutState,
              audit_summary: g.auditSummary,
              created_at: g.createdAt,
            })),
          }),
        );
      })
      .post(
        '/rooms/:roomId/treasury/grants/:grantId/review',
        authMiddleware(),
        // Review clearance is the payout prerequisite — the same verified+
        // adult bar as the milestone route it unlocks (sweep).
        requireVerifiedAccount(),
        requireAdult(),
        zValidator('param', z.object({ roomId: uuidSchema, grantId: uuidSchema })),
        zValidator(
          'json',
          z.object({ review_state: z.enum(['independent_review', 'cleared', 'flagged']) }).strict(),
        ),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const { roomId, grantId } = c.req.valid('param');
          // Review CLEARANCE gates disbursement (milestone acceptance requires
          // it) — a reviewer authority, not mere membership: room stewards or
          // platform staff (the service still blocks proposer/recipient COI).
          if (!isPlatformStaff(auth) && !(await services.rooms.isSteward(roomId, auth.userId))) {
            return c.json(notFound, 404);
          }
          const result = await setGrantReview(services, {
            roomId,
            grantId,
            reviewState: c.req.valid('json').review_state,
            reviewerUserId: auth.userId,
          });
          if ('code' in result) return tgError(c, result);
          return c.json({ review_state: result.grant.reviewState });
        },
      )
      .post(
        '/rooms/:roomId/treasury/grants/:grantId/milestones/:milestoneId',
        authMiddleware(),
        // Milestone transitions mutate DISBURSEMENT state (acceptance mints
        // the payout intent): the same verified+adult bar as every other
        // fund-moving treasury action (W12).
        requireVerifiedAccount(),
        requireAdult(),
        zValidator(
          'param',
          z.object({ roomId: uuidSchema, grantId: uuidSchema, milestoneId: uuidSchema }),
        ),
        zValidator('json', grantMilestoneUpdateRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('crypto');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const { roomId, grantId, milestoneId } = c.req.valid('param');
          if (!(await services.rooms.isSteward(roomId, auth.userId))) {
            return c.json(notFound, 404);
          }
          const result = await updateGrantMilestone(services, {
            roomId,
            grantId,
            milestoneId,
            state: c.req.valid('json').state,
            actorUserId: auth.userId,
          });
          if ('code' in result) return tgError(c, result);
          return c.json({ milestone_state: result.grant.milestoneState });
        },
      )
      .post(
        '/rooms/:roomId/treasury/grants/:grantId/clawback',
        authMiddleware(),
        zValidator('param', z.object({ roomId: uuidSchema, grantId: uuidSchema })),
        zValidator('json', z.object({ note: z.string().trim().min(1).max(2_000) }).strict()),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('crypto');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          if (!isPlatformStaff(auth)) {
            return c.json(deny('platform_review_required', 'Clawback needs platform review.'), 403);
          }
          const services = getTreasuryServices();
          const { roomId, grantId } = c.req.valid('param');
          const result = await markGrantClawedBack(services, {
            roomId,
            grantId,
            actorUserId: auth.userId,
            note: c.req.valid('json').note,
          });
          if ('code' in result) return tgError(c, result);
          return c.json({ payout_state: result.grant.payoutState });
        },
      )

      // --- Proposal signing / challenges (WS-M.2.3b-1 + 4.3a) --------------------
      .post(
        '/rooms/:roomId/governance/proposals/:proposalId/sign',
        authMiddleware(),
        // Parity with the WS-L signed-action routes: a wallet signature is a
        // real-asset governance act — verified account + adult gate required.
        requireVerifiedAccount(),
        requireAdult(),
        zValidator('param', z.object({ roomId: uuidSchema, proposalId: uuidSchema })),
        zValidator('json', proposalSignRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const { roomId, proposalId } = c.req.valid('param');
          const body = c.req.valid('json');
          const result = await signProposal(services, {
            roomId,
            proposalId,
            userId: auth.userId,
            purpose: body.purpose,
            choice: body.choice,
            deploymentId: body.deployment_id,
            walletAccountId: body.wallet_account_id,
            typedDataMessage: body.typed_data_message,
            signature: body.signature,
          });
          if ('code' in result) return tgError(c, result);
          return c.json({
            signature_id: result.signature.signatureId,
            weight_snapshot: result.signature.weightSnapshot ?? '0',
            eligibility_reason: result.signature.eligibilityReason,
            tally: result.tally,
          });
        },
      )
      .post(
        '/rooms/:roomId/governance/proposals/:proposalId/challenge',
        authMiddleware(),
        // Filing blocks execution: age-open by design (a member safety valve)
        // but VERIFIED — an unverified throwaway must not stall a treasury
        // (one open challenge per member is capped in the service) (sweep).
        requireVerifiedAccount(),
        zValidator('param', z.object({ roomId: uuidSchema, proposalId: uuidSchema })),
        zValidator('json', proposalChallengeRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const { roomId, proposalId } = c.req.valid('param');
          const body = c.req.valid('json');
          const result = await fileChallenge(services, {
            roomId,
            proposalId,
            userId: auth.userId,
            challengeType: body.challenge_type,
            description: body.description,
            evidenceRefs: body.evidence_refs,
          });
          if ('code' in result) return tgError(c, result);
          return c.json({ challenge_id: result.challenge.challengeId }, 201);
        },
      )
      .post(
        '/rooms/:roomId/governance/challenges/:challengeId/resolve',
        authMiddleware(),
        // Resolution CLEARS the execution blocker on a real-asset proposal —
        // the same verified+adult bar as signing/delegation/execution applies
        // (a teen or unverified steward must not dismiss the last blocker and
        // hand another steward a clear execute) (W14).
        requireVerifiedAccount(),
        requireAdult(),
        zValidator('param', z.object({ roomId: uuidSchema, challengeId: uuidSchema })),
        zValidator('json', challengeResolveRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const { roomId, challengeId } = c.req.valid('param');
          const body = c.req.valid('json');
          const result = await resolveChallenge(services, {
            roomId,
            challengeId,
            resolution: body.resolution,
            resolutionNote: body.resolution_note,
            actorUserId: auth.userId,
            isPlatformStaff: isPlatformStaff(auth),
          });
          if ('code' in result) return tgError(c, result);
          return c.json({ state: result.challenge.state });
        },
      )

      // --- Delegation (WS-M.4.2c-3) ------------------------------------------------
      .post(
        '/rooms/:roomId/governance/delegations',
        authMiddleware(),
        roomParam,
        zValidator('json', delegationCreateRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          // Delegation SHIFTS production voting power: the same verified +
          // adult bar as casting the ballot directly, or an account that
          // cannot vote treasury-controlling proposals could still route its
          // unit through an adult delegate (PR #144 W11).
          if (!auth.accountVerified) {
            return c.json(deny('verification_required', 'Verify your account to continue'), 403);
          }
          if (auth.ageBand !== 'adult') {
            return c.json(deny('adult_required', 'This feature is not available'), 403);
          }
          const services = getTreasuryServices();
          const roomId = c.req.valid('param').roomId;
          const body = c.req.valid('json');
          if (
            !(await services.rooms.isMember(roomId, auth.userId)) ||
            !(await services.rooms.isMember(roomId, body.delegate_user_id))
          ) {
            return c.json(notFound, 404);
          }
          const result = await createDelegation(services, {
            roomId,
            delegatorUserId: auth.userId,
            delegateUserId: body.delegate_user_id,
            scope: body.scope,
          });
          if ('code' in result) return tgError(c, result);
          return c.json({ delegation_id: result.delegation.delegationId }, 201);
        },
      )
      .post(
        '/rooms/:roomId/governance/delegations/:delegationId/revoke',
        authMiddleware(),
        zValidator('param', z.object({ roomId: uuidSchema, delegationId: uuidSchema })),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const { roomId, delegationId } = c.req.valid('param');
          const result = await revokeDelegation(services, {
            roomId,
            delegationId,
            actorUserId: auth.userId,
            isPlatformStaff: isPlatformStaff(auth),
          });
          if ('code' in result) return tgError(c, result);
          return c.json({ state: result.delegation.state });
        },
      )
      .get('/rooms/:roomId/governance/delegations', authMiddleware(), roomParam, async (c) => {
        const auth = requireAuth(c);
        const gate = flagGate('governance');
        if (gate) return c.json(deny(gate.code, gate.message), 503);
        const services = getTreasuryServices();
        const roomId = c.req.valid('param').roomId;
        const rooms = getKnomosisServices().rooms;
        if (rooms === null || !(await rooms.contentVisibleToUser(roomId, auth.userId))) {
          return c.json(notFound, 404);
        }
        const delegations = await services.delegations.listByRoom(roomId, 200);
        return c.json(
          delegationListResponseSchema.parse({
            delegations: delegations.map((d) => ({
              delegation_id: d.delegationId,
              room_id: d.roomId,
              delegator_user_id: d.delegatorUserId,
              delegate_user_id: d.delegateUserId,
              scope: d.scope,
              state: d.state,
              created_at: d.createdAt,
              revoked_at: d.revokedAt,
            })),
          }),
        );
      })

      // --- Accounting export (WS-M.5.2b) + audit-chain verification --------------
      .get(
        '/rooms/:roomId/treasury/export',
        authMiddleware(),
        roomParam,
        // Loose here (types the RPC client); the datetime check below keeps
        // the specific `invalid_period` error code.
        zValidator(
          'query',
          z.object({ period_start: z.string().optional(), period_end: z.string().optional() }),
        ),
        async (c) => {
          const auth = requireAuth(c);
          const gate = flagGate('governance');
          if (gate) return c.json(deny(gate.code, gate.message), 503);
          const services = getTreasuryServices();
          const roomId = c.req.valid('param').roomId;
          // Sensitive financial records: stewards + platform finance only.
          if (!isPlatformStaff(auth) && !(await services.rooms.isSteward(roomId, auth.userId))) {
            return c.json(notFound, 404);
          }
          const query = z
            .object({ period_start: z.string().datetime(), period_end: z.string().datetime() })
            .safeParse(c.req.valid('query'));
          if (!query.success) {
            return c.json(deny('invalid_period', 'period_start and period_end are required.'), 400);
          }
          const result = await buildAccountingExport(services, {
            roomId,
            periodStartIso: query.data.period_start,
            periodEndIso: query.data.period_end,
          });
          if ('code' in result) return tgError(c, result);
          return c.json(accountingExportResponseSchema.parse(result.export));
        },
      )
      .get('/rooms/:roomId/governance/audit-chain', authMiddleware(), roomParam, async (c) => {
        const auth = requireAuth(c);
        const gate = flagGate('governance');
        if (gate) return c.json(deny(gate.code, gate.message), 503);
        const services = getTreasuryServices();
        const roomId = c.req.valid('param').roomId;
        const rooms = getKnomosisServices().rooms;
        if (rooms === null || !(await rooms.contentVisibleToUser(roomId, auth.userId))) {
          return c.json(notFound, 404);
        }
        const verification = await verifyAuditChain(services, roomId);
        return c.json({
          valid: verification.valid,
          chained_entries: verification.chainedEntries,
          problems: verification.problems,
        });
      })
  );
}

export type TreasuryGovernanceRoutes = ReturnType<typeof createTreasuryGovernanceRoutes>;
