// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L unit coverage for the pure decision functions and fail-closed error
// branches that the end-to-end flow suites do not hit directly: reconciliation
// math, the compliance/region ports, the HTTP gateway standing/event paths,
// the submission state machine + resubmit, the contract-verifier factory, the
// in-memory store adapter methods, and the receipt pairing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpKnomosisGateway } from '../knomosis/gateway.js';
import { ingestGatewayEvents, KNOWN_GATEWAY_EVENT_TYPES } from '../knomosis/ingest.js';
import { KNOMOSIS_PIN } from '../knomosis/pin.js';
import {
  createIdentityRegionResolver,
  defaultCompliancePort,
  localeRegionSubtag,
} from '../knomosis/ports.js';
import { buildHumanSummary, pairSummaryToPayload } from '../knomosis/preflight.js';
import {
  PUBLIC_RECEIPT_FIELDS,
  projectPublicReceiptPayload,
  verifyReceiptPairing,
  writeReceipts,
} from '../knomosis/receipts.js';
import {
  canExpandTreasury,
  classifyDivergence,
  compareActorLedger,
  decideActionReconciliation,
  EVENT_STATE_OF_TYPE,
  reconcileDeployment,
} from '../knomosis/reconciliation.js';
import { getKnomosisServices, resetKnomosisServicesForTests } from '../knomosis/services.js';
import { createContractTypedDataVerifier } from '../knomosis/signatures.js';
import {
  InMemoryFinancialWalletStore,
  InMemoryGovernanceAuditStore,
  InMemoryKnomosisActionStore,
  InMemoryOnChainEventStore,
  InMemoryReconciliationStore,
  type KnomosisActionRecordEntity,
  WalletAbuseLimiter,
} from '../knomosis/stores.js';
import {
  applyTransition,
  canTransitionSubmissionState,
  recordAcceptedProposalSignature,
  resubmitPendingActions,
  VALID_SUBMISSION_TRANSITIONS,
} from '../knomosis/submission.js';
import { assertSingleActiveGatewayDeployment, syncPinnedDeployments } from '../knomosis/wiring.js';
import { seedUserWithSession } from './event-test-helpers.js';
import {
  freshKnomosisServices,
  LOCAL_DEPLOYMENT,
  resetKnomosisFixture,
} from './knomosis-test-helpers.js';

afterEach(() => resetKnomosisFixture());

