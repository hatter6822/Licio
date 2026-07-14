// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M slice-5: the real-asset treasury, the reservation sub-ledger, the
// 13-state payment-intent lifecycle, three-source treasury reconciliation
// (zero-or-explained), and the accounting export.

import type { TreasuryBounds } from '@licio/governance';
import type { KnomosisSignedActionType, SubmissionState } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import { DEFAULT_KNOMOSIS_CONFIG } from '../knomosis/config.js';
import { KNOMOSIS_PIN } from '../knomosis/pin.js';
import { defaultCompliancePort, defaultRegionResolverPort } from '../knomosis/ports.js';
import {
  InMemoryGovernanceAuditStore,
  InMemoryGovernanceProposalStore,
  InMemoryKnomosisActionStore,
  InMemoryKnomosisReceiptStore,
  type KnomosisActionRecordEntity,
} from '../knomosis/stores.js';
import { buildAccountingExport } from '../treasury/export.js';
import { updateGrantMilestone } from '../treasury/grants.js';
import {
  attachIntentSubmission,
  createPaymentIntent,
  depositAllowance,
  expireIntents,
  type IntentDeps,
  markIntentSigned,
  preflightIntent,
  quoteIntent,
  reconcileIntents,
  retryIntent,
} from '../treasury/intents.js';
import { setGovernancePause } from '../treasury/profile.js';
import {
  categoryHeadroom,
  consumeReservation,
  releaseReservation,
  reserveForProposal,
} from '../treasury/reservations.js';
import {
  InMemoryGovernanceProfileStore,
  InMemoryGrantStore,
  InMemoryPaymentIntentStore,
  InMemoryReservationStore,
  InMemorySnapshotStore,
  InMemoryTreasuryStore,
  type PaymentIntentRecord,
} from '../treasury/stores.js';
import {
  createTreasury,
  platformOperatingAddresses,
  type TreasuryServiceDeps,
  treasuryDashboard,
} from '../treasury/treasury.js';
import {
  canExpandWsmTreasury,
  reconcileTreasury,
  type TreasuryReconciliationDeps,
} from '../treasury/treasury-reconciliation.js';

const ROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEPLOYMENT = KNOMOSIS_PIN.deployments[0]?.deployment_id ?? '';
const ADDRESS = `0x${'ab'.repeat(20)}`;

const LIMITS = {
  perUserPerPeriod: '1000',
  perRoomPerPeriod: '1500',
  perDepositMax: '600',
  periodSeconds: 86_400,
};

type TestDeps = TreasuryReconciliationDeps & TreasuryServiceDeps;

function buildDeps(): TestDeps & {
  alerts: string[];
  clockAdvance: (ms: number) => void;
} {
  let clock = Date.parse('2026-07-13T00:00:00.000Z');
  const alerts: string[] = [];
  const deps: TestDeps = {
    profiles: new InMemoryGovernanceProfileStore(),
    treasuries: new InMemoryTreasuryStore(),
    reservations: new InMemoryReservationStore(),
    intents: new InMemoryPaymentIntentStore(),
    grants: new InMemoryGrantStore(),
    actions: new InMemoryKnomosisActionStore(),
    receipts: new InMemoryKnomosisReceiptStore(),
    snapshots: new InMemorySnapshotStore(),
    governanceAudit: new InMemoryGovernanceAuditStore(),
    compliance: defaultCompliancePort,
    regionResolver: defaultRegionResolverPort,
    configStore: new InMemoryPwattConfigStore(),
    wsmConfig: () => DEFAULT_KNOMOSIS_CONFIG,
    reconciliationGraceMs: () => DEFAULT_KNOMOSIS_CONFIG.reconciliationIntervalMs,
    alert: (event) => {
      alerts.push(event);
    },
    now: () => {
      clock += 1;
      return clock;
    },
    uuid: () => crypto.randomUUID(),
  };
  return Object.assign(deps, {
    alerts,
    clockAdvance: (ms: number) => {
      clock += ms;
    },
  });
}

