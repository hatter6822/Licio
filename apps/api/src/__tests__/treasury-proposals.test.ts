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
import {
  createDelegation,
  delegatorsAlreadyConsumed,
  type PriorBallot,
  revokeDelegation,
} from '../treasury/delegations.js';
import { setGrantReview, updateGrantMilestone } from '../treasury/grants.js';
import { adoptLawPack, registerLawPack } from '../treasury/law-packs.js';
import {
  createProductionProposal,
  deterministicProposalId,
  executeProposal,
  fileChallenge,
  isTreasuryControlling,
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
    {
      membershipDays: number | null;
      contributionCount: number | null;
      verifiedIdentity: boolean;
      memberSince?: string;
    }
  >;
  /** Every `asOf` the ballot gate asked `memberFacts` for, in order. */
  memberFactsAsOf: (string | null)[];
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
  /** Every `asOf` the ballot gate asked `memberFacts` for, in order. */
  const memberFactsAsOf: (string | null)[] = [];
  const memberFactsOverride = new Map<
    string,
    {
      membershipDays: number | null;
      contributionCount: number | null;
      verifiedIdentity: boolean;
      memberSince?: string;
    }
  >();
  const membership: MembershipFactsPort = {
    memberFacts: async (_r, userId, asOf) => {
      // Recorded so a test can assert WHICH instant the gate asked about — the whole
      // defect was the gate asking about `now`.
      memberFactsAsOf.push(asOf ?? null);
      if (!members.has(userId)) return null;
      return (
        memberFactsOverride.get(userId) ?? {
          membershipDays: 60,
          contributionCount: 10,
          verifiedIdentity: true,
        }
      );
    },
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
    // Test actor ref (deterministic, non-reversible-enough for the chain hash).
    opaqueRef: (id: string) => `ref:${id}`,
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
    memberFactsAsOf,
  });
}

/** A fixture corpus that PROVES the given pack (WS-M.1.3c): one passing
 *  tally per allowed type, one accepted action per cap category, and an
 *  eligibility fixture matched to the pack's rules — real-asset adoption
 *  re-runs the corpus, so the harness registers proven packs (W9). */
