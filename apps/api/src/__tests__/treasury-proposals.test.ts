// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M slice-6: the production proposal lifecycle — create/publish with the
// fail-closed preflight, wallet-signature voting through the REAL EIP-712
// verifiers, the deadline settle sweep (kernel tally + reservation), typed
// challenges, and execution through the shipped treasury-executor seam —
// plus grants, delegations, and action budgets.

import type { LawPack } from '@licio/governance';
import type { GovernanceMode, ProductionProposalCreate } from '@licio/shared';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import { InMemoryLawPackStore } from '../governance/stores.js';
import { hashFinancialWalletAddress } from '../identity/siwe.js';
import { DEFAULT_KNOMOSIS_CONFIG } from '../knomosis/config.js';
import { defaultCompliancePort, defaultRegionResolverPort } from '../knomosis/ports.js';
import type { RoomGovernancePort } from '../knomosis/preflight.js';
import type { RoomModePort } from '../knomosis/readiness.js';
import {
  InMemoryFinancialWalletStore,
  InMemoryGovernanceAuditStore,
  InMemoryGovernanceProposalStore,
  InMemoryGovernanceSignatureStore,
  InMemoryKnomosisActionStore,
  InMemoryKnomosisReceiptStore,
} from '../knomosis/stores.js';
import { verifyAuditChain } from '../treasury/audit-chain.js';
import { actionBudgetStatus } from '../treasury/budgets.js';
import { createDelegation, revokeDelegation } from '../treasury/delegations.js';
import { setGrantReview, updateGrantMilestone } from '../treasury/grants.js';
import { adoptLawPack, registerLawPack } from '../treasury/law-packs.js';
import {
  createProductionProposal,
  deterministicProposalId,
  executeProposal,
  fileChallenge,
  type MembershipFactsPort,
  type ProposalDeps,
  resolveChallenge,
  type SignProposalInput,
  settleDueProposals,
  signProposal,
} from '../treasury/proposals.js';
import {
  InMemoryActionBudgetStore,
  InMemoryChallengeStore,
  InMemoryCharterStore,
  InMemoryDelegationStore,
  InMemoryGovernanceProfileStore,
  InMemoryGrantStore,
  InMemoryPaymentIntentStore,
  InMemoryReservationStore,
  InMemoryTreasuryStore,
} from '../treasury/stores.js';
import { createTreasury } from '../treasury/treasury.js';
import {
  LOCAL_DEPLOYMENT,
  signedTypedData,
  TEST_KEY_2,
  testAccount,
  testAccount2,
} from './knomosis-test-helpers.js';

const ROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROPOSER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VOTER_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STEWARD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const WALLET_1 = '11111111-1111-4111-8111-111111111111';
const WALLET_2 = '22222222-2222-4222-8222-222222222222';
const MASTER_SECRET = 'test-master-secret';

const fullLawPack = (overrides: Partial<LawPack> = {}): Record<string, unknown> => ({
  lawPackId: 'placeholder',
  version: '1.0.0',
  allowedProposalTypes: ['capped_grant', 'charter_update'],
  permittedCapabilities: ['treasury.grant'],
  treasury: {
    caps: [
      { category: 'grant', perActionMax: '5000', perWindowMax: '10000', windowSeconds: 86_400 },
    ],
    minIntervalSeconds: 0,
    timelockSeconds: 0,
    materialThreshold: '1000000',
    requireCoiFor: ['grant'],
    investment: null,
  },
  election: {
    weightModel: 'one_civic_account_one_vote',
    perAccountCap: 1,
    minQuorum: 1,
    minTurnout: 0,
    termSeconds: 31_536_000,
  },
  humanSummary: 'Grants with COI review.',
  quorumRules: {
    capped_grant: { basis: 'eligible_voters', minFraction: 0.2 },
    charter_update: { basis: 'eligible_voters', minFraction: 0.2 },
  },
  thresholdRules: {
    capped_grant: { minAffirmativeFraction: 0.5 },
    charter_update: { minAffirmativeFraction: 0.5 },
  },
  timelockRules: {
    capped_grant: { seconds: 3_600 },
    charter_update: { seconds: 3_600 },
  },
  weightModel: 'one_civic_account_one_vote',
  maxVotingWeightPerAccount: 1,
  eligibility: {
    minMembershipDays: 0,
    minContributions: 0,
    requireVerifiedIdentity: false,
    newWalletCoolingOffDays: 7,
  },
  coiRequirements: {
    disclosureTriggers: ['financial relationship'],
    recusalRequired: false,
    independentReviewFor: ['capped_grant'],
  },
  appealRules: { whoCanAppeal: ['any_member'], timelineSeconds: 604_800, process: 'Floor.' },
  forkExitRules: { conditions: 'Vote.', process: 'Fork.', fundHandling: 'Return.' },
  emergencyConstraints: { freezeTriggers: ['divergence'], escalation: 'Security.' },
  actionBudgetRules: {
    costs: { proposal_submission: 5 },
    refill: { periodSeconds: 86_400, units: 5, max: 10 },
  },
  testFixtureCorpusRef: 'corpus-1',
  ...overrides,
});

interface TestHarness extends ProposalDeps {
  mode: { value: GovernanceMode };
  clockAdvance: (ms: number) => void;
  executorCalls: { category: string; amount: string; pinned: boolean }[];
  executorAccepts: { value: boolean };
  electionsOpened: string[];
  memberFactsOverride: Map<
    string,
    { membershipDays: number | null; contributionCount: number | null; verifiedIdentity: boolean }
  >;
}