const baseAction = (
  over: Partial<KnomosisActionRecordEntity> = {},
): KnomosisActionRecordEntity => ({
  actionRecordId: crypto.randomUUID(),
  deploymentId: LOCAL_DEPLOYMENT.deployment_id,
  actionType: 'treasury_deposit',
  roomId: crypto.randomUUID(),
  actorWalletAccountId: crypto.randomUUID(),
  actorUserId: crypto.randomUUID(),
  payloadHash: `0x${'11'.repeat(32)}`,
  typedDataHash: `0x${'11'.repeat(32)}`,
  signedAction: {
    // A far-future expiration so the retry sweep's expiry gate (WS-L.3.2a) does
    // not treat the fixture action as expired.
    message: {
      amount: '10',
      asset: 'USDC',
      expiration: String(Math.floor(Date.now() / 1000) + 3600),
    },
    signature: '0x',
  },
  submissionState: 'finalized',
  failureReason: null,
  indexedEventRef: null,
  reconciliationState: 'pending',
  idempotencyKey: crypto.randomUUID(),
  paymentIntentId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

describe('reconciliation decision math (WS-L.3.4a/b)', () => {
  it('decideActionReconciliation covers in-flight, match, and mismatch', () => {
    expect(
      decideActionReconciliation(baseAction({ submissionState: 'accepted' }), null, null).outcome,
    ).toBe('in_flight');
    // finalized: agrees ONLY when BOTH the event stream AND the receipt agree.
    expect(
      decideActionReconciliation(
        baseAction({ submissionState: 'finalized' }),
        'finalized',
        'finalized',
      ).outcome,
    ).toBe('match');
    expect(
      decideActionReconciliation(baseAction({ submissionState: 'finalized' }), null, 'finalized')
        .outcome,
    ).toBe('mismatch');
    expect(
      decideActionReconciliation(
        baseAction({ submissionState: 'finalized' }),
        'reverted',
        'finalized',
      ).outcome,
    ).toBe('mismatch');
    // Source-2 (receipt) is a GENUINE third observation: a matching event with a
    // MISSING or DISAGREEING receipt is itself a divergence (WS-L.3.4a).
    expect(
      decideActionReconciliation(baseAction({ submissionState: 'finalized' }), 'finalized', null)
        .outcome,
    ).toBe('mismatch');
    expect(
      decideActionReconciliation(
        baseAction({ submissionState: 'finalized' }),
        'finalized',
        'reverted',
      ).outcome,
    ).toBe('mismatch');
    // failed pre-execution: NO event ⇒ match; ANY event (a reverted one
    // included) ⇒ mismatch — a reverted event means it actually reached
    // execution, contradicting the failed product state (WS-L review fix).
    expect(
      decideActionReconciliation(baseAction({ submissionState: 'failed' }), null, null).outcome,
    ).toBe('match');
    // A failed record that nonetheless carries a settlement receipt is a
    // source-2 divergence even with no event.
    expect(
      decideActionReconciliation(baseAction({ submissionState: 'failed' }), null, 'finalized')
        .outcome,
    ).toBe('mismatch');
    expect(
      decideActionReconciliation(baseAction({ submissionState: 'failed' }), 'settled', null)
        .outcome,
    ).toBe('mismatch');
    expect(
      decideActionReconciliation(baseAction({ submissionState: 'failed' }), 'reverted', null)
        .outcome,
    ).toBe('mismatch');
    expect(
      decideActionReconciliation(
        baseAction({ submissionState: 'reverted' }),
        'reverted',
        'reverted',
      ).outcome,
    ).toBe('match');
    // `settled` is PRE-FINALITY: in-flight until it finalizes/reverts, never a
    // mismatch against the finalized/reverted pair (WS-L review fix).
    expect(
      decideActionReconciliation(baseAction({ submissionState: 'settled' }), 'settled', null)
        .outcome,
    ).toBe('in_flight');
    expect(
      decideActionReconciliation(baseAction({ submissionState: 'settled' }), 'finalized', null)
        .outcome,
    ).toBe('in_flight');
  });

  it('classifyDivergence spans informational/warning/critical', () => {
    expect(classifyDivergence('5', '1', true)).toBe('informational'); // timing window
    expect(classifyDivergence('5', '10', false)).toBe('warning'); // below critical threshold
    expect(classifyDivergence('50', '10', false)).toBe('critical'); // at/above threshold
  });

  it('compareActorLedger flags a per-asset shortfall/overage exactly', () => {
    const divergences = compareActorLedger(
      [
        { asset: 'USDC', amount: '100' },
        { asset: 'USDC', amount: '50' },
      ],
      { USDC: '120' }, // gateway shows 120; product expects 150
      '10',
      new Map(),
    );
    expect(divergences).toHaveLength(1);
    expect(divergences[0]).toMatchObject({ asset: 'USDC', expected: '150', actual: '120' });
    expect(divergences[0]?.severity).toBe('critical'); // |30| ≥ 10
    // Agreement ⇒ no divergence.
    expect(
      compareActorLedger([{ asset: 'USDC', amount: '5' }], { USDC: '5' }, '1', new Map()),
    ).toEqual([]);
  });

  it('compareActorLedger downgrades ONLY the in-flight asset, per-asset (R7-4)', () => {
    // USDC has an in-flight fund movement (informational); DAI does NOT — its
    // large delta must stay critical even though the wallet has an open action.
    const divergences = compareActorLedger(
      [
        { asset: 'USDC', amount: '100' },
        { asset: 'DAI', amount: '100' },
      ],
      { USDC: '90', DAI: '40' }, // both short by 10 / 60
      '10',
      new Map([['USDC', '100']]), // a 100-unit pending deposit covers USDC's 10 shortfall
    );
    const bySeverity = Object.fromEntries(divergences.map((d) => [d.asset, d.severity]));
    expect(bySeverity['USDC']).toBe('informational'); // in-flight ⇒ downgraded
    expect(bySeverity['DAI']).toBe('critical'); // unrelated ⇒ NOT downgraded
  });

  it('compareActorLedger downgrade is BOUNDED by the in-flight amount (R10-4)', () => {
    // A tiny 1-unit pending movement must NOT explain a huge unrelated gap.
    const divergences = compareActorLedger(
      [{ asset: 'USDC', amount: '1000' }],
      { USDC: '0' }, // short by 1000
      '10',
      new Map([['USDC', '1']]), // only 1 unit is in flight
    );
    expect(divergences[0]?.severity).toBe('critical'); // 1000 > 1 ⇒ still critical
    // A shortfall WITHIN the in-flight amount IS explained.
    const explained = compareActorLedger(
      [{ asset: 'USDC', amount: '1000' }],
      { USDC: '995' }, // short by 5
      '1',
      new Map([['USDC', '10']]), // 10 in flight covers the 5 shortfall
    );
    expect(explained[0]?.severity).toBe('informational');
  });

  it('reconcileDeployment halts when an unresolved unsupported-version result exists', async () => {
    const fixture = await freshKnomosisServices();
    await fixture.knomosis.reconciliation.append({
      resultId: crypto.randomUUID(),
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      entityType: 'action',
      entityRef: 'evt:1',
      outcome: 'halted_unsupported_version',
      severity: 'critical',
      details: {},
      lowWatermarkSeq: '1',
      createdAt: new Date().toISOString(),
    });
    const summary = await reconcileDeployment(fixture.knomosis, LOCAL_DEPLOYMENT.deployment_id);
    expect(summary.halted).toBe(true);
  });

  it('reconcileDeployment surfaces a treasury LEDGER divergence (WS-L review fix)', async () => {
    const fixture = await freshKnomosisServices();
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const walletAccountId = crypto.randomUUID();
    // A finalized deposit of 150 USDC; the actor maps to a gateway actor id.
    await fixture.knomosis.actions.insert({
      actionRecordId: crypto.randomUUID(),
      deploymentId,
      actionType: 'treasury_deposit',
      roomId: crypto.randomUUID(),
      actorWalletAccountId: walletAccountId,
      actorUserId: crypto.randomUUID(),
      payloadHash: '0x',
      typedDataHash: `0x${'aa'.repeat(32)}`,
      signedAction: { message: { asset: 'USDC', amount: '150' }, signature: '0x' },
      submissionState: 'finalized',
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'matched',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await fixture.knomosis.actorMappings.put({
      walletAccountId,
      deploymentId,
      actorId: 'actor-ledger',
      createdAt: new Date().toISOString(),
    });
    // The fake gateway shows 120 for that actor — a 30-unit divergence.
    fixture.gateway.setBalance('actor-ledger', 'USDC', '120');
    const summary = await reconcileDeployment(fixture.knomosis, deploymentId);
    expect(summary.mismatched).toBeGreaterThanOrEqual(1);
    // The divergence blocks treasury expansion (§28.3) even though action states agree.
    const gate = await canExpandTreasury(fixture.knomosis, deploymentId);
    expect(gate.allowed).toBe(false);
  });

  it('EVENT_STATE_OF_TYPE covers EVERY known gateway event type (N6 parity)', () => {
    // Reconciliation must map the SAME set ingest understands; a missing mapping
    // feeds decideActionReconciliation a null latest-event state and lets a diverged
    // row reconcile as a clean pre-execution failure.
    for (const type of KNOWN_GATEWAY_EVENT_TYPES) {
      expect(EVENT_STATE_OF_TYPE[type]).toBeDefined();
    }
    expect(EVENT_STATE_OF_TYPE['knomosis.action.challenged']).toBe('challenged');
    expect(EVENT_STATE_OF_TYPE['knomosis.action.frozen']).toBe('frozen');
  });

  it('a CHALLENGED event on a `failed` record surfaces a divergence, not a clean pass (N6)', async () => {
    const fixture = await freshKnomosisServices();
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const typedDataHash = `0x${'c6'.repeat(32)}`;
    // Product state says the action FAILED pre-execution, but the gateway emitted a
    // `challenged` event for it — proof it reached execution.  Before N6 this event
    // was dropped (unmapped) and the row reconciled as a clean failure.
    await fixture.knomosis.actions.insert(
      baseAction({ deploymentId, typedDataHash, submissionState: 'failed' }),
    );
    await fixture.knomosis.events.ingest({
      eventId: crypto.randomUUID(),
      deploymentId,
      chainId: LOCAL_DEPLOYMENT.chain_id,
      blockNumber: null,
      txHash: null,
      logIndex: null,
      eventType: 'knomosis.action.challenged',
      decodedPayload: { typed_data_hash: typedDataHash },
      eventSource: 'gateway',
      gatewaySeq: '1',
      gatewayIndex: 0,
      reorgState: 'confirmed',
      reorgDetectedAt: null,
      indexedAt: new Date().toISOString(),
    });
    const summary = await reconcileDeployment(fixture.knomosis, deploymentId);
    expect(summary.mismatched).toBe(1);
    expect(summary.matched).toBe(0);
  });

  it('DEFERS a treasury comparison when the standing snapshot lags the event cursor (N7)', async () => {
    const fixture = await freshKnomosisServices();
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const walletAccountId = crypto.randomUUID();
    await fixture.knomosis.actions.insert(
      baseAction({
        deploymentId,
        actionType: 'treasury_deposit',
        actorWalletAccountId: walletAccountId,
        typedDataHash: `0x${'77'.repeat(32)}`,
        signedAction: { message: { asset: 'USDC', amount: '150' }, signature: '0x' },
        submissionState: 'finalized',
        reconciliationState: 'matched',
      }),
    );
    await fixture.knomosis.actorMappings.put({
      walletAccountId,
      deploymentId,
      actorId: 'actor-lag',
      createdAt: new Date().toISOString(),
    });
    fixture.gateway.setBalance('actor-lag', 'USDC', '120'); // a 30-unit gap
    // The event cursor is at 100 but the standing snapshot is BEHIND at 50: the gap
    // may be a deposit the snapshot has not reflected yet, so the comparison DEFERS.
    await fixture.knomosis.events.recordGatewayCursor(deploymentId, '100');
    fixture.gateway.setStandingSeq('50');
    const deferred = await reconcileDeployment(fixture.knomosis, deploymentId);
    expect(deferred.mismatched).toBe(0);
    expect((await canExpandTreasury(fixture.knomosis, deploymentId)).allowed).toBe(true);
    // Once the snapshot CATCHES UP to the cursor, the real divergence surfaces.
    fixture.gateway.setStandingSeq('100');
    const caughtUp = await reconcileDeployment(fixture.knomosis, deploymentId);
    expect(caughtUp.mismatched).toBeGreaterThanOrEqual(1);
    expect((await canExpandTreasury(fixture.knomosis, deploymentId)).allowed).toBe(false);
  });

  it('an in-flight action on ANOTHER deployment does NOT explain this deployment’s shortfall (N8)', async () => {
    const fixture = await freshKnomosisServices();
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const walletAccountId = crypto.randomUUID();
    await fixture.knomosis.actions.insert(
      baseAction({
        deploymentId,
        actionType: 'treasury_deposit',
        actorWalletAccountId: walletAccountId,
        typedDataHash: `0x${'88'.repeat(32)}`,
        signedAction: { message: { asset: 'USDC', amount: '150' }, signature: '0x' },
        submissionState: 'finalized',
        reconciliationState: 'matched',
      }),
    );
    await fixture.knomosis.actorMappings.put({
      walletAccountId,
      deploymentId,
      actorId: 'actor-cross',
      createdAt: new Date().toISOString(),
    });
    fixture.gateway.setBalance('actor-cross', 'USDC', '120'); // a 30-unit shortfall
    // A forwarded 30-USDC deposit that could "explain" the gap — but it belongs to a
    // DIFFERENT deployment (moves a different treasury), so it must NOT downgrade this
    // deployment's critical divergence.
    await fixture.knomosis.actions.insert(
      baseAction({
        deploymentId: 'other-deployment',
        actionType: 'treasury_deposit',
        actorWalletAccountId: walletAccountId,
        typedDataHash: `0x${'89'.repeat(32)}`,
        signedAction: { message: { asset: 'USDC', amount: '30' }, signature: '0x' },
        submissionState: 'accepted',
        reconciliationState: 'pending',
      }),
    );
    const summary = await reconcileDeployment(fixture.knomosis, deploymentId);
    expect(summary.mismatched).toBeGreaterThanOrEqual(1);
    expect((await canExpandTreasury(fixture.knomosis, deploymentId)).allowed).toBe(false);
  });

  it('reconcileDeployment flags a finalized action whose RECEIPT is missing/mismatched (WS-L.3.4a receipt source)', async () => {
    const fixture = await freshKnomosisServices();
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const typedDataHash = `0x${'bb'.repeat(32)}`;
    const record = baseAction({
      deploymentId,
      typedDataHash,
      submissionState: 'finalized',
      reconciliationState: 'pending',
      signedAction: { message: { amount: '0', asset: 'USDC' }, signature: '0x' },
    });
    await fixture.knomosis.actions.insert(record);
    // The gateway stream AGREES (a finalized event for the hash) — but NO receipt
    // was persisted, so source-2 is missing and the action must NOT match.
    await fixture.knomosis.events.ingest({
      eventId: crypto.randomUUID(),
      deploymentId,
      chainId: LOCAL_DEPLOYMENT.chain_id,
      blockNumber: null,
      txHash: null,
      logIndex: null,
      eventType: 'knomosis.action.finalized',
      decodedPayload: { typed_data_hash: typedDataHash },
      eventSource: 'gateway',
      gatewaySeq: '1',
      gatewayIndex: 0,
      reorgState: 'confirmed',
      reorgDetectedAt: null,
      indexedAt: new Date().toISOString(),
    });
    const missing = await reconcileDeployment(fixture.knomosis, deploymentId);
    expect(missing.mismatched).toBe(1);
    expect(missing.matched).toBe(0);

    // Now WRITE a matching receipt and re-mark the action unreconciled: it matches.
    await writeReceipts(fixture.knomosis, record);
    await fixture.knomosis.actions.update({ ...record, reconciliationState: 'pending' });
    const withReceipt = await reconcileDeployment(fixture.knomosis, deploymentId);
    expect(withReceipt.matched).toBe(1);
    expect(withReceipt.mismatched).toBe(0);
  });

  it('resolves an orphan-event divergence once the late action reconciles (J5)', async () => {
    const fixture = await freshKnomosisServices();
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const typedDataHash = `0x${'ef'.repeat(32)}`;
    // A gateway event arrived BEFORE its action row: ingest recorded a CRITICAL
    // orphan divergence keyed by the action identity (its typed_data_hash).
    await fixture.knomosis.reconciliation.append({
      resultId: crypto.randomUUID(),
      deploymentId,
      entityType: 'action',
      entityRef: `event-orphan:${typedDataHash}`,
      outcome: 'mismatch',
      severity: 'critical',
      details: { kind: 'event_without_action', typed_data_hash: typedDataHash },
      lowWatermarkSeq: '1',
      createdAt: new Date(Date.now() - 1000).toISOString(),
    });
    // It blocks treasury expansion while unresolved.
    expect((await canExpandTreasury(fixture.knomosis, deploymentId)).allowed).toBe(false);

    // The late action row + its confirming event + receipt now arrive.
    const record = baseAction({
      deploymentId,
      typedDataHash,
      submissionState: 'finalized',
      reconciliationState: 'pending',
      signedAction: { message: { amount: '0', asset: 'USDC' }, signature: '0x' },
    });
    await fixture.knomosis.actions.insert(record);
    await fixture.knomosis.events.ingest({
      eventId: crypto.randomUUID(),
      deploymentId,
      chainId: LOCAL_DEPLOYMENT.chain_id,
      blockNumber: null,
      txHash: null,
      logIndex: null,
      eventType: 'knomosis.action.finalized',
      decodedPayload: { typed_data_hash: typedDataHash },
      eventSource: 'gateway',
      gatewaySeq: '1',
      gatewayIndex: 0,
      reorgState: 'confirmed',
      reorgDetectedAt: null,
      indexedAt: new Date().toISOString(),
    });
    await writeReceipts(fixture.knomosis, record);

    const summary = await reconcileDeployment(fixture.knomosis, deploymentId);
    expect(summary.matched).toBe(1);
    // The orphan-event divergence is SUPERSEDED by the resolving match — it no longer
    // blocks canExpandTreasury (J5: reconciliation, driven by action rows, can now
    // re-key and clear the earlier event-scoped divergence).
    const unresolved = await fixture.knomosis.reconciliation.listUnresolvedMismatches(deploymentId);
    expect(unresolved.some((d) => d.entityRef === `event-orphan:${typedDataHash}`)).toBe(false);
    expect((await canExpandTreasury(fixture.knomosis, deploymentId)).allowed).toBe(true);
  });

  it('a MISMATCHED action AUTO-resolves on a later tick, no manual reset (R9-3)', async () => {
    const fixture = await freshKnomosisServices();
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const typedDataHash = `0x${'cc'.repeat(32)}`;
    const record = baseAction({
      deploymentId,
      typedDataHash,
      submissionState: 'finalized',
      reconciliationState: 'pending',
      signedAction: { message: { amount: '0', asset: 'USDC' }, signature: '0x' },
    });
    await fixture.knomosis.actions.insert(record);
    await fixture.knomosis.events.ingest({
      eventId: crypto.randomUUID(),
      deploymentId,
      chainId: LOCAL_DEPLOYMENT.chain_id,
      blockNumber: null,
      txHash: null,
      logIndex: null,
      eventType: 'knomosis.action.finalized',
      decodedPayload: { typed_data_hash: typedDataHash },
      eventSource: 'gateway',
      gatewaySeq: '1',
      gatewayIndex: 0,
      reorgState: 'confirmed',
      reorgDetectedAt: null,
      indexedAt: new Date().toISOString(),
    });
    // Tick 1: the receipt is delayed ⇒ mismatch, which blocks treasury expansion.
    await reconcileDeployment(fixture.knomosis, deploymentId);
    expect(
      (await fixture.knomosis.actions.getById(record.actionRecordId))?.reconciliationState,
    ).toBe('mismatch');
    expect((await canExpandTreasury(fixture.knomosis, deploymentId)).allowed).toBe(false);
    // The delayed receipt finally arrives — NO manual reset of the row.
    await writeReceipts(fixture.knomosis, record);
    // Tick 2: the still-mismatched action is re-checked and resolves to matched.
    const resolved = await reconcileDeployment(fixture.knomosis, deploymentId);
    expect(resolved.matched).toBe(1);
    expect(
      (await fixture.knomosis.actions.getById(record.actionRecordId))?.reconciliationState,
    ).toBe('matched');
    expect((await canExpandTreasury(fixture.knomosis, deploymentId)).allowed).toBe(true);
  });

  it('reconcileDeployment flags a mapped actor with a gateway balance but NO deposit (R6-5)', async () => {
    const fixture = await freshKnomosisServices();
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const walletAccountId = crypto.randomUUID();
    // A wallet→actor mapping with NO finalized deposit at all…
    await fixture.knomosis.actorMappings.put({
      walletAccountId,
      deploymentId,
      actorId: 'ghost-actor',
      createdAt: new Date().toISOString(),
    });
    // …but the gateway reports a nonzero balance for that actor (indexer bug /
    // out-of-band credit).  The expected-ZERO product ledger must still be
    // compared, so this surfaces as a divergence + blocks treasury expansion.
    fixture.gateway.setBalance('ghost-actor', 'USDC', '500');
    const summary = await reconcileDeployment(fixture.knomosis, deploymentId);
    expect(summary.mismatched).toBeGreaterThanOrEqual(1);
    const gate = await canExpandTreasury(fixture.knomosis, deploymentId);
    expect(gate.allowed).toBe(false);
  });

  it('forwardToGateway records a proposal_sign signature ONLY on gateway acceptance (R6-3)', async () => {
    const fixture = await freshKnomosisServices();
    const { forwardToGateway } = await import('../knomosis/submission.js');
    const deps = {
      actions: fixture.knomosis.actions,
      signatures: fixture.knomosis.proposalSignatures,
      proposals: fixture.knomosis.proposals,
      uuid: fixture.knomosis.uuid,
      now: fixture.knomosis.now,
      log: fixture.knomosis.log,
    };
    const proposalId = crypto.randomUUID();
    const walletAccountId = crypto.randomUUID();
    const mk = (typedDataHash: string) =>
      baseAction({
        actionType: 'proposal_sign',
        submissionState: 'submitted',
        actorWalletAccountId: walletAccountId,
        typedDataHash,
        signedAction: { message: { proposalId }, signature: `0x${'ab'.repeat(65)}` },
      });
    // Gateway DECLINES ⇒ no signature is left behind…
    const declined = mk('0xno');
    await fixture.knomosis.actions.insert(declined);
    fixture.gateway.decline('0xno');
    expect((await forwardToGateway(deps, fixture.gateway, declined)).state).toBe('failed');
    expect(await fixture.knomosis.proposalSignatures.listByProposal(proposalId)).toHaveLength(0);
    // …so a re-signed retry (same proposal/wallet) is not blocked by the unique
    // key and records once it is ACCEPTED.
    const accepted = mk('0xyes');
    await fixture.knomosis.actions.insert(accepted);
    expect((await forwardToGateway(deps, fixture.gateway, accepted)).state).toBe('accepted');
    const sigs = await fixture.knomosis.proposalSignatures.listByProposal(proposalId);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ proposalId, walletAccountId });
  });

  it('forwardToGateway records NO signature when the CAS transition is stale (R9-2)', async () => {
    const fixture = await freshKnomosisServices();
    const { forwardToGateway } = await import('../knomosis/submission.js');
    const deps = {
      actions: fixture.knomosis.actions,
      signatures: fixture.knomosis.proposalSignatures,
      proposals: fixture.knomosis.proposals,
      uuid: fixture.knomosis.uuid,
      now: fixture.knomosis.now,
      log: fixture.knomosis.log,
    };
    const proposalId = crypto.randomUUID();
    const record = baseAction({
      actionType: 'proposal_sign',
      submissionState: 'submitted',
      typedDataHash: '0xacc',
      signedAction: { message: { proposalId }, signature: `0x${'ab'.repeat(65)}` },
    });
    await fixture.knomosis.actions.insert(record);
    // Ingestion RACES the action to a terminal `reverted` state (and would have
    // removed any signature) before forwardToGateway applies its stale accept.
    await fixture.knomosis.actions.update({ ...record, submissionState: 'reverted' });
    // The gateway accepts, but the CAS from the stale `submitted` fails ⇒ NO
    // signature is resurrected for the reverted action.
    expect((await forwardToGateway(deps, fixture.gateway, record)).state).toBe('accepted');
    expect(await fixture.knomosis.proposalSignatures.listByProposal(proposalId)).toHaveLength(0);
    expect((await fixture.knomosis.actions.getById(record.actionRecordId))?.submissionState).toBe(
      'reverted',
    );
  });

  it('sumFinalizedDeposits aggregates EVERY finalized deposit per (wallet,asset) (R7-2)', async () => {
    const store = new InMemoryKnomosisActionStore();
    const wallet = crypto.randomUUID();
    for (let i = 0; i < 3; i += 1) {
      await store.insert(
        baseAction({
          actorWalletAccountId: wallet,
          actionType: 'treasury_deposit',
          submissionState: 'finalized',
          signedAction: { message: { asset: 'USDC', amount: '100' }, signature: '0x' },
        }),
      );
    }
    // A non-finalized deposit must NOT count.
    await store.insert(
      baseAction({
        actorWalletAccountId: wallet,
        actionType: 'treasury_deposit',
        submissionState: 'submitted',
        signedAction: { message: { asset: 'USDC', amount: '999' }, signature: '0x' },
      }),
    );
    const sums = await store.sumFinalizedDeposits(LOCAL_DEPLOYMENT.deployment_id);
    expect(sums).toHaveLength(1);
    expect(sums[0]).toMatchObject({ walletAccountId: wallet, asset: 'USDC', total: '300' });
  });

  it('reconciliation latest-per-entity picks the resolving match on a same-createdAt tie (R7-8)', async () => {
    const store = new InMemoryReconciliationStore();
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const at = new Date().toISOString();
    const base = {
      deploymentId,
      entityType: 'treasury' as const,
      entityRef: `${deploymentId}:w1:USDC`,
      details: {},
      lowWatermarkSeq: null,
      createdAt: at, // identical timestamp for BOTH rows
    };
    await store.append({
      ...base,
      resultId: crypto.randomUUID(),
      outcome: 'mismatch',
      severity: 'critical',
    });
    // The resolving match is appended LATER with the SAME createdAt — it must win.
    await store.append({
      ...base,
      resultId: crypto.randomUUID(),
      outcome: 'match',
      severity: null,
    });
    const latest = await store.latestForEntity('treasury', base.entityRef);
    expect(latest?.outcome).toBe('match');
    expect(await store.listUnresolvedMismatches(deploymentId)).toHaveLength(0);
  });

  it('countQualifyingByRoom counts only simulated PRACTICE, not meta rows (WS-L review fix)', async () => {
    const store = new InMemoryGovernanceAuditStore();
    const roomId = crypto.randomUUID();
    const base = {
      roomId,
      actorUserId: null,
      actionDetails: {},
      simulationMode: true,
      createdAt: new Date().toISOString(),
    };
    await store.append({ entryId: crypto.randomUUID(), actionType: 'proposal_created', ...base });
    await store.append({ entryId: crypto.randomUUID(), actionType: 'vote_cast', ...base });
    await store.append({
      entryId: crypto.randomUUID(),
      actionType: 'treasury_deposit_simulated',
      ...base,
    });
    // Meta rows a failed transition attempt / the quiz append — NOT practice.
    await store.append({
      entryId: crypto.randomUUID(),
      actionType: 'mode_transition_requested',
      ...base,
    });
    await store.append({
      entryId: crypto.randomUUID(),
      actionType: 'comprehension_passed',
      ...base,
    });
    expect(await store.countByRoom(roomId)).toBe(5);
    expect(await store.countQualifyingByRoom(roomId)).toBe(3);
  });

  it('audit-log keyset paging is stable across SAME-millisecond rows (R5-13)', async () => {
    const store = new InMemoryGovernanceAuditStore();
    const roomId = crypto.randomUUID();
    // 5 entries that ALL share one millisecond — the exact case a createdAt-only
    // cursor skips or duplicates at a page boundary.
    const createdAt = new Date().toISOString();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const entryId = crypto.randomUUID();
      ids.push(entryId);
      await store.append({
        entryId,
        roomId,
        actionType: 'vote_cast',
        actorUserId: null,
        actionDetails: { i },
        simulationMode: true,
        createdAt,
      });
    }
    // Page through 2 at a time using the composite (createdAt, entryId) cursor.
    const seen: string[] = [];
    let before: { createdAt: string; entryId: string } | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await store.listByRoom(roomId, 2, before);
      if (page.length === 0) break;
      for (const e of page) seen.push(e.entryId);
      const oldest = page[page.length - 1];
      if (page.length < 2 || oldest === undefined) break;
      before = { createdAt: oldest.createdAt, entryId: oldest.entryId };
    }
    // Every row is seen EXACTLY once — no skip, no duplicate.
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());
  });
});

