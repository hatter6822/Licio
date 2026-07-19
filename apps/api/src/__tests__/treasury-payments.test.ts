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
import { activateKillSwitch } from '../knomosis/killswitch.js';
import { KNOMOSIS_PIN } from '../knomosis/pin.js';
import { defaultCompliancePort, defaultRegionResolverPort } from '../knomosis/ports.js';
import {
  InMemoryFinancialWalletStore,
  InMemoryGovernanceAuditStore,
  InMemoryGovernanceProposalStore,
  InMemoryKnomosisActionStore,
  InMemoryKnomosisReceiptStore,
  type KnomosisActionRecordEntity,
} from '../knomosis/stores.js';
import { buildAccountingExport } from '../treasury/export.js';
import { updateGrantMilestone } from '../treasury/grants.js';
import {
  abandonExpiredReorgs,
  abandonOpenIntent,
  attachIntentSubmission,
  createPaymentIntent,
  depositAllowance,
  disputeIntent,
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
    wallets: new InMemoryFinancialWalletStore(),
    masterSecret: 'test-master-secret',
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
      actorUserId: USER,
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

  it('a preflight retry on an already-preflighted intent replays without re-reserving velocity (thread-K)', async () => {
    const deps = buildDeps();
    let fraudCalls = 0;
    deps.compliance = {
      ...defaultCompliancePort,
      fraudRisk: async (input) => {
        fraudCalls += 1;
        return defaultCompliancePort.fraudRisk(input);
      },
    };
    await provisionTreasury(deps);
    const created = await create(deps);
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    const first = await preflightIntent(deps, id, USER);
    expect('intent' in first && first.intent.executionState).toBe('preflighted');
    expect(fraudCalls).toBe(1);
    // A lost-response retry REPLAYS the preflighted intent — no second reserve.
    const retry = await preflightIntent(deps, id, USER);
    expect('intent' in retry && retry.intent.executionState).toBe('preflighted');
    expect(fraudCalls).toBe(1);
    // A preflight on an intent already ADVANCED past preflighted is refused with
    // NO velocity burn (the state guard runs before the mutable checks).
    await quoteIntent(deps, id, USER);
    const stale = await preflightIntent(deps, id, USER);
    expect('code' in stale && stale.code).toBe('invalid_transition');
    expect(fraudCalls).toBe(1);
  });

  it('quote and sign are idempotent on a lost-response retry; out-of-order steps still 409 (audit: lifecycle-idempotency)', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const created = await create(deps);
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    await preflightIntent(deps, id, USER);

    // A sign BEFORE quote (skipping the quoted state) is a genuine invalid
    // transition, not a replay — refused.
    const early = await markIntentSigned(deps, id, USER);
    expect('code' in early && early.code).toBe('invalid_transition');

    const quoted = await quoteIntent(deps, id, USER);
    if (!('intent' in quoted)) throw new Error('expected quote');
    const firstQuoteRef = quoted.intent.quoteRef;
    // A lost-response retry of quote REPLAYS the quoted intent, returning the
    // recorded quoteRef UNCHANGED — a re-quote must not overwrite the fee/time.
    const requote = await quoteIntent(deps, id, USER);
    expect('intent' in requote && requote.intent.executionState).toBe('quoted');
    expect('intent' in requote && requote.intent.quoteRef).toEqual(firstQuoteRef);

    const signed = await markIntentSigned(deps, id, USER);
    expect('intent' in signed && signed.intent.executionState).toBe('signed');
    // A lost-response retry of sign REPLAYS the signed intent (no wasted
    // signature, no forced re-quote/re-sign).
    const resign = await markIntentSigned(deps, id, USER);
    expect('intent' in resign && resign.intent.executionState).toBe('signed');
    // …and a quote on an already-signed intent (out of order) still 409s.
    const staleQuote = await quoteIntent(deps, id, USER);
    expect('code' in staleQuote && staleQuote.code).toBe('invalid_transition');
  });

  it('listByComplianceState returns LIVE flagged intents only, never terminal ones (thread-O)', async () => {
    const store = new InMemoryPaymentIntentStore();
    const base = {
      userId: USER,
      roomId: ROOM,
      treasuryId: crypto.randomUUID(),
      targetType: 'treasury_deposit' as const,
      targetId: ROOM,
      asset: 'USDC',
      amount: '100',
      jurisdictionState: 'allowed' as const,
      complianceState: 'flagged' as const,
      retryCount: 0,
      quoteRef: null,
      actionRecordId: null,
      receiptId: null,
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const liveId = crypto.randomUUID();
    await store.insert({
      ...base,
      paymentIntentId: liveId,
      executionState: 'preflighted',
      idempotencyKey: crypto.randomUUID(),
    });
    const deadId = crypto.randomUUID();
    // A fraud-held intent that expired to a TERMINAL state (complianceState still
    // `flagged`) must not ride the fraud queue.
    await store.insert({
      ...base,
      paymentIntentId: deadId,
      executionState: 'abandoned',
      idempotencyKey: crypto.randomUUID(),
    });
    const listed = await store.listByComplianceState('flagged', 200);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.executionState).toBe('preflighted');
    expect(listed.some((i) => i.paymentIntentId === deadId)).toBe(false);
    // updateComplianceState CASes on a LIVE execution state too (thread-U): a
    // release/reject cannot flip a terminal intent's compliance column, closing
    // the TOCTOU between the release endpoint's pre-check and this write.
    const now = new Date().toISOString();
    expect(await store.updateComplianceState(liveId, 'flagged', 'cleared', now)).not.toBeNull();
    expect(await store.updateComplianceState(deadId, 'flagged', 'cleared', now)).toBeNull();
  });

  it('deleteIfUntouched removes ONLY the still-created, unbound insert (codex: delete only unobserved overshoot)', async () => {
    const store = new InMemoryPaymentIntentStore();
    const base = {
      userId: USER,
      roomId: ROOM,
      treasuryId: crypto.randomUUID(),
      targetType: 'treasury_deposit' as const,
      targetId: ROOM,
      asset: 'USDC',
      amount: '100',
      jurisdictionState: 'allowed' as const,
      complianceState: 'pending' as const,
      retryCount: 0,
      quoteRef: null,
      actionRecordId: null,
      receiptId: null,
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // An untouched `created` insert IS rolled back.
    const a = crypto.randomUUID();
    await store.insert({
      ...base,
      paymentIntentId: a,
      executionState: 'created',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await store.deleteIfUntouched(a)).toBe(true);
    expect(await store.getById(a)).toBeNull();
    // A row a concurrent replay ADVANCED (preflighted) is NOT yanked.
    const b = crypto.randomUUID();
    await store.insert({
      ...base,
      paymentIntentId: b,
      executionState: 'preflighted',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await store.deleteIfUntouched(b)).toBe(false);
    expect(await store.getById(b)).not.toBeNull();
    // A `created` row that already bound an action is NOT deleted either.
    const c = crypto.randomUUID();
    await store.insert({
      ...base,
      paymentIntentId: c,
      executionState: 'created',
      actionRecordId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await store.deleteIfUntouched(c)).toBe(false);
    expect(await store.getById(c)).not.toBeNull();
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
    const allowance = await depositAllowance(deps, ROOM, USER, 'USDC');
    expect(allowance).toMatchObject({ userRemaining: '0', roomRemaining: '0' });
  });

  it('deposit limits are PER-ASSET — a full USDC window does not exhaust the DAI allowance (codex: separate deposit limits by asset)', async () => {
    const deps = buildDeps();
    const created = await createTreasury(deps, {
      roomId: ROOM,
      deploymentId: DEPLOYMENT,
      treasuryAddress: ADDRESS,
      acceptedAssets: ['USDC', 'SIM-USDC'],
      depositLimits: LIMITS,
      actorUserId: USER,
    });
    if (!('treasury' in created)) throw new Error('treasury should provision');
    // Fill the USER's USDC window (perUserPerPeriod 1000, perDepositMax 600).
    expect(await create(deps, { asset: 'USDC', amount: '600' })).toMatchObject({ ok: true });
    expect(await create(deps, { asset: 'USDC', amount: '400' })).toMatchObject({ ok: true });
    expect(await create(deps, { asset: 'USDC', amount: '1' })).toMatchObject({
      ok: false,
      code: 'deposit_limit_exceeded',
    });
    // SIM-USDC has its OWN window: summing minor units across assets is
    // meaningless, so it is NOT blocked by the (full) USDC window…
    expect(await create(deps, { asset: 'SIM-USDC', amount: '600' })).toMatchObject({ ok: true });
    // …and it enforces its own cap independently (600 + 500 > 1000).
    expect(await create(deps, { asset: 'SIM-USDC', amount: '500' })).toMatchObject({
      ok: false,
      code: 'deposit_limit_exceeded',
    });
  });

  it('a retry that loses the post-transition allowance re-check is abandoned via the AUDITED transition (codex: audit abandoned retry transitions)', async () => {
    const deps = buildDeps();
    const treasury = await provisionTreasury(deps);
    // Recent timestamps so the rows fall inside the deposit period window.
    const nowIso = new Date(deps.now()).toISOString();
    const row = (over: Partial<PaymentIntentRecord>): PaymentIntentRecord => ({
      paymentIntentId: crypto.randomUUID(),
      userId: USER,
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      targetType: 'treasury_deposit',
      targetId: ROOM,
      asset: 'USDC',
      amount: '500',
      executionState: 'created',
      jurisdictionState: 'allowed',
      complianceState: 'cleared',
      retryCount: 0,
      quoteRef: null,
      actionRecordId: null,
      receiptId: null,
      expiresAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
      idempotencyKey: crypto.randomUUID(),
      ...over,
    });
    // A FAILED deposit (amount 500) eligible to retry.  The pre-check passes
    // (nothing else in flight), but a CONCURRENT 1000 deposit lands between the
    // pre- and post-check (injected on the 2nd period read), so the re-included
    // retry overshoots and is abandoned.
    const failedId = crypto.randomUUID();
    await deps.intents.insert(row({ paymentIntentId: failedId, executionState: 'failed' }));
    const realList = deps.intents.listDepositsInPeriod.bind(deps.intents);
    let calls = 0;
    const concurrent = row({ executionState: 'created', amount: '1000' });
    deps.intents.listDepositsInPeriod = async (roomId, sinceIso) => {
      calls += 1;
      const rows = await realList(roomId, sinceIso);
      return calls >= 2 ? [...rows, concurrent] : rows;
    };
    const retried = await retryIntent(deps, failedId, USER);
    expect(retried).toMatchObject({ ok: false, code: 'deposit_limit_exceeded' });
    expect((await deps.intents.getById(failedId))?.executionState).toBe('abandoned');
    // The abandonment is AUDITED, not a silent direct write: the retry records
    // TWO chained transitions — failed→created AND created→abandoned.  A raw
    // `intents.transition` for the abandonment (the bug) would have recorded only
    // the first, leaving the retry visibly created then silently abandoned.
    const chain = await deps.governanceAudit.listChainedByRoom(ROOM);
    expect(chain.filter((e) => e.actionType === 'payment_intent_transition')).toHaveLength(2);
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
      paymentIntentId: null,
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
    // Each attempt binds a FRESH live action that then fails at the gateway —
    // a terminal action can never be (re)attached (W14), matching the real
    // sign→submit→attach→ingest flow.
    const failAttempt = async () => {
      const action: KnomosisActionRecordEntity = {
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
        paymentIntentId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await deps.actions.insert(action);
      const attached = await attachIntentSubmission(deps, id, action.actionRecordId, USER);
      expect(attached).toMatchObject({ ok: true });
      await deps.actions.update({
        ...action,
        submissionState: 'failed' as SubmissionState,
        failureReason: 'gateway rejected',
      });
      await reconcileIntents(deps);
    };
    await failAttempt();
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
      await failAttempt();
    }
    expect(await retryIntent(deps, id, USER)).toMatchObject({
      ok: false,
      code: 'retries_exhausted',
    });
  });

  // Drive a fresh deposit intent to `confirmed` (settled action attached).
  async function driveToConfirmed(
    deps: TestDeps,
  ): Promise<{ id: string; action: KnomosisActionRecordEntity }> {
    await provisionTreasury(deps);
    const created = await create(deps);
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    const treasuryId = created.intent.treasuryId;
    await preflightIntent(deps, id, USER);
    await quoteIntent(deps, id, USER);
    await markIntentSigned(deps, id, USER);
    const action: KnomosisActionRecordEntity = {
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
      paymentIntentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await deps.actions.insert(action);
    await attachIntentSubmission(deps, id, action.actionRecordId, USER);
    await deps.actions.update({ ...action, submissionState: 'settled' });
    await reconcileIntents(deps);
    expect((await deps.intents.getById(id))?.executionState).toBe('confirmed');
    return { id, action };
  }

  // …then revert its action so reconcile moves it to `reorged`.
  async function driveToReorged(
    deps: TestDeps,
  ): Promise<{ id: string; action: KnomosisActionRecordEntity }> {
    const { id, action } = await driveToConfirmed(deps);
    await deps.actions.update({ ...action, submissionState: 'reverted' });
    await reconcileIntents(deps);
    expect((await deps.intents.getById(id))?.executionState).toBe('reorged');
    return { id, action };
  }

  // …or finalize it (with a public receipt) so reconcile reaches `finalized`.
  async function driveToFinalized(deps: TestDeps): Promise<string> {
    const { id, action } = await driveToConfirmed(deps);
    await deps.actions.update({ ...action, submissionState: 'finalized' });
    await deps.receipts.upsert({
      receiptId: crypto.randomUUID(),
      actionRecordId: action.actionRecordId,
      kind: 'public',
      payload: {},
      summaryPayloadHash: `0x${'3'.repeat(64)}`,
      ownerUserId: null,
      finalState: 'finalized',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await reconcileIntents(deps);
    expect((await deps.intents.getById(id))?.executionState).toBe('finalized');
    return id;
  }

  it('recovers a reorged intent when its action re-confirms (WS-M.3.1d)', async () => {
    const deps = buildDeps();
    const { id, action } = await driveToReorged(deps);
    // The transaction re-confirms on the canonical chain → reconcile recovers it.
    await deps.actions.update({ ...action, submissionState: 'settled' });
    await reconcileIntents(deps);
    expect((await deps.intents.getById(id))?.executionState).toBe('confirmed');
  });

  it('abandons a reorged intent after the recovery window while still reverted (WS-M.3.1d)', async () => {
    const deps = buildDeps();
    const { id } = await driveToReorged(deps);
    // Inside the grace window: NOT abandoned.
    expect(await abandonExpiredReorgs(deps)).toBe(0);
    expect((await deps.intents.getById(id))?.executionState).toBe('reorged');
    // Past the window with the action still reverted: abandoned for a clean trail.
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmIntentReorgRecoveryMs + 1_000);
    expect(await abandonExpiredReorgs(deps)).toBe(1);
    expect((await deps.intents.getById(id))?.executionState).toBe('abandoned');
  });

  it('disputes a finalized intent → disputed, recording the transition on-chain (WS-M.4.3d)', async () => {
    const deps = buildDeps();
    const id = await driveToFinalized(deps);
    const result = await disputeIntent(deps, id, USER);
    expect(result).toMatchObject({ ok: true });
    expect((await deps.intents.getById(id))?.executionState).toBe('disputed');
    const chain = await deps.governanceAudit.listChainedByRoom(ROOM);
    expect(
      chain.some(
        (e) =>
          e.actionType === 'payment_intent_transition' &&
          (e.actionDetails as { to?: string } | null | undefined)?.to === 'disputed',
      ),
    ).toBe(true);
  });

  it('refuses to dispute a non-finalized intent', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const created = await create(deps);
    if (!('intent' in created)) throw new Error('expected intent');
    // A freshly-created (not finalized) intent cannot be disputed.
    expect(await disputeIntent(deps, created.intent.paymentIntentId, USER)).toMatchObject({
      ok: false,
      code: 'not_disputable',
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

  it('the expiry sweep DRAINS the backlog across pages, not just the first (audit: paged-sweep-not-fully-drained)', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const ids: string[] = [];
    // Five timed intents (5 × 100 = 500, under the 1000 user / 1500 room caps).
    for (let i = 0; i < 5; i += 1) {
      const c = await create(deps, { amount: '100' });
      if (!('intent' in c)) throw new Error('expected intent');
      ids.push(c.intent.paymentIntentId);
    }
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmIntentCreatedTtlMs + 1_000);
    // A page size of 2 would abandon only 2 with a single-page sweep; the drain
    // loop clears all 5 in one call (each round re-reads the head after the
    // prior round's rows dropped out of the expired set).
    expect(await expireIntents(deps, 2)).toBe(5);
    for (const id of ids) {
      expect((await deps.intents.getById(id))?.executionState).toBe('abandoned');
    }
  });

  it('the expiry drain loop STOPS on a page of un-abandonable signed rows (no infinite spin)', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const created = await create(deps, { amount: '100' });
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    const treasuryId = created.intent.treasuryId;
    await preflightIntent(deps, id, USER);
    await quoteIntent(deps, id, USER);
    await markIntentSigned(deps, id, USER);
    // Bind a LIVE action (money in motion) so orphanActionFor makes the signed
    // intent un-abandonable — the reconcile sweep will attach it, the reaper
    // must not touch it.
    await deps.actions.insert({
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
      paymentIntentId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmIntentSignedTtlMs + 1_000);
    // The lone un-abandonable row is skipped (the cursor pages past it); with no
    // rows behind it the next page is empty and the sweep ends — nothing reaped.
    expect(await expireIntents(deps, 1)).toBe(0);
    expect((await deps.intents.getById(id))?.executionState).toBe('signed');
  });

  it('the expiry drain PAGES PAST an un-abandonable signed orphan to reap rows behind it (codex: continue expiring)', async () => {
    const deps = buildDeps();
    const treasury = await provisionTreasury(deps);
    const past = '2020-01-01T00:00:00.000Z';
    const baseRow = {
      userId: USER,
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      targetType: 'treasury_deposit' as const,
      targetId: ROOM,
      asset: 'USDC',
      amount: '100',
      jurisdictionState: 'allowed' as const,
      complianceState: 'pending' as const,
      retryCount: 0,
      quoteRef: null,
      actionRecordId: null,
      receiptId: null,
      expiresAt: past,
      createdAt: past,
      updatedAt: past,
    };
    // A SIGNED orphan that sorts FIRST by id — an action on chain makes it
    // un-abandonable (the next reconcile attaches it).
    const signedId = '00000000-0000-4000-8000-000000000001';
    await deps.intents.insert({
      ...baseRow,
      paymentIntentId: signedId,
      executionState: 'signed',
      idempotencyKey: crypto.randomUUID(),
    });
    await deps.actions.insert({
      actionRecordId: crypto.randomUUID(),
      deploymentId: DEPLOYMENT,
      actionType: 'treasury_deposit' as KnomosisSignedActionType,
      roomId: ROOM,
      actorWalletAccountId: crypto.randomUUID(),
      actorUserId: USER,
      payloadHash: `0x${'1'.repeat(64)}`,
      typedDataHash: `0x${'2'.repeat(64)}`,
      signedAction: {
        message: { amount: '100', asset: 'USDC', treasuryId: treasury.treasuryId },
        signature: '0xsig',
      },
      submissionState: 'submitted' as SubmissionState,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: signedId,
      createdAt: past,
      updatedAt: past,
    });
    // A CREATED intent that sorts AFTER it — abandonable, but BEHIND the orphan.
    const createdId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await deps.intents.insert({
      ...baseRow,
      paymentIntentId: createdId,
      executionState: 'created',
      idempotencyKey: crypto.randomUUID(),
    });
    // With page size 1, a no-progress break would STOP at the signed orphan and
    // never reach the created row behind it; the keyset cursor pages past it.
    expect(await expireIntents(deps, 1)).toBe(1);
    expect((await deps.intents.getById(createdId))?.executionState).toBe('abandoned');
    expect((await deps.intents.getById(signedId))?.executionState).toBe('signed'); // untouched
  });

  it('a room-owned payout intent scopes the regional kill switch to the ACTING STEWARD, not null (codex: resolve room-owned pauses from the actor)', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const STEWARD_FR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const STEWARD_DE = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd0';
    // A DE incident pause on room-owned payout INTENT CREATION.
    const activated = await activateKillSwitch(
      {
        configStore: deps.configStore,
        audit: { append: async () => {} } as never,
        now: deps.now,
        log: () => {},
      },
      {
        switchId: 'payment_intent_creation',
        scopes: { global: false, regions: ['DE'], room_ids: [] },
        releaseCard: {
          owner: 'sec',
          trigger_condition: 'incident',
          rollback_path: 'runbook',
          review_date: '2026-07-13T00:00:00.000Z',
        },
        actorUserId: STEWARD_DE,
        reason: 'jurisdiction',
      },
    );
    expect(activated.ok).toBe(true);
    const payout = (actor: string) =>
      createPaymentIntent(deps, {
        userId: null, // room-owned: the region must come from the ACTOR, not null
        actorUserId: actor,
        roomId: ROOM,
        targetType: 'grant_payout',
        targetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        asset: 'USDC',
        amount: '100',
        idempotencyKey: crypto.randomUUID(),
      });

    // A steward in FR: before the fix the null owner resolved region=null, which
    // matches EVERY regional scope, so the DE pause wrongly blocked this payout.
    deps.regionResolver = { regionForUser: async (uid) => (uid === STEWARD_FR ? 'FR' : null) };
    expect('intent' in (await payout(STEWARD_FR))).toBe(true);

    // Control: a steward whose region IS the paused DE is still blocked.
    deps.regionResolver = { regionForUser: async (uid) => (uid === STEWARD_DE ? 'DE' : null) };
    const blocked = await payout(STEWARD_DE);
    expect('code' in blocked && blocked.code).toBe('kill_switch_active');
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
      actorUserId: USER,
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
      paymentIntentId: null,
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
    // A RECENTLY finalized deposit whose INDEXED EVENT has not landed yet: the
    // observed source lags the ledger by 40 — explainable settlement lag.
    // (A missing RECEIPT can no longer reach finality at all: the sweep holds
    // the intent at `confirmed` until the receipt row is visible.)
    const lagged = await finalizedDeposit(deps, {
      amount: '40',
      withReceipt: true,
      withEvent: false,
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
    // Finalized whose indexed event NEVER lands; once the grace window passes
    // with the linkage still missing, the gap has no explanation.
    await finalizedDeposit(deps, { amount: '100', withReceipt: true, withEvent: false });
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

  it('a zero NET gap with persistent missing linkage is divergent, not synced (W5 review)', async () => {
    const deps = buildDeps();
    const treasury = await provisionTreasury(deps);
    // A deposit and a payout that OFFSET to zero — both finalized long ago
    // with receipts but no indexed event ever landing.  The arithmetic gap is
    // 0, the audit trail is not.
    const staleIso = new Date(Date.parse('2026-07-13T00:00:00.000Z') - 86_400_000).toISOString();
    const mkAction = async (): Promise<string> => {
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
        signedAction: { message: {}, signature: '0xsig' },
        submissionState: 'finalized' as SubmissionState,
        failureReason: null,
        indexedEventRef: null, // the event linkage NEVER landed
        reconciliationState: 'pending',
        idempotencyKey: crypto.randomUUID(),
        paymentIntentId: null,
        createdAt: staleIso,
        updatedAt: staleIso,
      });
      return actionRecordId;
    };
    const mkIntent = async (targetType: 'treasury_deposit' | 'grant_payout'): Promise<void> => {
      await deps.intents.insert({
        paymentIntentId: crypto.randomUUID(),
        userId: USER,
        roomId: ROOM,
        treasuryId: treasury.treasuryId,
        targetType,
        targetId: treasury.treasuryId,
        asset: 'USDC',
        amount: '100',
        jurisdictionState: 'allowed',
        complianceState: 'cleared',
        executionState: 'finalized',
        retryCount: 0,
        quoteRef: null,
        actionRecordId: await mkAction(),
        receiptId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        expiresAt: staleIso,
        createdAt: staleIso,
        updatedAt: staleIso,
      });
    };
    await mkIntent('treasury_deposit');
    await mkIntent('grant_payout');
    const snapshots = await reconcileTreasury(deps, treasury.treasuryId);
    const usdc = snapshots.find((s) => s.asset === 'USDC');
    expect(usdc?.gap).toBe('0');
    expect(usdc?.result).toBe('divergent');
    expect((await deps.treasuries.getById(treasury.treasuryId))?.reconciliationState).toBe(
      'divergent',
    );
  });

  it('the reconcile sweep reaches live work behind a full page of stuck intents (W5 review)', async () => {
    const deps = buildDeps();
    const treasury = await provisionTreasury(deps);
    const nowIso = new Date().toISOString();
    // 250 stuck submitted rows with LOW ids fill the first keyset page…
    for (let i = 0; i < 250; i += 1) {
      await deps.intents.insert({
        paymentIntentId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        userId: USER,
        roomId: ROOM,
        treasuryId: treasury.treasuryId,
        targetType: 'treasury_deposit',
        targetId: treasury.treasuryId,
        asset: 'USDC',
        amount: '1',
        jurisdictionState: 'allowed',
        complianceState: 'cleared',
        executionState: 'submitted',
        retryCount: 0,
        quoteRef: null,
        actionRecordId: null, // cannot advance — permanently stuck
        receiptId: null,
        idempotencyKey: crypto.randomUUID(),
        expiresAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
    // …and one LIVE intent (finalized action + receipt) hides behind them.
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
      signedAction: { message: {}, signature: '0xsig' },
      submissionState: 'finalized' as SubmissionState,
      failureReason: null,
      indexedEventRef: 'evt-1',
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await deps.receipts.upsert({
      receiptId: crypto.randomUUID(),
      actionRecordId,
      kind: 'public',
      payload: {},
      summaryPayloadHash: `0x${'3'.repeat(64)}`,
      ownerUserId: null,
      finalState: 'finalized',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const liveId = `ffffffff-ffff-4fff-8fff-${'f'.repeat(12)}`;
    await deps.intents.insert({
      paymentIntentId: liveId,
      userId: USER,
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '5',
      jurisdictionState: 'allowed',
      complianceState: 'cleared',
      executionState: 'submitted',
      retryCount: 0,
      quoteRef: null,
      actionRecordId,
      receiptId: null,
      idempotencyKey: crypto.randomUUID(),
      expiresAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await reconcileIntents(deps);
    expect((await deps.intents.getById(liveId))?.executionState).toBe('finalized');
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
    paymentIntentId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  });

  async function signedIntent(deps: TestDeps): Promise<string> {
    await provisionTreasury(deps);
    const created = await createPaymentIntent(deps, {
      userId: USER,
      actorUserId: USER,
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

  it('the clawback/cancel path refuses to abandon an intent whose money has moved (thread-4)', async () => {
    const deps = buildDeps();
    const id = await signedIntent(deps);
    // A LIVE action settles the intent (the submit stamped its payment_intent_id
    // and the browser died before the attach).  abandonOpenIntent — the choke
    // point a grant clawback (markGrantClawedBack) and a user cancel both ride —
    // must refuse to reap it, or the settled transfer vanishes from the ledger
    // and the accounting export while `reconcileIntents` no longer scans it.
    await deps.actions.insert(actionOf({ paymentIntentId: id }));
    expect(await abandonOpenIntent(deps, id)).toBe(false);
    expect((await deps.intents.getById(id))?.executionState).toBe('signed');
    // …and the reconcile sweep attaches it instead of it lingering unlinked.
    await reconcileIntents(deps);
    expect((await deps.intents.getById(id))?.executionState).toBe('submitted');
    // A control: with no money in motion a signed intent IS abandonable.
    const clean = buildDeps();
    const cleanId = await signedIntent(clean);
    expect(await abandonOpenIntent(clean, cleanId)).toBe(true);
    expect((await clean.intents.getById(cleanId))?.executionState).toBe('abandoned');
  });

  it('recovers a FIRST-attempt terminal action → failed (retryable), never abandoned; a post-retry corpse is not re-bound (thread-Z)', async () => {
    const deps = buildDeps();
    const id = await signedIntent(deps); // retryCount 0, signed
    // The submit reached the gateway but FAILED before the browser could attach:
    // its payment_intent_id is stamped, yet the action never bound to the intent.
    // The live orphan query (getByPaymentIntentId) skips it — `failed` is a dead
    // submission state — so without the terminal-recovery branch the sweep would
    // find nothing and eventually ABANDON a signed intent whose money moved.
    await deps.actions.insert(actionOf({ submissionState: 'failed', paymentIntentId: id }));
    // reconcile pass 1 recovers the terminal action (first attempt, retryCount 0)
    // and binds it; pass 2 maps submitted→failed and walks the intent to `failed`,
    // a RETRYABLE state — never `abandoned`.
    await reconcileIntents(deps);
    await reconcileIntents(deps);
    const recovered = await deps.intents.getById(id);
    expect(recovered?.executionState).toBe('failed');
    expect(recovered?.actionRecordId).not.toBeNull();

    // Retry (retryCount → 1) and re-sign.  The OLD failed corpse must NOT be
    // re-bound: terminal recovery is first-attempt-only, so there is no re-bind
    // loop past a retry — a genuinely orphaned first submit is recoverable, a
    // stale one from a prior attempt is not.
    const retried = await retryIntent(deps, id, USER);
    if (!('intent' in retried)) throw new Error(JSON.stringify(retried));
    await preflightIntent(deps, id, USER);
    await quoteIntent(deps, id, USER);
    await markIntentSigned(deps, id, USER);
    await reconcileIntents(deps);
    const afterRetry = await deps.intents.getById(id);
    expect(afterRetry?.executionState).toBe('signed'); // not re-failed by the corpse
    expect(afterRetry?.actionRecordId).toBeNull();
  });

  it('refuses to bind a `reserving` action — a reservation that never forwarded settles nothing (thread submission.ts:237)', async () => {
    const deps = buildDeps();
    const id = await signedIntent(deps);
    // A `reserving` row is a crashed prior attempt: inserted before the post-
    // reservation gates, never advanced to `submitted`, and the retry sweep is
    // submitted-only — it never forwarded.  Binding it would settle the intent
    // against a transfer that never happened.
    const action = actionOf({ submissionState: 'reserving' });
    await deps.actions.insert(action);
    const outcome = await attachIntentSubmission(deps, id, action.actionRecordId, USER);
    if (!('code' in outcome)) throw new Error('reserving action unexpectedly attached');
    expect(outcome.code).toBe('action_not_forwarded');
    // Even the reconcile sweep's `allowTerminal` path refuses it — that exemption
    // is for a real failed/reverted corpse, not a never-started reservation.
    const viaReconcile = await attachIntentSubmission(deps, id, action.actionRecordId, USER, {
      allowTerminal: true,
    });
    if (!('code' in viaReconcile)) throw new Error('reserving action attached via allowTerminal');
    expect(viaReconcile.code).toBe('action_not_forwarded');
    // The intent is untouched — still `signed`, unbound (the stale-reservation
    // sweep reclaims the row to `failed`, then the orphan sweep recovers it).
    expect((await deps.intents.getById(id))?.executionState).toBe('signed');
    expect((await deps.intents.getById(id))?.actionRecordId).toBeNull();
  });

  it('a re-attach of the SAME already-bound action returns success, not invalid_transition (thread DepositFlow:354)', async () => {
    const deps = buildDeps();
    const id = await signedIntent(deps);
    const action = actionOf();
    await deps.actions.insert(action);
    // First attach binds it and moves the intent to `submitted`.
    const first = await attachIntentSubmission(deps, id, action.actionRecordId, USER);
    if (!('ok' in first) || !first.ok) throw new Error('first attach should succeed');
    expect((await deps.intents.getById(id))?.executionState).toBe('submitted');
    // A lost-response retry re-attaches the SAME action.  The `submitted →
    // submitted` transition has no edge, so without idempotency it would 409
    // `invalid_transition` and the UI would never see a settlement that already
    // happened.  It returns the already-linked intent as success instead.
    const again = await attachIntentSubmission(deps, id, action.actionRecordId, USER);
    if (!('ok' in again) || !again.ok) throw new Error('re-attach should be idempotent success');
    expect(again.intent.executionState).toBe('submitted');
    expect(again.intent.actionRecordId).toBe(action.actionRecordId);
  });

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
      // A different DEPLOYMENT: a same-shape action from another chain must
      // not settle this treasury's intent (W11).
      { deploymentId: crypto.randomUUID() },
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

  it('binds payout actions to the APPROVED grant recipient (W6 review)', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const treasury = await deps.treasuries.getByRoom(ROOM);
    if (treasury === null) throw new Error('fixture treasury missing');
    const approvedRecipient = `0x${'aa'.repeat(20)}`;
    const grant = await deps.grants.insert({
      grantId: crypto.randomUUID(),
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId: crypto.randomUUID(),
      recipientRef: approvedRecipient,
      purpose: 'Translation sprint',
      amount: '100',
      asset: 'USDC',
      milestones: [],
      milestoneState: 'accepted',
      reviewState: 'cleared',
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    if (grant === null) throw new Error('fixture grant collision');
    const created = await createPaymentIntent(deps, {
      userId: null,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'grant_payout',
      targetId: grant.grantId,
      asset: 'USDC',
      amount: '100',
      idempotencyKey: crypto.randomUUID(),
    });
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    await preflightIntent(deps, id, USER);
    await quoteIntent(deps, id, USER);
    await markIntentSigned(deps, id, USER);
    const payoutAction = (recipient: string): KnomosisActionRecordEntity => ({
      actionRecordId: crypto.randomUUID(),
      deploymentId: DEPLOYMENT,
      actionType: 'grant_payout' as KnomosisSignedActionType,
      roomId: ROOM,
      actorWalletAccountId: crypto.randomUUID(),
      actorUserId: USER,
      payloadHash: `0x${'1'.repeat(64)}`,
      typedDataHash: `0x${'2'.repeat(64)}`,
      signedAction: {
        message: { amount: '100', asset: 'USDC', grantId: grant.grantId, recipient },
        signature: '0xsig',
      },
      submissionState: 'submitted' as SubmissionState,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // A same-grant/same-amount action paying a DIFFERENT address rejects —
    // otherwise a steward could route the tranche to their own wallet.
    const foreign = payoutAction(`0x${'bb'.repeat(20)}`);
    await deps.actions.insert(foreign);
    const rejected = await attachIntentSubmission(deps, id, foreign.actionRecordId, USER);
    if (!('code' in rejected)) throw new Error('unexpectedly attached');
    expect(rejected.code).toBe('action_mismatch');
    // The action paying the APPROVED recipient attaches.
    const good = payoutAction(approvedRecipient);
    await deps.actions.insert(good);
    expect(await attachIntentSubmission(deps, id, good.actionRecordId, USER)).toMatchObject({
      ok: true,
    });
  });

  it('binds user: grant recipients to their LINKED wallets (W11 review)', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const treasury = await deps.treasuries.getByRoom(ROOM);
    if (treasury === null) throw new Error('fixture treasury missing');
    const recipientAddress = `0x${'e1'.repeat(20)}`;
    const { hashFinancialWalletAddress } = await import('../identity/siwe.js');
    await deps.wallets.insert({
      walletAccountId: crypto.randomUUID(),
      userId: OTHER,
      addressHashHex: hashFinancialWalletAddress('test-master-secret', recipientAddress),
      addressTruncated: `${recipientAddress.slice(0, 6)}…${recipientAddress.slice(-4)}`,
      // The recipient wallet must be on the PAYOUT CHAIN (the pinned deployment's
      // chain), or the chain-scoped recipient bind rejects it (codex fix).
      chainId: KNOMOSIS_PIN.deployments[0]?.chain_id ?? 0,
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
    const grant = await deps.grants.insert({
      grantId: crypto.randomUUID(),
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId: crypto.randomUUID(),
      recipientRef: `user:${OTHER}`,
      purpose: 'Member grant',
      amount: '100',
      asset: 'USDC',
      milestones: [],
      milestoneState: 'accepted',
      reviewState: 'cleared',
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    if (grant === null) throw new Error('fixture grant collision');
    const mkIntent = async () => {
      const created = await createPaymentIntent(deps, {
        userId: null,
        actorUserId: USER,
        roomId: ROOM,
        targetType: 'grant_payout',
        targetId: grant.grantId,
        asset: 'USDC',
        amount: '100',
        idempotencyKey: crypto.randomUUID(),
      });
      if (!('intent' in created)) throw new Error('expected intent');
      const id = created.intent.paymentIntentId;
      await preflightIntent(deps, id, USER);
      await quoteIntent(deps, id, USER);
      await markIntentSigned(deps, id, USER);
      return id;
    };
    const payoutAction = (recipient: string): KnomosisActionRecordEntity => ({
      actionRecordId: crypto.randomUUID(),
      deploymentId: DEPLOYMENT,
      actionType: 'grant_payout' as KnomosisSignedActionType,
      roomId: ROOM,
      actorWalletAccountId: crypto.randomUUID(),
      actorUserId: USER,
      payloadHash: `0x${'1'.repeat(64)}`,
      typedDataHash: `0x${'2'.repeat(64)}`,
      signedAction: {
        message: { amount: '100', asset: 'USDC', grantId: grant.grantId, recipient },
        signature: '0xsig',
      },
      submissionState: 'submitted' as SubmissionState,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // An UNRELATED address rejects — the approved member never linked it.
    const first = await mkIntent();
    const foreign = payoutAction(`0x${'bb'.repeat(20)}`);
    await deps.actions.insert(foreign);
    expect(await attachIntentSubmission(deps, first, foreign.actionRecordId, USER)).toMatchObject({
      ok: false,
      code: 'recipient_not_bound',
    });
    // The recipient's LINKED wallet binds (hashed comparison).
    const good = payoutAction(recipientAddress);
    await deps.actions.insert(good);
    expect(await attachIntentSubmission(deps, first, good.actionRecordId, USER)).toMatchObject({
      ok: true,
    });
  });

  it('erased member deposits never join the room-owned idempotency scope (W10 review)', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const treasury = await deps.treasuries.getByRoom(ROOM);
    if (treasury === null) throw new Error('fixture treasury missing');
    const sharedKey = crypto.randomUUID();
    // An ERASED member deposit: user nulled by the data-rights purge.
    await deps.intents.insert({
      paymentIntentId: crypto.randomUUID(),
      userId: null,
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '50',
      jurisdictionState: 'allowed',
      complianceState: 'cleared',
      executionState: 'finalized',
      retryCount: 0,
      quoteRef: null,
      actionRecordId: null,
      receiptId: crypto.randomUUID(),
      idempotencyKey: sharedKey,
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // A room-owned PAYOUT with the same key must not replay the erased
    // deposit (0086 scopes the null-owner uniqueness to the payout classes).
    const created = await createPaymentIntent(deps, {
      userId: null,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'grant_payout',
      targetId: crypto.randomUUID(),
      asset: 'USDC',
      amount: '10',
      idempotencyKey: sharedKey,
    });
    if (!('intent' in created)) throw new Error(JSON.stringify(created));
    expect(created.existing).toBe(false);
    expect(created.intent.targetType).toBe('grant_payout');
  });

  it('the sweep AUTO-ATTACHES a durable action whose client died pre-attach (W13)', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const treasury = await deps.treasuries.getByRoom(ROOM);
    if (treasury === null) throw new Error('fixture treasury missing');
    const created = await createPaymentIntent(deps, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '100',
      idempotencyKey: crypto.randomUUID(),
    });
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    await preflightIntent(deps, id, USER);
    await quoteIntent(deps, id, USER);
    await markIntentSigned(deps, id, USER);
    // The WS-L submit landed (stamping its payment_intent_id onto the action)
    // but the browser died before the attach request.
    const action: KnomosisActionRecordEntity = {
      actionRecordId: crypto.randomUUID(),
      deploymentId: DEPLOYMENT,
      actionType: 'treasury_deposit' as KnomosisSignedActionType,
      roomId: ROOM,
      actorWalletAccountId: crypto.randomUUID(),
      actorUserId: USER,
      payloadHash: `0x${'1'.repeat(64)}`,
      typedDataHash: `0x${'2'.repeat(64)}`,
      signedAction: {
        message: { amount: '100', asset: 'USDC', treasuryId: treasury.treasuryId },
        signature: '0xsig',
      },
      submissionState: 'submitted' as SubmissionState,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await deps.actions.insert(action);
    await reconcileIntents(deps);
    const recovered = await deps.intents.getById(id);
    expect(recovered?.executionState).toBe('submitted');
    expect(recovered?.actionRecordId).toBe(action.actionRecordId);
  });

  it('the expiry sweep NEVER abandons a signed intent whose action already exists (W13)', async () => {
    // The W13 recovery is what makes a lost attach survivable: the client dies
    // between submit and attach, and the sweep re-binds the durable action.
    // But `signed` is a TIMED state, so the intent has a TTL — and the tick
    // runs expiry BEFORE reconcile.  An intent whose TTL lapsed in the gap is
    // therefore abandoned by the same tick that would have attached it, and no
    // later sweep looks at it: the transfer is on chain and its intent is
    // `abandoned`, so the money settles outside the ledger and the accounting
    // export.  Nothing else notices — there is no error anywhere.
    const deps = buildDeps();
    await provisionTreasury(deps);
    const treasury = await deps.treasuries.getByRoom(ROOM);
    if (treasury === null) throw new Error('fixture treasury missing');
    const created = await createPaymentIntent(deps, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '100',
      idempotencyKey: crypto.randomUUID(),
    });
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    await preflightIntent(deps, id, USER);
    await quoteIntent(deps, id, USER);
    await markIntentSigned(deps, id, USER);
    // The submit stamped the action with this `payment_intent_id`; the browser
    // died before it could attach.  The client's own idempotency key is a free
    // UUID — the intent↔action link is the payment_intent_id, not the key.
    await deps.actions.insert({
      actionRecordId: crypto.randomUUID(),
      deploymentId: DEPLOYMENT,
      actionType: 'treasury_deposit' as KnomosisSignedActionType,
      roomId: ROOM,
      actorWalletAccountId: crypto.randomUUID(),
      actorUserId: USER,
      payloadHash: `0x${'1'.repeat(64)}`,
      typedDataHash: `0x${'2'.repeat(64)}`,
      signedAction: {
        message: { amount: '100', asset: 'USDC', treasuryId: treasury.treasuryId },
        signature: '0xsig',
      },
      submissionState: 'submitted' as SubmissionState,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // …and the signed TTL lapses before the next tick.
    const signed = await deps.intents.getById(id);
    if (signed === null) throw new Error('intent missing');
    await deps.intents.transition(
      id,
      'signed',
      'signed',
      { expiresAt: new Date(deps.now() - 1).toISOString() },
      new Date(deps.now()).toISOString(),
    );

    // The tick: expiry, then reconcile.
    await expireIntents(deps);
    await reconcileIntents(deps);

    const after = await deps.intents.getById(id);
    // An intent whose money HAS MOVED is not abandonable — the action is the
    // evidence, and reaping it destroys the only link back to the ledger.
    expect(after?.executionState).not.toBe('abandoned');
    expect(after?.actionRecordId).not.toBeNull();
  });

  it('a revert landing before the first sweep still reaches terminal state (W13)', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const treasury = await deps.treasuries.getByRoom(ROOM);
    if (treasury === null) throw new Error('fixture treasury missing');
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
      signedAction: { message: {}, signature: '0xsig' },
      submissionState: 'reverted' as SubmissionState,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await deps.intents.insert({
      paymentIntentId: crypto.randomUUID(),
      userId: USER,
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '100',
      jurisdictionState: 'allowed',
      complianceState: 'cleared',
      executionState: 'submitted',
      retryCount: 0,
      quoteRef: null,
      actionRecordId,
      receiptId: null,
      idempotencyKey: crypto.randomUUID(),
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const before = (await deps.intents.listByStates(['submitted'], 10))[0];
    if (before === undefined) throw new Error('fixture intent missing');
    await reconcileIntents(deps);
    // submitted → pending → reverted in ONE pass: a permanently `submitted`
    // row would count as in-flight forever (deposit limits, unlink).
    expect((await deps.intents.getById(before.paymentIntentId))?.executionState).toBe('reverted');
  });

  it('rejects an action record already settling another intent', async () => {
    const deps = buildDeps();
    const first = await signedIntent(deps);
    const second = await createPaymentIntent(deps, {
      userId: USER,
      actorUserId: USER,
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

  it('a freeze landing between submit and attach never strands the bookkeeping (W15)', async () => {
    const deps = buildDeps();
    const id = await signedIntent(deps);
    const action = actionOf();
    await deps.actions.insert(action);
    // The transfer is ALREADY on chain when the pause/freeze lands: refusing
    // the bind would let it finalize outside the WS-M ledger and export.
    await setGovernancePause(deps, {
      roomId: ROOM,
      patch: { deposits: true },
      reason: 'incident',
      actorUserId: USER,
    });
    const profile = await deps.profiles.get(ROOM);
    if (profile === null) throw new Error('profile missing');
    await deps.profiles.upsert({
      ...profile,
      freezeState: 'frozen',
      freezeReason: 'platform review',
    });
    expect(await attachIntentSubmission(deps, id, action.actionRecordId, USER)).toMatchObject({
      ok: true,
    });
    // The guard still bites where fund movement is AUTHORIZED: no new intent.
    expect(
      await createPaymentIntent(deps, {
        userId: USER,
        actorUserId: USER,
        roomId: ROOM,
        targetType: 'treasury_deposit',
        targetId: ROOM,
        asset: 'USDC',
        amount: '100',
        idempotencyKey: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: false, code: 'governance_frozen' });
  });

  it('the sweep recovers a ROOM-OWNED payout whose steward died pre-attach (W14)', async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const treasury = await deps.treasuries.getByRoom(ROOM);
    if (treasury === null) throw new Error('fixture treasury missing');
    const approvedRecipient = `0x${'d4'.repeat(20)}`;
    const grant = await deps.grants.insert({
      grantId: crypto.randomUUID(),
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId: crypto.randomUUID(),
      recipientRef: approvedRecipient,
      purpose: 'Recovered tranche',
      amount: '100',
      asset: 'USDC',
      milestones: [],
      milestoneState: 'accepted',
      reviewState: 'cleared',
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    if (grant === null) throw new Error('fixture grant collision');
    const created = await createPaymentIntent(deps, {
      userId: null,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'grant_payout',
      targetId: grant.grantId,
      asset: 'USDC',
      amount: '100',
      idempotencyKey: crypto.randomUUID(),
    });
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    await preflightIntent(deps, id, USER);
    await quoteIntent(deps, id, USER);
    await markIntentSigned(deps, id, USER);
    // The steward's WS-L submit landed (stamping its payment_intent_id) but the
    // browser died before the attach — a NULL-owner intent recovers through the
    // SAME actor-agnostic payment_intent_id link, whichever steward signed it.
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
        message: {
          amount: '100',
          asset: 'USDC',
          grantId: grant.grantId,
          recipient: approvedRecipient,
        },
        signature: '0xsig',
      },
      submissionState: 'submitted' as SubmissionState,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await deps.actions.insert(action);
    await reconcileIntents(deps);
    const recovered = await deps.intents.getById(id);
    expect(recovered?.executionState).toBe('submitted');
    expect(recovered?.actionRecordId).toBe(action.actionRecordId);
  });

  it("a retried intent never re-binds the prior attempt's terminal action (W14)", async () => {
    const deps = buildDeps();
    await provisionTreasury(deps);
    const treasury = await deps.treasuries.getByRoom(ROOM);
    if (treasury === null) throw new Error('fixture treasury missing');
    const created = await createPaymentIntent(deps, {
      userId: USER,
      actorUserId: USER,
      roomId: ROOM,
      targetType: 'treasury_deposit',
      targetId: treasury.treasuryId,
      asset: 'USDC',
      amount: '100',
      idempotencyKey: crypto.randomUUID(),
    });
    if (!('intent' in created)) throw new Error('expected intent');
    const id = created.intent.paymentIntentId;
    await preflightIntent(deps, id, USER);
    await quoteIntent(deps, id, USER);
    await markIntentSigned(deps, id, USER);
    // Attempt 0's action forwards LIVE — the ORDINARY way an intent reaches
    // `failed` and becomes retryable: the auto-attach binds the live action by
    // its payment_intent_id, then the gateway failure reconciles onto the intent
    // (the client's idempotency key is its own free UUID, not a derived key).
    const attempt0: KnomosisActionRecordEntity = {
      actionRecordId: crypto.randomUUID(),
      deploymentId: DEPLOYMENT,
      actionType: 'treasury_deposit' as KnomosisSignedActionType,
      roomId: ROOM,
      actorWalletAccountId: crypto.randomUUID(),
      actorUserId: USER,
      payloadHash: `0x${'1'.repeat(64)}`,
      typedDataHash: `0x${'2'.repeat(64)}`,
      signedAction: {
        message: { amount: '100', asset: 'USDC', treasuryId: treasury.treasuryId },
        signature: '0xsig',
      },
      submissionState: 'submitted' as SubmissionState,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await deps.actions.insert(attempt0);
    await reconcileIntents(deps); // signed → submitted (auto-attach binds the live action)
    await deps.actions.update({
      ...attempt0,
      submissionState: 'failed' as SubmissionState,
      failureReason: 'gateway_rejected',
    });
    await reconcileIntents(deps); // submitted → failed
    expect((await deps.intents.getById(id))?.executionState).toBe('failed');
    // The bounded retry re-arms the intent for a NEW attempt…
    const retried = await retryIntent(deps, id, USER);
    if (!('intent' in retried)) throw new Error(JSON.stringify(retried));
    expect(retried.intent.retryCount).toBe(1);
    await preflightIntent(deps, id, USER);
    await quoteIntent(deps, id, USER);
    await markIntentSigned(deps, id, USER);
    // …whose MANUAL attach refuses the now-terminal attempt-0 action outright…
    const replay = await attachIntentSubmission(deps, id, attempt0.actionRecordId, USER);
    if (!('code' in replay)) throw new Error('unexpectedly attached');
    expect(replay.code).toBe('action_terminal');
    // …and whose auto-attach, keyed on the LIVE payment_intent_id link, never
    // rebinds the dead attempt-0 action (a corpse moved no money).
    await reconcileIntents(deps);
    const after = await deps.intents.getById(id);
    expect(after?.executionState).toBe('signed');
    expect(after?.actionRecordId).toBeNull();
    // A fresh LIVE attempt-1 action for the same intent DOES recover — the link
    // finds it, the dead attempt-0 stays invisible.
    const fresh: KnomosisActionRecordEntity = {
      ...attempt0,
      actionRecordId: crypto.randomUUID(),
      typedDataHash: `0x${'3'.repeat(64)}`,
      submissionState: 'submitted' as SubmissionState,
      failureReason: null,
      idempotencyKey: crypto.randomUUID(),
    };
    await deps.actions.insert(fresh);
    await reconcileIntents(deps);
    const rebound = await deps.intents.getById(id);
    expect(rebound?.executionState).toBe('submitted');
    expect(rebound?.actionRecordId).toBe(fresh.actionRecordId);
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
      recipientRef: `0x${'aa'.repeat(20)}`,
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
    // The payout intent is ROOM-owned: acceptance by one steward must not
    // pin the lifecycle to them (W5 review — steward handoff).
    expect((await deps.intents.getById(intentId))?.userId).toBeNull();
    const action: KnomosisActionRecordEntity = {
      actionRecordId: crypto.randomUUID(),
      deploymentId: DEPLOYMENT,
      actionType: 'grant_payout' as KnomosisSignedActionType,
      roomId: ROOM,
      actorWalletAccountId: crypto.randomUUID(),
      // A DIFFERENT steward executes the on-chain payout than the one who
      // accepted the milestone — the attach must still bind.
      actorUserId: OTHER,
      payloadHash: `0x${'1'.repeat(64)}`,
      typedDataHash: `0x${'2'.repeat(64)}`,
      signedAction: {
        message: {
          amount: '100',
          asset: 'USDC',
          grantId: inserted.grantId,
          recipient: `0x${'aa'.repeat(20)}`,
        },
        signature: '0xsig',
      },
      submissionState: 'finalized' as SubmissionState,
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'matched',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await deps.actions.insert(action);
    const attached = await attachIntentSubmission(deps, intentId, action.actionRecordId, USER);
    expect(attached).toMatchObject({ ok: true });
    // Finality WAITS for the receipt: with the action finalized but no receipt
    // row visible yet, the sweep holds the intent at `confirmed` (a finalized
    // intent leaves the working set, so a missing receipt would never attach).
    await reconcileIntents(deps);
    expect((await deps.intents.getById(intentId))?.executionState).toBe('confirmed');
    expect((await deps.grants.getById(inserted.grantId))?.payoutState).toBe('scheduled');
    await deps.receipts.upsert({
      receiptId: crypto.randomUUID(),
      actionRecordId: action.actionRecordId,
      kind: 'public',
      payload: {},
      summaryPayloadHash: `0x${'3'.repeat(64)}`,
      ownerUserId: null,
      finalState: 'finalized',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await reconcileIntents(deps);
    expect((await deps.intents.getById(intentId))?.executionState).toBe('finalized');
    // Reconciliation — not scheduling — declares the grant paid.
    expect((await deps.grants.getById(inserted.grantId))?.payoutState).toBe('paid');
  });
});