function buildHarness(): TestHarness {
  let clock = Date.parse('2026-07-13T00:00:00.000Z');
  const mode = { value: 'testnet' as GovernanceMode };
  const members = new Set([PROPOSER, VOTER_2, STEWARD]);
  const stewards = new Set([STEWARD]);
  const executorCalls: TestHarness['executorCalls'] = [];
  const executorAccepts = { value: true };
  const electionsOpened: string[] = [];
  const proposals = new InMemoryGovernanceProposalStore();
  const rooms: RoomGovernancePort = {
    roomGovernance: async () => ({ mode: mode.value, name: 'Test Room' }),
    isMember: async (_r, userId) => members.has(userId),
    isSteward: async (_r, userId) => stewards.has(userId),
    contentVisibleToUser: async () => true,
  };
  const roomMode: RoomModePort = {
    currentMode: async () => mode.value,
    setMode: async (_r, m) => {
      mode.value = m;
      return true;
    },
    setModeIf: async (_r, expected, next) => {
      if (mode.value !== expected) return false;
      mode.value = next;
      return true;
    },
  };
  const memberFactsOverride = new Map<
    string,
    { membershipDays: number | null; contributionCount: number | null; verifiedIdentity: boolean }
  >();
  const membership: MembershipFactsPort = {
    memberFacts: async (_r, userId) =>
      members.has(userId)
        ? (memberFactsOverride.get(userId) ?? {
            membershipDays: 60,
            contributionCount: 10,
            verifiedIdentity: true,
          })
        : null,
    eligibleMemberCount: async () => 3,
  };
  const deps: ProposalDeps = {
    profiles: new InMemoryGovernanceProfileStore(),
    treasuries: new InMemoryTreasuryStore(),
    reservations: new InMemoryReservationStore(),
    charters: new InMemoryCharterStore(),
    lawPacks: new InMemoryLawPackStore(),
    proposals,
    proposalSignatures: new InMemoryGovernanceSignatureStore(proposals),
    challenges: new InMemoryChallengeStore(),
    delegations: new InMemoryDelegationStore(),
    budgets: new InMemoryActionBudgetStore(),
    grants: new InMemoryGrantStore(),
    intents: new InMemoryPaymentIntentStore(),
    actions: new InMemoryKnomosisActionStore(),
    receipts: new InMemoryKnomosisReceiptStore(),
    wallets: new InMemoryFinancialWalletStore(),
    governanceAudit: new InMemoryGovernanceAuditStore(),
    rooms,
    roomMode,
    membership,
    treasuryExecutor: {
      execute: async (_roomId, action) => {
        // `pinned` records whether the caller supplied the proposal's pinned
        // law-pack (W6 review: execution must ride the pinned rules).
        executorCalls.push({
          category: action.category,
          amount: action.amount,
          pinned: action.lawPack != null,
        });
        return executorAccepts.value
          ? { accepted: true, code: null }
          : { accepted: false, code: 'per_action_cap_exceeded' };
      },
    },
    elections: {
      openElection: async (roomId) => {
        electionsOpened.push(roomId);
        return true;
      },
    },
    compliance: defaultCompliancePort,
    regionResolver: defaultRegionResolverPort,
    configStore: new InMemoryPwattConfigStore(),
    masterSecret: MASTER_SECRET,
    contractVerifier: undefined,
    wsmConfig: () => DEFAULT_KNOMOSIS_CONFIG,
    wsmProposalConfig: () => DEFAULT_KNOMOSIS_CONFIG,
    now: () => {
      clock += 1;
      return clock;
    },
    uuid: () => crypto.randomUUID(),
  };
  return Object.assign(deps, {
    mode,
    clockAdvance: (ms: number) => {
      clock += ms;
    },
    executorCalls,
    executorAccepts,
    electionsOpened,
    memberFactsOverride,
  });
}

/** Provision treasury (with a reconciled balance) + adopt the law-pack. */
async function prepareRoom(deps: TestHarness, packOverrides: Partial<LawPack> = {}) {
  const created = await createTreasury(deps, {
    roomId: ROOM,
    deploymentId: LOCAL_DEPLOYMENT.deployment_id,
    treasuryAddress: `0x${'ab'.repeat(20)}`,
    acceptedAssets: ['USDC'],
    depositLimits: {
      perUserPerPeriod: '1000000',
      perRoomPerPeriod: '10000000',
      perDepositMax: '500000',
      periodSeconds: 86_400,
    },
    actorUserId: STEWARD,
  });
  if (!('treasury' in created)) throw new Error('treasury');
  await deps.treasuries.setReconciliation(
    created.treasury.treasuryId,
    'synced',
    { USDC: '100000' },
    new Date().toISOString(),
  );
  const registered = await registerLawPack(deps, {
    roomId: ROOM,
    document: fullLawPack(packOverrides),
    fixtures: null,
    actorUserId: STEWARD,
  });
  if (!('record' in registered)) throw new Error(JSON.stringify(registered));
  await adoptLawPack(deps, {
    roomId: ROOM,
    lawPackId: registered.record.lawPackId,
    actorUserId: STEWARD,
  });
  return created.treasury;
}

/** Link a wallet (old enough to clear the 7-day cooling-off). */
async function linkWallet(
  deps: TestHarness,
  walletAccountId: string,
  userId: string,
  address: string,
  ageDays = 30,
) {
  await deps.wallets.insert({
    walletAccountId,
    userId,
    addressHashHex: hashFinancialWalletAddress(MASTER_SECRET, address.toLowerCase()),
    addressTruncated: `${address.slice(0, 6)}…${address.slice(-4)}`,
    chainId: LOCAL_DEPLOYMENT.chain_id,
    walletType: 'eoa',
    unlinkState: 'active',
    riskState: 'normal',
    label: null,
    linkedAt: new Date(deps.now() - ageDays * 86_400_000).toISOString(),
    lastUsedAt: null,
    unlinkRequestedAt: null,
    unlinkFinalizeAfter: null,
    unlinkedAt: null,
  });
}

const draft = (overrides: Partial<ProductionProposalCreate> = {}): ProductionProposalCreate => ({
  proposal_type: 'capped_grant',
  title: 'Fund the translation sprint',
  plain_language_summary: 'Pay a contributor to translate the charter.',
  category: 'grant',
  requested_amount: '4000',
  asset: 'USDC',
  recipient_ref: `0x${'cd'.repeat(20)}`,
  conflict_disclosures: 'None: no relationship with the recipient.',
  risk_assessment: 'Low: capped and milestone-gated.',
  requested_action: { kind: 'grant' },
  expected_deliverable: 'A published translation.',
  idempotency_key: crypto.randomUUID(),
  ...overrides,
});

async function createProposal(
  deps: TestHarness,
  overrides: Partial<ProductionProposalCreate> = {},
) {
  const result = await createProductionProposal(deps, {
    roomId: ROOM,
    userId: PROPOSER,
    create: draft(overrides),
  });
  if (!('proposal' in result)) throw new Error(JSON.stringify(result));
  return result.proposal;
}

/** Sign a REAL EIP-712 vote for `proposal_sign`. */
async function castVote(
  deps: TestHarness,
  proposalId: string,
  userId: string,
  walletAccountId: string,
  account: typeof testAccount,
  choice: 'approve' | 'reject' | 'abstain',
  overrides: Partial<SignProposalInput> = {},
) {
  const nonce = String(Math.floor(Math.random() * 1_000_000_000));
  const message: Record<string, string> = {
    roomId: ROOM,
    proposalId,
    // Registry v2: the ballot itself is inside the signed struct.
    purpose: (overrides.purpose as string | undefined) ?? 'vote',
    choice:
      (overrides.purpose as string | undefined) === 'vote' || overrides.purpose === undefined
        ? choice
        : 'none',
    actor: account.address.toLowerCase(),
    nonce,
    expiration: String(Math.floor(deps.now() / 1000) + 600),
    deploymentId: LOCAL_DEPLOYMENT.deployment_id,
  };
  const signature = await signedTypedData('proposal_sign', message, account);
  return signProposal(deps, {
    roomId: ROOM,
    proposalId,
    userId,
    purpose: 'vote',
    choice,
    deploymentId: LOCAL_DEPLOYMENT.deployment_id,
    walletAccountId,
    typedDataMessage: message,
    signature,
    ...overrides,
  });
}