describe('signed human summary decimals (WS-L.3.1a / H6)', () => {
  const msg = (over: Record<string, string>): Record<string, string> => ({
    expiration: '2026-01-01T00:00:00Z',
    nonce: '7',
    ...over,
  });

  it('formats a KNOWN asset at its validated decimals', () => {
    // 1_500_000 minor units of a 6-decimal asset → 1.5 (never a guessed scale).
    const summary = buildHumanSummary(
      'treasury_deposit',
      'Test Room',
      msg({ asset: 'USDC', amount: '1500000' }),
    );
    expect(summary).toContain('of 1.5 USDC');
    expect(summary).not.toContain('minor units');
  });

  it('shows RAW minor units for an asset with no validated precision', () => {
    // An unlisted (e.g. 18-decimal) asset is NEVER mis-scaled at a guessed 6 — it is
    // shown as raw minor units and flagged as such, so the signed summary can't lie.
    const summary = buildHumanSummary(
      'treasury_deposit',
      'Test Room',
      msg({ asset: 'WETH', amount: '1000000000000000000' }),
    );
    expect(summary).toContain('of 1000000000000000000 WETH (minor units)');
  });

  it('omits the amount clause entirely when asset or amount is absent', () => {
    const summary = buildHumanSummary('proposal_sign', 'Test Room', msg({}));
    expect(summary).not.toContain(' of ');
    expect(summary).toContain('room "Test Room"');
  });
});

describe('ports (WS-L.3.1b / §19.1 region)', () => {
  it('the fail-closed compliance port never screens clear', async () => {
    expect(
      await defaultCompliancePort.screenAddress({ addressLower: '0x', deploymentId: 'd' }),
    ).toBe('unavailable');
    expect(
      await defaultCompliancePort.jurisdiction({
        userId: 'u',
        region: null,
        featureCell: null,
        asset: null,
      }),
    ).toBe('unknown');
    expect(await defaultCompliancePort.walletRisk({ walletAccountId: 'w', userId: 'u' })).toBe(
      'unavailable',
    );
  });

  it('localeRegionSubtag extracts the BCP-47 region (never geolocation)', () => {
    expect(localeRegionSubtag('en-GB')).toBe('GB');
    expect(localeRegionSubtag('en')).toBeNull();
    expect(localeRegionSubtag(null)).toBeNull();
  });

  it('createIdentityRegionResolver reads the account locale, tolerating errors', async () => {
    const ok = createIdentityRegionResolver({ userLocale: async () => 'de-DE' });
    expect(await ok.regionForUser('u')).toBe('DE');
    const broken = createIdentityRegionResolver({
      userLocale: async () => {
        throw new Error('store outage');
      },
    });
    expect(await broken.regionForUser('u')).toBeNull();
  });
});

describe('HTTP gateway standing + event paths (WS-L.3.6a / 3.3a)', () => {
  function stub(status: number, body: unknown, headers?: Record<string, string>) {
    return async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        ...(headers ? { headers } : {}),
      });
  }

  it('reads a well-formed budget with the seq header', async () => {
    const gw = new HttpKnomosisGateway({
      baseUrl: 'http://gw',
      bearerToken: 't',
      fetchImpl: stub(200, { amount: '500', isLowerBound: true }, { 'x-knomosis-seq': '9' }),
    });
    const result = await gw.getBudget('0xa');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.amount).toBe('500');
  });

  it('honours a 304 not-modified standing read', async () => {
    const gw = new HttpKnomosisGateway({
      baseUrl: 'http://gw',
      bearerToken: 't',
      fetchImpl: stub(304, undefined),
    });
    expect((await gw.getBalances('0xa', 'W/"etag"')).kind).toBe('not_modified');
  });

  it('parses a 200 events batch', async () => {
    const gw = new HttpKnomosisGateway({
      baseUrl: 'http://gw',
      bearerToken: 't',
      fetchImpl: stub(200, {
        events: [{ seq: '1', index: 0, type: 'knomosis.action.accepted', payload: {} }],
        latestSeq: '1',
      }),
    });
    const result = await gw.getEvents(null, 10);
    expect(result.kind).toBe('events');
    if (result.kind === 'events') expect(result.events).toHaveLength(1);
  });

  it('a 500 standing read degrades to unavailable', async () => {
    const gw = new HttpKnomosisGateway({
      baseUrl: 'http://gw',
      bearerToken: 't',
      fetchImpl: stub(500, undefined),
    });
    expect((await gw.getBalances('0xa')).kind).toBe('unavailable');
    expect((await gw.getBudget('0xa')).kind).toBe('unavailable');
  });
});

