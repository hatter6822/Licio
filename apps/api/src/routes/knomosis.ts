// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.1/3 Knomosis routes (SPEC §23.4): GET /deployments, GET
// /deployments/:id/manifest, POST /actions/preflight, POST /actions/submit,
// GET /actions/:id, the WS-L.3.6a standing reads (per selected wallet), the
// private-receipt export, and the kill-switch admin surface (steward+MFA,
// two-person deactivation).
//
// Availability: everything except the admin surface requires the runtime
// crypto flag (fail-closed 503 when off).  Submission additionally honours
// the action-submission kill switch (preflight stays available during an
// incident — WS-L.3.5c — so users can see WHY an action would fail).

import { zValidator } from '@hono/zod-validator';
import {
  KILL_SWITCH_IDS,
  type KnomosisSignedActionType,
  killSwitchAdminRequestSchema,
  killSwitchRegistryResponseSchema,
  knomosisActionStatusResponseSchema,
  knomosisDeploymentListResponseSchema,
  knomosisManifestResponseSchema,
  knomosisPreflightRequestSchema,
  knomosisPreflightResponseSchema,
  knomosisSubmitRequestSchema,
  knomosisSubmitResponseSchema,
  uuidSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  ACTION_KILL_SWITCH,
  activateKillSwitch,
  confirmKillSwitchDeactivation,
  emptyRegistry,
  killSwitchDecision,
  readKillSwitchRegistry,
  requestKillSwitchDeactivation,
} from '../knomosis/killswitch.js';
import { KNOMOSIS_PIN, pinnedDeployment } from '../knomosis/pin.js';
import { type PreflightDeps, runPreflight } from '../knomosis/preflight.js';
import { getKnomosisServices, type KnomosisServices } from '../knomosis/services.js';
import {
  composeStandingEtag,
  ensureActorMapping,
  readBalances,
  readBudget,
} from '../knomosis/standing.js';
import { type SubmissionDeps, submitAction } from '../knomosis/submission.js';
import {
  type AuthEnv,
  authMiddleware,
  requireAdult,
  requireAuth,
  requireStepUp,
  requireSteward,
  requireVerifiedAccount,
} from '../middleware/auth.js';

const deny = (code: string, message: string) => ({ error: { code, message } });
const notFound = { error: { code: 'not_found', message: 'Resource not found' } };

function preflightDeps(services: KnomosisServices): PreflightDeps | null {
  if (services.rooms === null) return null;
  return {
    wallets: services.wallets,
    actions: services.actions,
    proposals: services.proposals,
    rooms: services.rooms,
    lawPacks: services.lawPacks,
    nonces: services.nonces,
    compliance: services.compliance,
    ephemeral: services.ephemeral,
    audit: services.audit,
    masterSecret: services.masterSecret,
    contractVerifier: services.contractTypedDataVerifier,
    config: services.config,
    now: services.now,
    log: services.log,
    regionForUser: (userId) => services.regionResolver.regionForUser(userId),
  };
}

function submissionDeps(services: KnomosisServices): SubmissionDeps | null {
  if (services.rooms === null) return null; // governance port unwired ⇒ fail closed
  return {
    actions: services.actions,
    wallets: services.wallets,
    rooms: services.rooms,
    signatures: services.proposalSignatures,
    nonces: services.nonces,
    gateway: services.gateway,
    ephemeral: services.ephemeral,
    audit: services.audit,
    config: services.config,
    now: services.now,
    uuid: services.uuid,
    log: services.log,
    ...(services.contractTypedDataVerifier
      ? { contractVerifier: services.contractTypedDataVerifier }
      : {}),
  };
}