/** Advance past deliberation, open voting. */
async function openVoting(deps: TestHarness) {
  deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmDeliberationSeconds * 1000 + 1_000);
  await settleDueProposals(deps, ROOM);
}

describe('createProductionProposal (WS-M.4.1a-c + 4.2a)', () => {
  it('publishes into deliberation with the law-pack pinned', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const proposal = await createProposal(deps);
    expect(proposal.votingState).toBe('deliberation');
    expect(proposal.simulationMode).toBe(false);
    expect(proposal.lawPackVersionId).not.toBeNull();
    expect(proposal.category).toBe('grant');
    const chain = await deps.governanceAudit.listChainedByRoom(ROOM);
    expect(chain.some((e) => e.actionType === 'proposal_published')).toBe(true);
  });

  it('replays idempotently on the same (room, user, key)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const key = crypto.randomUUID();
    const first = await createProposal(deps, { idempotency_key: key });
    const replay = await createProposal(deps, { idempotency_key: key });
    expect(replay.proposalId).toBe(first.proposalId);
    expect(first.proposalId).toBe(deterministicProposalId(ROOM, PROPOSER, key));
  });

  it('requires a real-asset mode, membership, and an allowed type', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    deps.mode.value = 'simulated';
    expect(
      await createProductionProposal(deps, { roomId: ROOM, userId: PROPOSER, create: draft() }),
    ).toMatchObject({ ok: false, code: 'mode_invalid' });
    deps.mode.value = 'testnet';
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        create: draft(),
      }),
    ).toMatchObject({ ok: false, code: 'not_member' });
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({
          proposal_type: 'bounty',
          category: 'bounty',
          requested_action: { kind: 'bounty' },
        }),
      }),
    ).toMatchObject({ ok: false, code: 'type_not_allowed' });
  });

  it('enforces draft completeness and the prohibited-target classifier', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ conflict_disclosures: null }),
      }),
    ).toMatchObject({ ok: false, code: 'coi_required' });
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ requested_action: { kind: 'unban_user' } }),
      }),
    ).toMatchObject({ ok: false, code: 'prohibited_target' });
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ requested_action: { kind: 'something_new' } }),
      }),
    ).toMatchObject({ ok: false, code: 'unclassifiable_action' });
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ requested_action: {} }),
      }),
    ).toMatchObject({ ok: false, code: 'unclassifiable_action' });
  });

  it('fails closed on unreconciled balances and insufficient headroom', async () => {
    const deps = buildHarness();
    const treasury = await prepareRoom(deps);
    await deps.treasuries.setReconciliation(treasury.treasuryId, 'pending', null, null);
    // Balance snapshot still exists from prepareRoom — wipe it via a fresh harness instead.
    const fresh = buildHarness();
    const t2 = await createTreasury(fresh, {
      roomId: ROOM,
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      treasuryAddress: `0x${'ab'.repeat(20)}`,
      acceptedAssets: ['USDC'],
      depositLimits: {
        perUserPerPeriod: '1000000',
        perRoomPerPeriod: '10000000',
        perDepositMax: '500000',
        periodSeconds: 86_400,
      },
      actorUserId: STEWARD,
    });
    void t2;
    const registered = await registerLawPack(fresh, {
      roomId: ROOM,
      document: fullLawPack(),
      fixtures: null,
      actorUserId: STEWARD,
    });
    if (!('record' in registered)) throw new Error('law pack');
    await adoptLawPack(fresh, {
      roomId: ROOM,
      lawPackId: registered.record.lawPackId,
      actorUserId: STEWARD,
    });
    expect(
      await createProductionProposal(fresh, { roomId: ROOM, userId: PROPOSER, create: draft() }),
    ).toMatchObject({ ok: false, code: 'treasury_not_synced' });
    // With a reconciled but SMALL balance, funds fail closed.
    const t = await fresh.treasuries.getByRoom(ROOM);
    await fresh.treasuries.setReconciliation(
      t?.treasuryId ?? '',
      'synced',
      { USDC: '10' },
      new Date().toISOString(),
    );
    expect(
      await createProductionProposal(fresh, { roomId: ROOM, userId: PROPOSER, create: draft() }),
    ).toMatchObject({ ok: false, code: 'insufficient_funds' });
  });

  it('charges the action budget and blocks when exhausted', async () => {
    const deps = buildHarness();
    await prepareRoom(deps); // cost 5, max 10 ⇒ two proposals, then empty
    await createProposal(deps);
    await createProposal(deps);
    expect(
      await createProductionProposal(deps, { roomId: ROOM, userId: PROPOSER, create: draft() }),
    ).toMatchObject({ ok: false, code: 'insufficient_budget' });
    const status = await actionBudgetStatus(deps, {
      roomId: ROOM,
      userId: PROPOSER,
      rules: {
        costs: { proposal_submission: 5 },
        refill: { periodSeconds: 86_400, units: 5, max: 10 },
      },
    });
    expect(status.available_units).toBe(0);
    expect(status.transferable).toBe(false);
  });

  it('rejects a request above the per-action cap BEFORE publication (PR #144 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps); // perActionMax 5000, perWindowMax 10000, balance 100000
    // 6000 fits the window headroom and the balance but can NEVER be
    // reserved — it must fail at create, not after a full vote.
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ requested_amount: '6000' }),
      }),
    ).toMatchObject({ ok: false, code: 'per_action_cap_exceeded' });
  });

  it('screens ONLY address-shaped recipients; opaque refs skip sanctions (PR #144 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    // An opaque recipient ref never reaches the sanctions port at all.
    deps.compliance = {
      ...deps.compliance,
      screenAddress: async () => {
        throw new Error('screenAddress must not be called for an opaque ref');
      },
    };
    const opaque = await createProductionProposal(deps, {
      roomId: ROOM,
      userId: PROPOSER,
      create: draft({ recipient_ref: 'coop:the-translation-collective' }),
    });
    expect(opaque).toMatchObject({ ok: true });
    // An address-shaped recipient IS screened — a blocked verdict rejects.
    deps.compliance = { ...deps.compliance, screenAddress: async () => 'blocked' };
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ recipient_ref: `0x${'99'.repeat(20)}` }),
      }),
    ).toMatchObject({ ok: false, code: 'sanctions_blocked' });
  });

  it('refunds the action budget to the idempotent-race loser (PR #144 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps); // cost 5, max 10 ⇒ two funded creates
    // Simulate the duplicate-key race: the loser's pre-check misses, the
    // charge lands, then the insert collides (SQLSTATE 23505 on the Drizzle
    // cause chain) and the winner's row is returned.
    const winner = await createProposal(deps);
    const raw = deps.proposals;
    let firstLookup = true;
    deps.proposals = new Proxy(raw, {
      get(target, prop) {
        if (prop === 'getById') {
          return async (_id: string) => {
            if (firstLookup) {
              firstLookup = false;
              return null; // the race window: the winner's row is not yet visible
            }
            return target.getById(winner.proposalId);
          };
        }
        if (prop === 'insert') {
          return async () => {
            throw Object.assign(new Error('duplicate key'), { cause: { code: '23505' } });
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const replay = await createProductionProposal(deps, {
      roomId: ROOM,
      userId: PROPOSER,
      create: draft(),
    });
    expect(replay).toMatchObject({ ok: true });
    if (!('proposal' in replay)) throw new Error('expected the winner row');
    expect(replay.proposal.proposalId).toBe(winner.proposalId);
    // The loser's charge was credited back: a THIRD funded create still fits
    // the 10-unit budget (5 charged for the winner + 5 for this one).
    deps.proposals = raw;
    expect(
      await createProductionProposal(deps, { roomId: ROOM, userId: PROPOSER, create: draft() }),
    ).toMatchObject({ ok: true });
  });

  it('rejects malformed charter sections at publication (W6 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, {
      allowedProposalTypes: ['capped_grant', 'charter_update'],
    });
    // Missing/short sections must die at CREATE — not after a full vote when
    // `createCharterVersion()` refuses them at execution.
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({
          proposal_type: 'charter_update',
          category: null,
          requested_amount: null,
          asset: null,
          recipient_ref: null,
          requested_action: { kind: 'charter_update', sections: { purpose: 'too short' } },
        }),
      }),
    ).toMatchObject({ ok: false, code: 'charter_sections_invalid' });
  });

  it('a role_class quorum basis without a signer set cannot publish (W6 review)', async () => {
    const deps = buildHarness();
    const registered = await registerLawPack(deps, {
      roomId: ROOM,
      document: fullLawPack({
        quorumRules: {
          capped_grant: { basis: 'role_class', minFraction: 0.5 },
          charter_update: { basis: 'eligible_voters', minFraction: 0.2 },
        },
      }),
      fixtures: null,
      actorUserId: STEWARD,
    });
    expect(registered).toMatchObject({ ok: false, code: 'law_pack_invalid' });
  });

  it('a real-asset room cannot adopt a pack below the production bar (W6 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps); // testnet room with the full pack adopted
    // Registration permits a real-asset-INCOMPLETE pack (simulated rooms
    // iterate)…
    const { appealRules: _omit, ...incomplete } = fullLawPack({ version: '1.2.0' });
    const registered = await registerLawPack(deps, {
      roomId: ROOM,
      document: incomplete,
      fixtures: null,
      actorUserId: STEWARD,
    });
    if (!('record' in registered)) throw new Error(JSON.stringify(registered));
    // …but a room already past the readiness gate must not ACTIVATE it.
    expect(
      await adoptLawPack(deps, {
        roomId: ROOM,
        lawPackId: registered.record.lawPackId,
        actorUserId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'law_pack_not_real_asset_ready' });
  });

  it('a frozen room cannot adopt a different law-pack (W5 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const second = await registerLawPack(deps, {
      roomId: ROOM,
      document: fullLawPack({ version: '1.1.0' }),
      fixtures: null,
      actorUserId: STEWARD,
    });
    if (!('record' in second)) throw new Error(JSON.stringify(second));
    const profile = await deps.profiles.get(ROOM);
    if (profile === null) throw new Error('profile missing');
    await deps.profiles.upsert({
      ...profile,
      freezeState: 'frozen',
      freezeReason: 'Emergency review.',
    });
    // Swapping the active quorum/threshold/timelock rules is a configuration
    // mutation — frozen rooms refuse it like charter publishing.
    expect(
      await adoptLawPack(deps, {
        roomId: ROOM,
        lawPackId: second.record.lawPackId,
        actorUserId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'governance_frozen' });
  });
});