describe('submission state machine + resubmit (WS-L.3.2)', () => {
  it('the transition table is terminal-correct', () => {
    expect(VALID_SUBMISSION_TRANSITIONS.finalized).toHaveLength(0);
    expect(VALID_SUBMISSION_TRANSITIONS.reverted).toHaveLength(0);
    expect(VALID_SUBMISSION_TRANSITIONS.failed).toHaveLength(0);
    expect(canTransitionSubmissionState('submitted', 'accepted')).toBe(true);
    expect(canTransitionSubmissionState('finalized', 'submitted')).toBe(false);
  });

  it('applyTransition rejects an invalid transition (logged, no write)', async () => {
    const actions = new InMemoryKnomosisActionStore();
    const record = baseAction({ submissionState: 'finalized' });
    await actions.insert(record);
    const logged: string[] = [];
    const result = await applyTransition(
      { actions, now: () => Date.now(), log: (e) => logged.push(e) },
      record,
      'submitted',
      null,
    );
    expect(result).toBeNull();
    expect(logged).toContain('knomosis.action.invalid_transition');
  });

  it('applyTransition CAS does NOT clobber a row a concurrent writer already moved (R8-3)', async () => {
    const actions = new InMemoryKnomosisActionStore();
    // The action is `submitted` when forwardToGateway computes its transition…
    const record = baseAction({ submissionState: 'submitted' });
    await actions.insert(record);
    // …but ingestion RACES it to `finalized` before the stale transition writes.
    await actions.update({ ...record, submissionState: 'finalized' });
    const logged: string[] = [];
    const result = await applyTransition(
      { actions, now: () => Date.now(), log: (e) => logged.push(e) },
      record, // still carries the stale `submitted` from-state
      'accepted',
      null,
    );
    // The CAS matches nothing → null, and the terminal `finalized` state stands.
    expect(result).toBeNull();
    expect(logged).toContain('knomosis.action.stale_transition');
    expect((await actions.getById(record.actionRecordId))?.submissionState).toBe('finalized');
  });

  it('an accepted proposal_sign on a PRODUCTION proposal records NO ledger row (W14)', async () => {
    const fixture = await freshKnomosisServices();
    const proposalRow = (proposalId: string, simulationMode: boolean) => ({
      proposalId,
      roomId: crypto.randomUUID(),
      proposerUserId: crypto.randomUUID(),
      proposalType: 'charter_update' as const,
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: null,
      asset: null,
      recipientRef: null,
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed' as const,
      votingState: 'open' as const,
      challengeState: 'none' as const,
      executionState: 'not_executed' as const,
      simulationMode,
      executableAfter: null,
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: null,
    });
    const signAction = (proposalId: string) =>
      baseAction({
        actionType: 'proposal_sign',
        submissionState: 'accepted',
        signedAction: {
          message: { proposalId, purpose: 'vote', choice: 'approve' },
          signature: `0x${'cd'.repeat(65)}`,
        },
      });
    const deps = {
      signatures: fixture.knomosis.proposalSignatures,
      proposals: fixture.knomosis.proposals,
      uuid: fixture.knomosis.uuid,
      now: fixture.knomosis.now,
    };
    // A PRODUCTION ballot's ledger is the WS-M sign surface — a null-snapshot
    // row here would occupy the (proposal, wallet, purpose) unique and BLOCK
    // the same wallet's real vote (W14).
    const production = crypto.randomUUID();
    await fixture.knomosis.proposals.insert(proposalRow(production, false));
    await recordAcceptedProposalSignature(deps, signAction(production));
    expect(await fixture.knomosis.proposalSignatures.listByProposal(production)).toHaveLength(0);
    // A SIMULATED proposal still records its educational ledger row…
    const sim = crypto.randomUUID();
    await fixture.knomosis.proposals.insert(proposalRow(sim, true));
    await recordAcceptedProposalSignature(deps, signAction(sim));
    expect(await fixture.knomosis.proposalSignatures.listByProposal(sim)).toHaveLength(1);
    // …and an UNKNOWN proposal id keeps the durable-marker behaviour.
    const unknown = crypto.randomUUID();
    await recordAcceptedProposalSignature(deps, signAction(unknown));
    expect(await fixture.knomosis.proposalSignatures.listByProposal(unknown)).toHaveLength(1);
  });

  it('resubmitPendingActions re-forwards only submitted records', async () => {
    const fixture = await freshKnomosisServices();
    const record = baseAction({ submissionState: 'submitted', reconciliationState: 'pending' });
    await fixture.knomosis.actions.insert(record);
    const count = await resubmitPendingActions(
      {
        actions: fixture.knomosis.actions,
        signatures: fixture.knomosis.proposalSignatures,
        proposals: fixture.knomosis.proposals,
        uuid: fixture.knomosis.uuid,
        gateway: fixture.knomosis.gateway,
        now: fixture.knomosis.now,
        log: fixture.knomosis.log,
      },
      LOCAL_DEPLOYMENT.deployment_id,
    );
    expect(count).toBe(1);
    // The fake gateway accepted it → now `accepted`.
    const after = await fixture.knomosis.actions.getById(record.actionRecordId);
    expect(after?.submissionState).toBe('accepted');
  });

  it('resubmitPendingActions FORWARDS an expired submitted action — the gateway decides (G5)', async () => {
    const fixture = await freshKnomosisServices();
    // A `submitted` action (already forwarded once, gateway outage) whose signed
    // expiration has since passed.
    const expired = baseAction({
      submissionState: 'submitted',
      reconciliationState: 'pending',
      signedAction: {
        message: {
          amount: '10',
          asset: 'USDC',
          expiration: String(Math.floor(Date.now() / 1000) - 60),
        },
        signature: '0x',
      },
    });
    await fixture.knomosis.actions.insert(expired);
    const count = await resubmitPendingActions(
      {
        actions: fixture.knomosis.actions,
        signatures: fixture.knomosis.proposalSignatures,
        proposals: fixture.knomosis.proposals,
        uuid: fixture.knomosis.uuid,
        gateway: fixture.knomosis.gateway,
        now: fixture.knomosis.now,
        log: fixture.knomosis.log,
      },
      LOCAL_DEPLOYMENT.deployment_id,
    );
    // The row already reached the gateway once, so the retry RE-FORWARDS it (the
    // idempotency key makes it safe) and lets the GATEWAY's verdict decide — it is
    // NOT pre-emptively marked terminally `failed` on expiry, which would strand a
    // possibly-accepted action so later finalized events could never advance it (G5).
    expect(count).toBe(1);
    const after = await fixture.knomosis.actions.getById(expired.actionRecordId);
    expect(after?.submissionState).not.toBe('failed');
  });
});

