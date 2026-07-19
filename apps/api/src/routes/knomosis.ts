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
  decCompare,
  isValidDecimal,
  PAYMENT_INTENT_TIMED_STATES,
  type PaymentIntentState,
} from '@licio/governance';
import {
  ACTION_TYPE_FOR_PAYMENT_TARGET,
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
  TARGET_ID_FIELD_FOR_ACTION,
  uuidSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { disclosureGate } from '../compliance/disclosures.js';
import {
  buildDisclosureDeps,
  complianceServicesConfigured,
  getComplianceServices,
} from '../compliance/services.js';
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
import { FUND_TRANSFER_ACTIONS, type PreflightDeps, runPreflight } from '../knomosis/preflight.js';
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
import { bindPayoutRecipient } from '../treasury/intents.js';
import { getTreasuryServices, treasuryServicesConfigured } from '../treasury/services.js';

const deny = (code: string, message: string) => ({ error: { code, message } });
const notFound = { error: { code: 'not_found', message: 'Resource not found' } };

/** WS-L.2.6e — a high-value transfer requires a step-up assertion FRESHER than
 *  this window (much tighter than the general 5-minute step-up window), forcing
 *  re-authentication for a large amount even inside the general window. */
const HIGH_VALUE_STEP_UP_WINDOW_MS = 60_000;
const STEP_UP_METHODS = ['webauthn', 'email_otp', 'wallet'] as const;

/**
 * A client-named `payment_intent_id` is a CLAIM, not a fact — and it buys the
 * naming action a share of that intent's compliance review.  Left unverified it
 * is a clearance to steal: a member whose high-value intent for amount X was
 * cleared could put that id on ANY later signed transfer of X and skip manual
 * review entirely (the review case key names the same subject and amount, so
 * `createCase` would hand the new transfer the old cleared case).
 *
 * So the intent must BE this transfer: the caller's own (or their room's), for
 * this room, this asset, this amount, and still live.  A mismatch is rejected
 * outright rather than silently dropped — dropping it would quietly split the
 * transfer's review in two, which is the defect the id exists to prevent.
 *
 * Null ⇔ verified (or none claimed).  The read crosses into WS-M, so it lives
 * here at the composition layer, never inside the WS-L domain module.
 */
async function verifyClaimedIntent(input: {
  paymentIntentId: string | undefined;
  userId: string;
  roomId: string;
  actionType: string;
  typedDataMessage: Record<string, unknown>;
  /** The submit's client key, when present: lets the ORIGINAL-actor check for a
   *  room-owned payout recognize the caller's OWN action in ANY state (a dead
   *  `failed`/`reverted` row the live lookup skips) precisely, by owner + key. */
  idempotencyKey?: string;
  /** The deployment the action would move funds ON (`body.deployment_id`): the
   *  intent is bound to its treasury's deployment, so a claim naming a DIFFERENT
   *  deployment is not this movement (see the binding in the identity block). */
  deploymentId: string;
  /** `submit` demands the intent already be `signed`; `preflight` accepts the
   *  whole pre-submission window (it is what moves the intent toward signed). */
  stage: 'preflight' | 'submit';
  /** IDENTITY ONLY: is the intent the caller's, and is it this transfer?
   *
   *  The split matters.  Identity is AUTHORIZATION and is checked on every
   *  request that names an intent, retry or not.  The state checks below —
   *  in-flight and `signed` — are a GATE on minting a NEW action, and a retry
   *  has already minted: re-applying them would reject the retry of a submission
   *  that succeeded.  Conflating the two is how a client that merely QUOTED
   *  someone else's intent id could be treated as its retry. */
  identityOnly?: boolean;
}): Promise<{ code: string; message: string } | null> {
  if (input.paymentIntentId === undefined) return null;
  if (!treasuryServicesConfigured()) {
    // The claim cannot be checked, so it cannot be honoured.
    return { code: 'intent_unverifiable', message: 'The payment intent could not be verified.' };
  }
  const intent = await getTreasuryServices().intents.getById(input.paymentIntentId);
  const mismatch = {
    code: 'intent_mismatch',
    message: 'The payment intent does not match this action.',
  };
  if (intent === null) return mismatch;
  // Ownership.  A member's own intent is authorized by the owner match.  A
  // room-owned payout (null owner: grant/compensation) is authorized EITHER by
  // current STEWARDSHIP (to mint a fresh action — the same `isSteward` test
  // `/actions/:id` uses to hide another steward's action, and the gate
  // `submitAction` re-runs for a `grant_payout`) OR by being the ORIGINAL ACTOR
  // of the action already settling it (a lost-response retry of one's OWN
  // submission, which a steward-role revocation landing in between must not
  // strand — the action id they need to recover is theirs).  Both MUST be
  // checked here, in the identity block, because the retry replay skips
  // `submitAction`'s gate: without it any authenticated user who merely names a
  // room-owned intent id + payload passes as its "retry" and is handed the
  // steward's action id and submission state (WS-N.2.3d tipping-off).
  if (intent.userId !== null) {
    if (intent.userId !== input.userId) return mismatch;
  } else {
    const services = getKnomosisServices();
    // Fail closed: an unwired governance port cannot authorize a room payout.
    if (services.rooms === null) return mismatch;
    // The action already settling this intent, read in ANY state — a lost-response
    // retry of one's OWN payout must be recognized even after that action reached
    // `failed`/`reverted` (which the LIVE lookup skips) and even after the steward
    // role was revoked, or the retry gets `intent_mismatch` before it can reach the
    // idempotency replay that returns their own action id/status.  Prefer the
    // caller's OWN idempotency-scoped action (precise: owner + key); else the newest
    // action for the intent (`getLatestByPaymentIntentId`, all-state).
    const ownAction =
      input.idempotencyKey !== undefined
        ? await services.actions.getByIdempotencyKey(input.userId, input.idempotencyKey)
        : null;
    const settling =
      ownAction ?? (await services.actions.getLatestByPaymentIntentId(intent.paymentIntentId));
    const isOriginalActor = settling !== null && settling.actorUserId === input.userId;
    if (!isOriginalActor && !(await services.rooms.isSteward(intent.roomId, input.userId))) {
      return mismatch;
    }
  }
  if (intent.roomId !== input.roomId) return mismatch;
  // …and the SAME movement.  Amount and asset come from the signed payload, so
  // a cleared small intent cannot cover a large transfer — but they are not
  // enough on their own: a cleared payout intent for grant A would otherwise
  // cover a same-room, same-asset, same-amount payout to grant B, and B would
  // skip its own review (the later treasury attach rejects the mismatch, but
  // only after this action has already been forwarded).  So the intent's TARGET
  // must be the one the message names.
  if (intent.amount !== input.typedDataMessage['amount']) return mismatch;
  if (intent.asset !== input.typedDataMessage['asset']) return mismatch;
  // The action this intent SETTLES THROUGH — not the target type itself.  They
  // are not the same enum and not the identity mapping: `steward_compensation`
  // pays out as a `grant_payout`, so a raw comparison rejects a valid payout
  // and leaves its cleared review unusable.  The SSOT owns the pairing.
  if (ACTION_TYPE_FOR_PAYMENT_TARGET[intent.targetType] !== input.actionType) return mismatch;
  const targetField = TARGET_ID_FIELD_FOR_ACTION[input.actionType];
  // A fund-moving action with no known target field cannot be bound to an
  // intent at all — fail closed rather than accept an unbindable claim.
  if (targetField === undefined) return mismatch;
  // A deposit's target IS its treasury; the payout classes name their own row.
  const expectedTarget =
    intent.targetType === 'treasury_deposit' ? intent.treasuryId : intent.targetId;
  if (expectedTarget !== input.typedDataMessage[targetField]) return mismatch;
  // …and the SAME DEPLOYMENT.  The intent draws on its treasury, which is pinned
  // to one deployment; the action moves funds on `body.deployment_id`.  In a room
  // with a rotated or additional active deployment, a cleared same-room / asset /
  // amount / target / recipient intent would otherwise cover a submit on ANOTHER
  // deployment — the treasury attach rejects `action.deploymentId !==
  // intentTreasury.deploymentId`, but only AFTER `submitAction` has already
  // forwarded the WS-L action, settling the transfer OUTSIDE the intent ledger and
  // the accounting export.  Bind it here, BEFORE the mint, as IDENTITY (a retry
  // names the same deployment, so it stays bound).  A missing treasury fails closed.
  const intentTreasury = await getTreasuryServices().treasuries.getById(intent.treasuryId);
  if (intentTreasury === null || intentTreasury.deploymentId !== input.deploymentId) {
    return mismatch;
  }
  // Everything above is IDENTITY — whose intent this is and what it settles.
  // A retry stops here: it minted its action already, and the gate below is
  // about minting.  (A payout's RECIPIENT binding is a MINT gate, not identity —
  // see below — so a replay does not re-run it: the action already forwarded
  // under a recipient the preflight vetted, and a grant clawed back SINCE must
  // not now strand that recovery.)
  if (input.identityOnly === true) return null;
  // A payout must pay the grant's APPROVED recipient, checked BEFORE the action
  // forwards.  The target match above only proves the action names grant A;
  // without this a steward could sign a `grant_payout` under A's cleared intent
  // (same amount/asset) paying a DIFFERENT address, and the transfer would
  // forward before the attach's recipient check ran — settling outside the intent
  // ledger.  This is the PREFLIGHT (non-identity) call; the submit rides a token
  // that binds the exact typed-data hash (recipient included), so it cannot swap
  // the recipient after this gate.  ONE binding, shared with the attach.
  const recipientError = await bindPayoutRecipient(
    getTreasuryServices(),
    intent,
    input.typedDataMessage,
    // A `user:<id>` recipient binds to a wallet on the payout's CHAIN — the intent
    // treasury's deployment chain (the deployment the identity check above already
    // pinned to `input.deployment_id`).
    pinnedDeployment(intentTreasury.deploymentId)?.chain_id,
  );
  if (recipientError !== null) {
    return { code: recipientError.code, message: recipientError.message };
  }
  // …and still an attempt IN FLIGHT.  `PAYMENT_INTENT_TIMED_STATES` is exactly
  // the pre-submission window in which an action is being minted (the states
  // the expiry sweep watches); past it the intent's action already exists, so
  // naming it in a NEW preflight would resurrect a spent clearance.  The
  // expiry itself is re-checked because the sweep is periodic — a lapsed intent
  // can still be sitting in `quoted`.
  if (!(PRE_SUBMISSION_INTENT_STATES as ReadonlySet<string>).has(intent.executionState)) {
    return mismatch;
  }
  // At SUBMIT the intent must already be `signed`.  The bookkeeping that
  // records the action against the intent has one legal edge — `signed →
  // submitted` — and the auto-attach sweep scans only `signed` intents, so
  // forwarding from `quoted`/`preflighted` lets a client crash leave the
  // transfer settled on chain while the intent expires OUTSIDE the ledger and
  // the accounting export.  Preflight keeps the broad window: it is what moves
  // the intent toward `signed` in the first place.
  if (input.stage === 'submit' && intent.executionState !== 'signed') {
    return {
      code: 'intent_not_signed',
      message: 'The payment intent must be signed before its action is submitted.',
    };
  }
  // The client's idempotency key is its own (WS-L.3.2a): a free UUID that dedups
  // its HTTP retries.  The intent↔action link is `payment_intent_id`, stamped
  // onto the action record and read back LIVE-only, so the auto-attach finds the
  // orphan regardless of the key the client chose — no key convention to enforce.
  if (intent.expiresAt <= new Date(getKnomosisServices().now()).toISOString()) return mismatch;
  return null;
}

/** The pre-submission window, from the WS-M lifecycle SSOT (never re-listed
 *  here: a state added there must not silently become replayable). */
const PRE_SUBMISSION_INTENT_STATES: ReadonlySet<PaymentIntentState> = new Set(
  PAYMENT_INTENT_TIMED_STATES,
);

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
    proposals: services.proposals,
    compliance: services.compliance,
    regionForUser: (userId) => services.regionResolver.regionForUser(userId),
    lawPacks: services.lawPacks,
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
          // WS-N.1.2d — the first-financial-action disclosure gate, the second
          // of its two chokepoints (payment-intent creation is the other).  A
          // fund-moving signed action can be minted here WITHOUT ever passing
          // through an intent, so gating only the intent route would let those
          // proceed on unacknowledged disclosures.  Fail-closed: an unreadable
          // ack store reports them missing.
          // `action_type` is an unvalidated wire string here (runPreflight is
          // what rejects an unregistered one), so widen the set for the lookup:
          // a non-fund-transfer — registered or not — simply skips this gate
          // and meets its own rejection inside the pipeline.
          const movesFunds = (FUND_TRANSFER_ACTIONS as ReadonlySet<string>).has(body.action_type);
          if (movesFunds && complianceServicesConfigured()) {
            const disclosureCheck = await disclosureGate(
              buildDisclosureDeps(getComplianceServices()),
              auth.userId,
            );
            if (disclosureCheck.unavailable) {
              // Policy-store OUTAGE: the disclosure requirement is unreadable, so
              // fail closed rather than mint a fund action on an unverified gate.
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
          const intentClaim = await verifyClaimedIntent({
            paymentIntentId: body.payment_intent_id,
            userId: auth.userId,
            roomId: body.room_id,
            actionType: body.action_type,
            typedDataMessage: body.typed_data_message,
            deploymentId: body.deployment_id,
            stage: 'preflight',
          });
          if (intentClaim !== null) {
            return c.json(deny(intentClaim.code, intentClaim.message), 400);
          }
          const response = await runPreflight(deps, {
            userId: auth.userId,
            actionType: body.action_type,
            paymentIntentId: body.payment_intent_id,
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
          const body = c.req.valid('json');
          // Is this a RETRY of a submission that already landed?  A retry after
          // a lost response has ALREADY submitted — its action exists and may
          // be on chain — so the gates below answer a question that no longer
          // applies: a disclosure published since, a kill switch engaged since,
          // or an intent that has since advanced past the pre-submission window
          // would each turn the retry into a fresh 403/503/400 instead of the
          // original action id, leaving the client unable to learn what
          // happened and the intent stranded.  Gates decide whether a NEW
          // action may be minted, so they are skipped here — and `submitAction`
          // still owns the replay itself (it re-reads the record AND repairs a
          // lost actor mapping; a second replay path here would drift from it).
          // A claimed intent is AUTHORIZED FIRST, before it is trusted for
          // anything — including as evidence that this is a retry.  Otherwise a
          // caller who merely knows another member's intent id is treated as
          // its retry, skips this very check, collides on the intent unique,
          // and is handed that member's action id and submission state.
          const claimIdentity = await verifyClaimedIntent({
            paymentIntentId: body.payment_intent_id,
            userId: auth.userId,
            roomId: body.room_id,
            actionType: body.action_type,
            typedDataMessage: body.typed_data_message,
            deploymentId: body.deployment_id,
            idempotencyKey: body.idempotency_key,
            stage: 'submit',
            identityOnly: true,
          });
          if (claimIdentity !== null) {
            return c.json(deny(claimIdentity.code, claimIdentity.message), 400);
          }
          // BOTH replays `submitAction` performs, or this skips the gates for
          // one and re-gates the other.  The idempotency key finds the caller's
          // OWN earlier attempt; the intent — now known to be theirs — finds
          // whoever settled it first, which for a room-owned payout is another
          // steward under their own actor-scoped key, and their retry is just
          // as much a retry.
          const isRetry =
            (await services.actions.getByIdempotencyKey(auth.userId, body.idempotency_key)) !==
              null ||
            (body.payment_intent_id !== undefined &&
              (await services.actions.getByPaymentIntentId(body.payment_intent_id)) !== null);
          // WS-L.3.5c: submission honours the kill switch (503); preflight
          // stays available so users can see why an action would fail.
          if (!isRetry) {
            // The crypto flag gates MINTING too, so it sits with the other
            // gates.  Ahead of the replay it stranded work already done: an
            // action inserted and forwarded, the response lost, an operator
            // disabling crypto during the incident — and the retry got
            // `crypto_disabled` instead of its own action id, with no other way
            // to learn the fate of a transfer that may be on chain.  Returning
            // that id mints nothing and moves nothing.
            if (!services.config().cryptoEnabled) {
              return c.json(deny('crypto_disabled', 'Crypto features are not enabled.'), 503);
            }
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
            // WS-L.2.6e — a HIGH-VALUE amount requires a FRESH step-up: the
            // general 5-min window (already enforced by requireStepUp) is not
            // enough.  The amount is only known here in the signed message, so
            // this cannot live in the route-level middleware.  Exact-decimal
            // comparison (amounts are up to 78-digit minor-unit strings); a
            // MALFORMED amount is left for `submitAction`'s typed-data validation
            // to reject (400), never crashing the comparator into a 500.
            const submitAmount = body.typed_data_message['amount'];
            if (
              typeof submitAmount === 'string' &&
              isValidDecimal(submitAmount) &&
              decCompare(submitAmount, services.config().highValueThresholdMinorUnits) >= 0 &&
              Date.now() - Date.parse(auth.authAssurance.last_verified_at) >
                HIGH_VALUE_STEP_UP_WINDOW_MS
            ) {
              return c.json({ status: 'step_up_required' as const, methods: STEP_UP_METHODS }, 401);
            }
          }
          const subDeps = submissionDeps(services);
          if (subDeps === null) {
            return c.json(deny('unavailable', 'Governance data is unavailable.'), 503);
          }
          // WS-N.1.2d — the disclosure gate AGAIN, at submit.  The preflight's
          // gate cannot stand for both: a token stays valid for its TTL, and
          // counsel can publish or bump a disclosure inside that window — so a
          // still-valid token would move funds against disclosures the member
          // has never acknowledged.  This is the same reason submit re-checks
          // sanctions, jurisdiction, and fraud rather than trusting the token;
          // disclosures were the one gate left behind.
          const movesFunds = (FUND_TRANSFER_ACTIONS as ReadonlySet<string>).has(body.action_type);
          if (!isRetry && movesFunds && complianceServicesConfigured()) {
            const disclosureCheck = await disclosureGate(
              buildDisclosureDeps(getComplianceServices()),
              auth.userId,
            );
            if (disclosureCheck.unavailable) {
              // Policy-store OUTAGE: the disclosure requirement is unreadable, so
              // fail closed rather than mint a fund action on an unverified gate.
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
          const claimed = isRetry
            ? null
            : await verifyClaimedIntent({
                paymentIntentId: body.payment_intent_id,
                userId: auth.userId,
                roomId: body.room_id,
                actionType: body.action_type,
                typedDataMessage: body.typed_data_message,
                deploymentId: body.deployment_id,
                stage: 'submit',
              });
          if (claimed !== null) {
            return c.json(deny(claimed.code, claimed.message), 400);
          }
          const outcome = await submitAction(subDeps, {
            userId: auth.userId,
            preflightToken: body.preflight_token,
            idempotencyKey: body.idempotency_key,
            actionType: body.action_type,
            paymentIntentId: body.payment_intent_id,
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
            // Rebuild the mapping ONLY from a record that COMPLETED submit
            // validation.  A `reserving` row (never validated) or a `failed` row
            // (a pre-forward gate failure via failReserved carries the caller's
            // UNVERIFIED `actor`, or a gateway decline that produced no standing)
            // must NOT map a wallet to an arbitrary actor — `ensureActorMapping`
            // is first-write-wins, so /standing would then read balances for that
            // unverified actor.  Only a forwarded state (submitted/accepted/…)
            // proves the actor↔wallet binding passed every gate (WS-L.3.2a).
            const stored = await services.actions.getById(outcome.actionRecordId);
            const storedActor = stored?.signedAction.message['actor'];
            const validated =
              stored != null &&
              stored.submissionState !== 'reserving' &&
              stored.submissionState !== 'failed';
            if (validated && typeof storedActor === 'string') {
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
          // Access: the actor, a steward of the action's room, or the platform
          // ADMIN with cleared per-session MFA (a READ — the final-line-of-
          // defense decision, behind the SAME MFA bar as every other admin
          // surface: another user's financial action status must not open to
          // an elevated session that has not stepped up — codex; the room-port
          // isSteward stays room-grants-only on purpose, because it also gates
          // treasury ACTIONS admin does not inherit).  404-over-403.
          if (
            record.actorUserId !== auth.userId &&
            !(auth.roles.includes('admin') && auth.mfaActive && auth.mfaVerified)
          ) {
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
          // `readBudget` re-runs the SAME fail-closed gates as `readBalances`
          // (crypto flag, wallet_connection kill switch, wallet-active, actor
          // mapping).  If one TRIPPED between the two reads — the wallet was
          // unlinked, or crypto / wallet_connection was paused — abort rather than
          // leak balances with `budget: null` during the pause.  A merely transient
          // gateway outage (`standing_unavailable`) still degrades to `budget: null`
          // since the already-read balances remain valid (WS-L.3.5a / O3).
          if (
            !budget.ok &&
            budget.code !== 'standing_unavailable' &&
            budget.code !== 'not_modified'
          ) {
            const status = budget.code === 'wallet_not_active' ? 404 : 503;
            return c.json(deny(budget.code, 'Standing is unavailable.'), status);
          }
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