async function provisionTreasury(deps: TestDeps) {
  const created = await createTreasury(deps, {
    roomId: ROOM,
    deploymentId: DEPLOYMENT,
    treasuryAddress: ADDRESS,
    acceptedAssets: ['USDC'],
    depositLimits: LIMITS,
    actorUserId: USER,
  });
  if (!('treasury' in created)) throw new Error('treasury should provision');
  return created.treasury;
}

const bounds: TreasuryBounds = {
  caps: [{ category: 'grant', perActionMax: '400', perWindowMax: '1000', windowSeconds: 86_400 }],
  minIntervalSeconds: 0,
  timelockSeconds: 0,
  materialThreshold: '10000',
  requireCoiFor: [],
  investment: null,
};

describe('treasury provisioning (WS-M.2.1a/b)', () => {
  it('creates one treasury per room with a platform-disjoint address', async () => {
    const deps = buildDeps();
    const treasury = await provisionTreasury(deps);
    expect(treasury.treasuryAddress).toBe(ADDRESS);
    // Second treasury for the same room collides.
    expect(
      await createTreasury(deps, {
        roomId: ROOM,
        deploymentId: DEPLOYMENT,
        treasuryAddress: `0x${'cd'.repeat(20)}`,
        acceptedAssets: ['USDC'],
        depositLimits: LIMITS,
        actorUserId: USER,
      }),
    ).toMatchObject({ ok: false, code: 'treasury_exists' });
    // Address reuse across rooms collides too.
    expect(
      await createTreasury(deps, {
        roomId: OTHER,
        deploymentId: DEPLOYMENT,
        treasuryAddress: ADDRESS,
        acceptedAssets: ['USDC'],
        depositLimits: LIMITS,
        actorUserId: USER,
      }),
    ).toMatchObject({ ok: false, code: 'treasury_exists' });
  });

  it('rejects platform operating addresses (no commingling)', async () => {
    const deps = buildDeps();
    const platform = [...platformOperatingAddresses(DEPLOYMENT)][0];
    expect(platform).toBeDefined();
    expect(
      await createTreasury(deps, {
        roomId: ROOM,
        deploymentId: DEPLOYMENT,
        treasuryAddress: platform ?? '',
        acceptedAssets: ['USDC'],
        depositLimits: LIMITS,
        actorUserId: USER,
      }),
    ).toMatchObject({ ok: false, code: 'address_not_disjoint' });
  });

  it('rejects assets without validated precision', async () => {
    const deps = buildDeps();
    expect(
      await createTreasury(deps, {
        roomId: ROOM,
        deploymentId: DEPLOYMENT,
        treasuryAddress: ADDRESS,
        acceptedAssets: ['MYSTERYCOIN'],
        depositLimits: LIMITS,
        actorUserId: USER,
      }),
    ).toMatchObject({ ok: false, code: 'asset_unsupported' });
  });

  it('the dashboard serves reconciled balances + reservation headroom only', async () => {
    const deps = buildDeps();
    const treasury = await provisionTreasury(deps);
    await reserveForProposal(deps, {
      treasuryId: treasury.treasuryId,
      proposalId: crypto.randomUUID(),
      category: 'grant',
      asset: 'USDC',
      amount: '250',
      bounds,
    });
    const dashboard = await treasuryDashboard(deps, ROOM);
    expect(dashboard?.balances).toEqual([]); // nothing reconciled yet
    expect(dashboard?.reserved_by_category).toEqual({ grant: '250' });
    expect(dashboard?.reconciliation_state).toBe('pending');
  });
});