function corpusFor(pack: Record<string, unknown>): Record<string, unknown> {
  const allowed = (pack['allowedProposalTypes'] as string[] | undefined) ?? [];
  const caps = ((pack['treasury'] as { caps?: { category: string }[] } | undefined)?.caps ??
    []) as {
    category: string;
  }[];
  const rules = pack['eligibility'] as
    | { minMembershipDays: number; newWalletCoolingOffDays: number }
    | undefined;
  const eligibilityFixture =
    rules !== undefined && rules.newWalletCoolingOffDays > 0
      ? {
          kind: 'eligibility',
          label: 'cooling-off recusal',
          facts: {
            userId: 'v1',
            membershipDays: Math.max(60, rules.minMembershipDays),
            contributionCount: 10,
            verifiedIdentity: true,
            newestWalletAgeDays: 0,
            walletClusterId: null,
            hasDisclosedConflict: false,
            roleClasses: [],
            reputationScore: 0,
            tokenVoteUnits: 0,
            isDesignatedSigner: false,
          },
          treasuryControlling: true,
          recusalRequired: false,
          clustersAlreadyVoted: [],
          expect: 'wallet_cooling_off',
        }
      : {
          kind: 'eligibility',
          label: 'fully eligible member',
          facts: {
            userId: 'v1',
            membershipDays: Math.max(60, rules?.minMembershipDays ?? 0),
            contributionCount: 10,
            verifiedIdentity: true,
            newestWalletAgeDays: 365,
            walletClusterId: null,
            hasDisclosedConflict: false,
            roleClasses: [],
            reputationScore: 0,
            tokenVoteUnits: 0,
            isDesignatedSigner: false,
          },
          treasuryControlling: true,
          recusalRequired: false,
          clustersAlreadyVoted: [],
          expect: 'eligible',
        };
  return {
    fixtures: [
      ...allowed.map((type) => {
        // The fixture must be tallied the way the RUNTIME (and now the validator)
        // will for this type's quorum BASIS.  A `role_class` quorum is measured
        // over the multisig signer set, so its `passes majority` fixture must have
        // the SIGNERS as voters (every signer participating clears quorum even at
        // minFraction 1; all approving clears the threshold).  An `eligible_voters`
        // quorum keeps the room-wide a/b/c majority over an eligibleCount of 3.
        const quorumRules = pack['quorumRules'] as
          | Record<string, { basis?: string } | undefined>
          | undefined;
        if (quorumRules?.[type]?.basis === 'role_class') {
          const signers = (pack['multisig'] as { signers?: string[] } | undefined)?.signers ?? [];
          return {
            kind: 'proposal_tally',
            label: `${type} passes majority`,
            proposalType: type,
            votes: signers.map((voterUserId) => ({
              voterUserId,
              choice: 'approve',
              weightSnapshot: 1,
            })),
            eligibleCount: signers.length,
            deadlinePassed: true,
            expect: 'passed',
          };
        }
        return {
          kind: 'proposal_tally',
          label: `${type} passes majority`,
          proposalType: type,
          votes: [
            { voterUserId: 'a', choice: 'approve', weightSnapshot: 1 },
            { voterUserId: 'b', choice: 'approve', weightSnapshot: 1 },
            { voterUserId: 'c', choice: 'reject', weightSnapshot: 1 },
          ],
          eligibleCount: 3,
          deadlinePassed: true,
          expect: 'passed',
        };
      }),
      ...caps.map((cap) => ({
        kind: 'treasury_action',
        label: `${cap.category} within caps accepts`,
        action: {
          category: cap.category,
          amount: '1',
          asset: 'USDC',
          coiDeclared: true,
          proposedAt: '2026-07-01T00:00:00.000Z',
          targetAllocation: null,
        },
        history: [],
        now: '2026-07-02T00:00:00.000Z',
        expect: 'accepted',
      })),
      eligibilityFixture,
    ],
  };
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
  const document = fullLawPack(packOverrides);
  const registered = await registerLawPack(deps, {
    roomId: ROOM,
    document,
    fixtures: corpusFor(document),
    actorUserId: STEWARD,
  });
  if (!('record' in registered)) throw new Error(JSON.stringify(registered));
  const adopted = await adoptLawPack(deps, {
    roomId: ROOM,
    lawPackId: registered.record.lawPackId,
    actorUserId: STEWARD,
  });
  if ('code' in adopted) throw new Error(JSON.stringify(adopted));
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

  // WS-K.2.2a §24.5.  `buildGovernanceAiDeps` was the one wiring builder with no
  // production caller, so the whole advisory module — plain-language summary,
  // missing required fields, conflict of interest, scam-pattern language — was
  // reachable from nothing.  These pin the port's CONTRACT: it receives the
  // published proposal, and it can never change the outcome.
  describe('the §24.5 advisory port (advisory means advisory)', () => {
    it('runs over a published proposal with the fields the §24.5 checks name', async () => {
      const deps = buildHarness();
      await prepareRoom(deps);
      const seen: Array<Record<string, unknown>> = [];
      deps.governanceAdvisor = async (input) => {
        seen.push(input as unknown as Record<string, unknown>);
      };
      const proposal = await createProposal(deps);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        proposalRef: proposal.proposalId,
        roomId: ROOM,
        proposerRef: PROPOSER,
        // `detectMissingFields` asks about budget/recipient/citations by those
        // names, so the mapping from this domain's fields has to be made once,
        // at the call site, rather than guessed per caller.
        fields: expect.objectContaining({ budget: '4000' }),
      });
    });

    it('reads the CANONICAL recipient, so proposer-as-recipient is seen', async () => {
      // The production contract carries the recipient in top-level
      // `recipient_ref`, and an ordinary spend draft need not repeat it inside
      // `requested_action` — so reading the action alone passed null for most
      // proposals and the conflict-of-interest check never fired on the ones it
      // exists for, while the missing-fields check called the recipient absent.
      const deps = buildHarness();
      await prepareRoom(deps);
      const seen: Array<Record<string, unknown>> = [];
      deps.governanceAdvisor = async (input) => {
        seen.push(input as unknown as Record<string, unknown>);
      };
      await createProposal(deps, { recipient_ref: `user:${PROPOSER}` });
      // Normalized past the accepted `user:` form, which is how the COI recusal
      // gate compares it — so the advisor and the gate name the same party.
      const advised = seen[0];
      if (advised === undefined) throw new Error('the advisor was not called');
      expect(advised['recipientRef']).toBe(PROPOSER);
      expect((advised['fields'] as Record<string, string>)['recipient']).toBe(`user:${PROPOSER}`);
    });

    it('a FAILING advisor never unpublishes an already-recorded proposal', async () => {
      const deps = buildHarness();
      await prepareRoom(deps);
      const alerts: string[] = [];
      deps.alert = (event) => alerts.push(event);
      deps.governanceAdvisor = async () => {
        throw new Error('model unavailable');
      };
      const proposal = await createProposal(deps);
      // Advice is not a precondition of governance: the proposal stands, the
      // audit entry stands, and the failure is reported operationally.
      expect(proposal.votingState).toBe('deliberation');
      const chain = await deps.governanceAudit.listChainedByRoom(ROOM);
      expect(chain.some((e) => e.actionType === 'proposal_published')).toBe(true);
      expect(alerts).toContain('governance.advisory.failed');
    });

    it('an UNWIRED advisor is silence, not a failure', async () => {
      const deps = buildHarness();
      await prepareRoom(deps);
      // A deployment with no AI wired keeps full governance — which is what
      // "advisory" has to mean if it means anything.
      expect(deps.governanceAdvisor).toBeUndefined();
      const proposal = await createProposal(deps);
      expect(proposal.votingState).toBe('deliberation');
    });
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

  it('replays BEFORE the freeze gate — a freeze after create cannot hide the proposal', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const key = crypto.randomUUID();
    const first = await createProposal(deps, { idempotency_key: key });
    // The room's governance freezes AFTER the proposal was created.
    await deps.profiles.setProfileFreeze(
      ROOM,
      'frozen',
      'incident',
      new Date(deps.now()).toISOString(),
    );
    // A lost-response retry replays the stored proposal (idempotency runs before
    // the mint-only writability gate), NOT a fresh governance_frozen.
    const replay = await createProductionProposal(deps, {
      roomId: ROOM,
      userId: PROPOSER,
      create: draft({ idempotency_key: key }),
    });
    expect(replay).toMatchObject({ ok: true });
    if ('proposal' in replay) expect(replay.proposal.proposalId).toBe(first.proposalId);
    // …but a NEW proposal IS blocked by the freeze (the gate still bites a mint).
    const fresh = await createProductionProposal(deps, {
      roomId: ROOM,
      userId: PROPOSER,
      create: draft({ idempotency_key: crypto.randomUUID() }),
    });
    expect(fresh).toMatchObject({ ok: false, code: 'governance_frozen' });
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
    const document = fullLawPack();
    const registered = await registerLawPack(fresh, {
      roomId: ROOM,
      document,
      fixtures: corpusFor(document),
      actorUserId: STEWARD,
    });
    if (!('record' in registered)) throw new Error('law pack');
    const adopted = await adoptLawPack(fresh, {
      roomId: ROOM,
      lawPackId: registered.record.lawPackId,
      actorUserId: STEWARD,
    });
    if ('code' in adopted) throw new Error(JSON.stringify(adopted));
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

  it('a preflight-rejected draft burns NO action budget (W15)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps); // cost 5, max 10 ⇒ two funded creates
    // Two drafts die at the per-action cap — rejection-only checks now run
    // BEFORE the charge, so the member's allowance is untouched.
    for (let i = 0; i < 2; i += 1) {
      expect(
        await createProductionProposal(deps, {
          roomId: ROOM,
          userId: PROPOSER,
          create: draft({ requested_amount: '6000', idempotency_key: crypto.randomUUID() }),
        }),
      ).toMatchObject({ ok: false, code: 'per_action_cap_exceeded' });
    }
    // Under the old order those two failures drained the whole budget; both
    // funded creates still succeed.
    await createProposal(deps);
    await createProposal(deps);
    expect(
      await createProductionProposal(deps, { roomId: ROOM, userId: PROPOSER, create: draft() }),
    ).toMatchObject({ ok: false, code: 'insufficient_budget' });
  });

  it('non-spend proposals reject a recipient_ref — the recusal weapon (W15)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    // Naming `user:<member>` on a policy/charter proposal would recuse that
    // member (and their delegated unit) from a vote with no recipient.
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: STEWARD,
        create: draft({
          proposal_type: 'charter_update',
          category: null,
          requested_amount: null,
          asset: null,
          recipient_ref: `user:${VOTER_2}`,
          requested_action: { kind: 'charter_update', sections: {} },
        }),
      }),
    ).toMatchObject({ ok: false, code: 'draft_invalid' });
  });

  it('a supplied milestone schedule outside 1..16 entries is INVALID, never the fallback (W15)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    // 17 tranches: before the fix both plan builders silently replaced the
    // voted schedule with ONE full-amount milestone.
    const seventeen = Array.from({ length: 17 }, (_, i) => ({
      description: `Tranche ${i + 1}`,
      amount: i === 0 ? '400' : '225',
    }));
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ requested_action: { kind: 'grant', milestones: seventeen } }),
      }),
    ).toMatchObject({ ok: false, code: 'milestones_invalid' });
    // A supplied non-array (or empty) schedule is equally invalid.
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({
          requested_action: { kind: 'grant', milestones: 'all-at-once' },
          idempotency_key: crypto.randomUUID(),
        }),
      }),
    ).toMatchObject({ ok: false, code: 'milestones_invalid' });
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({
          requested_action: { kind: 'grant', milestones: [] },
          idempotency_key: crypto.randomUUID(),
        }),
      }),
    ).toMatchObject({ ok: false, code: 'milestones_invalid' });
    // An ABSENT key still falls through to the single full-amount milestone.
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ idempotency_key: crypto.randomUUID() }),
      }),
    ).toMatchObject({ ok: true });
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

  it('law-pack upgrades must target a published pack of this room (W8 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, {
      allowedProposalTypes: ['capped_grant', 'charter_update', 'law_pack_upgrade'],
      quorumRules: {
        capped_grant: { basis: 'eligible_voters', minFraction: 0.2 },
        charter_update: { basis: 'eligible_voters', minFraction: 0.2 },
        law_pack_upgrade: { basis: 'eligible_voters', minFraction: 0.2 },
      },
      thresholdRules: {
        capped_grant: { minAffirmativeFraction: 0.5 },
        charter_update: { minAffirmativeFraction: 0.5 },
        law_pack_upgrade: { minAffirmativeFraction: 0.5 },
      },
      timelockRules: {
        capped_grant: { seconds: 3_600 },
        charter_update: { seconds: 3_600 },
        law_pack_upgrade: { seconds: 3_600 },
      },
    });
    // A random id would deliberate, pass, and only then die at execution.
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: STEWARD,
        create: draft({
          proposal_type: 'law_pack_upgrade',
          category: null,
          requested_amount: null,
          asset: null,
          recipient_ref: null,
          requested_action: { kind: 'law_pack_upgrade', law_pack_id: crypto.randomUUID() },
        }),
      }),
    ).toMatchObject({ ok: false, code: 'law_pack_target_invalid' });
  });

  it('an upgrade targeting a fixture-less pack rejects at CREATE (W11 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, {
      allowedProposalTypes: ['capped_grant', 'charter_update', 'law_pack_upgrade'],
      quorumRules: {
        capped_grant: { basis: 'eligible_voters', minFraction: 0.2 },
        charter_update: { basis: 'eligible_voters', minFraction: 0.2 },
        law_pack_upgrade: { basis: 'eligible_voters', minFraction: 0.2 },
      },
      thresholdRules: {
        capped_grant: { minAffirmativeFraction: 0.5 },
        charter_update: { minAffirmativeFraction: 0.5 },
        law_pack_upgrade: { minAffirmativeFraction: 0.5 },
      },
      timelockRules: {
        capped_grant: { seconds: 3_600 },
        charter_update: { seconds: 3_600 },
        law_pack_upgrade: { seconds: 3_600 },
      },
    });
    // The freeze guard on registration is off (room active); the pack is
    // structurally valid but NEVER fixture-proven.
    const registered = await registerLawPack(deps, {
      roomId: ROOM,
      document: fullLawPack({ version: '2.0.0' }),
      fixtures: null,
      actorUserId: STEWARD,
    });
    if (!('record' in registered)) throw new Error(JSON.stringify(registered));
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: STEWARD,
        create: draft({
          proposal_type: 'law_pack_upgrade',
          category: null,
          requested_amount: null,
          asset: null,
          recipient_ref: null,
          requested_action: {
            kind: 'law_pack_upgrade',
            law_pack_id: registered.record.lawPackId,
          },
        }),
      }),
    ).toMatchObject({ ok: false, code: 'law_pack_not_real_asset_ready' });
  });

  it('a malformed fixture corpus rejects publication outright (W12 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    // Valid DOCUMENT, garbage FIXTURES: silently publishing with
    // `fixtures: null` would drop the proof corpus the steward attached.
    expect(
      await registerLawPack(deps, {
        roomId: ROOM,
        document: fullLawPack({ version: '4.0.0' }),
        fixtures: { fixtures: 'not-an-array' },
        actorUserId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'law_pack_coverage_gap' });
  });

  it('rejected milestones leave the liquidity encumbrance (W12 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const treasury = await deps.treasuries.getByRoom(ROOM);
    if (treasury === null) throw new Error('treasury missing');
    // A 4000 grant whose 3000 tranche was terminally REJECTED: only the 1000
    // pending tranche still encumbers.
    const inserted = await deps.grants.insert({
      grantId: crypto.randomUUID(),
      roomId: ROOM,
      treasuryId: treasury.treasuryId,
      proposalId: crypto.randomUUID(),
      recipientRef: `0x${'cd'.repeat(20)}`,
      purpose: 'Partially rejected grant',
      amount: '4000',
      asset: 'USDC',
      milestones: [
        {
          milestoneId: crypto.randomUUID(),
          description: 'Rejected',
          amount: '3000',
          state: 'rejected',
          paymentIntentId: null,
        },
        {
          milestoneId: crypto.randomUUID(),
          description: 'Pending',
          amount: '1000',
          state: 'pending',
          paymentIntentId: null,
        },
      ],
      milestoneState: 'rejected',
      reviewState: 'cleared',
      payoutState: 'not_started',
      auditSummary: null,
      createdAt: new Date().toISOString(),
    });
    if (inserted === null) throw new Error('fixture grant collision');
    await deps.treasuries.setReconciliation(
      treasury.treasuryId,
      'synced',
      { USDC: '5000' },
      new Date(deps.now()).toISOString(),
    );
    // Free liquidity = 5000 − 1000 (pending tranche only): a 3900 ask fits —
    // encumbering the whole 4000 would have blocked it forever.
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ requested_amount: '3900' }),
      }),
    ).toMatchObject({ ok: true });
    // …and the pending 1000 still counts: 4100 exceeds the free liquidity.
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ requested_amount: '4100' }),
      }),
    ).toMatchObject({ ok: false, code: 'insufficient_funds' });
  });

  it('a frozen room cannot register a new law-pack (W10 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const profile = await deps.profiles.get(ROOM);
    if (profile === null) throw new Error('profile missing');
    await deps.profiles.upsert({ ...profile, freezeState: 'frozen', freezeReason: 'Review.' });
    expect(
      await registerLawPack(deps, {
        roomId: ROOM,
        document: fullLawPack({ version: '3.0.0' }),
        fixtures: null,
        actorUserId: STEWARD,
      }),
    ).toMatchObject({ ok: false, code: 'governance_frozen' });
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

  it('a real-asset room cannot adopt a pack registered WITHOUT fixtures (W9 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const registered = await registerLawPack(deps, {
      roomId: ROOM,
      document: fullLawPack({ version: '1.3.0' }),
      fixtures: null, // structurally valid, never fixture-proven
      actorUserId: STEWARD,
    });
    if (!('record' in registered)) throw new Error(JSON.stringify(registered));
    const adopted = await adoptLawPack(deps, {
      roomId: ROOM,
      lawPackId: registered.record.lawPackId,
      actorUserId: STEWARD,
    });
    expect(adopted).toMatchObject({ ok: false, code: 'law_pack_not_real_asset_ready' });
    if (!('code' in adopted)) throw new Error('unreachable');
    expect(adopted.message).toMatch(/fixture corpus/i);
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

  it('rejects a delegator’s direct ballot after their delegate already voted (WS-M.4.2c-1)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'delegated', maxVotingWeightPerAccount: 2 });
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    // PROPOSER delegates to VOTER_2.
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: VOTER_2,
      scope: { all: true },
    });
    const proposal = await createProposal(deps);
    await openVoting(deps);
    // The DELEGATE votes FIRST: their snapshot already includes PROPOSER's unit.
    const delegateVote = await castVote(
      deps,
      proposal.proposalId,
      VOTER_2,
      WALLET_2,
      testAccount2,
      'approve',
    );
    if (!('signature' in delegateVote)) throw new Error(JSON.stringify(delegateVote));
    expect(delegateVote.signature.weightSnapshot).toBe('2');
    // PROPOSER (the delegator) now voting directly would double-count their unit —
    // it must be refused (the symmetric mitigation to the delegator-first guard).
    expect(
      await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve'),
    ).toMatchObject({ ok: false, code: 'delegated_weight_already_cast' });
  });

  it('a member the LAGGING open counted can still cast their ballot (WS-M.4.2c)', async () => {
    // The denominator and the numerator have to answer to ONE instant.
    // `eligibleBasisCount` is the membership at the actual deliberation→open
    // transition, and the cutoff used to read the SCHEDULED
    // `deliberationEndsAt` — so ordinary tick lag (or a room freeze) admitted
    // members to the basis and refused them a ballot, and enough such joins
    // made quorum unreachable however many eligible members voted.
    const deps = buildHarness();
    await prepareRoom(deps);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    const proposal = await createProposal(deps);
    const deadline = Date.parse(proposal.deliberationEndsAt ?? '');
    // The scheduler runs an HOUR late…
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmDeliberationSeconds * 1000 + 1_000 + 3_600_000);
    await settleDueProposals(deps, ROOM);
    const opened = await deps.proposals.getById(proposal.proposalId);
    expect(opened?.votingState).toBe('open');
    // …so the basis was counted well after the scheduled deadline, and the
    // instant is recorded rather than inferred from the schedule.
    expect(Date.parse(opened?.eligibleBasisAt ?? '')).toBeGreaterThan(deadline);

    // A member who joined between the deadline and the actual open was counted
    // in that basis, so their ballot must count too.
    deps.memberFactsOverride.set(PROPOSER, {
      membershipDays: 60,
      contributionCount: 10,
      verifiedIdentity: true,
      memberSince: new Date(deadline + 60_000).toISOString(),
    });
    const vote = await castVote(
      deps,
      proposal.proposalId,
      PROPOSER,
      WALLET_1,
      testAccount,
      'approve',
    );
    expect('signature' in vote).toBe(true);
  });

  it('a delegator who joined AFTER the freeze confers NOTHING (WS-M.4.2c)', async () => {
    // Delegation was the way around the electorate freeze.  The direct ballot
    // refuses a signer whose join postdates `eligibleBasisAt`; the incoming-
    // delegation fold applied the law-pack eligibility gate and nothing else,
    // so one question — "is this member inside the population the denominator
    // was counted over?" — was answered against a stamped instant for a direct
    // voter and against LIVE membership for a delegated one.  Post-open joiners
    // could hand their units to a delegate whose cap admits them all, and
    // delegated weight is what the threshold arithmetic consumes.
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'delegated', maxVotingWeightPerAccount: 5 });
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: VOTER_2,
      scope: { all: true },
    });
    const proposal = await createProposal(deps);
    await openVoting(deps);
    const opened = await deps.proposals.getById(proposal.proposalId);
    const frozenAt = Date.parse(opened?.eligibleBasisAt ?? '');
    expect(frozenAt).toBeGreaterThan(0);
    // The delegator joined a minute AFTER the basis was frozen.
    deps.memberFactsOverride.set(PROPOSER, {
      membershipDays: 60,
      contributionCount: 10,
      verifiedIdentity: true,
      memberSince: new Date(frozenAt + 60_000).toISOString(),
    });
    const vote = await castVote(
      deps,
      proposal.proposalId,
      VOTER_2,
      WALLET_2,
      testAccount2,
      'approve',
    );
    if (!('signature' in vote)) throw new Error(JSON.stringify(vote));
    // Own vote only — the post-freeze delegation conferred nothing…
    expect(vote.signature.weightSnapshot).toBe('1');
    // …and it is not recorded as consumed, so the unit is still the delegator's
    // to cast on the NEXT proposal.
    expect(vote.signature.countedDelegatorIds).toEqual([]);
  });

  it('a delegated unit the CAP dropped is still the delegator’s to cast (WS-M.4.2c-3)', async () => {
    // Existence is not consumption.  The delegate's fold stops at the
    // per-account ceiling, so with a cap of 1 — the default when a law pack
    // sets none — the delegate's own vote fills the cap and NO delegated unit
    // is counted.  The guard used to read "a live delegation existed when they
    // signed" and refuse the delegator anyway: the unit left the tally, and
    // the delegator was refused the ballot that would have carried it.
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'delegated', maxVotingWeightPerAccount: 1 });
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: VOTER_2,
      scope: { all: true },
    });
    const proposal = await createProposal(deps);
    await openVoting(deps);
    const delegateVote = await castVote(
      deps,
      proposal.proposalId,
      VOTER_2,
      WALLET_2,
      testAccount2,
      'approve',
    );
    if (!('signature' in delegateVote)) throw new Error(JSON.stringify(delegateVote));
    // The cap admitted the delegate's own vote and nothing else…
    expect(delegateVote.signature.weightSnapshot).toBe('1');
    // …and the ballot says so, which is what the guard below reads.
    expect(delegateVote.signature.countedDelegatorIds).toEqual([]);
    const direct = await castVote(
      deps,
      proposal.proposalId,
      PROPOSER,
      WALLET_1,
      testAccount,
      'approve',
    );
    if (!('signature' in direct)) throw new Error(JSON.stringify(direct));
    expect(direct.signature.weightSnapshot).toBe('1');
  });

  it('the cap admits delegators in a canonical order, and frees the rest (WS-M.4.2c-3)', async () => {
    // Cap 2 with TWO delegators: the delegate's own vote plus exactly ONE
    // delegated unit fits.  Which one is decided by the canonical fold order
    // (delegator id) rather than by store iteration, and the delegator the cap
    // left out is still free — `delegatorsAlreadyConsumed` is the predicate
    // both ballot guards read, so asserting it directly asserts both.
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'delegated', maxVotingWeightPerAccount: 2 });
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    for (const delegatorUserId of [STEWARD, PROPOSER]) {
      await createDelegation(deps, {
        roomId: ROOM,
        delegatorUserId,
        delegateUserId: VOTER_2,
        scope: { all: true },
      });
    }
    const proposal = await createProposal(deps);
    await openVoting(deps);
    const delegateVote = await castVote(
      deps,
      proposal.proposalId,
      VOTER_2,
      WALLET_2,
      testAccount2,
      'approve',
    );
    if (!('signature' in delegateVote)) throw new Error(JSON.stringify(delegateVote));
    expect(delegateVote.signature.weightSnapshot).toBe('2');
    // PROPOSER sorts before STEWARD, so the ceiling admitted PROPOSER — even
    // though STEWARD's delegation was created first.
    expect(delegateVote.signature.countedDelegatorIds).toEqual([PROPOSER]);
    const signatures = await deps.proposalSignatures.listByProposal(proposal.proposalId);
    const ballotByUser = new Map<string, PriorBallot>(
      signatures
        .filter((r) => r.purpose === 'vote')
        .map((r) => [
          r.userId,
          {
            createdAt: r.createdAt,
            weightSnapshot: r.weightSnapshot,
            countedDelegatorIds:
              r.countedDelegatorIds == null ? null : new Set<string>(r.countedDelegatorIds),
          },
        ]),
    );
    const consumed = await delegatorsAlreadyConsumed(
      deps.delegations,
      ROOM,
      proposal.proposalType,
      [PROPOSER, STEWARD],
      ballotByUser,
      null,
    );
    expect(consumed.has(PROPOSER)).toBe(true);
    expect(consumed.has(STEWARD)).toBe(false);

    // LEGACY ROW: `counted_delegator_ids` is null (written before migration 0105),
    // so the check falls back to timestamps — but a recorded weight of exactly 1
    // is positive proof that NO delegated unit was folded into that ballot,
    // whatever the timestamps say.  Refusing the delegator then erased a vote on
    // the strength of a delegation the tally never counted.
    const legacyWeightOne = new Map<string, PriorBallot>(
      [...ballotByUser].map(([userId, ballot]) => [
        userId,
        { ...ballot, weightSnapshot: '1', countedDelegatorIds: null },
      ]),
    );
    expect(
      await delegatorsAlreadyConsumed(
        deps.delegations,
        ROOM,
        proposal.proposalType,
        [PROPOSER, STEWARD],
        legacyWeightOne,
        null,
      ),
    ).toEqual(new Set());

    // …and a legacy row whose weight EXCEEDS 1 still falls back to the timestamp
    // test, because then a delegated unit really was folded and the row does not
    // say which.  The conservative answer is the one that cannot double-count.
    const legacyWeightTwo = new Map<string, PriorBallot>(
      [...ballotByUser].map(([userId, ballot]) => [
        userId,
        { ...ballot, weightSnapshot: '2', countedDelegatorIds: null },
      ]),
    );
    expect(
      (
        await delegatorsAlreadyConsumed(
          deps.delegations,
          ROOM,
          proposal.proposalType,
          [PROPOSER, STEWARD],
          legacyWeightTwo,
          null,
        )
      ).has(PROPOSER),
    ).toBe(true);
  });

  it('resolves EVERY candidate in ONE store read, not one per candidate', async () => {
    // A delegate can hold many incoming delegations, and this read must include
    // REVOKED rows — so before batching, one ballot performed N sequential scans of
    // a history a member can grow without limit by revoking and re-creating a
    // delegation.  The cost was attacker-controlled, not proportional to the ballot.
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'delegated', maxVotingWeightPerAccount: 5 });
    let singleReads = 0;
    let batchReads = 0;
    const realSingle = deps.delegations.listByDelegator.bind(deps.delegations);
    const realBatch = deps.delegations.listByDelegators.bind(deps.delegations);
    deps.delegations.listByDelegator = async (room: string, id: string) => {
      singleReads += 1;
      return realSingle(room, id);
    };
    deps.delegations.listByDelegators = async (room: string, ids: readonly string[]) => {
      batchReads += 1;
      return realBatch(room, ids);
    };
    await delegatorsAlreadyConsumed(
      deps.delegations,
      ROOM,
      'treasury_spend',
      [PROPOSER, STEWARD, VOTER_2],
      new Map(),
      null,
    );
    expect(batchReads).toBe(1);
    expect(singleReads).toBe(0);
  });

  it('asks for eligibility AS OF the frozen instant, not at the ballot', async () => {
    // The freeze covered only `memberSince`.  Tenure, contributions and identity were
    // read LIVE, so a member the frozen basis EXCLUDED for any of those could satisfy
    // the rule mid-window and vote against a denominator they were never counted in —
    // satisfying quorum, or turning a treasury decision, against a smaller frozen
    // figure.  The whole defect was the gate asking about `now`.
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'one_civic_account_one_vote' });
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    const opened = await deps.proposals.getById(proposal.proposalId);
    const frozenAt = opened?.eligibleBasisAt ?? '';
    expect(Date.parse(frozenAt)).toBeGreaterThan(0);
    deps.memberFactsAsOf.length = 0;
    const vote = await castVote(
      deps,
      proposal.proposalId,
      PROPOSER,
      WALLET_1,
      testAccount,
      'approve',
    );
    if (!('signature' in vote)) throw new Error(JSON.stringify(vote));
    // EVERY facts read on the ballot path used the frozen instant — none went live.
    expect(deps.memberFactsAsOf.length).toBeGreaterThan(0);
    expect([...new Set(deps.memberFactsAsOf)]).toEqual([frozenAt]);
  });

  it("asks for the DELEGATOR's eligibility at the frozen instant too", async () => {
    // The delegated arm had the identical asymmetry: its JOIN test was already frozen
    // while its eligibility verdict was live, so an ineligible delegator could become
    // eligible mid-window and boost a delegate's ballot.  Delegation is otherwise the
    // way around the freeze, and delegated weight is what the threshold arithmetic
    // consumes.
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'delegated', maxVotingWeightPerAccount: 5 });
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: VOTER_2,
      scope: { all: true },
    });
    const proposal = await createProposal(deps);
    await openVoting(deps);
    const opened = await deps.proposals.getById(proposal.proposalId);
    const frozenAt = opened?.eligibleBasisAt ?? '';
    expect(Date.parse(frozenAt)).toBeGreaterThan(0);
    deps.memberFactsAsOf.length = 0;
    const vote = await castVote(
      deps,
      proposal.proposalId,
      VOTER_2,
      WALLET_2,
      testAccount2,
      'approve',
    );
    if (!('signature' in vote)) throw new Error(JSON.stringify(vote));
    // At least TWO reads — the voter and the delegator — and every one frozen.
    expect(deps.memberFactsAsOf.length).toBeGreaterThan(1);
    expect([...new Set(deps.memberFactsAsOf)]).toEqual([frozenAt]);
  });

  it('REVOKING after the delegate voted does not return the unit (WS-M.4.2c-1)', async () => {
    // The guard used to read only ACTIVE delegations, so revoking erased its
    // evidence while the weight stayed inside the delegate's frozen
    // `weightSnapshot` — and the refusal message ("revoke the delegation to
    // vote directly") walked the delegator straight through the hole.
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'delegated', maxVotingWeightPerAccount: 2 });
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: VOTER_2,
      scope: { all: true },
    });
    const proposal = await createProposal(deps);
    await openVoting(deps);
    const delegateVote = await castVote(
      deps,
      proposal.proposalId,
      VOTER_2,
      WALLET_2,
      testAccount2,
      'approve',
    );
    if (!('signature' in delegateVote)) throw new Error(JSON.stringify(delegateVote));
    expect(delegateVote.signature.weightSnapshot).toBe('2'); // own 1 + PROPOSER's 1

    // Now revoke, then try to vote directly.
    const all = await deps.delegations.listByRoom(ROOM, 10);
    const mine = all.find((d) => d.delegatorUserId === PROPOSER);
    expect(
      await revokeDelegation(deps, {
        roomId: ROOM,
        delegationId: mine?.delegationId ?? '',
        actorUserId: PROPOSER,
        isPlatformStaff: false,
      }),
    ).toMatchObject({ ok: true });

    expect(
      await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve'),
    ).toMatchObject({ ok: false, code: 'delegated_weight_already_cast' });
  });

  it('SPLITTING an `all` and a `type:` delegation across two delegates counts the unit ONCE', async () => {
    // `incomingDelegationsFor` dedups per DELEGATE, so it cannot see a sibling
    // delegation the same delegator granted to someone else; `alreadyVoted`
    // does not catch it either, because that delegator never voted directly.
    // The unit was therefore counted once in each delegate's snapshot.
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'delegated', maxVotingWeightPerAccount: 3 });
    const WALLET_3 = '33333333-3333-4333-8333-333333333333';
    const signer3 = privateKeyToAccount(`0x${'59'.repeat(32)}`);
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    await linkWallet(deps, WALLET_3, STEWARD, signer3.address);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    // ONE delegator, TWO delegates, two scopes that both match this proposal.
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: VOTER_2,
      scope: { all: true },
    });
    const proposal = await createProposal(deps);
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: STEWARD,
      scope: { proposal_type: proposal.proposalType },
    });
    await openVoting(deps);

    const first = await castVote(
      deps,
      proposal.proposalId,
      VOTER_2,
      WALLET_2,
      testAccount2,
      'approve',
    );
    if (!('signature' in first)) throw new Error(JSON.stringify(first));
    expect(first.signature.weightSnapshot).toBe('2'); // own 1 + the delegated 1

    const second = await castVote(deps, proposal.proposalId, STEWARD, WALLET_3, signer3, 'approve');
    if (!('signature' in second)) throw new Error(JSON.stringify(second));
    // Their OWN vote only — PROPOSER's unit is already inside the first ballot.
    expect(second.signature.weightSnapshot).toBe('1');
  });

  it('allows a delegator’s direct vote when the delegation POST-DATES the delegate’s ballot (WS-M.4.2c-1)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, { weightModel: 'delegated', maxVotingWeightPerAccount: 2 });
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    // The delegate votes FIRST — no delegation exists yet, so weight = own 1.
    const delegateVote = await castVote(
      deps,
      proposal.proposalId,
      VOTER_2,
      WALLET_2,
      testAccount2,
      'approve',
    );
    if (!('signature' in delegateVote)) throw new Error(JSON.stringify(delegateVote));
    expect(delegateVote.signature.weightSnapshot).toBe('1');
    // PROPOSER delegates AFTER the ballot (advance the clock so the delegation's
    // createdAt is strictly later than the vote): it is NOT in VOTER_2's snapshot.
    deps.clockAdvance(1000);
    await createDelegation(deps, {
      roomId: ROOM,
      delegatorUserId: PROPOSER,
      delegateUserId: VOTER_2,
      scope: { all: true },
    });
    // So PROPOSER's direct vote (their own weight 1) stands — no double-count.
    const directVote = await castVote(
      deps,
      proposal.proposalId,
      PROPOSER,
      WALLET_1,
      testAccount,
      'approve',
    );
    if (!('signature' in directVote)) throw new Error(JSON.stringify(directVote));
    expect(directVote.signature.weightSnapshot).toBe('1');
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
    // The upgrade must target a real published, FIXTURE-PROVEN pack
    // (W6/W8/W11 create gate).
    const targetDoc = fullLawPack({ version: '1.1.0' });
    const target = await registerLawPack(deps, {
      roomId: ROOM,
      document: targetDoc,
      fixtures: corpusFor(targetDoc),
      actorUserId: STEWARD,
    });
    if (!('record' in target)) throw new Error(JSON.stringify(target));
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
        requested_action: { kind: 'law_pack_upgrade', law_pack_id: target.record.lawPackId },
      }),
    });
    if (!('proposal' in created)) throw new Error(JSON.stringify(created));
    await openVoting(deps);
    await linkWallet(deps, WALLET_1, VOTER_2, testAccount.address, 1); // 1d < 7d cooling-off
    expect(
      await castVote(deps, created.proposal.proposalId, VOTER_2, WALLET_1, testAccount, 'approve'),
    ).toMatchObject({ ok: false, code: 'wallet_cooling_off' });
  });

  it('policy-type proposals count quorum with the treasury-controlling basis (W14)', async () => {
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
    const targetDoc = fullLawPack({ version: '1.1.0' });
    const target = await registerLawPack(deps, {
      roomId: ROOM,
      document: targetDoc,
      fixtures: corpusFor(targetDoc),
      actorUserId: STEWARD,
    });
    if (!('record' in target)) throw new Error(JSON.stringify(target));
    const created = await createProductionProposal(deps, {
      roomId: ROOM,
      userId: STEWARD,
      create: draft({
        proposal_type: 'treasury_policy_update',
        category: null,
        requested_amount: null,
        asset: null,
        recipient_ref: null,
        requested_action: { kind: 'law_pack_upgrade', law_pack_id: target.record.lawPackId },
      }),
    });
    if (!('proposal' in created)) throw new Error(JSON.stringify(created));
    // Capture the eligibility basis the quorum denominator is computed with:
    // the ballot gate treats a category-less rule rewrite as spend-controlling,
    // so the denominator must apply the SAME predicate — members who could
    // never sign must not inflate it (W14).
    //
    // The observation point is BEFORE `openVoting`, because the basis is frozen
    // at the `deliberation → open` transition rather than recomputed at settle
    // (migration 0100): reading it fresh at settle let membership growth after
    // the last ballot nullify a decided proposal.
    const inner = deps.membership;
    const captured: boolean[] = [];
    deps.membership = {
      // FORWARDS `asOf`.  A positional forward that drops it compiles cleanly and
      // makes every test through this harness exercise the pre-freeze live-facts path
      // while appearing to cover the frozen one.
      memberFacts: (roomId, userId, asOf) => inner.memberFacts(roomId, userId, asOf),
      eligibleMemberCount: (roomId, eligibility) => {
        if (eligibility !== undefined) captured.push(eligibility.treasuryControlling);
        return inner.eligibleMemberCount(roomId, eligibility);
      },
    };
    await openVoting(deps);
    expect(captured).toContain(true);
    expect(captured).not.toContain(false);
    // …and it really was recorded, not merely computed and discarded.
    const opened = await deps.proposals.getById(created.proposal.proposalId);
    expect(opened?.votingState).toBe('open');
    expect(opened?.eligibleBasisCount).toBeGreaterThan(0);

    await linkWallet(deps, WALLET_1, VOTER_2, testAccount.address);
    await castVote(deps, created.proposal.proposalId, VOTER_2, WALLET_1, testAccount, 'approve');
    captured.length = 0;
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    // The settle tally uses the FROZEN basis, so it asks the membership port
    // nothing — that silence is the fix.
    expect(captured).toEqual([]);
    // The ONE predicate both gates share.
    expect(isTreasuryControlling({ category: null, proposalType: 'treasury_policy_update' })).toBe(
      true,
    );
    expect(isTreasuryControlling({ category: null, proposalType: 'law_pack_upgrade' })).toBe(true);
    expect(isTreasuryControlling({ category: null, proposalType: 'charter_update' })).toBe(false);
    expect(isTreasuryControlling({ category: 'grant', proposalType: 'capped_grant' })).toBe(true);
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
  /** Vote an ALREADY-OPEN proposal to `passed` (wallets pre-linked). */
  async function passProposalVotes(deps: TestHarness, proposal: { proposalId: string }) {
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    await castVote(deps, proposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    const settled = await deps.proposals.getById(proposal.proposalId);
    if (settled === null) throw new Error('proposal lost');
    return settled;
  }

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
    // A SECOND challenger (one open challenge per member — sweep cap).
    const second = await fileChallenge(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: STEWARD,
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
    // While voting is still OPEN, an approval cannot be recorded (W9): stale
    // pre-pass approvals would later satisfy the execution count.
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    const draftProposal = await createProposal(deps);
    await openVoting(deps);
    expect(
      await castVote(deps, draftProposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve', {
        purpose: 'approval',
        choice: null,
      }),
    ).toMatchObject({ ok: false, code: 'not_approvable' });
    const settled = await passProposalVotes(deps, draftProposal);
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
    // An approval carries NO ballot choice — a signed `approve`/`reject`
    // riding the approval purpose rejects outright (W8 review).
    const WALLET_3 = '33333333-3333-4333-8333-333333333333';
    const signer3 = privateKeyToAccount(`0x${'59'.repeat(32)}`);
    await linkWallet(deps, WALLET_3, STEWARD, signer3.address);
    expect(
      await castVote(deps, settled.proposalId, STEWARD, WALLET_3, signer3, 'approve', {
        purpose: 'approval',
      }),
    ).toMatchObject({ ok: false, code: 'choice_not_allowed' });
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
    // VOTER_2 already VOTED with WALLET_2 — the SAME wallet records the
    // execution approval (migration 0084: uniqueness scopes by purpose, so a
    // signer who voted is never locked out of co-signing) (W8 review).
    const approve2 = await castVote(
      deps,
      settled.proposalId,
      VOTER_2,
      WALLET_2,
      testAccount2,
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

  it('ledger-only signature rows (null snapshot) never tally or satisfy quorum (W8 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    // A generic WS-L `proposal_sign` submit records a DURABLE row with no
    // weight snapshot (it never passed the WS-M eligibility/weight gate).
    // Two such rows would otherwise meet the 0.2×3 quorum as distinct voters.
    for (const userId of [PROPOSER, VOTER_2]) {
      await deps.proposalSignatures.insert({
        signatureId: crypto.randomUUID(),
        proposalId: proposal.proposalId,
        userId,
        walletAccountId: crypto.randomUUID(),
        signatureType: 'eip712_ecdsa',
        typedDataHash: `0x${'2'.repeat(64)}`,
        signatureRef: crypto.randomUUID(),
        weightSnapshot: null,
        eligibilityReason: 'proposal_sign accepted by the gateway (WS-L.3.2a; ledger-only)',
        createdAt: new Date(deps.now()).toISOString(),
        purpose: 'vote',
        choice: 'approve',
        nonce: crypto.randomUUID(),
      });
    }
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    expect((await deps.proposals.getById(proposal.proposalId))?.votingState).toBe('quorum_not_met');
  });

  it('a frozen room defers deadline settlement entirely (W8 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    await castVote(deps, proposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    // The freeze lands before the sweep: settlement must DEFER — no pass, no
    // timelock, no reservation encumbered mid-review.
    const profile = await deps.profiles.get(ROOM);
    if (profile === null) throw new Error('profile missing');
    await deps.profiles.upsert({ ...profile, freezeState: 'frozen', freezeReason: 'Review.' });
    await settleDueProposals(deps, ROOM);
    expect((await deps.proposals.getById(proposal.proposalId))?.votingState).toBe('open');
    expect(await deps.reservations.getByProposal(proposal.proposalId)).toBeNull();
    // Once the freeze lifts the same sweep settles the recorded ballots.
    await deps.profiles.upsert({ ...profile, freezeState: 'active', freezeReason: null });
    await settleDueProposals(deps, ROOM);
    expect((await deps.proposals.getById(proposal.proposalId))?.votingState).toBe('passed');
  });

  it('a treasury-scope freeze defers pass settlement and reservations (W10 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    await castVote(deps, proposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    // A TREASURY-scope freeze leaves the room profile active — the room-level
    // deferral does not cover it, but a pass reserves headroom (fund
    // movement), so the executions guard must defer this settlement too.
    const treasury = await deps.treasuries.getByRoom(ROOM);
    if (treasury === null) throw new Error('treasury missing');
    await deps.treasuries.setFreeze(treasury.treasuryId, 'frozen', 'Treasury hold.', false);
    await settleDueProposals(deps, ROOM);
    expect((await deps.proposals.getById(proposal.proposalId))?.votingState).toBe('open');
    expect(await deps.reservations.getByProposal(proposal.proposalId)).toBeNull();
    // The hold lifts; the same sweep settles and reserves.
    await deps.treasuries.setFreeze(treasury.treasuryId, 'active', null, false);
    await settleDueProposals(deps, ROOM);
    expect((await deps.proposals.getById(proposal.proposalId))?.votingState).toBe('passed');
    expect((await deps.reservations.getByProposal(proposal.proposalId))?.state).toBe('reserved');
  });

  it('a conflicted delegator is recused from delegated weight too (W8 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, {
      weightModel: 'delegated',
      maxVotingWeightPerAccount: 5,
      coiRequirements: {
        disclosureTriggers: ['financial relationship'],
        recusalRequired: true,
        independentReviewFor: ['capped_grant'],
      },
    });
    await linkWallet(deps, WALLET_1, VOTER_2, testAccount.address);
    // The PROPOSER (a disclosed-conflict party on their own spend) delegates
    // to VOTER_2 before the vote — the recusal must follow the weight.
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
    // Own 1 + STEWARD's unit; the conflicted PROPOSER's unit is recused.
    expect(vote.signature.weightSnapshot).toBe('2');
  });

  it('one member holds at most ONE open challenge per proposal (sweep)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps);
    const first = await fileChallenge(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: VOTER_2,
      challengeType: 'coi',
      description: 'First concern.',
      evidenceRefs: [],
    });
    expect(first).toMatchObject({ ok: true });
    // Stacking unresolved challenges would hold execution hostage.
    expect(
      await fileChallenge(deps, {
        roomId: ROOM,
        proposalId: settled.proposalId,
        userId: VOTER_2,
        challengeType: 'fraud',
        description: 'Second concern.',
        evidenceRefs: [],
      }),
    ).toMatchObject({ ok: false, code: 'challenge_already_open' });
    // Once the first is resolved, the member may file again.
    if (!('challenge' in first)) throw new Error('unreachable');
    await resolveChallenge(deps, {
      roomId: ROOM,
      challengeId: first.challenge.challengeId,
      resolution: 'dismissed',
      resolutionNote: 'No issue.',
      actorUserId: STEWARD,
      isPlatformStaff: false,
    });
    expect(
      await fileChallenge(deps, {
        roomId: ROOM,
        proposalId: settled.proposalId,
        userId: VOTER_2,
        challengeType: 'fraud',
        description: 'Renewed concern.',
        evidenceRefs: [],
      }),
    ).toMatchObject({ ok: true });
  });

  it('a frozen room defers new challenge filings (W11 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps);
    const profile = await deps.profiles.get(ROOM);
    if (profile === null) throw new Error('profile missing');
    await deps.profiles.upsert({ ...profile, freezeState: 'frozen', freezeReason: 'Review.' });
    expect(
      await fileChallenge(deps, {
        roomId: ROOM,
        proposalId: settled.proposalId,
        userId: VOTER_2,
        challengeType: 'coi',
        description: 'Filed mid-freeze.',
        evidenceRefs: [],
      }),
    ).toMatchObject({ ok: false, code: 'governance_frozen' });
  });

  it('dismissing the last challenge restarts an execution window spent under review (W10 review)', async () => {
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
    // The ENTIRE execution window elapses while the challenge is under
    // review (the sweep pauses expiry; manual execute is challenge-blocked).
    deps.clockAdvance(
      3_600 * 1000 + DEFAULT_KNOMOSIS_CONFIG.wsmExecutionWindowSeconds * 1000 + 60_000,
    );
    const dismissed = await resolveChallenge(deps, {
      roomId: ROOM,
      challengeId: filed.challenge.challengeId,
      resolution: 'dismissed',
      resolutionNote: 'No conflict found.',
      actorUserId: STEWARD,
      isPlatformStaff: false,
    });
    expect(dismissed).toMatchObject({ ok: true });
    // The window restarted at dismissal — execution succeeds instead of
    // dying `execution_window_expired` for time spent under review.
    const executed = await executeProposal(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: STEWARD,
    });
    expect(executed).toMatchObject({ ok: true });
  });

  it('a late upheld verdict cannot un-execute a completed proposal (W11 review)', async () => {
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
      resolutionNote: 'No conflict.',
      actorUserId: STEWARD,
      isPlatformStaff: false,
    });
    expect(dismissed).toMatchObject({ ok: true });
    deps.clockAdvance(3_600 * 1000 + 1_000);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    const executed = await executeProposal(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: STEWARD,
    });
    expect(executed).toMatchObject({ ok: true });
    // A second challenge upheld AFTER execution projects the challenge
    // column but must NOT rewrite executionState (blockExecution guards on
    // not-yet-executed rows only).
    const second = await fileChallenge(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: VOTER_2,
      challengeType: 'fraud',
      description: 'Post-hoc claim.',
      evidenceRefs: [],
    });
    // The challenge window closed at execution — filings are shut; drive the
    // projection DIRECTLY to prove the guard (the store-level contract).
    expect(second).toMatchObject({ ok: false });
    await deps.proposals.applyChallengeProjection(settled.proposalId, {
      challengeState: 'upheld',
      blockExecution: true,
    });
    expect((await deps.proposals.getById(settled.proposalId))?.executionState).toBe('executed');
  });

  it('execution fails closed when the reservation is no longer consumable (W13)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps);
    deps.clockAdvance(3_600 * 1000 + 1_000);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    // A concurrent upheld resolution RELEASED the reservation in the gap
    // before the claim: the spend must not finalize against nothing.
    const { releaseReservation } = await import('../treasury/reservations.js');
    await releaseReservation(deps, settled.proposalId);
    const executed = await executeProposal(deps, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: STEWARD,
    });
    expect(executed).toMatchObject({ ok: false, code: 'reservation_not_consumable' });
    expect((await deps.proposals.getById(settled.proposalId))?.executionState).toBe('blocked');
  });

  it('an audit-append failure after the effect never wedges the row (W13)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    const settled = await passProposal(deps);
    deps.clockAdvance(3_600 * 1000 + 1_000);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    const alerts: string[] = [];
    const rawAudit = deps.governanceAudit;
    const failing = {
      ...deps,
      alert: (event: string) => alerts.push(event),
      governanceAudit: new Proxy(rawAudit, {
        get(target, prop) {
          if (prop === 'appendChained' || prop === 'append' || prop === 'insertChained') {
            const original = Reflect.get(target, prop, target);
            if (typeof original === 'function') {
              return async (entry: { actionType?: string }) => {
                if (entry?.actionType === 'proposal_executed') {
                  throw new Error('audit store down');
                }
                return (original as (e: unknown) => Promise<unknown>).call(target, entry);
              };
            }
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
    const executed = await executeProposal(failing, {
      roomId: ROOM,
      proposalId: settled.proposalId,
      userId: STEWARD,
    });
    // The grant/kernel effect happened and the row is EXECUTED — the audit
    // failure alerted instead of stranding an `executing` claim.
    expect(executed).toMatchObject({ ok: true });
    expect((await deps.proposals.getById(settled.proposalId))?.executionState).toBe('executed');
    expect(alerts).toContain('wsm.proposal.execute_audit_failed');
  });

  it('milestone descriptions carry the wire bounds at BOTH gates (W13/W15)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    const malformed = {
      kind: 'grant',
      milestones: [{ description: 'x'.repeat(1_001), amount: '4000' }],
    };
    // PUBLICATION rejects the plan up front — no governance cycle burned (W15).
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ requested_action: malformed }),
      }),
    ).toMatchObject({ ok: false, code: 'milestones_invalid' });
    // EXECUTION still re-checks independently: a row predating the create
    // gate (mutated in place here) dies before the kernel — an over-bound
    // description would otherwise make every later grants read fail response
    // validation for the room (W13).
    const proposal = await createProposal(deps);
    await openVoting(deps);
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    await castVote(deps, proposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    const row = await deps.proposals.getById(proposal.proposalId);
    if (row === null) throw new Error('proposal lost');
    await deps.proposals.update({ ...row, requestedAction: malformed });
    const executed = await executeProposal(deps, {
      roomId: ROOM,
      proposalId: proposal.proposalId,
      userId: STEWARD,
    });
    expect(executed).toMatchObject({ ok: false, code: 'grant_creation_failed' });
    expect(deps.executorCalls).toEqual([]);
  });

  it('production ballots must ride the room treasury deployment (W13)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    // Repoint the room at a DIFFERENT deployment (inserted directly — the
    // create path would reject an unpinned id).
    const treasury = await deps.treasuries.getByRoom(ROOM);
    if (treasury === null) throw new Error('treasury missing');
    await deps.treasuries.clear();
    await deps.treasuries.insert({ ...treasury, deploymentId: crypto.randomUUID() });
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    expect(
      await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve'),
    ).toMatchObject({ ok: false, code: 'deployment_mismatch' });
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
    const malformed = {
      kind: 'grant',
      milestones: [{ description: 'Only', amount: '9999' }], // ≠ 4000
    };
    // Publication refuses the unsound split up front (W15)…
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ requested_action: malformed }),
      }),
    ).toMatchObject({ ok: false, code: 'milestones_invalid' });
    // …and execution re-checks a row that slipped past it: no grant lands.
    const proposal = await createProposal(deps);
    await openVoting(deps);
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    await castVote(deps, proposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    const row = await deps.proposals.getById(proposal.proposalId);
    if (row === null) throw new Error('proposal lost');
    await deps.proposals.update({ ...row, requestedAction: malformed });
    await executeProposal(deps, { roomId: ROOM, proposalId: proposal.proposalId, userId: STEWARD });
    expect(await deps.grants.getByProposal(proposal.proposalId)).toBeNull();
  });

  it('rejects tranches that are negative, zero, or above the approved amount (W6 review)', async () => {
    const deps = buildHarness();
    await prepareRoom(deps);
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    // `-100` + `4100` SUMS to the approved 4000 — but accepting the 4100
    // milestone first would disburse above the voted authorization.
    const malformed = {
      kind: 'grant',
      milestones: [
        { description: 'Offset', amount: '-100' },
        { description: 'Over', amount: '4100' },
      ],
    };
    // Publication refuses it up front (W15)…
    expect(
      await createProductionProposal(deps, {
        roomId: ROOM,
        userId: PROPOSER,
        create: draft({ requested_action: malformed }),
      }),
    ).toMatchObject({ ok: false, code: 'milestones_invalid' });
    // …and execution re-checks a row that slipped past it.
    const proposal = await createProposal(deps);
    await openVoting(deps);
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    await castVote(deps, proposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmChallengeWindowSeconds * 1000 + 1_000);
    const row = await deps.proposals.getById(proposal.proposalId);
    if (row === null) throw new Error('proposal lost');
    await deps.proposals.update({ ...row, requestedAction: malformed });
    const executed = await executeProposal(deps, {
      roomId: ROOM,
      proposalId: proposal.proposalId,
      userId: STEWARD,
    });
    expect(executed).toMatchObject({ ok: false, code: 'grant_creation_failed' });
    expect(await deps.grants.getByProposal(proposal.proposalId)).toBeNull();
    // The kernel was NEVER invoked: a plan failure after the kernel append
    // would leave a phantom accepted spend consuming future cap headroom (W9).
    expect(deps.executorCalls).toEqual([]);
  });
});