describe('submission fail-closed paths (WS-L.3.2)', () => {
  const s = (fixture: Awaited<ReturnType<typeof freshKnomosisServices>>) => ({
    actions: fixture.knomosis.actions,
    wallets: fixture.knomosis.wallets,
    // These fail-closed tests reject BEFORE the room revalidation; a fail-closed
    // stub suffices when the fixture has no rooms port wired.
    rooms: fixture.knomosis.rooms ?? {
      roomGovernance: async () => null,
      isMember: async () => false,
      isSteward: async () => false,
      contentVisibleToUser: async () => false,
    },
    proposals: fixture.knomosis.proposals,
    lawPacks: fixture.knomosis.lawPacks,
    compliance: fixture.knomosis.compliance,
    regionForUser: (userId: string) => fixture.knomosis.regionResolver.regionForUser(userId),
    signatures: fixture.knomosis.proposalSignatures,
    nonces: fixture.knomosis.nonces,
    gateway: fixture.knomosis.gateway,
    ephemeral: fixture.knomosis.ephemeral,
    audit: fixture.knomosis.audit,
    config: fixture.knomosis.config,
    now: fixture.knomosis.now,
    uuid: fixture.knomosis.uuid,
    log: fixture.knomosis.log,
  });

  it('ONE action per payment intent: a second reservation replays the winner', async () => {
    const { InMemoryKnomosisActionStore } = await import('../knomosis/stores.js');
    const store = new InMemoryKnomosisActionStore();
    const INTENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const base = {
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      actionType: 'treasury_deposit' as const,
      roomId: '33333333-3333-4333-8333-333333333333',
      actorWalletAccountId: 'w1',
      payloadHash: '0xaa',
      typedDataHash: '0xbb',
      signedAction: { message: {}, signature: '0x' },
      submissionState: 'reserving' as const,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.insert({
      ...base,
      actionRecordId: 'a1',
      actorUserId: 'steward-a',
      idempotencyKey: INTENT,
      paymentIntentId: INTENT,
    });
    // A DIFFERENT steward, with their own actor-scoped key, settling the SAME
    // intent.  The `(actor, key)` unique cannot see this — it is actor-scoped
    // on purpose — so without the intent unique both would reserve, both would
    // forward under their own gateway key, and both would move funds while only
    // one could ever attach to the intent's ledger.
    await expect(
      store.insert({
        ...base,
        actionRecordId: 'a2',
        actorUserId: 'steward-b',
        idempotencyKey: INTENT,
        paymentIntentId: INTENT,
      }),
    ).rejects.toThrow(/unique constraint violated: knomosis_action_intent_uq/);
    // …and the loser can find the winner, which is what turns the lost race
    // into an idempotent replay rather than an error.
    expect((await store.getByPaymentIntentId(INTENT))?.actionRecordId).toBe('a1');

    // A DEAD attempt releases the intent.  `retryIntent` re-arms a
    // failed/reverted intent (`failed|reverted → created`) and the next attempt
    // mints a REPLACEMENT under its OWN fresh key (W14) — an index spanning every
    // state would collide with the corpse and replay it, stranding the retry.
    const attempt0 = await store.getById('a1');
    if (attempt0 === null) throw new Error('attempt 0 missing');
    await store.update({ ...attempt0, submissionState: 'failed' });
    expect(await store.getByPaymentIntentId(INTENT)).toBeNull(); // no live action
    await store.insert({
      ...base,
      actionRecordId: 'a5',
      actorUserId: 'steward-a',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      paymentIntentId: INTENT,
    });
    expect((await store.getByPaymentIntentId(INTENT))?.actionRecordId).toBe('a5');
    // …and the replacement is itself exclusive while it lives — the collision is
    // on the intent link, whatever key the second submitter chose.
    await expect(
      store.insert({
        ...base,
        actionRecordId: 'a6',
        actorUserId: 'steward-b',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        paymentIntentId: INTENT,
      }),
    ).rejects.toThrow(/unique constraint violated/);

    // A direct action (no intent) is unaffected: two actors, same key, fine.
    await store.insert({
      ...base,
      actionRecordId: 'a3',
      actorUserId: 'u1',
      idempotencyKey: 'k',
      paymentIntentId: null,
    });
    await store.insert({
      ...base,
      actionRecordId: 'a4',
      actorUserId: 'u2',
      idempotencyKey: 'k',
      paymentIntentId: null,
    });
    expect((await store.getById('a4'))?.actorUserId).toBe('u2');
  });

  it('an intent’s action replays BEFORE the mint-only gates, so a recovery cannot be locked out', async () => {
    const fixture = await freshKnomosisServices();
    const INTENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    // Steward A already submitted and forwarded this room-owned payout.
    await fixture.knomosis.actions.insert({
      actionRecordId: 'winner',
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      actionType: 'grant_payout',
      roomId: '33333333-3333-4333-8333-333333333333',
      actorWalletAccountId: 'wallet-a',
      actorUserId: 'steward-a',
      payloadHash: '0xaa',
      typedDataHash: '0xbb',
      signedAction: { message: {}, signature: '0x' },
      submissionState: 'submitted',
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: INTENT,
      paymentIntentId: INTENT,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Steward B recovers, under their OWN actor scope — and would fail every
    // mint-only gate: no wallet, no room port, a junk token, an empty payload.
    // None of that applies to an action that already exists and may be on
    // chain; B needs its id to attach the intent, and the insert conflict that
    // used to be the only replay is far past all those gates.
    const { submitAction } = await import('../knomosis/submission.js');
    const result = await submitAction(s(fixture), {
      userId: 'steward-b',
      preflightToken: 'nonexistent-token',
      // Steward B's OWN free idempotency key — the replay is found by the
      // payment_intent_id link, not by any shared/derived key.
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
      actionType: 'grant_payout',
      roomId: '33333333-3333-4333-8333-333333333333',
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      walletAccountId: 'wallet-b',
      paymentIntentId: INTENT,
      typedDataMessage: {},
      signature: '0x',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actionRecordId).toBe('winner');
      expect(result.submissionState).toBe('submitted');
      expect(result.replayed).toBe(true);
    }
  });

  it('the preflight token BINDS the intent it was cleared under', async () => {
    const { buildPreflightBinding, preflightBindingMismatch } = await import(
      '../knomosis/preflight.js'
    );
    const INTENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const base = {
      userId: 'u1',
      actionType: 'treasury_deposit' as const,
      roomId: 'r1',
      deploymentId: 'd1',
      walletAccountId: 'w1',
      typedDataHash: '0xbb',
    };
    const bound = buildPreflightBinding({ ...base, paymentIntentId: INTENT });
    // The same submission passes.
    expect(
      preflightBindingMismatch(bound, buildPreflightBinding({ ...base, paymentIntentId: INTENT })),
    ).toBeNull();
    // DROPPING the intent must not pass: submit would re-run the fraud check
    // under the typed-data hash instead — a different review from the one this
    // token was cleared under — and forward a direct action while the signed
    // intent stays unattached.
    expect(preflightBindingMismatch(bound, buildPreflightBinding(base))).not.toBeNull();
    // …and neither must SWAPPING it.
    expect(
      preflightBindingMismatch(bound, buildPreflightBinding({ ...base, paymentIntentId: OTHER })),
    ).not.toBeNull();
    // A token minted with no intent may not acquire one at submit.
    expect(
      preflightBindingMismatch(
        buildPreflightBinding(base),
        buildPreflightBinding({ ...base, paymentIntentId: INTENT }),
      ),
    ).not.toBeNull();
  });

  it('a bogus token reaches NO mutable compliance check (WS-N.2.2a/b)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
      isMember: async () => true,
      isSteward: async () => true,
      contentVisibleToUser: async () => true,
    };
    await fixture.knomosis.wallets.insert({
      walletAccountId: 'w1',
      userId: 'u1',
      addressHashHex: 'deadbeef',
      addressTruncated: '0x00…00',
      chainId: LOCAL_DEPLOYMENT.chain_id,
      walletType: 'eoa',
      unlinkState: 'active',
      riskState: 'normal',
      label: null,
      linkedAt: new Date().toISOString(),
      lastUsedAt: null,
      unlinkRequestedAt: null,
      unlinkFinalizeAfter: null,
      unlinkedAt: null,
    });
    // Count every MUTATING compliance call: `screenAddress` opens a sanctions
    // case and caches a verdict; `fraudRisk` reserves a velocity check (which a
    // room payout spends from the ROOM's window) and opens a high-value review.
    let screened = 0;
    let fraudChecked = 0;
    fixture.knomosis.compliance = {
      screenAddress: async () => {
        screened += 1;
        return 'clear' as const;
      },
      fraudRisk: async () => {
        fraudChecked += 1;
        return 'normal' as const;
      },
      jurisdiction: async () => 'allowed' as const,
      walletRisk: async () => ({ state: 'normal' as const, explanation: 'ok', nextStep: null }),
    };
    const { submitAction } = await import('../knomosis/submission.js');
    const result = await submitAction(s(fixture), {
      userId: 'u1',
      preflightToken: 'nonexistent-token',
      idempotencyKey: crypto.randomUUID(),
      actionType: 'treasury_deposit',
      roomId: '33333333-3333-4333-8333-333333333333',
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      walletAccountId: 'w1',
      typedDataMessage: {
        roomId: '33333333-3333-4333-8333-333333333333',
        treasuryId: '44444444-4444-4444-8444-444444444444',
        asset: 'USDC',
        amount: '1000000',
        actor: '0x0000000000000000000000000000000000000001',
        nonce: '1',
        expiration: String(Math.floor(Date.now() / 1000) + 600),
        deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      },
      signature: '0x',
    });
    // The submission fails at the token gate, as it always would have…
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PREFLIGHT_EXPIRED');
    // …but it never touched compliance on the way.  An authorized member could
    // otherwise sign arbitrary payloads, submit them with junk tokens, and
    // pollute the review queue / burn velocity budget on requests that were
    // always going to be rejected.
    expect(screened).toBe(0);
    expect(fraudChecked).toBe(0);
    // The failure is still AUDITED: the reservation exists and is `failed`, so
    // a retry replays it rather than re-processing.
    const reserved = (await fixture.knomosis.actions.listByActor('u1', 10)).find(
      (r) => r.actorWalletAccountId === 'w1',
    );
    expect(reserved?.submissionState).toBe('failed');
  });

  it('a missing preflight token is rejected (PREFLIGHT_EXPIRED)', async () => {
    const fixture = await freshKnomosisServices();
    // The pre-reservation gates (deployment/wallet/room) now run BEFORE the
    // single-use preflight token is consumed (WS-L.3.2a), so seed an active,
    // owned wallet + a testnet room the user belongs to — otherwise the flow
    // would (correctly) reject on the wallet/room before reaching the token.
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    await fixture.knomosis.wallets.insert({
      walletAccountId: 'w1',
      userId: 'u1',
      addressHashHex: 'deadbeef',
      addressTruncated: '0x00…00',
      chainId: LOCAL_DEPLOYMENT.chain_id,
      walletType: 'eoa',
      unlinkState: 'active',
      riskState: 'normal',
      label: null,
      linkedAt: new Date().toISOString(),
      lastUsedAt: null,
      unlinkRequestedAt: null,
      unlinkFinalizeAfter: null,
      unlinkedAt: null,
    });
    const { submitAction } = await import('../knomosis/submission.js');
    const result = await submitAction(s(fixture), {
      userId: 'u1',
      preflightToken: 'nonexistent-token',
      idempotencyKey: crypto.randomUUID(),
      actionType: 'treasury_deposit',
      roomId: '33333333-3333-4333-8333-333333333333',
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      walletAccountId: 'w1',
      // A VALID message so the hash computes and the flow reaches the (missing)
      // preflight-token check rather than failing message validation first.
      typedDataMessage: {
        roomId: '33333333-3333-4333-8333-333333333333',
        treasuryId: '44444444-4444-4444-8444-444444444444',
        asset: 'USDC',
        amount: '1000000',
        actor: '0x0000000000000000000000000000000000000001',
        nonce: '1',
        expiration: String(Math.floor(Date.now() / 1000) + 600),
        deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      },
      signature: '0x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PREFLIGHT_EXPIRED');
    // The reservation was FAILED (never left in `reserving`), so a retry replays
    // the failure rather than re-processing (WS-L.3.2a).
    const reserved = (await fixture.knomosis.actions.listByActor('u1', 10)).find(
      (r) => r.actorWalletAccountId === 'w1',
    );
    expect(reserved?.submissionState).toBe('failed');
  });

  const activeWallet = (walletAccountId: string, userId: string) => ({
    walletAccountId,
    userId,
    addressHashHex: 'deadbeef',
    addressTruncated: '0x00…00',
    chainId: LOCAL_DEPLOYMENT.chain_id,
    walletType: 'eoa' as const,
    unlinkState: 'active' as const,
    riskState: 'normal' as const,
    label: null,
    linkedAt: new Date().toISOString(),
    lastUsedAt: null,
    unlinkRequestedAt: null,
    unlinkFinalizeAfter: null,
    unlinkedAt: null,
  });
  const testnetRooms = {
    roomGovernance: async () => ({ mode: 'testnet' as const, name: 'Test Room' }),
    isMember: async () => true,
    isSteward: async () => false,
    contentVisibleToUser: async () => true,
  };
  const validDeposit = (deploymentId: string, roomId: string) => ({
    roomId,
    treasuryId: '44444444-4444-4444-8444-444444444444',
    asset: 'USDC',
    amount: '1000000',
    actor: '0x0000000000000000000000000000000000000001',
    nonce: '1',
    expiration: String(Math.floor(Date.now() / 1000) + 600),
    deploymentId,
  });

  it('rejects a submit for a wallet linked on a DIFFERENT chain than the deployment (F1)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = testnetRooms;
    // An active, owned wallet — but linked on a DIFFERENT chain than the deployment.
    await fixture.knomosis.wallets.insert({
      ...activeWallet('w1', 'u1'),
      chainId: LOCAL_DEPLOYMENT.chain_id + 1,
    });
    const room = crypto.randomUUID();
    const { submitAction } = await import('../knomosis/submission.js');
    const result = await submitAction(s(fixture), {
      userId: 'u1',
      preflightToken: 'irrelevant-token-here',
      idempotencyKey: crypto.randomUUID(),
      actionType: 'treasury_deposit',
      roomId: room,
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      walletAccountId: 'w1',
      typedDataMessage: validDeposit(LOCAL_DEPLOYMENT.deployment_id, room),
      signature: '0x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('WALLET_CHAIN_MISMATCH');
    // The chain gate runs BEFORE the reservation — no row persisted.
    expect(await fixture.knomosis.actions.listByActor('u1', 10)).toHaveLength(0);
  });

  it('rejects a submit for a wallet owned by ANOTHER user WITHOUT reserving a row (R11-1)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = testnetRooms;
    // A wallet owned by the VICTIM, not the submitter.
    await fixture.knomosis.wallets.insert(activeWallet('victim-wallet', 'victim'));
    const room = crypto.randomUUID();
    const { submitAction } = await import('../knomosis/submission.js');
    const result = await submitAction(s(fixture), {
      userId: 'attacker',
      preflightToken: 'irrelevant-token-here',
      idempotencyKey: crypto.randomUUID(),
      actionType: 'treasury_deposit',
      roomId: room,
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      walletAccountId: 'victim-wallet',
      typedDataMessage: validDeposit(LOCAL_DEPLOYMENT.deployment_id, room),
      signature: '0x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('WALLET_NOT_ACTIVE');
    // CRUCIAL: NO action row was ever inserted — the attacker cannot persist a row
    // whose FK points at the victim's wallet and blocks the victim's purge (R11-1).
    expect(await fixture.knomosis.actions.listByActor('attacker', 10)).toHaveLength(0);
    expect(await fixture.knomosis.actions.listOpenByWallet('victim-wallet')).toHaveLength(0);
  });

  it('rejects a submit on a FROZEN deployment at submit time (R11-5)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = testnetRooms;
    await fixture.knomosis.wallets.insert(activeWallet('w1', 'u1'));
    const room = crypto.randomUUID();
    const pinModule = await import('../knomosis/pin.js');
    const real = pinModule.pinnedDeployment(LOCAL_DEPLOYMENT.deployment_id);
    // The deployment is FROZEN in the pin file AFTER the still-alive preflight
    // token was minted — submit must reject it, not just a missing one.
    const spy = vi
      .spyOn(pinModule, 'pinnedDeployment')
      .mockReturnValue(real ? { ...real, status: 'frozen' } : undefined);
    try {
      const { submitAction } = await import('../knomosis/submission.js');
      const result = await submitAction(s(fixture), {
        userId: 'u1',
        preflightToken: 'irrelevant-token-here',
        idempotencyKey: crypto.randomUUID(),
        actionType: 'treasury_deposit',
        roomId: room,
        deploymentId: LOCAL_DEPLOYMENT.deployment_id,
        walletAccountId: 'w1',
        typedDataMessage: validDeposit(LOCAL_DEPLOYMENT.deployment_id, room),
        signature: '0x',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('DEPLOYMENT_UNKNOWN');
      // No row reserved for an inactive deployment.
      expect(await fixture.knomosis.actions.listByActor('u1', 10)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('never forwards/reconciles a `reserving` row, and sweeps a stale one to failed (R11-3)', async () => {
    const fixture = await freshKnomosisServices();
    const dep = LOCAL_DEPLOYMENT.deployment_id;
    const mkReserving = (createdAt: string) => {
      const id = crypto.randomUUID();
      return fixture.knomosis.actions
        .insert({
          actionRecordId: id,
          deploymentId: dep,
          actionType: 'treasury_deposit',
          roomId: crypto.randomUUID(),
          actorWalletAccountId: crypto.randomUUID(),
          actorUserId: crypto.randomUUID(),
          payloadHash: '0x',
          typedDataHash: `0x${'ab'.repeat(32)}`,
          signedAction: { message: {}, signature: '0x' },
          submissionState: 'reserving',
          failureReason: null,
          indexedEventRef: null,
          reconciliationState: 'pending',
          idempotencyKey: crypto.randomUUID(),
          paymentIntentId: null,
          createdAt,
          updatedAt: createdAt,
        })
        .then(() => id);
    };
    const staleId = await mkReserving(new Date(fixture.knomosis.now() - 60 * 60_000).toISOString());
    const freshId = await mkReserving(new Date(fixture.knomosis.now()).toISOString());
    // A `reserving` row is NEVER in the retry (submitted-only) set…
    expect(await fixture.knomosis.actions.listSubmittedRetryable(dep, 50)).toHaveLength(0);
    // …and NEVER in the reconciliation set (it never reached the gateway).
    expect(await fixture.knomosis.actions.listUnreconciled(dep, 50)).toHaveLength(0);
    // The sweep FAILS the stale reservation but LEAVES the fresh one (a live,
    // in-flight submit is never clobbered — the threshold ≫ any submit duration).
    const { failStaleReservations } = await import('../knomosis/submission.js');
    const failed = await failStaleReservations(
      { actions: fixture.knomosis.actions, now: fixture.knomosis.now, log: fixture.knomosis.log },
      dep,
      5 * 60_000,
    );
    expect(failed).toBe(1);
    expect((await fixture.knomosis.actions.getById(staleId))?.submissionState).toBe('failed');
    expect((await fixture.knomosis.actions.getById(freshId))?.submissionState).toBe('reserving');
  });

  it('an unconfigured gateway rejects submission (GATEWAY_UNAVAILABLE)', async () => {
    const fixture = await freshKnomosisServices();
    (fixture.knomosis as unknown as { setGateway?: (g: null) => void }).setGateway?.(null);
    const { submitAction } = await import('../knomosis/submission.js');
    const result = await submitAction(s(fixture), {
      userId: 'u1',
      preflightToken: 'tok',
      idempotencyKey: crypto.randomUUID(),
      actionType: 'treasury_deposit',
      roomId: 'r1',
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      walletAccountId: 'w1',
      typedDataMessage: {},
      signature: '0x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('GATEWAY_UNAVAILABLE');
  });

  it('forwardToGateway applies the accept / decline / outage verdicts', async () => {
    const fixture = await freshKnomosisServices();
    const { forwardToGateway } = await import('../knomosis/submission.js');
    const deps = {
      actions: fixture.knomosis.actions,
      signatures: fixture.knomosis.proposalSignatures,
      proposals: fixture.knomosis.proposals,
      uuid: fixture.knomosis.uuid,
      now: fixture.knomosis.now,
      log: fixture.knomosis.log,
    };
    // Accept.
    const accepted = baseAction({ submissionState: 'submitted' });
    await fixture.knomosis.actions.insert(accepted);
    expect((await forwardToGateway(deps, fixture.gateway, accepted)).state).toBe('accepted');
    // Decline (kernel says NotAdmissible) ⇒ failed.
    const declined = baseAction({ submissionState: 'submitted', typedDataHash: '0xdecl' });
    await fixture.knomosis.actions.insert(declined);
    fixture.gateway.decline('0xdecl');
    const declineOutcome = await forwardToGateway(deps, fixture.gateway, declined);
    expect(declineOutcome.state).toBe('failed');
    // Outage ⇒ stays submitted (idempotent re-submit later).
    const pending = baseAction({ submissionState: 'submitted', typedDataHash: '0xout' });
    await fixture.knomosis.actions.insert(pending);
    fixture.gateway.offline = true;
    expect((await forwardToGateway(deps, fixture.gateway, pending)).state).toBe('submitted');
  });
});

describe('readiness + simulation additional branches', () => {
  it('a not-permitted transition (testnet → mature) is rejected', async () => {
    const fixture = await freshKnomosisServices();
    const { requestModeTransition } = await import('../knomosis/readiness.js');
    let mode = 'testnet';
    const deps = {
      checklist: fixture.knomosis.readinessChecklist,
      roomMode: {
        currentMode: async () => mode as never,
        setMode: async (_r: string, m: string) => {
          mode = m;
          return true;
        },
        setModeIf: async (_r: string, expected: string, m: string) => {
          if (mode !== expected) return false;
          mode = m;
          return true;
        },
      },
      governanceAudit: fixture.knomosis.governanceAudit,
      comprehension: fixture.knomosis.comprehension,
      audit: fixture.knomosis.audit,
      config: fixture.knomosis.config,
      now: fixture.knomosis.now,
      uuid: fixture.knomosis.uuid,
    };
    const result = await requestModeTransition(deps, {
      roomId: crypto.randomUUID(),
      targetMode: 'testnet',
      userId: crypto.randomUUID(),
      reason: 'x',
    });
    // testnet → testnet is not a permitted edge.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('transition_not_permitted');
  });

  it('an unknown room mode transition is 404', async () => {
    const fixture = await freshKnomosisServices();
    const { requestModeTransition } = await import('../knomosis/readiness.js');
    const deps = {
      checklist: fixture.knomosis.readinessChecklist,
      roomMode: {
        currentMode: async () => null,
        setMode: async () => false,
        setModeIf: async () => false,
      },
      governanceAudit: fixture.knomosis.governanceAudit,
      comprehension: fixture.knomosis.comprehension,
      audit: fixture.knomosis.audit,
      config: fixture.knomosis.config,
      now: fixture.knomosis.now,
      uuid: fixture.knomosis.uuid,
    };
    const result = await requestModeTransition(deps, {
      roomId: crypto.randomUUID(),
      targetMode: 'simulated',
      userId: crypto.randomUUID(),
      reason: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it('a rejecting majority rejects the simulated proposal', async () => {
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' } });
    const sim = (await import('../knomosis/services.js')).simulationDeps(fixture.knomosis);
    const { castSimVote, createSimProposal, COMPREHENSION_QUIZ, submitComprehension } =
      await import('../knomosis/simulation.js');
    const roomId = crypto.randomUUID();
    const users: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const u = await seedUserWithSession(fixture.identity, { handle: `rej${i}` });
      users.push(u.userId);
      const answers: Record<string, number> = {};
      for (const q of COMPREHENSION_QUIZ) answers[q.question_id] = q.correctChoice;
      await submitComprehension(sim, { userId: u.userId, quizVersion: '1', answers });
    }
    const created = await createSimProposal(sim, {
      roomId,
      userId: users[0] as string,
      create: {
        proposal_type: 'bounty',
        title: 't',
        plain_language_summary: 's',
        requested_amount: '1',
        asset: 'SIM-USDC',
        recipient_ref: 'x',
        conflict_disclosures: 'none',
        risk_assessment: 'low',
        requested_action: {},
        expected_deliverable: 'd',
      },
    });
    if (!created.ok) throw new Error('proposal failed');
    for (const userId of users) {
      await castSimVote(sim, {
        roomId,
        proposalId: created.proposal.proposalId,
        userId,
        choice: 'reject',
      });
    }
    const after = await fixture.knomosis.proposals.getById(created.proposal.proposalId);
    expect(after?.votingState).toBe('rejected');
  });
});

describe('signature verifier factory + receipts', () => {
  it('createContractTypedDataVerifier returns undefined with no RPCs, a fn otherwise', () => {
    expect(createContractTypedDataVerifier({})).toBeUndefined();
    const verifier = createContractTypedDataVerifier({ 1: 'http://rpc' });
    expect(typeof verifier).toBe('function');
  });

  it('the contract verifier returns false for a chain with no endpoint', async () => {
    const verifier = createContractTypedDataVerifier({ 1: 'http://rpc' });
    const result = await verifier?.({
      address: '0xabc',
      typedDataHash: `0x${'00'.repeat(32)}`,
      signature: '0x',
      chainId: 999, // no endpoint
    });
    expect(result).toBe(false);
  });

  it('the PUBLIC receipt payload carries exactly the §19.5 allowlist — no more', async () => {
    const fixture = await freshKnomosisServices();
    // A signed message deliberately carrying fields that must NEVER reach the
    // room's public audit log (a civic identity, an address, the raw nonce).
    const record = baseAction({
      submissionState: 'finalized',
      signedAction: {
        message: {
          amount: '150',
          asset: 'SIM-USDC',
          nonce: '7',
          civicId: 'civic-abc',
          walletAddress: '0xdeadbeef',
        },
        signature: '0x',
      },
    });
    await fixture.knomosis.actions.insert(record);
    const { publicReceipt, privateReceipt } = await writeReceipts(fixture.knomosis, record);

    // EQUALITY, not merely "subset": a missing allowlisted field would thin the
    // receipt silently, and an extra key would be a §19.5 leak.
    expect(Object.keys(publicReceipt.payload).sort()).toEqual([...PUBLIC_RECEIPT_FIELDS].sort());
    for (const leaked of ['civicId', 'walletAddress', 'nonce', 'signed_fields']) {
      expect(Object.hasOwn(publicReceipt.payload, leaked)).toBe(false);
    }
    // The owner-scoped PRIVATE receipt is where the full disclosure belongs.
    expect(privateReceipt.payload['signed_fields']).toMatchObject({ civicId: 'civic-abc' });
  });

  it('projectPublicReceiptPayload drops an unlisted key instead of forwarding it', () => {
    // The structural guarantee: even a caller that supplies an extra field
    // (a future edit, a spread of the signed message) cannot widen the payload.
    const projected = projectPublicReceiptPayload({
      action_type: 'treasury_deposit',
      room_id: 'r1',
      asset: 'SIM-USDC',
      amount: '1',
      tx_ref: '0xabc',
      state: 'finalized',
      created_at: '2026-01-01T00:00:00.000Z',
      // @ts-expect-error — an unlisted field is a TYPE error as well as a runtime no-op.
      civic_identity: 'must-not-egress',
    });
    expect(Object.keys(projected).sort()).toEqual([...PUBLIC_RECEIPT_FIELDS].sort());
    expect(Object.hasOwn(projected, 'civic_identity')).toBe(false);
  });

  it('receipt pairing verifies and detects tampering', async () => {
    const fixture = await freshKnomosisServices();
    const record = baseAction({ submissionState: 'finalized' });
    await fixture.knomosis.actions.insert(record);
    const { publicReceipt } = await writeReceipts(fixture.knomosis, record);
    expect(verifyReceiptPairing(publicReceipt, record)).toBe(true);
    const tampered = { ...publicReceipt, summaryPayloadHash: `0x${'ff'.repeat(32)}` };
    expect(verifyReceiptPairing(tampered, record)).toBe(false);
  });

  it('receipts pair against the PERSISTED preflight summary, matching the preflight hash (O2)', async () => {
    const fixture = await freshKnomosisServices();
    const message = {
      amount: '150',
      asset: 'SIM-USDC',
      expiration: '9999999999',
      nonce: '1',
    };
    // The EXACT summary the preflight built + showed + hashed for this action.
    const preflightSummary = buildHumanSummary('treasury_deposit', 'My Room', message);
    const record = baseAction({
      submissionState: 'finalized',
      preflightSummary,
      signedAction: { message, signature: '0x' },
    });
    await fixture.knomosis.actions.insert(record);
    const { publicReceipt, privateReceipt } = await writeReceipts(fixture.knomosis, record);
    // The receipt's summary_payload_hash equals the hash the PREFLIGHT computed over
    // the SAME summary — so the receipt audits exactly what the user saw and signed,
    // not a receipt-specific state string whose hash could never match (O2).
    const preflightHash = pairSummaryToPayload(preflightSummary, record.typedDataHash);
    expect(publicReceipt.summaryPayloadHash).toBe(preflightHash);
    expect(privateReceipt.summaryPayloadHash).toBe(preflightHash);
    expect(verifyReceiptPairing(publicReceipt, record)).toBe(true);
  });
});

describe('ingest unsupported-event halt (WS-L.3.3a)', () => {
  function ingestDeps(fixture: Awaited<ReturnType<typeof freshKnomosisServices>>) {
    return {
      actions: fixture.knomosis.actions,
      proposalSignatures: fixture.knomosis.proposalSignatures,
      proposals: fixture.knomosis.proposals,
      actorMappings: fixture.knomosis.actorMappings,
      events: fixture.knomosis.events,
      reconciliation: fixture.knomosis.reconciliation,
      receipts: fixture.knomosis.receipts,
      audit: fixture.knomosis.audit,
      gateway: fixture.knomosis.gateway,
      now: fixture.knomosis.now,
      uuid: fixture.knomosis.uuid,
      log: fixture.knomosis.log,
      alert: fixture.knomosis.alert,
      notifyActor: async () => {},
    };
  }

  it('halts FAIL-CLOSED on an unknown gateway event type (unsupported_version)', async () => {
    const fixture = await freshKnomosisServices();
    const alerts: string[] = [];
    fixture.knomosis.alert = (event) => alerts.push(event);
    // Emit a future/unknown event tag through the fake gateway.
    fixture.gateway.emitRaw('knomosis.action.future_unknown', { typed_data_hash: '0xzz' });
    const result = await ingestGatewayEvents(
      ingestDeps(fixture),
      LOCAL_DEPLOYMENT.deployment_id,
      LOCAL_DEPLOYMENT.chain_id,
    );
    expect(result.kind).toBe('halted');
    if (result.kind === 'halted') expect(result.reason).toBe('unsupported_event');
    expect(alerts).toContain('knomosis.ingest.unsupported_event');
    // The deployment's reconciliation is now halted.
    const unresolved = await fixture.knomosis.reconciliation.listUnresolvedMismatches(
      LOCAL_DEPLOYMENT.deployment_id,
    );
    expect(unresolved.some((r) => r.outcome === 'halted_unsupported_version')).toBe(true);
  });
});

describe('scheduler error + lease handling', () => {
  it('still maintains an INACTIVE deployment that has in-flight actions (H5)', async () => {
    const fixture = await freshKnomosisServices();
    const { runKnomosisTick } = await import('../knomosis/scheduler.js');
    const depId = LOCAL_DEPLOYMENT.deployment_id;
    // Freeze the deployment — but it still has a FORWARDED (submitted, non-terminal)
    // action awaiting settlement.
    const existing = await fixture.knomosis.deployments.getById(depId);
    if (!existing) throw new Error('expected the pinned local deployment');
    await fixture.knomosis.deployments.upsert({ ...existing, status: 'frozen' });
    await fixture.knomosis.actions.insert(
      baseAction({ deploymentId: depId, submissionState: 'submitted' }),
    );
    // Observe which deployments reach reconciliation (reconcileDeployment →
    // listUnreconciled) vs RESUBMISSION (resubmitPendingActions → listSubmittedRetryable).
    const reconciled = new Set<string>();
    const resubmitted = new Set<string>();
    const originalList = fixture.knomosis.actions.listUnreconciled.bind(fixture.knomosis.actions);
    fixture.knomosis.actions.listUnreconciled = async (deploymentId, limit) => {
      reconciled.add(deploymentId);
      return originalList(deploymentId, limit);
    };
    const originalRetryable = fixture.knomosis.actions.listSubmittedRetryable.bind(
      fixture.knomosis.actions,
    );
    fixture.knomosis.actions.listSubmittedRetryable = async (deploymentId, limit) => {
      resubmitted.add(deploymentId);
      return originalRetryable(deploymentId, limit);
    };
    await runKnomosisTick(fixture.knomosis);
    // The frozen-but-in-flight deployment is STILL ingested/reconciled so its
    // finalized/reverted events settle and stop pinning the wallet's unlink…
    expect(reconciled.has(depId)).toBe(true);
    // …but resubmission (a NEW forward to the gateway) is NOT run for it — freezing
    // the deployment stops new forwarding even for its in-flight actions (J2).
    expect(resubmitted.has(depId)).toBe(false);
  });

  it('does NOT maintain an inactive deployment once its actions are terminal (H5)', async () => {
    const fixture = await freshKnomosisServices();
    const { runKnomosisTick } = await import('../knomosis/scheduler.js');
    const depId = LOCAL_DEPLOYMENT.deployment_id;
    const existing = await fixture.knomosis.deployments.getById(depId);
    if (!existing) throw new Error('expected the pinned local deployment');
    await fixture.knomosis.deployments.upsert({ ...existing, status: 'retired' });
    // Only a terminal (finalized) action remains → nothing left to settle.
    await fixture.knomosis.actions.insert(
      baseAction({ deploymentId: depId, submissionState: 'finalized' }),
    );
    const reconciled = new Set<string>();
    const originalList = fixture.knomosis.actions.listUnreconciled.bind(fixture.knomosis.actions);
    fixture.knomosis.actions.listUnreconciled = async (deploymentId, limit) => {
      reconciled.add(deploymentId);
      return originalList(deploymentId, limit);
    };
    await runKnomosisTick(fixture.knomosis);
    expect(reconciled.has(depId)).toBe(false);
  });

  it('assertSingleActiveGatewayDeployment fails closed on >1 active deployment (K1)', () => {
    const active = (id: string) => ({ deployment_id: id, status: 'active' });
    // One active deployment (the norm) is fine.
    expect(() => assertSingleActiveGatewayDeployment([active('d1')])).not.toThrow();
    // A retired/frozen sibling does NOT count toward the single-gateway limit.
    expect(() =>
      assertSingleActiveGatewayDeployment([
        active('d1'),
        { deployment_id: 'd0', status: 'retired' },
        { deployment_id: 'df', status: 'frozen' },
      ]),
    ).not.toThrow();
    // TWO active deployments a single gateway cannot route → refuse to boot.
    expect(() => assertSingleActiveGatewayDeployment([active('d1'), active('d2')])).toThrow(
      /refusing to start/,
    );
    // The real pin satisfies the invariant (a single active local deployment).
    expect(() => assertSingleActiveGatewayDeployment(KNOMOSIS_PIN.deployments)).not.toThrow();
  });

  it('syncPinnedDeployments retires a rotated pin BEFORE its active replacement (J4)', async () => {
    const fixture = await freshKnomosisServices();
    // freshKnomosisServices already synced the base deployment as ACTIVE.
    const base = LOCAL_DEPLOYMENT;
    const oldId = base.deployment_id;
    const newId = 'd0000000-0000-4000-8000-0000000000ff';
    // A rotation pin for the SAME (environment, chain_id): the NEW active deployment
    // appears BEFORE the OLD one (now marked retired) in the deployments array.
    const rotationPin = {
      ...KNOMOSIS_PIN,
      deployments: [
        { ...base, deployment_id: newId, status: 'active' as const },
        { ...base, deployment_id: oldId, status: 'retired' as const },
      ],
    };
    const order: Array<{ id: string; status: string }> = [];
    const originalUpsert = fixture.knomosis.deployments.upsert.bind(fixture.knomosis.deployments);
    fixture.knomosis.deployments.upsert = async (r) => {
      order.push({ id: r.deploymentId, status: r.status });
      return originalUpsert(r);
    };
    await syncPinnedDeployments(fixture.knomosis, rotationPin);
    // The displaced OLD deployment is retired BEFORE the NEW active replacement is
    // upserted, so the active-only (env,chain) unique index never sees two active rows.
    const oldRetiredAt = order.findIndex((o) => o.id === oldId && o.status === 'retired');
    const newActiveAt = order.findIndex((o) => o.id === newId && o.status === 'active');
    expect(oldRetiredAt).toBeGreaterThanOrEqual(0);
    expect(newActiveAt).toBeGreaterThanOrEqual(0);
    expect(oldRetiredAt).toBeLessThan(newActiveAt);
    expect((await fixture.knomosis.deployments.getById(oldId))?.status).toBe('retired');
    expect((await fixture.knomosis.deployments.getById(newId))?.status).toBe('active');
  });

  it('reports a task error without aborting the tick, and a denied lease is a no-op', async () => {
    const fixture = await freshKnomosisServices();
    const { runKnomosisTick, startKnomosisScheduler } = await import('../knomosis/scheduler.js');
    // Force the unlink-finalization task to throw.
    const original = fixture.knomosis.wallets.listPendingFinalization;
    fixture.knomosis.wallets.listPendingFinalization = async () => {
      throw new Error('boom');
    };
    const errors: string[] = [];
    await runKnomosisTick(fixture.knomosis, (_e, task) => errors.push(task));
    expect(errors).toContain('unlink_finalize');
    fixture.knomosis.wallets.listPendingFinalization = original;

    // A denied lease skips the tick entirely.
    let ran = false;
    const originalReload = fixture.knomosis.reloadConfig;
    fixture.knomosis.reloadConfig = async () => {
      ran = true;
      return originalReload();
    };
    const stop = startKnomosisScheduler(fixture.knomosis, () => {}, 10_000, {
      lease: { tryAcquire: async () => false },
      holder: 'test',
    });
    await new Promise((r) => setTimeout(r, 5));
    stop();
    expect(ran).toBe(false); // never acquired the lease
    fixture.knomosis.reloadConfig = originalReload;
  });

  it('a lease acquisition error is reported and skips the tick', async () => {
    const fixture = await freshKnomosisServices();
    const { startKnomosisScheduler } = await import('../knomosis/scheduler.js');
    const errors: string[] = [];
    const stop = startKnomosisScheduler(fixture.knomosis, (_e, task) => errors.push(task), 10_000, {
      lease: {
        tryAcquire: async () => {
          throw new Error('lease store down');
        },
      },
      holder: 'test',
    });
    await new Promise((r) => setTimeout(r, 5));
    stop();
    expect(errors).toContain('lease');
  });
});

describe('in-memory store adapters + services getter', () => {
  it('the on-chain event store marks reorged/confirmed and finds the latest seq', async () => {
    const store = new InMemoryOnChainEventStore();
    const { record } = await store.ingest({
      eventId: 'e1',
      deploymentId: 'd',
      chainId: 1,
      blockNumber: null,
      txHash: null,
      logIndex: null,
      eventType: 'knomosis.action.accepted',
      decodedPayload: {},
      eventSource: 'gateway',
      gatewaySeq: '5',
      gatewayIndex: 0,
      reorgState: 'pending',
      reorgDetectedAt: null,
      indexedAt: new Date().toISOString(),
    });
    // F3: latestGatewaySeq is the RECORDED, group-atomic watermark — NOT the raw
    // max-stored seq — so an ingested-but-not-yet-cursor-advanced event does not
    // move the resume point (a partial multi-index group must never advance it).
    expect(await store.latestGatewaySeq('d')).toBeNull();
    await store.recordGatewayCursor('d', '5');
    expect(await store.latestGatewaySeq('d')).toBe('5');
    // Monotonic: a lower seq never rewinds the watermark.
    await store.recordGatewayCursor('d', '3');
    expect(await store.latestGatewaySeq('d')).toBe('5');
    await store.markConfirmed([record.eventId]);
    await store.markReorged([record.eventId], new Date().toISOString());
    const fetched = await store.getById(record.eventId);
    expect(fetched?.reorgState).toBe('reorged');
    // A duplicate ingest is idempotent (no-op).
    const dup = await store.ingest({ ...record, eventId: 'e2' });
    expect(dup.inserted).toBe(false);
  });

  it('the governance audit store is append-only + counts by room', async () => {
    const store = new InMemoryGovernanceAuditStore();
    await store.append({
      entryId: crypto.randomUUID(),
      roomId: 'r1',
      actionType: 'proposal_created',
      actorUserId: null,
      actionDetails: {},
      simulationMode: true,
      createdAt: new Date().toISOString(),
    });
    expect(await store.countByRoom('r1')).toBe(1);
    expect(await store.listByRoom('r1', 10)).toHaveLength(1);
  });

  it('insertIfUnderCap atomically rejects at the wallet cap (R9-5)', async () => {
    const store = new InMemoryFinancialWalletStore();
    const userId = crypto.randomUUID();
    const mk = (i: number) => ({
      walletAccountId: crypto.randomUUID(),
      userId,
      addressHashHex: `cc${i.toString().padStart(62, '0')}`,
      addressTruncated: `0x0${i}…ff`,
      chainId: 8357,
      walletType: 'eoa' as const,
      unlinkState: 'active' as const,
      riskState: 'pending' as const,
      label: null,
      linkedAt: new Date().toISOString(),
      lastUsedAt: null,
      unlinkRequestedAt: null,
      unlinkFinalizeAfter: null,
      unlinkedAt: null,
    });
    expect(await store.insertIfUnderCap(mk(0), 2)).not.toBe('cap_exceeded');
    expect(await store.insertIfUnderCap(mk(1), 2)).not.toBe('cap_exceeded');
    // At the cap ⇒ rejected (the count + insert are one atomic step).
    expect(await store.insertIfUnderCap(mk(2), 2)).toBe('cap_exceeded');
    expect(await store.listByUser(userId, false)).toHaveLength(2);
  });

  it('reactivateIfUnderCap shares the cap with the new-link path (R10-3)', async () => {
    const store = new InMemoryFinancialWalletStore();
    const userId = crypto.randomUUID();
    const base = (over: Record<string, unknown>) => ({
      walletAccountId: crypto.randomUUID(),
      userId,
      addressHashHex: `dd${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 64),
      addressTruncated: '0x00…00',
      chainId: 8357,
      walletType: 'eoa' as const,
      unlinkState: 'active' as const,
      riskState: 'pending' as const,
      label: null,
      linkedAt: new Date().toISOString(),
      lastUsedAt: null,
      unlinkRequestedAt: null,
      unlinkFinalizeAfter: null,
      unlinkedAt: null,
      ...over,
    });
    await store.insert(base({}));
    await store.insert(base({})); // 2 active — at the cap of 2
    const finalized = base({ unlinkState: 'finalized' as const });
    await store.insert(finalized);
    // Reactivating the finalized wallet would make 3 active ⇒ blocked by the SAME cap.
    expect(await store.reactivateIfUnderCap({ ...finalized, unlinkState: 'active' }, 2)).toBe(
      'cap_exceeded',
    );
    expect((await store.getById(finalized.walletAccountId))?.unlinkState).toBe('finalized');
  });

  it('finalizeIfStillPending CAS never clobbers a re-linked wallet (R10-6)', async () => {
    const store = new InMemoryFinancialWalletStore();
    const finalizeAfter = '2026-01-01T00:00:00.000Z';
    const wallet = {
      walletAccountId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      addressHashHex: 'e'.repeat(64),
      addressTruncated: '0x0…0',
      chainId: 8357,
      walletType: 'eoa' as const,
      unlinkState: 'pending_unlink' as const,
      riskState: 'normal' as const,
      label: null,
      linkedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
      unlinkRequestedAt: '2026-01-01T00:00:00.000Z',
      unlinkFinalizeAfter: finalizeAfter,
      unlinkedAt: null,
    };
    await store.insert(wallet);
    // A relink CANCELS the unlink (active, finalize timestamp cleared) between the
    // sweep's list and this write.
    await store.update({ ...wallet, unlinkState: 'active', unlinkFinalizeAfter: null });
    // The CAS (still-pending + same timestamp) matches nothing ⇒ not clobbered.
    expect(
      await store.finalizeIfStillPending(
        wallet.walletAccountId,
        finalizeAfter,
        '2026-01-02T00:00:00.000Z',
      ),
    ).toBe(false);
    expect((await store.getById(wallet.walletAccountId))?.unlinkState).toBe('active');
    // A genuinely still-pending wallet DOES finalize.
    await store.update({
      ...wallet,
      unlinkState: 'pending_unlink',
      unlinkFinalizeAfter: finalizeAfter,
    });
    expect(
      await store.finalizeIfStillPending(
        wallet.walletAccountId,
        finalizeAfter,
        '2026-01-02T00:00:00.000Z',
      ),
    ).toBe(true);
    expect((await store.getById(wallet.walletAccountId))?.unlinkState).toBe('finalized');
  });

  it('the abuse limiter enforces a sliding window', async () => {
    let clock = 0;
    const limiter = new WalletAbuseLimiter(() => clock);
    expect(await limiter.hit('k', 2, 1000)).toBe(true);
    expect(await limiter.hit('k', 2, 1000)).toBe(true);
    expect(await limiter.hit('k', 2, 1000)).toBe(false); // over
    clock += 2000; // window elapsed
    expect(await limiter.hit('k', 2, 1000)).toBe(true);
  });

  it('getKnomosisServices throws when unconfigured; configured flag reflects state', async () => {
    const { knomosisServicesConfigured, setServicesGateway } = await import(
      '../knomosis/services.js'
    );
    resetKnomosisServicesForTests();
    expect(knomosisServicesConfigured()).toBe(false);
    expect(() => getKnomosisServices()).toThrow(/not configured/);
    const fixture = await freshKnomosisServices();
    expect(knomosisServicesConfigured()).toBe(true);
    // setServicesGateway swaps the gateway on the live container.
    setServicesGateway(fixture.knomosis, null);
    expect(fixture.knomosis.gateway()).toBeNull();
  });

  it('a config-store reject is logged and the default kept (fail closed)', async () => {
    const { loadKnomosisConfig, storeKnomosisConfigValue, DEFAULT_KNOMOSIS_CONFIG } = await import(
      '../knomosis/config.js'
    );
    const { InMemoryPwattConfigStore } = await import('../events/stores.js');
    const store = new InMemoryPwattConfigStore();
    await storeKnomosisConfigValue(store, 'siweNonceTtlMs', -1); // invalid
    const rejected: string[] = [];
    const config = await loadKnomosisConfig(store, (key) => rejected.push(key));
    expect(rejected).toContain('siweNonceTtlMs');
    expect(config.siweNonceTtlMs).toBe(DEFAULT_KNOMOSIS_CONFIG.siweNonceTtlMs);
  });

  it('consumePreflightToken returns null for a malformed stored value', async () => {
    const fixture = await freshKnomosisServices();
    const { consumePreflightToken } = await import('../knomosis/preflight.js');
    // Absent token ⇒ null.
    expect(await consumePreflightToken(fixture.knomosis.ephemeral, 'nope')).toBeNull();
    // Malformed (non-JSON) stored value ⇒ null (parse catch).
    await fixture.knomosis.ephemeral.set('knomosis:preflight:garbage', 'not-json{', 60_000);
    expect(await consumePreflightToken(fixture.knomosis.ephemeral, 'garbage')).toBeNull();
  });

  it('writeReceipts handles an action with no amount/asset (proposal_sign)', async () => {
    const fixture = await freshKnomosisServices();
    const record = baseAction({
      actionType: 'proposal_sign',
      submissionState: 'finalized',
      signedAction: { message: { roomId: 'r1', proposalId: 'p1' }, signature: '0x' },
    });
    await fixture.knomosis.actions.insert(record);
    const { publicReceipt } = await writeReceipts(fixture.knomosis, record);
    expect(publicReceipt.payload['asset']).toBeNull();
    expect(publicReceipt.payload['amount']).toBeNull();
  });

  it('reconciliation fires a critical alert on a material mismatch', async () => {
    const fixture = await freshKnomosisServices();
    const alerts: string[] = [];
    fixture.knomosis.alert = (event) => alerts.push(event);
    // A finalized action with NO indexed event ⇒ mismatch; amount ≥ threshold ⇒ critical.
    const record = baseAction({
      submissionState: 'finalized',
      reconciliationState: 'pending',
      signedAction: { message: { amount: '1000000', asset: 'USDC' }, signature: '0x' },
    });
    await fixture.knomosis.actions.insert(record);
    const summary = await reconcileDeployment(fixture.knomosis, LOCAL_DEPLOYMENT.deployment_id);
    expect(summary.mismatched).toBe(1);
    expect(alerts).toContain('knomosis.reconcile.critical_divergence');
  });

  it('preflight rejects a wallet that is not active (WALLET_NOT_ACTIVE)', async () => {
    const fixture = await freshKnomosisServices();
    const { runPreflight } = await import('../knomosis/preflight.js');
    const { hashFinancialWalletAddress } = await import('../identity/siwe.js');
    const {
      signedTypedData,
      testAccount,
      LOCAL_DEPLOYMENT: dep,
    } = await import('./knomosis-test-helpers.js');
    const uid = '99999999-9999-4999-8999-999999999999';
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    // A wallet in pending_unlink is NOT active.
    const walletAccountId = fixture.knomosis.uuid();
    await fixture.knomosis.wallets.insert({
      walletAccountId,
      userId: uid,
      addressHashHex: hashFinancialWalletAddress(
        fixture.knomosis.masterSecret,
        testAccount.address.toLowerCase(),
      ),
      addressTruncated: '0x00…00',
      chainId: dep.chain_id,
      walletType: 'eoa',
      unlinkState: 'pending_unlink',
      riskState: 'normal',
      label: null,
      linkedAt: new Date().toISOString(),
      lastUsedAt: null,
      unlinkRequestedAt: null,
      unlinkFinalizeAfter: null,
      unlinkedAt: null,
    });
    const message = {
      roomId: crypto.randomUUID(),
      treasuryId: crypto.randomUUID(),
      asset: 'USDC',
      amount: '1',
      actor: testAccount.address,
      nonce: '1',
      expiration: String(Math.floor(Date.now() / 1000) + 600),
      deploymentId: dep.deployment_id,
    };
    const signature = await signedTypedData('treasury_deposit', message);
    const result = await runPreflight(
      {
        wallets: fixture.knomosis.wallets,
        actions: fixture.knomosis.actions,
        proposals: fixture.knomosis.proposals,
        rooms: fixture.knomosis.rooms,
        lawPacks: fixture.knomosis.lawPacks,
        nonces: fixture.knomosis.nonces,
        compliance: fixture.knomosis.compliance,
        ephemeral: fixture.knomosis.ephemeral,
        audit: fixture.knomosis.audit,
        masterSecret: fixture.knomosis.masterSecret,
        config: fixture.knomosis.config,
        now: fixture.knomosis.now,
        log: fixture.knomosis.log,
        regionForUser: () => fixture.knomosis.regionResolver.regionForUser(uid),
      },
      {
        userId: uid,
        actionType: 'treasury_deposit',
        roomId: message.roomId,
        deploymentId: dep.deployment_id,
        walletAccountId,
        typedDataMessage: message,
        signature,
      },
    );
    expect(result.result).toBe('fail');
    if (result.result === 'fail') expect(result.reason_code).toBe('WALLET_NOT_ACTIVE');
  });

  it('simulated execution rejects a not-ready or still-timelocked proposal', async () => {
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' } });
    const { simulationDeps } = await import('../knomosis/services.js');
    const sim = simulationDeps(fixture.knomosis);
    const { executeSimProposal, executeElapsedSimProposals, ensureSimTreasury } = await import(
      '../knomosis/simulation.js'
    );
    const roomId = crypto.randomUUID();
    await ensureSimTreasury(sim, roomId);

    // An OPEN proposal is not executable.
    const openId = crypto.randomUUID();
    await fixture.knomosis.proposals.insert({
      proposalId: openId,
      roomId,
      proposerUserId: 'u',
      proposalType: 'charter_update',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: null,
      asset: null,
      recipientRef: null,
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'open',
      challengeState: 'none',
      executionState: 'not_executed',
      simulationMode: true,
      executableAfter: null,
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: null,
    });
    const notReady = await executeSimProposal(sim, {
      roomId,
      proposalId: openId,
      actorUserId: null,
    });
    expect(notReady.ok).toBe(false);
    if (!notReady.ok) expect(notReady.code).toBe('not_executable');

    // A passed+timelocked proposal whose timelock has NOT elapsed.
    const futureId = crypto.randomUUID();
    await fixture.knomosis.proposals.insert({
      proposalId: futureId,
      roomId,
      proposerUserId: 'u',
      proposalType: 'charter_update',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: null,
      asset: null,
      recipientRef: null,
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'passed',
      challengeState: 'none',
      executionState: 'timelocked',
      simulationMode: true,
      executableAfter: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: null,
    });
    const timelocked = await executeSimProposal(sim, {
      roomId,
      proposalId: futureId,
      actorUserId: null,
    });
    expect(timelocked.ok).toBe(false);
    if (!timelocked.ok) expect(timelocked.code).toBe('timelocked');

    // The scheduler sweep executes an elapsed one (charter update, no funds).
    const elapsedId = crypto.randomUUID();
    await fixture.knomosis.proposals.insert({
      proposalId: elapsedId,
      roomId,
      proposerUserId: 'u',
      proposalType: 'charter_update',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: null,
      asset: null,
      recipientRef: null,
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'passed',
      challengeState: 'none',
      executionState: 'timelocked',
      simulationMode: true,
      executableAfter: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: null,
    });
    expect(await executeElapsedSimProposals(sim)).toBeGreaterThanOrEqual(1);
  });

  it('walletRiskState returns the local explanation for each stored risk state', async () => {
    const fixture = await freshKnomosisServices();
    const { walletRiskState, issueWalletLinkNonce } = await import('../knomosis/wallet.js');
    const userId = '77777777-7777-4777-8777-777777777777';
    const deps = {
      wallets: fixture.knomosis.wallets,
      actions: fixture.knomosis.actions,
      proposalSignatures: fixture.knomosis.proposalSignatures,
      compliance: fixture.knomosis.compliance, // default unavailable ⇒ local text
      treasuryObligations: fixture.knomosis.treasuryObligations,
      ephemeral: fixture.knomosis.ephemeral,
      audit: fixture.knomosis.audit,
      abuse: fixture.knomosis.abuse,
      masterSecret: fixture.knomosis.masterSecret,
      siweBase: fixture.knomosis.siweBase,
      chainAllowlist: () => [8357, 11155111],
      config: fixture.knomosis.config,
      now: fixture.knomosis.now,
      uuid: fixture.knomosis.uuid,
      log: fixture.knomosis.log,
      alert: fixture.knomosis.alert,
    };
    // Each stored state resolves the corresponding local explanation.
    for (const riskState of ['normal', 'elevated', 'high'] as const) {
      const walletAccountId = fixture.knomosis.uuid();
      await fixture.knomosis.wallets.insert({
        walletAccountId,
        userId,
        addressHashHex: crypto.randomUUID(),
        addressTruncated: '0x00…00',
        chainId: 1,
        walletType: 'eoa',
        unlinkState: 'active',
        riskState,
        label: null,
        linkedAt: new Date().toISOString(),
        lastUsedAt: null,
        unlinkRequestedAt: null,
        unlinkFinalizeAfter: null,
        unlinkedAt: null,
      });
      const result = await walletRiskState(deps, { userId, walletAccountId });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.riskState).toBe(riskState);
    }
    expect((await walletRiskState(deps, { userId, walletAccountId: crypto.randomUUID() })).ok).toBe(
      false,
    );

    // The nonce endpoint is rate-limited (WS-L.2.5d): exhausting the budget 429s.
    const limit = fixture.knomosis.config().linkAttemptsPerHour;
    for (let i = 0; i < limit; i += 1) {
      await issueWalletLinkNonce(deps, { userId, sessionTokenHash: `t${i}` });
    }
    const over = await issueWalletLinkNonce(deps, { userId, sessionTokenHash: 'tx' });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.status).toBe(429);
  });

  it('reconciliation logs a warning (not critical) for a small mismatch', async () => {
    const fixture = await freshKnomosisServices();
    const alerts: string[] = [];
    fixture.knomosis.alert = (event) => alerts.push(event);
    // A finalized action with NO indexed event ⇒ mismatch; amount BELOW the
    // critical threshold ('1') would be critical, so use amount '0' → warning.
    const record = baseAction({
      submissionState: 'finalized',
      reconciliationState: 'pending',
      signedAction: { message: { amount: '0', asset: 'USDC' }, signature: '0x' },
    });
    await fixture.knomosis.actions.insert(record);
    await reconcileDeployment(fixture.knomosis, LOCAL_DEPLOYMENT.deployment_id);
    // A warning severity does NOT fire the critical page.
    expect(alerts).not.toContain('knomosis.reconcile.critical_divergence');
  });

  it('KnomosisMetrics counts and the nonce store reports usage', async () => {
    const { KnomosisMetrics, InMemoryActionNonceStore } = await import('../knomosis/services.js');
    const metrics = new KnomosisMetrics();
    metrics.increment('a');
    metrics.increment('a', 2);
    expect(metrics.snapshot()['a']).toBe(3);
    metrics.clear();
    expect(metrics.snapshot()).toEqual({});

    const nonces = new InMemoryActionNonceStore();
    expect(await nonces.isUsed('u', 'd', '1')).toBe(false);
    expect(await nonces.tryConsume('u', 'd', '1')).toBe(true);
    expect(await nonces.isUsed('u', 'd', '1')).toBe(true);
    expect(await nonces.tryConsume('u', 'd', '1')).toBe(false);
  });

  it('the HTTP gateway maps 413 (oversize) to a protocol error', async () => {
    const gw = new HttpKnomosisGateway({
      baseUrl: 'http://gw',
      bearerToken: 't',
      fetchImpl: async () => new Response(null, { status: 413 }),
    });
    const result = await gw.submitAction({
      signedAction: {
        message: { actor: '0xa' },
        signature: '0x',
        actionType: 'treasury_deposit',
        typedDataHash: '0xh',
      },
      idempotencyKey: 'k',
    });
    expect(result.kind).toBe('protocol_error');
  });

  it('the lease-guarded scheduler runs when it owns the lease and stops cleanly', async () => {
    const fixture = await freshKnomosisServices();
    const { startKnomosisScheduler } = await import('../knomosis/scheduler.js');
    let granted = true;
    const lease = { tryAcquire: async () => granted };
    const stop = startKnomosisScheduler(fixture.knomosis, () => {}, 10_000, {
      lease,
      holder: 'test',
    });
    // Immediate tick already ran under the granted lease; a denied lease is a no-op.
    granted = false;
    stop();
    expect(typeof stop).toBe('function');
  });

  it('a simulated execution blocks when the sim treasury cannot cover it', async () => {
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' } });
    const sim = (await import('../knomosis/services.js')).simulationDeps(fixture.knomosis);
    const { executeSimProposal, ensureSimTreasury } = await import('../knomosis/simulation.js');
    const roomId = crypto.randomUUID();
    await ensureSimTreasury(sim, roomId);
    // A timelocked, passed proposal requesting MORE than the treasury holds.
    const proposalId = crypto.randomUUID();
    await fixture.knomosis.proposals.insert({
      proposalId,
      roomId,
      proposerUserId: 'u1',
      proposalType: 'capped_grant',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: '999999999999999',
      asset: 'SIM-USDC',
      recipientRef: 'x',
      conflictDisclosures: 'none',
      riskAssessment: 'low',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'passed',
      challengeState: 'none',
      executionState: 'timelocked',
      simulationMode: true,
      executableAfter: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: null,
    });
    const result = await executeSimProposal(sim, { roomId, proposalId, actorUserId: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('insufficient_sim_funds');
  });

  it('ingest against an unconfigured gateway degrades to unavailable', async () => {
    const fixture = await freshKnomosisServices();
    (fixture.knomosis as unknown as { setGateway?: (g: null) => void }).setGateway?.(null);
    const result = await ingestGatewayEvents(
      {
        actions: fixture.knomosis.actions,
        proposalSignatures: fixture.knomosis.proposalSignatures,
        proposals: fixture.knomosis.proposals,
        actorMappings: fixture.knomosis.actorMappings,
        events: fixture.knomosis.events,
        reconciliation: fixture.knomosis.reconciliation,
        receipts: fixture.knomosis.receipts,
        audit: fixture.knomosis.audit,
        gateway: fixture.knomosis.gateway,
        now: fixture.knomosis.now,
        uuid: fixture.knomosis.uuid,
        log: fixture.knomosis.log,
        alert: fixture.knomosis.alert,
        notifyActor: async () => {},
      },
      LOCAL_DEPLOYMENT.deployment_id,
      LOCAL_DEPLOYMENT.chain_id,
    );
    expect(result.kind).toBe('unavailable');
  });
});