describe('reservation sub-ledger (WS-M.2.3a-1)', () => {
  it('headroom = cap − consumed − reserved, exact', async () => {
    const deps = buildDeps();
    const treasury = await provisionTreasury(deps);
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    await reserveForProposal(deps, {
      treasuryId: treasury.treasuryId,
      proposalId: p1,
      category: 'grant',
      asset: 'USDC',
      amount: '400',
      bounds,
    });
    await reserveForProposal(deps, {
      treasuryId: treasury.treasuryId,
      proposalId: p2,
      category: 'grant',
      asset: 'USDC',
      amount: '399',
      bounds,
    });
    let headroom = await categoryHeadroom(deps, treasury.treasuryId, 'grant', bounds);
    expect(headroom).toMatchObject({ reserved: '799', consumed: '0', headroom: '201' });
    await consumeReservation(deps, p1);
    headroom = await categoryHeadroom(deps, treasury.treasuryId, 'grant', bounds);
    expect(headroom).toMatchObject({ reserved: '399', consumed: '400', headroom: '201' });
    await releaseReservation(deps, p2);
    headroom = await categoryHeadroom(deps, treasury.treasuryId, 'grant', bounds);
    expect(headroom).toMatchObject({ reserved: '0', consumed: '400', headroom: '600' });
  });

  it('two proposals cannot jointly exceed the window cap (TOCTOU closed)', async () => {
    const deps = buildDeps();
    const treasury = await provisionTreasury(deps);
    expect(
      await reserveForProposal(deps, {
        treasuryId: treasury.treasuryId,
        proposalId: crypto.randomUUID(),
        category: 'grant',
        asset: 'USDC',
        amount: '400',
        bounds,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await reserveForProposal(deps, {
        treasuryId: treasury.treasuryId,
        proposalId: crypto.randomUUID(),
        category: 'grant',
        asset: 'USDC',
        amount: '400',
        bounds,
      }),
    ).toMatchObject({ ok: true });
    // Third 400 would make 1200 > 1000 window cap.
    expect(
      await reserveForProposal(deps, {
        treasuryId: treasury.treasuryId,
        proposalId: crypto.randomUUID(),
        category: 'grant',
        asset: 'USDC',
        amount: '400',
        bounds,
      }),
    ).toMatchObject({ ok: false, code: 'per_window_cap_exceeded' });
  });

  it('per-action cap, double-approval idempotency, and idempotent release', async () => {
    const deps = buildDeps();
    const treasury = await provisionTreasury(deps);
    expect(
      await reserveForProposal(deps, {
        treasuryId: treasury.treasuryId,
        proposalId: crypto.randomUUID(),
        category: 'grant',
        asset: 'USDC',
        amount: '401',
        bounds,
      }),
    ).toMatchObject({ ok: false, code: 'per_action_cap_exceeded' });
    const proposalId = crypto.randomUUID();
    const first = await reserveForProposal(deps, {
      treasuryId: treasury.treasuryId,
      proposalId,
      category: 'grant',
      asset: 'USDC',
      amount: '100',
      bounds,
    });
    const second = await reserveForProposal(deps, {
      treasuryId: treasury.treasuryId,
      proposalId,
      category: 'grant',
      asset: 'USDC',
      amount: '100',
      bounds,
    });
    if (!('reservation' in first) || !('reservation' in second)) throw new Error('expected ok');
    expect(second.reservation.reservationId).toBe(first.reservation.reservationId);
    expect(await releaseReservation(deps, proposalId)).toBe(true);
    expect(await releaseReservation(deps, proposalId)).toBe(true); // idempotent
  });
});

describe('payment-intent lifecycle (WS-M.3.1a-d)', () => {
  const create = (
    deps: IntentDeps,
    overrides: Partial<Parameters<typeof createPaymentIntent>[1]> = {},
  ) =>
    createPaymentIntent(deps, {
      userId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: ROOM,
      asset: 'USDC',
      amount: '100',
      idempotencyKey: crypto.randomUUID(),
      ...overrides,
    });

  it('creation is idempotent on (user, room, key) with no side effects on replay', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const key = crypto.randomUUID();
    const first = await create(deps, { idempotencyKey: key });
    const replay = await create(deps, { idempotencyKey: key });
    if (!('intent' in first) || !('intent' in replay)) throw new Error('expected intents');
    expect(replay.intent.paymentIntentId).toBe(first.intent.paymentIntentId);
    expect(replay.existing).toBe(true);
  });

  it('enforces the three deposit limits including in-flight aggregates', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    expect(await create(deps, { amount: '601' })).toMatchObject({
      ok: false,
      code: 'deposit_limit_exceeded',
    }); // per-deposit max
    expect(await create(deps, { amount: '600' })).toMatchObject({ ok: true });
    expect(await create(deps, { amount: '500' })).toMatchObject({
      ok: false,
      code: 'deposit_limit_exceeded',
    }); // user 600+500 > 1000
    expect(await create(deps, { amount: '400' })).toMatchObject({ ok: true }); // user at 1000
    // Other user hits the ROOM cap: 1000 in flight + 600 > 1500.
    expect(await create(deps, { userId: OTHER, amount: '600' })).toMatchObject({
      ok: false,
      code: 'deposit_limit_exceeded',
    });
    expect(await create(deps, { userId: OTHER, amount: '500' })).toMatchObject({ ok: true });
    const allowance = await depositAllowance(deps, ROOM, USER);
    expect(allowance).toMatchObject({ userRemaining: '0', roomRemaining: '0' });
  });

  it('the pause guard blocks creation before any side effect', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    await setGovernancePause(deps, {
      roomId: ROOM,
      patch: { deposits: true },
      reason: 'maintenance',
      actorUserId: USER,
    });
    expect(await create(deps)).toMatchObject({ ok: false, code: 'deposits_paused' });
  });

  it('walks the full lifecycle: preflight → quote → sign → submit → reconcile → finalize', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const created = await create(deps);
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    expect(created.intent.jurisdictionState).toBe('blocked'); // fail-closed default

    const preflighted = await preflightIntent(deps, id, USER);
    if (!('intent' in preflighted)) throw new Error(JSON.stringify(preflighted));
    // Local deployment: unknown jurisdiction records `restricted` and proceeds.
    expect(preflighted.intent.jurisdictionState).toBe('restricted');
    expect(preflighted.intent.complianceState).toBe('pending');

    const quoted = await quoteIntent(deps, id, USER);
    if (!('intent' in quoted)) throw new Error('expected quote');
    expect(quoted.intent.quoteRef).toMatchObject({ estimated_fee: '0' });

    const signed = await markIntentSigned(deps, id, USER);
    expect(signed).toMatchObject({ ok: true });

    // Simulate the WS-L submit path minting an action record.
    const treasuryId = created.intent.treasuryId;
    const actionRecordId = crypto.randomUUID();
    const action: KnomosisActionRecordEntity = {
      actionRecordId,
      deploymentId: DEPLOYMENT,
      actionType: 'treasury_deposit' as KnomosisSignedActionType,
      roomId: ROOM,
      actorWalletAccountId: crypto.randomUUID(),
      actorUserId: USER,
      payloadHash: `0x${'1'.repeat(64)}`,
      typedDataHash: `0x${'2'.repeat(64)}`,
      signedAction: { message: { amount: '100', asset: 'USDC', treasuryId }, signature: '0xsig' },
      submissionState: 'submitted' as SubmissionState,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await deps.actions.insert(action);
    const submitted = await attachIntentSubmission(deps, id, actionRecordId, USER);
    expect(submitted).toMatchObject({ ok: true });

    // The action settles, then finalizes with a public receipt.
    await deps.actions.update({ ...action, submissionState: 'settled' });
    await reconcileIntents(deps);
    expect((await deps.intents.getById(id))?.executionState).toBe('confirmed');

    await deps.actions.update({ ...action, submissionState: 'finalized' });
    await deps.receipts.upsert({
      receiptId: crypto.randomUUID(),
      actionRecordId,
      kind: 'public',
      payload: {},
      summaryPayloadHash: `0x${'3'.repeat(64)}`,
      ownerUserId: null,
      finalState: 'finalized',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await reconcileIntents(deps);
    const finalized = await deps.intents.getById(id);
    expect(finalized?.executionState).toBe('finalized');
    expect(finalized?.receiptId).not.toBeNull();
    const chain = await deps.governanceAudit.listChainedByRoom(ROOM);
    expect(chain.some((e) => e.actionType === 'deposit_recorded')).toBe(true);
  });

  it('maps failures and reverts; retries are bounded', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const created = await create(deps);
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    const treasuryId = created.intent.treasuryId;
    await preflightIntent(deps, id, USER);
    await quoteIntent(deps, id, USER);
    await markIntentSigned(deps, id, USER);
    const actionRecordId = crypto.randomUUID();
    await deps.actions.insert({
      actionRecordId,
      deploymentId: DEPLOYMENT,
      actionType: 'treasury_deposit' as KnomosisSignedActionType,
      roomId: ROOM,
      actorWalletAccountId: crypto.randomUUID(),
      actorUserId: USER,
      payloadHash: `0x${'1'.repeat(64)}`,
      typedDataHash: `0x${'2'.repeat(64)}`,
      signedAction: { message: { amount: '100', asset: 'USDC', treasuryId }, signature: '0xsig' },
      submissionState: 'failed' as SubmissionState,
      failureReason: 'gateway rejected',
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await attachIntentSubmission(deps, id, actionRecordId, USER);
    await reconcileIntents(deps);
    expect((await deps.intents.getById(id))?.executionState).toBe('failed');
    // Bounded retries (default 3): three succeed, the fourth refuses.
    for (let i = 0; i < 3; i += 1) {
      const retried = await retryIntent(deps, id, USER);
      expect(retried).toMatchObject({ ok: true });
      const back = await deps.intents.getById(id);
      expect(back?.executionState).toBe('created');
      // Drive it back to failed for the next loop.
      await preflightIntent(deps, id, USER);
      await quoteIntent(deps, id, USER);
      await markIntentSigned(deps, id, USER);
      await attachIntentSubmission(deps, id, actionRecordId, USER);
      await reconcileIntents(deps);
    }
    expect(await retryIntent(deps, id, USER)).toMatchObject({
      ok: false,
      code: 'retries_exhausted',
    });
  });

  it('expires timed states to abandoned on the sweep', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const created = await create(deps);
    if (!('intent' in created)) throw new Error('expected intent');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmIntentCreatedTtlMs + 1_000);
    expect(await expireIntents(deps)).toBe(1);
    expect((await deps.intents.getById(created.intent.paymentIntentId))?.executionState).toBe(
      'abandoned',
    );
  });
});