describe('reputation_bounded weight (§17.5: the fact has to be wired)', () => {
  const REPUTATION_PACK: Partial<LawPack> = {
    weightModel: 'reputation_bounded',
    maxVotingWeightPerAccount: 10,
  };

  it('resolves the weight from the room-scoped participation count', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, REPUTATION_PACK);
    deps.memberFactsOverride.set(PROPOSER, {
      membershipDays: 90,
      contributionCount: 3,
      verifiedIdentity: true,
    });
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    const proposal = await createProposal(deps);
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
    // min(score 3, cap 10) — NOT the hard-coded 0 every ballot used to carry.
    expect(vote.signature.weightSnapshot).toBe('3');
    expect(vote.signature.eligibilityReason).toContain('score 3');
    expect(vote.tally.approve).toBe('3');
  });

  it('caps the score at the law-pack ceiling and settles a unanimous vote to passed', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, REPUTATION_PACK);
    deps.memberFactsOverride.set(PROPOSER, {
      membershipDays: 90,
      contributionCount: 40, // above the cap: min(40, 10) = 10
      verifiedIdentity: true,
    });
    deps.memberFactsOverride.set(VOTER_2, {
      membershipDays: 90,
      contributionCount: 4,
      verifiedIdentity: true,
    });
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    await linkWallet(deps, WALLET_2, VOTER_2, testAccount2.address);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve');
    await castVote(deps, proposal.proposalId, VOTER_2, WALLET_2, testAccount2, 'approve');
    deps.clockAdvance(DEFAULT_KNOMOSIS_CONFIG.wsmVotingSeconds * 1000 + 1_000);
    await settleDueProposals(deps, ROOM);
    const settled = await deps.proposals.getById(proposal.proposalId);
    // With every snapshot at 0 this UNANIMOUS approval settled `rejected`:
    // `decided` stayed '0', so the threshold branch never ran.
    expect(settled?.votingState).toBe('passed');
    expect(settled?.tallySnapshot).toMatchObject({ outcome: 'passed', approve: '14', reject: '0' });
  });

  it('refuses a zero-weight ballot instead of recording a vote that cannot count', async () => {
    const deps = buildHarness();
    await prepareRoom(deps, REPUTATION_PACK);
    deps.memberFactsOverride.set(PROPOSER, {
      membershipDays: 90,
      contributionCount: 0,
      verifiedIdentity: true,
    });
    await linkWallet(deps, WALLET_1, PROPOSER, testAccount.address);
    const proposal = await createProposal(deps);
    await openVoting(deps);
    expect(
      await castVote(deps, proposal.proposalId, PROPOSER, WALLET_1, testAccount, 'approve'),
    ).toMatchObject({ ok: false, code: 'zero_voting_weight' });
    // Nothing recorded: a 0 adds nothing to the tally yet still counts toward
    // QUORUM, so recording it would let a weightless electorate carry a room.
    expect(await deps.proposalSignatures.listByProposal(proposal.proposalId)).toEqual([]);
  });
});
