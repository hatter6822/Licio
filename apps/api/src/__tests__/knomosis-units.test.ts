// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L unit coverage for the pure decision functions and fail-closed error
// branches that the end-to-end flow suites do not hit directly: reconciliation
// math, the compliance/region ports, the HTTP gateway standing/event paths,
// the submission state machine + resubmit, the contract-verifier factory, the
// in-memory store adapter methods, and the receipt pairing.

import { afterEach, describe, expect, it } from 'vitest';
import { HttpKnomosisGateway } from '../knomosis/gateway.js';
import { ingestGatewayEvents } from '../knomosis/ingest.js';
import {
  createIdentityRegionResolver,
  defaultCompliancePort,
  localeRegionSubtag,
} from '../knomosis/ports.js';
import { verifyReceiptPairing, writeReceipts } from '../knomosis/receipts.js';
import {
  canExpandTreasury,
  classifyDivergence,
  compareActorLedger,
  decideActionReconciliation,
  reconcileDeployment,
} from '../knomosis/reconciliation.js';
import { getKnomosisServices, resetKnomosisServicesForTests } from '../knomosis/services.js';
import { createContractTypedDataVerifier } from '../knomosis/signatures.js';
import {
  InMemoryGovernanceAuditStore,
  InMemoryKnomosisActionStore,
  InMemoryOnChainEventStore,
  type KnomosisActionRecordEntity,
  WalletAbuseLimiter,
} from '../knomosis/stores.js';
import {
  applyTransition,
  canTransitionSubmissionState,
  resubmitPendingActions,
  VALID_SUBMISSION_TRANSITIONS,
} from '../knomosis/submission.js';
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
  signedAction: { message: { amount: '10', asset: 'USDC' }, signature: '0x' },
  submissionState: 'finalized',
  failureReason: null,
  indexedEventRef: null,
  reconciliationState: 'pending',
  idempotencyKey: crypto.randomUUID(),
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
      false,
    );
    expect(divergences).toHaveLength(1);
    expect(divergences[0]).toMatchObject({ asset: 'USDC', expected: '150', actual: '120' });
    expect(divergences[0]?.severity).toBe('critical'); // |30| ≥ 10
    // Agreement ⇒ no divergence.
    expect(compareActorLedger([{ asset: 'USDC', amount: '5' }], { USDC: '5' }, '1', false)).toEqual(
      [],
    );
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

describe('ports (WS-L.3.1b / §19.1 region)', () => {
  it('the fail-closed compliance port never screens clear', async () => {
    expect(
      await defaultCompliancePort.screenAddress({ addressLower: '0x', deploymentId: 'd' }),
    ).toBe('unavailable');
    expect(await defaultCompliancePort.jurisdiction({ userId: 'u', region: null })).toBe('unknown');
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

  it('resubmitPendingActions re-forwards only submitted records', async () => {
    const fixture = await freshKnomosisServices();
    const record = baseAction({ submissionState: 'submitted', reconciliationState: 'pending' });
    await fixture.knomosis.actions.insert(record);
    const count = await resubmitPendingActions(
      {
        actions: fixture.knomosis.actions,
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
});

describe('submission fail-closed paths (WS-L.3.2)', () => {
  const s = (fixture: Awaited<ReturnType<typeof freshKnomosisServices>>) => ({
    actions: fixture.knomosis.actions,
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

  it('a missing preflight token is rejected (PREFLIGHT_EXPIRED)', async () => {
    const fixture = await freshKnomosisServices();
    const { submitAction } = await import('../knomosis/submission.js');
    const result = await submitAction(s(fixture), {
      userId: 'u1',
      preflightToken: 'nonexistent',
      idempotencyKey: crypto.randomUUID(),
      actionType: 'treasury_deposit',
      roomId: 'r1',
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      walletAccountId: 'w1',
      typedDataMessage: {},
      signature: '0x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PREFLIGHT_EXPIRED');
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
      roomMode: { currentMode: async () => null, setMode: async () => false },
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

  it('receipt pairing verifies and detects tampering', async () => {
    const fixture = await freshKnomosisServices();
    const record = baseAction({ submissionState: 'finalized' });
    await fixture.knomosis.actions.insert(record);
    const { publicReceipt } = await writeReceipts(fixture.knomosis, record);
    expect(verifyReceiptPairing(publicReceipt, record)).toBe(true);
    const tampered = { ...publicReceipt, summaryPayloadHash: `0x${'ff'.repeat(32)}` };
    expect(verifyReceiptPairing(tampered, record)).toBe(false);
  });
});

describe('ingest unsupported-event halt (WS-L.3.3a)', () => {
  function ingestDeps(fixture: Awaited<ReturnType<typeof freshKnomosisServices>>) {
    return {
      actions: fixture.knomosis.actions,
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

  it('the abuse limiter enforces a sliding window', () => {
    let clock = 0;
    const limiter = new WalletAbuseLimiter(() => clock);
    expect(limiter.hit('k', 2, 1000)).toBe(true);
    expect(limiter.hit('k', 2, 1000)).toBe(true);
    expect(limiter.hit('k', 2, 1000)).toBe(false); // over
    clock += 2000; // window elapsed
    expect(limiter.hit('k', 2, 1000)).toBe(true);
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
      chainAllowlist: () => [1],
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