export function createKnomosisRoutes() {
  return (
    new Hono<AuthEnv>()
      // --- GET /deployments (WS-L.1.1a-1) ----------------------------------
      .get('/deployments', authMiddleware(), requireVerifiedAccount(), async (c) => {
        const services = getKnomosisServices();
        if (!services.config().cryptoEnabled) {
          return c.json(deny('crypto_disabled', 'Crypto features are not enabled.'), 503);
        }
        // Active deployments only, straight from the DB rows the reviewed
        // config-sync wrote (never derived at request time).
        const deployments = (await services.deployments.list()).filter(
          (d) => d.status === 'active',
        );
        return c.json(
          knomosisDeploymentListResponseSchema.parse({
            deployments: deployments.map((d) => ({
              deployment_id: d.deploymentId,
              environment: d.environment,
              chain_id: d.chainId,
              l1_bridge_address: d.l1BridgeAddress,
              runtime_endpoint_ref: d.runtimeEndpointRef,
              contract_manifest_hash: d.contractManifestHash,
              pinned_knomosis_commit: d.pinnedKnomosisCommit,
              status: d.status,
              created_at: d.createdAt,
            })),
          }),
        );
      })

      // --- GET /deployments/:id/manifest (WS-L.1.1a-1) ---------------------
      .get(
        '/deployments/:deploymentId/manifest',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ deploymentId: uuidSchema })),
        async (c) => {
          const services = getKnomosisServices();
          if (!services.config().cryptoEnabled) {
            return c.json(deny('crypto_disabled', 'Crypto features are not enabled.'), 503);
          }
          const deploymentId = c.req.valid('param').deploymentId;
          const stored = await services.deployments.getById(deploymentId);
          const pin = pinnedDeployment(deploymentId);
          // The manifest is served from the PIN (the client's source of truth
          // for domain separation); the DB row must exist and agree.
          if (stored === null || pin === undefined || stored.status !== 'active') {
            return c.json(notFound, 404);
          }
          return c.json(
            knomosisManifestResponseSchema.parse({
              deployment_id: pin.deployment_id,
              environment: pin.environment,
              chain_id: pin.chain_id,
              chain_name: pin.chain_name,
              l1_bridge_address: pin.l1_bridge_address,
              verifying_contract_address: pin.verifying_contract_address,
              contract_manifest_hash: pin.contract_manifest_hash,
              abi_manifest_hash: pin.abi_manifest_hash,
              pinned_knomosis_commit: pin.pinned_knomosis_commit,
              eip712_domain_version: pin.eip712_domain_version,
              typed_data_registry_version: KNOMOSIS_PIN.typed_data_registry_version,
              contract_allowlist: pin.contract_allowlist,
              confirmation_depth: pin.confirmation_depth,
            }),
          );
        },
      )

      // --- POST /actions/preflight (WS-L.3.1a-c) ---------------------------
      .post(
        '/actions/preflight',
        authMiddleware(),
        requireVerifiedAccount(),
        requireAdult(),
        zValidator('json', knomosisPreflightRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          if (!services.config().cryptoEnabled) {
            return c.json(deny('crypto_disabled', 'Crypto features are not enabled.'), 503);
          }
          const deps = preflightDeps(services);
          if (deps === null) {
            return c.json(deny('unavailable', 'Governance data is unavailable.'), 503);
          }
          const body = c.req.valid('json');
          const response = await runPreflight(deps, {
            userId: auth.userId,
            actionType: body.action_type,
            roomId: body.room_id,
            deploymentId: body.deployment_id,
            walletAccountId: body.wallet_account_id,
            typedDataMessage: body.typed_data_message,
            signature: body.signature,
          });
          return c.json(knomosisPreflightResponseSchema.parse(response));
        },
      )

      // --- POST /actions/submit (WS-L.3.2a) --------------------------------
      .post(
        '/actions/submit',
        authMiddleware(),
        requireVerifiedAccount(),
        requireAdult(),
        requireStepUp(),
        zValidator('json', knomosisSubmitRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          if (!services.config().cryptoEnabled) {
            return c.json(deny('crypto_disabled', 'Crypto features are not enabled.'), 503);
          }
          const body = c.req.valid('json');
          // WS-L.3.5c: submission honours the kill switch (503); preflight
          // stays available so users can see why an action would fail.
          const region = await services.regionResolver.regionForUser(auth.userId);
          const decision = await killSwitchDecision(services.configStore, 'action_submission', {
            roomId: body.room_id,
            region,
          });
          if (decision.engaged) {
            return c.json(
              deny('kill_switch_active', 'Action submission is temporarily paused.'),
              503,
            );
          }
          // Also honour the NARROWER switch for this action type (treasury /
          // governance-voting) so a targeted pause stops the mapped submissions.
          const specificSwitch = ACTION_KILL_SWITCH[body.action_type as KnomosisSignedActionType];
          if (specificSwitch) {
            const specific = await killSwitchDecision(services.configStore, specificSwitch, {
              roomId: body.room_id,
              region,
            });
            if (specific.engaged) {
              return c.json(
                deny('kill_switch_active', 'This action type is temporarily paused.'),
                503,
              );
            }
          }
          const subDeps = submissionDeps(services);
          if (subDeps === null) {
            return c.json(deny('unavailable', 'Governance data is unavailable.'), 503);
          }
          const outcome = await submitAction(subDeps, {
            userId: auth.userId,
            preflightToken: body.preflight_token,
            idempotencyKey: body.idempotency_key,
            actionType: body.action_type,
            roomId: body.room_id,
            deploymentId: body.deployment_id,
            walletAccountId: body.wallet_account_id,
            typedDataMessage: body.typed_data_message,
            signature: body.signature,
          });
          if (!outcome.ok) return c.json(deny(outcome.code, outcome.message), outcome.status);
          // Record the wallet→actor mapping for the standing reads (G1 seam).  On a
          // validated NEW submission, use the request body.  On an idempotency-key
          // REPLAY, NEVER trust the unvalidated replay body (a different owned
          // wallet + arbitrary actor must not remap standing) — instead rebuild the
          // mapping from the STORED (validated) signed action, so a mapping lost to
          // an error/crash on the original submit is restored (ensureActorMapping is
          // idempotent, so this never double-writes).
          if (!outcome.replayed) {
            const actor = body.typed_data_message['actor'];
            if (actor !== undefined) {
              await ensureActorMapping(services, {
                walletAccountId: body.wallet_account_id,
                deploymentId: body.deployment_id,
                actorLower: actor.toLowerCase(),
              });
            }
          } else {
            const stored = await services.actions.getById(outcome.actionRecordId);
            const storedActor = stored?.signedAction.message['actor'];
            if (stored != null && typeof storedActor === 'string') {
              await ensureActorMapping(services, {
                walletAccountId: stored.actorWalletAccountId,
                deploymentId: stored.deploymentId,
                actorLower: storedActor.toLowerCase(),
              });
            }
          }
          return c.json(
            knomosisSubmitResponseSchema.parse({
              action_record_id: outcome.actionRecordId,
              submission_state: outcome.submissionState,
              reason_code: outcome.reasonCode,
              human_message: outcome.humanMessage,
            }),
            202,
          );
        },
      )

      // --- GET /actions/:id (WS-L.3.2b) ------------------------------------
      .get(
        '/actions/:actionRecordId',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ actionRecordId: uuidSchema })),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          if (!services.config().cryptoEnabled) {
            return c.json(deny('crypto_disabled', 'Crypto features are not enabled.'), 503);
          }
          const record = await services.actions.getById(c.req.valid('param').actionRecordId);
          if (record === null) return c.json(notFound, 404);
          // Access: the actor, or a steward of the action's room (404-over-403).
          if (record.actorUserId !== auth.userId) {
            const isSteward =
              services.rooms !== null &&
              (await services.rooms.isSteward(record.roomId, auth.userId));
            if (!isSteward) return c.json(notFound, 404);
          }
          return c.json(
            knomosisActionStatusResponseSchema.parse({
              action: {
                action_record_id: record.actionRecordId,
                deployment_id: record.deploymentId,
                action_type: record.actionType,
                room_id: record.roomId,
                actor_ref: record.actorWalletAccountId,
                payload_hash: record.payloadHash,
                typed_data_hash: record.typedDataHash,
                submission_state: record.submissionState,
                failure_reason: record.failureReason,
                indexed_event_ref: record.indexedEventRef,
                reconciliation_state: record.reconciliationState,
                created_at: record.createdAt,
                updated_at: record.updatedAt,
              },
            }),
          );
        },
      )

      // --- GET /standing/:walletId/:deploymentId (WS-L.3.6a) ---------------
      // Balances + budget for the SELECTED linked wallet.  Consumed ONLY by
      // governance/treasury surfaces — never a ranking/search/notification
      // input (static import-graph test + isolation proof).
      .get(
        '/standing/:walletId/:deploymentId',
        authMiddleware(),
        requireVerifiedAccount(),
        requireAdult(),
        zValidator('param', z.object({ walletId: uuidSchema, deploymentId: uuidSchema })),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          const params = c.req.valid('param');
          const standingDeps = {
            wallets: services.wallets,
            actorMappings: services.actorMappings,
            gateway: services.gateway,
            configStore: services.configStore,
            cryptoEnabled: () => services.config().cryptoEnabled,
            regionForUser: (userId: string) => services.regionResolver.regionForUser(userId),
            now: services.now,
            log: services.log,
          };
          // The response carries BOTH balances AND budget, so the conditional
          // validator must cover both — a balances-only ETag would 304 a moved
          // budget (WS-L.3.6a).  Read both views fully (do NOT forward the
          // client's COMPOSITE ETag to the gateway's per-view conditional read;
          // it would never match a single view's tag), then compose ONE weak
          // validator and decide the 304 here.
          const clientEtag = c.req.header('if-none-match') ?? null;
          const balances = await readBalances(standingDeps, {
            userId: auth.userId,
            walletAccountId: params.walletId,
            deploymentId: params.deploymentId,
          });
          if (!balances.ok) {
            const status = balances.code === 'wallet_not_active' ? 404 : 503;
            return c.json(deny(balances.code, 'Standing is unavailable.'), status);
          }
          const budget = await readBudget(standingDeps, {
            userId: auth.userId,
            walletAccountId: params.walletId,
            deploymentId: params.deploymentId,
          });
          const compositeEtag = composeStandingEtag(balances, budget);
          if (clientEtag !== null && clientEtag === compositeEtag) return c.body(null, 304);
          c.header('x-knomosis-seq', balances.knomosisSeq);
          c.header('etag', compositeEtag);
          return c.json({
            balances: balances.value,
            budget: budget.ok
              ? { amount: budget.value.amount, is_lower_bound: budget.value.isLowerBound }
              : null,
            knomosis_seq: balances.knomosisSeq,
          });
        },
      )

      // --- GET /receipts (private, owner-scoped; WS-L.3.4c) ----------------
      // ADULT gate like every other financial surface (WS-D.1.7c: fail closed on
      // unknown/teen age) — these payloads carry the full signed financial fields.
      .get('/receipts', authMiddleware(), requireVerifiedAccount(), requireAdult(), async (c) => {
        const auth = requireAuth(c);
        const services = getKnomosisServices();
        if (!services.config().cryptoEnabled) {
          return c.json(deny('crypto_disabled', 'Crypto features are not enabled.'), 503);
        }
        const receipts = await services.receipts.listPrivateForUser(auth.userId, 100);
        return c.json({
          receipts: receipts.map((r) => ({
            receipt_id: r.receiptId,
            action_record_id: r.actionRecordId,
            payload: r.payload,
            summary_payload_hash: r.summaryPayloadHash,
            final_state: r.finalState,
            updated_at: r.updatedAt,
          })),
        });
      })

      // --- Kill-switch admin (WS-L.3.5f; steward/admin + MFA) --------------
      .get('/admin/killswitch', authMiddleware(), requireSteward(), async (c) => {
        const services = getKnomosisServices();
        const registry = await readKillSwitchRegistry(services.configStore);
        const resolved =
          registry === 'invalid'
            ? emptyRegistry(new Date(services.now()).toISOString())
            : (registry ?? emptyRegistry(new Date(services.now()).toISOString()));
        return c.json(
          killSwitchRegistryResponseSchema.parse({
            switches: KILL_SWITCH_IDS.map((id) => ({
              switch_id: id,
              scopes: resolved.switches[id].scopes,
              release_card: resolved.switches[id].release_card,
              engaged_at: resolved.switches[id].engaged_at,
              deactivation_requested_by: resolved.switches[id].deactivation_requested_by,
            })),
            unreadable: registry === 'invalid',
          }),
        );
      })
      .put(
        '/admin/killswitch',
        authMiddleware(),
        requireSteward(),
        zValidator('json', killSwitchAdminRequestSchema),
        async (c) => {
          const auth = requireAuth(c);
          const services = getKnomosisServices();
          const deps = {
            configStore: services.configStore,
            audit: services.audit,
            now: services.now,
            log: services.log,
          };
          const body = c.req.valid('json');
          const result =
            body.action === 'activate'
              ? await activateKillSwitch(deps, {
                  switchId: body.switch_id,
                  scopes: body.scopes,
                  releaseCard: body.release_card,
                  actorUserId: auth.userId,
                  reason: body.reason,
                })
              : body.action === 'request_deactivation'
                ? await requestKillSwitchDeactivation(deps, {
                    switchId: body.switch_id,
                    actorUserId: auth.userId,
                    reason: body.reason,
                  })
                : await confirmKillSwitchDeactivation(deps, {
                    switchId: body.switch_id,
                    actorUserId: auth.userId,
                    reason: body.reason,
                  });
          if (!result.ok) {
            const status =
              result.code === 'same_operator' ? 403 : result.code === 'empty_scopes' ? 400 : 409;
            return c.json(deny(result.code, result.message), status);
          }
          return c.json({ ok: true, entry: result.entry });
        },
      )
  );
}

export type KnomosisRoutes = ReturnType<typeof createKnomosisRoutes>;