describe('signProposal (WS-M.2.3b-1 + 4.2c)', () => {
  it('records a capped weight snapshot from a REAL EIP-712 signature', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    const proposal = await createProposal(deps);
    // Deliberation first: voting has not opened.
    expect(
      await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve'),
    ).toMatchObject({ ok: false, code: 'still_deliberating' });
    await openVoting(deps);
    const vote = await castVote(
      deps,
      proposal.proposalId,
      PROPOSER,
      WALLET_1,
      testAccount,
      'approve',
    );
    if (!('signature' in vote)) throw new Error(JSON.stringify(vote));
    expect(vote.signature.weightSnapshot).toBe('1');
    expect(vote.signature.purpose).toBe('vote');
    expect(vote.tally.approve).toBe('1');
    expect(vote.tally.outcome).toBe('open'); // deadline-driven, never early
  });

  it('rejects double votes, replayed nonces, expired payloads, and tampered signatures', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    expect(
      await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'reject'),
    ).toMatchObject({ ok: false, code: 'already_signed' });
    // Expired typed data.
    const nonce = '424242';
    const expired: Record<string, string> = {
      roomId: ROOM,
      proposalId: proposal.proposalId,
      purpose: 'vote',
      choice: 'approve',
      actor: testAccount2.address.toLowerCase(),
      nonce,
      expiration: String(Math.floor(deps.now() / 1000) - 10),
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
    };
    expect(
      await signProposal(deps, {
        roomId: ROOM,
        proposalId: proposal.proposalId,
        userId: VOTER_2,
        purpose: 'vote',
        choice: 'approve',
        deploymentId: LOCAL_DEPLOYMENT.deployment_id,
        walletAccountId: WALLET_2,
        typedDataMessage: expired,
        signature: await signedTypedData('proposal_sign', expired, testAccount2),
      }),
    ).toMatchObject({ ok: false, code: 'expired' });
    // A signature from a DIFFERENT key than the linked wallet fails.
    const stranger = privateKeyToAccount(TEST_KEY_2);
    const forged: Record<string, string> = {
      roomId: ROOM,
      proposalId: proposal.proposalId,
      purpose: 'vote',
      choice: 'approve',
      actor: testAccount.address.toLowerCase(),
      nonce: '99',
      expiration: String(Math.floor(deps.now() / 1000) + 600),
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
    };
    expect(
      await signProposal(deps, {
        roomId: ROOM,
        proposalId: proposal.proposalId,
        userId: VOTER_2,
        purpose: 'vote',
        choice: 'approve',
        deploymentId: LOCAL_DEPLOYMENT.deployment_id,
        walletAccountId: WALLET_2,
        typedDataMessage: forged,
        signature: await signedTypedData('proposal_sign', forged, stranger),
      }),
    ).toMatchObject({ ok: false, code: 'signature_invalid' });
    // The SIGNED deployment binding must match the recording deployment
    // (PR #144 review: the §17.3.1 quartet includes deploymentId).
    const foreignDeployment: Record<string, string> = {
      roomId: ROOM,
      proposalId: proposal.proposalId,
      purpose: 'vote',
      choice: 'approve',
      actor: testAccount2.address.toLowerCase(),
      nonce: '4243',
      expiration: String(Math.floor(deps.now() / 1000) + 600),
      deploymentId: '00000000-0000-4000-8000-00000000dead',
    };
    expect(
      await signProposal(deps, {
        roomId: ROOM,
        proposalId: proposal.proposalId,
        userId: VOTER_2,
        purpose: 'vote',
        choice: 'approve',
        deploymentId: LOCAL_DEPLOYMENT.deployment_id,
        walletAccountId: WALLET_2,
        typedDataMessage: foreignDeployment,
        signature: await signedTypedData('proposal_sign', foreignDeployment, testAccount2),
      }),
    ).toMatchObject({ ok: false, code: 'payload_mismatch' });
    // Registry v2: the request cannot repurpose a signed ballot — the wallet
    // approved 'approve', the JSON asks to record 'reject'.
    expect(
      await castVote(deps, proposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve', {
        choice: 'reject',
      }),
    ).toMatchObject({ ok: false, code: 'payload_mismatch' });
  });

  it('rejects ballots after the voting deadline even before the sweep settles', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    // Past the deadline, the row still says `open` (the sweep has not run).
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 60_000);
    expect(
      await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve'),
    ).toMatchObject({ ok: false, code: 'voting_closed' });
  });

  it('enforces the cooling-off for treasury-controlling votes (WS-M.4.2c-2)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    // A wallet linked 2 days ago is inside the 7-day cooling-off.
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address, 2);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    expect(
      await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve'),
    ).toMatchObject({ ok: false, code: 'wallet_cooling_off' });
  });

  it('aggregates delegated weight under the delegated model, capped', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'delegated', maxVotingWeightPerAccount: 2 });
    await linkWallet(deps, WALLET_1, VOTER_2, testAccount.address);
    // Two members delegate to VOTER_2 (own 1 + 2 delegated = 3, capped to 2).
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: VOTER_2,
      scope: { all: true },
    });
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: STEWARD,
      delegateUserId: VOTER_2,
      scope: { proposal_type: 'capped_grant' },
    });
    const proposal = await createProposal(deps);
    await openVoting(deps);
    const vote = await castVote(
      deps,
      proposal.proposalId,
      VOTER_2,
      WALLET_1,
      testAccount,
      'approve',
    );
    if (!('signature' in vote)) throw new Error(JSON.stringify(vote));
    expect(vote.signature.weightSnapshot).toBe('2');
    // Revocation is public + audited.
    const delegations = await deps.delegations.listByRoom(ROOM, 10);
    const first = delegations.find((d) => d.delegatorUserId === PROPOSER);
    const revoked = await revokeDelegation(deps, {
      roomId: ROOM,
      delegationId: first?.delegationId ?? '',
      actorUserId: PROPOSER,
      isPlatformStaff: false,
    });
    expect(revoked).toMatchObject({ ok: true });
    const chain = await deps.governanceAudit.listChainedByRoom(ROOM);
    expect(chain.some((e) => e.actionType === 'delegation_revoked')).toBe(true);
  });

  it('excludes INELIGIBLE delegators from delegated weight (W3 review)', async () => {
    const deps = buildHarness();
    // Treasury votes need 30 membership days under this pack.
    await prepareRoom(deps, {
      weightModel: 'delegated',
      maxVotingWeightPerAccount: 5,
      eligibility: {
        minMembershipDays: 30,
        minContributions: 0,
        requireVerifiedIdentity: false,
        newWalletCoolingOffDays: 0,
      },
    });
    await linkWallet(deps, WALLET_1, VOTER_2, testAccount.address);
    // PROPOSER is a 5-day member: their delegation must not boost the ballot.
    deps.memberFactsOverride.set(PROPOSER, {
      membershipDays: 5,
      contributionCount: 10,
      verifiedIdentity: true,
    });
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: VOTER_2,
      scope: { all: true },
    });
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: STEWARD,
      delegateUserId: VOTER_2,
      scope: { all: true },
    });
    const proposal = await createProposal(deps);
    await openVoting(deps);
    const vote = await castVote(
      deps,
      proposal.proposalId,
      VOTER_2,
      WALLET_1,
      testAccount,
      'approve',
    );
    if (!('signature' in vote)) throw new Error(JSON.stringify(vote));
    // Own 1 + STEWARD's eligible delegation = 2; PROPOSER's ineligible one is out.
    expect(vote.signature.weightSnapshot).toBe('2');
  });

  it('binds the cooling-off to the NEWEST active wallet (W3 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, {
      eligibility: {
        minMembershipDays: 0,
        minContributions: 0,
        requireVerifiedIdentity: false,
        newWalletCoolingOffDays: 7,
      },
    });
    // The SELECTED wallet is 30 days old… but a fresh wallet linked yesterday
    // exists, and spend-controlling votes bind the newest one.
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address, 30);
    await linkWallet(deps, WALLET_2, PROPOSER, testAccount2.address, 1);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    expect(
      await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve'),
    ).toMatchObject({ ok: false, code: 'wallet_cooling_off' });
  });

  it('treasury-RULE proposals are treasury-controlling: cooling-off applies (W5 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, {
      allowedProposalTypes: ['capped_grant', 'charter_update', 'treasury_policy_update'],
      quorumRules: {
        capped_grant: { basis: 'eligible_voters', minFraction: 0.2 },
        charter_update: { basis: 'eligible_voters', minFraction: 0.2 },
        treasury_policy_update: { basis: 'eligible_voters', minFraction: 0.2 },
      },
      thresholdRules: {
        capped_grant: { minAffirmativeFraction: 0.5 },
        charter_update: { minAffirmativeFraction: 0.5 },
        treasury_policy_update: { minAffirmativeFraction: 0.5 },
      },
      timelockRules: {
        capped_grant: { seconds: 3_600 },
        charter_update: { seconds: 3_600 },
        treasury_policy_update: { seconds: 3_600 },
      },
    });
    // Steward-only type; carries NO spend category — before the fix a fresh
    // wallet could vote to rewrite the treasury's rules.
    const created = await createProductionProposal(deps, {
      roomId: ROOM,
      userId: STEWARD,
      create: draft({
        proposal_type: 'treasury_policy_update',
        category: null,
        requested_amount: null,
        asset: null,
        recipient_ref: null,
        requested_action: { kind: 'law_pack_upgrade' },
      }),
    });
    if (!('proposal' in created)) throw new Error(JSON.stringify(created));
    await openVoting(deps);
    await linkWallet(deps, WALLET_1, VOTER_2, testAccount.address, 1); // 1d < 7d cooling-off
    expect(
      await castVote(deps, created.proposal.proposalId, VOTER_2, WALLET_1, testAccount, 'approve'),
    ).toMatchObject({ ok: false, code: 'wallet_cooling_off' });
  });

  it('the grant RECIPIENT is recused from their own payout vote (W5 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, {
      coiRequirements: {
        disclosureTriggers: ['financial relationship'],
        recusalRequired: true,
        independentReviewFor: ['capped_grant'],
      },
    });
    const proposal = await createProposal(deps, { recipient_ref: `user:${VOTER_2}` });
    await openVoting(deps);
    await linkWallet(deps, WALLET_1, VOTER_2, testAccount.address);
    // The member being PAID cannot weigh in on paying themselves.
    expect(
      await castVote(deps, proposal.proposalId, VOTER_2, WALLET_1, testAccount, 'approve'),
    ).toMatchObject({ ok: false, code: 'coi_recusal' });
  });

  it('one delegator contributes ONE delegated weight even with two matching scopes (W5 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'delegated', maxVotingWeightPerAccount: 5 });
    await linkWallet(deps, WALLET_1, VOTER_2, testAccount.address);
    // PROPOSER holds BOTH an all-scope and a type-scope delegation to VOTER_2:
    // without the dedup the same delegator would double-boost the ballot.
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: VOTER_2,
      scope: { all: true },
    });
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: VOTER_2,
      scope: { proposal_type: 'capped_grant' },
    });
    const proposal = await createProposal(deps);
    await openVoting(deps);
    const vote = await castVote(
      deps,
      proposal.proposalId,
      VOTER_2,
      WALLET_1,
      testAccount,
      'approve',
    );
    if (!('signature' in vote)) throw new Error(JSON.stringify(vote));
    expect(vote.signature.weightSnapshot).toBe('2'); // own 1 + PROPOSER once
  });

  it('a delegator who already voted keeps their ballot out of the delegate weight (W5 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'delegated', maxVotingWeightPerAccount: 5 });
    await linkWallet(deps, WALLET_1, VOTER_2, testAccount.address);
    await linkWallet(deps, WALLET_2, PROPOSER, testAccount2.address);
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: VOTER_2,
      scope: { all: true },
    });
    const proposal = await createProposal(deps);
    await openVoting(deps);
    // The delegator votes THEMSELVES first — their weight is spent.
    const own = await castVote(
      deps,
      proposal.proposalId,
      PROPOSER,
      WALLET_2,
      testAccount2,
      'reject',
    );
    if (!('signature' in own)) throw new Error(JSON.stringify(own));
    const vote = await castVote(
      deps,
      proposal.proposalId,
      VOTER_2,
      WALLET_1,
      testAccount,
      'approve',
    );
    if (!('signature' in vote)) throw new Error(JSON.stringify(vote));
    expect(vote.signature.weightSnapshot).toBe('1'); // own only — no double-count
  });
});