describe('treasury reconciliation (WS-M.5.2a) + export (WS-M.5.2b)', () => {
  /** Drive one deposit intent to `finalized`, with or without receipt/event. */
  async function finalizedDeposit(
    deps: TreasuryReconciliationDeps,
    opts: { amount: string; withReceipt: boolean; withEvent: boolean },
  ): Promise<PaymentIntentRecord> {
    const created = await createPaymentIntent(deps, {
      userId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: ROOM,
      asset: 'USDC',
      amount: opts.amount,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    const treasuryId = created.intent.treasuryId;
    await preflightIntent(deps, id, USER);
    await quoteIntent(deps, id, USER);
    await markIntentSigned(deps, id, USER);
    const actionRecordId = crypto.randomUUID();
    await deps.actions.insert({
      actionRecordId,
      deploymentId: DEPLOYMENT,
      actionType: 'treasury_deposit' as KnomosisSignedActionType,
      roomId: ROOM,
      actorWalletAccountId: crypto.randomUUID(),
      actorUserId: USER,
      payloadHash: `0x${'1'.repeat(64)}`,
      typedDataHash: `0x${'2'.repeat(64)}`,
      signedAction: {
        message: { amount: opts.amount, asset: 'USDC', treasuryId },
        signature: '0xsig',
      },
      submissionState: 'finalized' as SubmissionState,
      failureReason: null,
      indexedEventRef: opts.withEvent ? crypto.randomUUID() : null,
      reconciliationState: 'matched',
      idempotencyKey: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (opts.withReceipt) {
      await deps.receipts.upsert({
        receiptId: crypto.randomUUID(),
        actionRecordId,
        kind: 'public',
        payload: {},
        summaryPayloadHash: `0x${'3'.repeat(64)}`,
        ownerUserId: null,
        finalState: 'finalized',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    await attachIntentSubmission(deps, id, actionRecordId, USER);
    await reconcileIntents(deps);
    const intent = await deps.intents.getById(id);
    if (intent === null) throw new Error('intent lost');
    return intent;
  }

  it('fully-agreeing sources sync and republish the dashboard balance', async () => {
    const deps = buildDeps();
    const treasury = await provisionTreasury(deps);
    await finalizedDeposit(deps, { amount: '100', withReceipt: true, withEvent: true });
    await finalizedDeposit(deps, { amount: '50', withReceipt: true, withEvent: true });
    const snapshots = await reconcileTreasury(deps, treasury.treasuryId);
    const usdc = snapshots.find((s) => s.asset === 'USDC');
    expect(usdc).toMatchObject({ result: 'synced', gap: '0', productLedgerBalance: '150' });
    const dashboard = await treasuryDashboard(deps, ROOM);
    expect(dashboard?.balances).toEqual([{ asset: 'USDC', amount: '150' }]);
    expect(dashboard?.reconciliation_state).toBe('synced');
    expect((await canExpandWsmTreasury(deps, ROOM)).allowed).toBe(true);
  });

  it('a settlement-lag gap within the grace window is explained with the intent ids', async () => {
    const deps = buildDeps();
    const treasury = await provisionTreasury(deps);
    await finalizedDeposit(deps, { amount: '100', withReceipt: true, withEvent: true });
    // A RECENTLY finalized deposit whose receipt has not been written yet: the
    // receipts source lags the ledger by 40 — explainable settlement lag.
    const lagged = await finalizedDeposit(deps, {
      amount: '40',
      withReceipt: false,
      withEvent: true,
    });
    const snapshots = await reconcileTreasury(deps, treasury.treasuryId);
    const usdc = snapshots.find((s) => s.asset === 'USDC');
    expect(usdc?.result).toBe('explained');
    expect(usdc?.explanation).toMatchObject({ cause: 'settlement_lag' });
    const explanation = usdc?.explanation as { lagged_payment_intent_ids: string[] } | undefined;
    expect(explanation?.lagged_payment_intent_ids).toContain(lagged.paymentIntentId);
    // Explained keeps the treasury out of `synced` but does NOT block expansion.
    expect((await deps.treasuries.getByRoom(ROOM))?.reconciliationState).toBe('pending');
    expect((await canExpandWsmTreasury(deps, ROOM)).allowed).toBe(true);
  });

  it('an unexplained gap is divergent: alert + expansion block', async () => {
    const deps = buildDeps();
    const treasury = await provisionTreasury(deps);
    // Finalized with NO receipt and NO indexed event; once the grace window
    // passes with the linkage still missing, the gap has no explanation.
    await finalizedDeposit(deps, { amount: '100', withReceipt: false, withEvent: false });
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.reconciliationIntervalMs + 60_000);
    const snapshots = await reconcileTreasury(deps, treasury.treasuryId);
    expect(snapshots.find((s) => s.asset === 'USDC')?.result).toBe('divergent');
    expect(deps.alerts).toContain('wsm.treasury.reconciliation_divergent');
    const expansion = await canExpandWsmTreasury(deps, ROOM);
    expect(expansion.allowed).toBe(false);
  });

  it('the accounting export includes settled rows and excludes divergent assets', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    await finalizedDeposit(deps, { amount: '100', withReceipt: true, withEvent: true });
    const treasury = await deps.treasuries.getByRoom(ROOM);
    await reconcileTreasury(deps, treasury?.treasuryId ?? '');
    const result = await buildAccountingExport(deps, {
      roomId: ROOM,
      periodStartIso: '2026-07-01T00:00:00.000Z',
      periodEndIso: '2026-08-01T00:00:00.000Z',
    });
    if (!('export' in result)) throw new Error('expected export');
    expect(result.export.rows).toHaveLength(1);
    expect(result.export.rows[0]).toMatchObject({
      event_kind: 'deposit',
      asset: 'USDC',
      amount: '100',
      reconciliation_result: 'synced',
      usd_equivalent_at_event: null,
    });
    expect(result.export.excluded_unreconciled).toBe(0);
  });
});

describe('intent–action binding (PR #144 review: attach validation)', () => {
  let treasuryId = '';
  const actionOf = (
    over: Partial<KnomosisActionRecordEntity> = {},
  ): KnomosisActionRecordEntity => ({
    actionRecordId: crypto.randomUUID(),
    deploymentId: DEPLOYMENT,
    actionType: 'treasury_deposit' as KnomosisSignedActionType,
    roomId: ROOM,
    actorWalletAccountId: crypto.randomUUID(),
    actorUserId: USER,
    payloadHash: `0x${'1'.repeat(64)}`,
    typedDataHash: `0x${'2'.repeat(64)}`,
    signedAction: { message: { amount: '100', asset: 'USDC', treasuryId }, signature: '0xsig' },
    submissionState: 'submitted' as SubmissionState,
    failureReason: null,
    indexedEventRef: null,
    reconciliationState: 'pending',
    idempotencyKey: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  });

  async function signedIntent(deps: TestDeps): Promise<string> {
    await provisionTreasury(deps);
    const created = await createPaymentIntent(deps, {
      userId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: ROOM,
      asset: 'USDC',
      amount: '100',
      idempotencyKey: crypto.randomUUID(),
    });
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    treasuryId = created.intent.treasuryId;
    await preflightIntent(deps, id, USER);
    await quoteIntent(deps, id, USER);
    await markIntentSigned(deps, id, USER);
    return id;
  }

  it('rejects an action from another room, actor, type, or payload', async () => {
    const deps = buildDeps();
    const id = await signedIntent(deps);
    const cases: Array<Partial<KnomosisActionRecordEntity>> = [
      { roomId: crypto.randomUUID() }, // foreign room
      { actorUserId: OTHER }, // foreign actor
      { actionType: 'grant_payout' as KnomosisSignedActionType }, // wrong type
      {
        signedAction: { message: { amount: '999', asset: 'USDC', treasuryId }, signature: '0xsig' },
      },
      {
        signedAction: { message: { amount: '100', asset: 'DOGE', treasuryId }, signature: '0xsig' },
      },
      {
        // The signed TARGET is a different treasury: the P1 cross-intent
        // mirroring vector — amount/asset agree but the money goes elsewhere.
        signedAction: {
          message: { amount: '100', asset: 'USDC', treasuryId: crypto.randomUUID() },
          signature: '0xsig',
        },
      },
    ];
    for (const [index, over] of cases.entries()) {
      const action = actionOf(over);
      await deps.actions.insert(action);
      const outcome = await attachIntentSubmission(deps, id, action.actionRecordId, USER);
      if (!('code' in outcome)) throw new Error(`case ${index} unexpectedly attached`);
      expect(outcome.code).toBe('action_mismatch');
    }
    // The matching action still attaches.
    const good = actionOf();
    await deps.actions.insert(good);
    expect(await attachIntentSubmission(deps, id, good.actionRecordId, USER)).toMatchObject({
      ok: true,
    });
  });

  it('rejects an action record already settling another intent', async () => {
    const deps = buildDeps();
    const first = await signedIntent(deps);
    const second = await createPaymentIntent(deps, {
      userId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: ROOM,
      asset: 'USDC',
      amount: '100',
      idempotencyKey: crypto.randomUUID(),
    });
    if (!('intent' in second)) throw new Error('expected intent');
    const secondId = second.intent.paymentIntentId;
    await preflightIntent(deps, secondId, USER);
    await quoteIntent(deps, secondId, USER);
    await markIntentSigned(deps, secondId, USER);
    const action = actionOf();
    await deps.actions.insert(action);
    expect(await attachIntentSubmission(deps, first, action.actionRecordId, USER)).toMatchObject({
      ok: true,
    });
    // The SAME on-chain action cannot settle a second intent — that would
    // double-count one transfer in balances and the accounting export.
    const reused = await attachIntentSubmission(deps, secondId, action.actionRecordId, USER);
    if (!('code' in reused)) throw new Error('unexpectedly attached');
    expect(reused.code).toBe('action_in_use');
  });
});

describe('grant payout finality (PR #144 review: paid ⇐ reconciliation only)', () => {
  it('stays scheduled until the payout intent finalizes, then pays', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const treasury = await deps.treasuries.getByRoom(ROOM);
    if (treasury === null) throw new Error('fixture treasury missing');
    const milestoneId = crypto.randomUUID();
    const inserted = await deps.grants.insert({
      grantId: crypto.randomUUID(),
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId: crypto.randomUUID(),
      recipientRef: 'coop',
      purpose: 'Finality fixture',
      amount: '100',
      asset: 'USDC',
      milestones: [
        {
          milestoneId,
          description: 'All',
          amount: '100',
          state: 'submitted',
          paymentIntentId: null,
        },
      ],
      milestoneState: 'submitted',
      reviewState: 'cleared',
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    if (inserted === null) throw new Error('fixture grant collision');

    // Acceptance schedules the payout intent — the grant is SCHEDULED, not paid.
    const grantDeps = { ...deps, proposals: new InMemoryGovernanceProposalStore() };
    const accepted = await updateGrantMilestone(grantDeps, {
      roomId: ROOM,
      grantId: inserted.grantId,
      milestoneId,
      state: 'accepted',
      actorUserId: USER,
    });
    if ('code' in accepted) throw new Error(accepted.message);
    expect(accepted.grant.payoutState).toBe('scheduled');
    const intentId = accepted.grant.milestones[0]?.paymentIntentId;
    if (intentId == null) throw new Error('payout intent missing');

    // Walk the payout intent to on-chain finality via the reconcile sweep.
    await preflightIntent(deps, intentId, USER);
    await quoteIntent(deps, intentId, USER);
    await markIntentSigned(deps, intentId, USER);
    const action: KnomosisActionRecordEntity = {
      actionRecordId: crypto.randomUUID(),
      deploymentId: DEPLOYMENT,
      actionType: 'grant_payout' as KnomosisSignedActionType,
      roomId: ROOM,
      actorWalletAccountId: crypto.randomUUID(),
      actorUserId: USER,
      payloadHash: `0x${'1'.repeat(64)}`,
      typedDataHash: `0x${'2'.repeat(64)}`,
      signedAction: {
        message: { amount: '100', asset: 'USDC', grantId: inserted.grantId },
        signature: '0xsig',
      },
      submissionState: 'finalized' as SubmissionState,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'matched',
      idempotencyKey: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await deps.actions.insert(action);
    const attached = await attachIntentSubmission(deps, intentId, action.actionRecordId, USER);
    expect(attached).toMatchObject({ ok: true });
    await reconcileIntents(deps);
    expect((await deps.intents.getById(intentId))?.executionState).toBe('finalized');
    // Reconciliation — not scheduling — declares the grant paid.
    expect((await deps.grants.getById(inserted.grantId))?.payoutState).toBe('paid');
  });
});
