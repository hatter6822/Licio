// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.2b/c ↔ WS-M.3.1b — the fraud-risk leg of intent preflight and the
// COMPLIANCE HOLD: an `elevated` verdict flags the intent into the fraud
// queue; a flagged/blocked intent cannot advance toward execution (the
// orthogonal compliance column — the 13-state machine itself is unchanged);
// release (`flagged → cleared`) lets it proceed; reject (`flagged → blocked`)
// pins it until the expiry sweep abandons it.  `blocked` fraud verdicts
// reject outright; `unavailable` passes on testnet (the shipped real-funds
// arm stays the WS-L posture).
import { describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import { DEFAULT_KNOMOSIS_CONFIG } from '../knomosis/config.js';
import { KNOMOSIS_PIN } from '../knomosis/pin.js';
import {
  type CompliancePort,
  defaultCompliancePort,
  defaultRegionResolverPort,
} from '../knomosis/ports.js';
import {
  InMemoryFinancialWalletStore,
  InMemoryGovernanceAuditStore,
  InMemoryKnomosisActionStore,
  InMemoryKnomosisReceiptStore,
} from '../knomosis/stores.js';
import {
  createPaymentIntent,
  type IntentDeps,
  preflightIntent,
  quoteIntent,
} from '../treasury/intents.js';
import {
  InMemoryGovernanceProfileStore,
  InMemoryGrantStore,
  InMemoryPaymentIntentStore,
  InMemoryReservationStore,
  InMemoryTreasuryStore,
} from '../treasury/stores.js';
import { createTreasury, type TreasuryServiceDeps } from '../treasury/treasury.js';

type TestDeps = IntentDeps & TreasuryServiceDeps;

const ROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEPLOYMENT = KNOMOSIS_PIN.deployments[0]?.deployment_id ?? '';
const ADDRESS = `0x${'ab'.repeat(20)}`;

function buildDeps(compliance: CompliancePort): TestDeps {
  let clock = Date.parse('2026-07-15T00:00:00.000Z');
  return {
    profiles: new InMemoryGovernanceProfileStore(),
    treasuries: new InMemoryTreasuryStore(),
    reservations: new InMemoryReservationStore(),
    intents: new InMemoryPaymentIntentStore(),
    grants: new InMemoryGrantStore(),
    actions: new InMemoryKnomosisActionStore(),
    receipts: new InMemoryKnomosisReceiptStore(),
    wallets: new InMemoryFinancialWalletStore(),
    masterSecret: 'test-master-secret',
    governanceAudit: new InMemoryGovernanceAuditStore(),
    compliance,
    regionResolver: defaultRegionResolverPort,
    configStore: new InMemoryPwattConfigStore(),
    wsmConfig: () => DEFAULT_KNOMOSIS_CONFIG,
    now: () => {
      clock += 1;
      return clock;
    },
    uuid: () => crypto.randomUUID(),
  };
}

async function provision(deps: TestDeps): Promise<string> {
  const created = await createTreasury(deps, {
    roomId: ROOM,
    deploymentId: DEPLOYMENT,
    treasuryAddress: ADDRESS,
    acceptedAssets: ['USDC'],
    depositLimits: {
      perUserPerPeriod: '1000',
      perRoomPerPeriod: '1500',
      perDepositMax: '600',
      periodSeconds: 86_400,
    },
    actorUserId: USER,
  });
  if (!('treasury' in created)) throw new Error('treasury should provision');
  const intent = await createPaymentIntent(deps, {
    userId: USER,
    roomId: ROOM,
    targetType: 'treasury_deposit',
    targetId: created.treasury.treasuryId,
    asset: 'USDC',
    amount: '100',
    idempotencyKey: 'k-1',
  });
  if (!('intent' in intent)) throw new Error('intent should create');
  return intent.intent.paymentIntentId;
}

const port = (fraud: 'normal' | 'elevated' | 'blocked' | 'unavailable'): CompliancePort => ({
  ...defaultCompliancePort,
  screenAddress: async () => 'clear',
  jurisdiction: async () => 'unknown',
  fraudRisk: async () => fraud,
});

describe('the fraud-risk preflight leg (WS-N.2.2b/c)', () => {
  it('normal → preflighted cleared; the intent quotes normally', async () => {
    const deps = buildDeps(port('normal'));
    const intentId = await provision(deps);
    const preflighted = await preflightIntent(deps, intentId, USER);
    expect('intent' in preflighted && preflighted.intent.complianceState).toBe('cleared');
    const quoted = await quoteIntent(deps, intentId, USER);
    expect('intent' in quoted).toBe(true);
  });

  it('elevated → FLAGGED into the queue; the flagged intent cannot advance', async () => {
    const deps = buildDeps(port('elevated'));
    const intentId = await provision(deps);
    const preflighted = await preflightIntent(deps, intentId, USER);
    expect('intent' in preflighted && preflighted.intent.complianceState).toBe('flagged');
    const quoted = await quoteIntent(deps, intentId, USER);
    expect('code' in quoted && quoted.code).toBe('invalid_transition');
    // The queue read sees it.
    expect(await deps.intents.listByComplianceState('flagged', 10)).toHaveLength(1);
  });

  it('release (flagged → cleared) lets the intent proceed; reject pins it', async () => {
    const deps = buildDeps(port('elevated'));
    const intentId = await provision(deps);
    await preflightIntent(deps, intentId, USER);
    // Reject first: flagged → blocked still cannot advance.
    const rejected = await deps.intents.updateComplianceState(
      intentId,
      'flagged',
      'blocked',
      new Date().toISOString(),
    );
    expect(rejected?.complianceState).toBe('blocked');
    expect('code' in (await quoteIntent(deps, intentId, USER))).toBe(true);
    // The CAS refuses a release from the wrong state...
    expect(
      await deps.intents.updateComplianceState(
        intentId,
        'flagged',
        'cleared',
        new Date().toISOString(),
      ),
    ).toBeNull();
    // ...but blocked → cleared is a deliberate senior override path the
    // store supports; the queue routes expose only flagged → cleared/blocked.
    const released = await deps.intents.updateComplianceState(
      intentId,
      'blocked',
      'cleared',
      new Date().toISOString(),
    );
    expect(released?.complianceState).toBe('cleared');
    expect('intent' in (await quoteIntent(deps, intentId, USER))).toBe(true);
  });

  it('blocked → 403 fraud_risk at preflight; unavailable passes on testnet', async () => {
    const blockedDeps = buildDeps(port('blocked'));
    const blockedId = await provision(blockedDeps);
    const blocked = await preflightIntent(blockedDeps, blockedId, USER);
    expect('code' in blocked && blocked.code).toBe('fraud_risk');
    const unavailableDeps = buildDeps(port('unavailable'));
    const unavailableId = await provision(unavailableDeps);
    const preflighted = await preflightIntent(unavailableDeps, unavailableId, USER);
    // Local/testnet proceeds (the shipped WS-L posture; the real-funds arm
    // rejects — pinned by the shipped WS-M suites).  The compliance STATE
    // reflects the SCREENING outcome ('clear' here ⇒ cleared): the fraud
    // verdict only flags (elevated) or rejects (blocked / real-funds
    // unavailable) — it never silently improves the state.
    expect('intent' in preflighted && preflighted.intent.complianceState).toBe('cleared');
  });
});