describe('settle + challenge + execute (WS-M.4.2d/4.3a/4.3b)', () => {
  /** Drive a proposal to `passed` with quorum met (2 approvals of 3 eligible). */
  async function passProposal(deps: TestHarness) {
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    await castVote(deps, proposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    const settled = await deps.proposals.getById(proposal.proposalId);
    if (settled === null) throw new Error('proposal lost');
    return settled;
  }

  it('escalation is steward/platform-gated and survives sibling dismissals', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps);
    const first = await fileChallenge(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: VOTER_2,
      challengeType: 'coi',
      description: 'Undisclosed conflict.',
      evidenceRefs: [],
    });
    if ('code' in first) throw new Error(first.message);
    const second = await fileChallenge(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: VOTER_2,
      challengeType: 'fraud',
      description: 'Numbers look fabricated.',
      evidenceRefs: [],
    });
    if ('code' in second) throw new Error(second.message);

    // A plain member cannot escalate (it blocks execution — a free veto).
    const memberEscalate = await resolveChallenge(deps, {
      roomId: ROOM,
      challengeId: first.challenge.challengeId,
      resolution: 'escalated',
      resolutionNote: 'Send it up.',
      actorUserId: VOTER_2,
      isPlatformStaff: false,
    });
    expect('code' in memberEscalate && memberEscalate.code).toBe('steward_required');

    // A steward escalates the first…
    const escalated = await resolveChallenge(deps, {
      roomId: ROOM,
      challengeId: first.challenge.challengeId,
      resolution: 'escalated',
      resolutionNote: 'Platform should look.',
      actorUserId: STEWARD,
      isPlatformStaff: false,
    });
    if ('code' in escalated) throw new Error(escalated.message);
    // …and dismissing the SECOND must not clear the live escalation.
    const dismissed = await resolveChallenge(deps, {
      roomId: ROOM,
      challengeId: second.challenge.challengeId,
      resolution: 'dismissed',
      resolutionNote: 'Unfounded.',
      actorUserId: STEWARD,
      isPlatformStaff: false,
    });
    if ('code' in dismissed) throw new Error(dismissed.message);
    expect((await deps.proposals.getById(settled.proposalId))?.challengeState).toBe('escalated');
  });

  it('settles a quorum-meeting majority to passed with timelock + reservation', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps);
    expect(settled.votingState).toBe('passed');
    expect(settled.executionState).toBe('timelocked');
    expect(settled.challengeWindowEndsAt).not.toBeNull();
    expect(settled.tallySnapshot).toMatchObject({ outcome: 'passed', approve: '2' });
    const reservation = await deps.reservations.getByProposal(settled.proposalId);
    expect(reservation).toMatchObject({ state: 'reserved', amount: '4000' });
  });

  it('expires below quorum at the deadline', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    expect((await deps.proposals.getById(proposal.proposalId))?.votingState).toBe('quorum_not_met');
  });

  it('executes through the shipped treasury executor, consumes the reservation, creates the grant', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps);
    // Before the timelock elapses + challenge window closes, execution refuses
    // (the timelock guard fires first; the window guard covers the remainder).
    expect(
      await executeProposal(deps, {
        roomId: ROOM,
        proposalId: settled.proposalId,
        userId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'timelocked' });
    deps.clockAdvance(3_600 * 1000 + 1_000); // past the 1h law-pack timelock
    expect(
      await executeProposal(deps, {
        roomId: ROOM,
        proposalId: settled.proposalId,
        userId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'challenge_window_open' });
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    const executed = await executeProposal(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: STEWARD,
    });
    if (!('proposal' in executed)) throw new Error(JSON.stringify(executed));
    expect(executed.proposal.executionState).toBe('executed');
    // The kernel check rode the proposal's PINNED pack (W6 review).
    expect(deps.executorCalls).toEqual([{ category: 'grant', amount: '4000', pinned: true }]);
    expect((await deps.reservations.getByProposal(settled.proposalId))?.state).toBe('consumed');
    const grant = await deps.grants.getByProposal(settled.proposalId);
    expect(grant).toMatchObject({ amount: '4000', payoutState: 'not_started' });
    // Only stewards execute; a second execute cannot double-run.
    expect(
      await executeProposal(deps, {
        roomId: ROOM,
        proposalId: settled.proposalId,
        userId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'not_executable' });
    expect((await verifyAuditChain(deps, ROOM)).valid).toBe(true);
  });

  it('a kernel rejection blocks execution and releases the reservation', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    deps.executorAccepts.value = false;
    const failed = await executeProposal(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: STEWARD,
    });
    expect(failed).toMatchObject({ ok: false, code: 'per_action_cap_exceeded' });
    expect((await deps.proposals.getById(settled.proposalId))?.executionState).toBe('blocked');
    expect((await deps.reservations.getByProposal(settled.proposalId))?.state).toBe('released');
  });

  it('challenges block execution; upheld releases; dismissed unblocks; legal needs platform', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps);
    const filed = await fileChallenge(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: VOTER_2,
      challengeType: 'coi',
      description: 'The proposer has an undisclosed relationship with the recipient.',
      evidenceRefs: ['https://example.com/evidence'],
    });
    if (!('challenge' in filed)) throw new Error(JSON.stringify(filed));
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    expect(
      await executeProposal(deps, {
        roomId: ROOM,
        proposalId: settled.proposalId,
        userId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'challenge_blocking' });
    // The proposer cannot judge a challenge against their own proposal — but
    // STEWARD here is independent, so dismissal unblocks execution.
    const dismissed = await resolveChallenge(deps, {
      roomId: ROOM,
      challengeId: filed.challenge.challengeId,
      resolution: 'dismissed',
      resolutionNote: 'Reviewed: no relationship found.',
      actorUserId: STEWARD,
      isPlatformStaff: false,
    });
    expect(dismissed).toMatchObject({ ok: true });
    expect(
      await executeProposal(deps, {
        roomId: ROOM,
        proposalId: settled.proposalId,
        userId: STEWARD,
      }),
    ).toMatchObject({ ok: true });

    // A second scenario: a LEGAL challenge needs platform staff.
    const deps2 = buildHarness();
    await prepareRoom(deps2);
    const settled2 = await passProposal(deps2);
    const legal = await fileChallenge(deps2, {
      roomId: ROOM,
      proposalId: settled2.proposalId,
      userId: VOTER_2,
      challengeType: 'legal',
      description: 'This disbursement may violate a court order in effect.',
      evidenceRefs: [],
    });
    if (!('challenge' in legal)) throw new Error('legal challenge');
    expect(
      await resolveChallenge(deps2, {
        roomId: ROOM,
        challengeId: legal.challenge.challengeId,
        resolution: 'upheld',
        resolutionNote: 'Confirmed.',
        actorUserId: STEWARD,
        isPlatformStaff: false,
      }),
    ).toMatchObject({ ok: false, code: 'platform_review_required' });
    const upheld = await resolveChallenge(deps2, {
      roomId: ROOM,
      challengeId: legal.challenge.challengeId,
      resolution: 'upheld',
      resolutionNote: 'Confirmed by legal.',
      actorUserId: 'admin',
      isPlatformStaff: true,
    });
    expect(upheld).toMatchObject({ ok: true });
    expect((await deps2.proposals.getById(settled2.proposalId))?.executionState).toBe('blocked');
    expect((await deps2.reservations.getByProposal(settled2.proposalId))?.state).toBe('released');
  });

  it('an unexecuted proposal expires after the execution window and frees headroom', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps);
    deps.clockAdvance((DEFAULT_KNOMOSIS_CONFIG.wsmExecutionWindowSeconds + 7_200) * 1000 + 60_000);
    await settleDueProposals(deps, ROOM);
    expect((await deps.proposals.getById(settled.proposalId))?.executionState).toBe('expired');
    expect((await deps.reservations.getByProposal(settled.proposalId))?.state).toBe('released');
  });

  it('a role_class quorum counts ONLY designated-signer participation (W6 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, {
      multisig: { signers: [PROPOSER, VOTER_2], required: 2 },
      quorumRules: {
        capped_grant: { basis: 'role_class', minFraction: 1 },
        charter_update: { basis: 'eligible_voters', minFraction: 0.2 },
      },
    });
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await linkWallet(deps, WALLET_2, STEWARD, testAccount2.address);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    // TWO voters — but only ONE is in the role class.  Before the fix the
    // room-wide voter count satisfied quorum; the basis demands BOTH signers.
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    await castVote(deps, proposal.proposalId, STEWARD, WALLET_2, testAccount2, 'approve');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    expect((await deps.proposals.getById(proposal.proposalId))?.votingState).toBe('quorum_not_met');
  });

  it('multisig execution requires the designated-signer approvals (W6 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, { multisig: { signers: [STEWARD, VOTER_2], required: 2 } });
    const settled = await passProposal(deps); // votes: PROPOSER (W1) + VOTER_2 (W2)
    deps.clockAdvance(3_600 * 1000 + 1_000);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    // Timelock elapsed, challenges clear — but no designated-signer approvals.
    expect(
      await executeProposal(deps, {
        roomId: ROOM,
        proposalId: settled.proposalId,
        userId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'multisig_required' });
    // The two designated signers record APPROVAL signatures (fresh wallets —
    // the (proposal, wallet) unique holds one signature per wallet).
    const WALLET_3 = '33333333-3333-4333-8333-333333333333';
    const WALLET_4 = '44444444-4444-4444-8444-444444444444';
    const signer3 = privateKeyToAccount(`0x${'59'.repeat(32)}`);
    const signer4 = privateKeyToAccount(`0x${'5a'.repeat(32)}`);
    await linkWallet(deps, WALLET_3, STEWARD, signer3.address);
    await linkWallet(deps, WALLET_4, VOTER_2, signer4.address);
    const approve1 = await castVote(
      deps,
      settled.proposalId,
      STEWARD,
      WALLET_3,
      signer3,
      'approve',
      { purpose: 'approval', choice: null },
    );
    expect(approve1).toMatchObject({ ok: true });
    // One approval of the required two still refuses.
    expect(
      await executeProposal(deps, {
        roomId: ROOM,
        proposalId: settled.proposalId,
        userId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'multisig_required' });
    const approve2 = await castVote(
      deps,
      settled.proposalId,
      VOTER_2,
      WALLET_4,
      signer4,
      'approve',
      { purpose: 'approval', choice: null },
    );
    expect(approve2).toMatchObject({ ok: true });
    const executed = await executeProposal(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: STEWARD,
    });
    expect(executed).toMatchObject({ ok: true });
  });

  it('manual execution refuses once the execution window has closed (W7 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps);
    // Past the timelock, the challenge window, AND the 14-day execution
    // window: a delayed sweep must not leave the proposal steward-executable.
    deps.clockAdvance(
      3_600 * 1000 + DEFAULT_KNOMOSIS_CONFIG.wsmExecutionWindowSeconds * 1000 + 60_000,
    );
    expect(
      await executeProposal(deps, {
        roomId: ROOM,
        proposalId: settled.proposalId,
        userId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'execution_window_expired' });
  });

  it('unpaid grant obligations stay encumbered against new spends (W7 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps); // 4000 USDC grant
    deps.clockAdvance(3_600 * 1000 + 1_000);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    const executed = await executeProposal(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: STEWARD,
    });
    expect(executed).toMatchObject({ ok: true });
    // The reservation is CONSUMED but the grant is unpaid — the cash is still
    // in the reconciled balance.  Re-reconcile to a small balance: 5000 on the
    // books, 4000 of it owed to the executed grant.
    const treasury = await deps.treasuries.getByRoom(ROOM);
    await deps.treasuries.setReconciliation(
      treasury?.treasuryId ?? '',
      'synced',
      { USDC: '5000' },
      new Date(deps.now()).toISOString(),
    );
    // A 4000 ask fits the window headroom (10000 − 4000 consumed = 6000) and
    // the raw balance — but only 1000 is actually free.
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ requested_amount: '4000' }),
      }),
    ).toMatchObject({ ok: false, code: 'insufficient_funds' });
    // A 900 ask fits the free liquidity.
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ requested_amount: '900' }),
      }),
    ).toMatchObject({ ok: true });
  });

  it('a disposed challenge is immutable: no re-resolution, no late escalation (W5 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps);
    const filed = await fileChallenge(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: VOTER_2,
      challengeType: 'coi',
      description: 'Undisclosed conflict.',
      evidenceRefs: [],
    });
    if ('code' in filed) throw new Error(filed.message);
    const dismissed = await resolveChallenge(deps, {
      roomId: ROOM,
      challengeId: filed.challenge.challengeId,
      resolution: 'dismissed',
      resolutionNote: 'No conflict found.',
      actorUserId: STEWARD,
      isPlatformStaff: false,
    });
    expect(dismissed).toMatchObject({ ok: true });
    // Replaying a resolve against the DISMISSED record must not rewrite the
    // disposition (dismissed → upheld would retro-block an executed proposal).
    expect(
      await resolveChallenge(deps, {
        roomId: ROOM,
        challengeId: filed.challenge.challengeId,
        resolution: 'upheld',
        resolutionNote: 'Changed my mind.',
        actorUserId: STEWARD,
        isPlatformStaff: true,
      }),
    ).toMatchObject({ ok: false, code: 'already_resolved' });
    // And a disposed challenge cannot be escalated either.
    expect(
      await resolveChallenge(deps, {
        roomId: ROOM,
        challengeId: filed.challenge.challengeId,
        resolution: 'escalated',
        resolutionNote: 'Too late.',
        actorUserId: STEWARD,
        isPlatformStaff: false,
      }),
    ).toMatchObject({ ok: false, code: 'already_resolved' });
  });
});

describe('grants (WS-M.5.1a)', () => {
  async function executedGrant(deps: TestHarness) {
    await prepareRoom(deps);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    const proposal = await createProposal(deps, {
      requested_action: {
        kind: 'grant',
        milestones: [
          { description: 'Draft', amount: '1500' },
          { description: 'Final', amount: '2500' },
        ],
      },
    });
    await openVoting(deps);
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    await castVote(deps, proposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    const executed = await executeProposal(deps, {
      roomId: ROOM,
      proposalId: proposal.proposalId,
      userId: STEWARD,
    });
    if (!('proposal' in executed)) throw new Error(JSON.stringify(executed));
    const grant = await deps.grants.getByProposal(proposal.proposalId);
    if (grant === null) throw new Error('grant missing');
    return grant;
  }

  it('milestone acceptance is review-gated and schedules idempotent tranches', async () => {
    const deps = buildHarness();
    const grant = await executedGrant(deps);
    expect(grant.milestones).toHaveLength(2);
    const [first] = grant.milestones;
    if (!first) throw new Error('milestone');
    // Walk to submitted.
    await updateGrantMilestone(deps, {
      roomId: ROOM,
      grantId: grant.grantId,
      milestoneId: first.milestoneId,
      state: 'in_progress',
      actorUserId: STEWARD,
    });
    await updateGrantMilestone(deps, {
      roomId: ROOM,
      grantId: grant.grantId,
      milestoneId: first.milestoneId,
      state: 'submitted',
      actorUserId: STEWARD,
    });
    // Acceptance blocked until the independent review clears.
    expect(
      await updateGrantMilestone(deps, {
        roomId: ROOM,
        grantId: grant.grantId,
        milestoneId: first.milestoneId,
        state: 'accepted',
        actorUserId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'independent_review_required' });
    // The PROPOSER cannot be the reviewer.
    expect(
      await setGrantReview(deps, {
        roomId: ROOM,
        grantId: grant.grantId,
        reviewState: 'cleared',
        reviewerUserId: PROPOSER,
      }),
    ).toMatchObject({ ok: false, code: 'independent_review_required' });
    await setGrantReview(deps, {
      roomId: ROOM,
      grantId: grant.grantId,
      reviewState: 'cleared',
      reviewerUserId: VOTER_2,
    });
    const accepted = await updateGrantMilestone(deps, {
      roomId: ROOM,
      grantId: grant.grantId,
      milestoneId: first.milestoneId,
      state: 'accepted',
      actorUserId: STEWARD,
    });
    if (!('grant' in accepted)) throw new Error(JSON.stringify(accepted));
    const tranche = accepted.grant.milestones.find((m) => m.milestoneId === first.milestoneId);
    expect(tranche?.paymentIntentId).not.toBeNull();
    // Scheduling an intent never claims payment: `partially_paid`/`paid` are
    // reconciliation verdicts at on-chain finality (PR #144 review).
    expect(accepted.grant.payoutState).toBe('scheduled');
    // The tranche intent exists with the milestone amount.
    const intent = await deps.intents.getById(tranche?.paymentIntentId ?? '');
    expect(intent).toMatchObject({ targetType: 'grant_payout', amount: '1500' });
  });

  it('rejects milestone plans that do not sum to the approved amount', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    const proposal = await createProposal(deps, {
      requested_action: {
        kind: 'grant',
        milestones: [{ description: 'Only', amount: '9999' }], // ≠ 4000
      },
    });
    await openVoting(deps);
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    await castVote(deps, proposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    await executeProposal(deps, { roomId: ROOM, proposalId: proposal.proposalId, userId: STEWARD });
    // The malformed plan yields NO grant (execution still settles the treasury
    // action; grant creation refuses the unsound tranche split).
    expect(await deps.grants.getByProposal(proposal.proposalId)).toBeNull();
  });

  it('rejects tranches that are negative, zero, or above the approved amount (W6 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    // `-100` + `4100` SUMS to the approved 4000 — but accepting the 4100
    // milestone first would disburse above the voted authorization.
    const proposal = await createProposal(deps, {
      requested_action: {
        kind: 'grant',
        milestones: [
          { description: 'Offset', amount: '-100' },
          { description: 'Over', amount: '4100' },
        ],
      },
    });
    await openVoting(deps);
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    await castVote(deps, proposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    const executed = await executeProposal(deps, {
      roomId: ROOM,
      proposalId: proposal.proposalId,
      userId: STEWARD,
    });
    expect(executed).toMatchObject({ ok: false, code: 'grant_creation_failed' });
    expect(await deps.grants.getByProposal(proposal.proposalId)).toBeNull();
  });
});
