// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  fixtureCoverageProblems,
  lawPackCanonicalText,
  runLawPackFixtures,
  validateLawPackBundle,
  validateLawPackForRealAssets,
} from '../law-pack-validate.js';
import { type LawPack, lawPackSchema } from '../schemas/law-pack.js';
import {
  type LawPackFixtureCorpus,
  lawPackFixtureCorpusSchema,
} from '../schemas/law-pack-fixtures.js';

/** A complete WS-M extended bundle (every optional block present). */
const fullPack = (): LawPack =>
  lawPackSchema.parse({
    lawPackId: 'pack-1',
    version: '1.0.0',
    allowedProposalTypes: ['capped_grant', 'charter_update'],
    permittedCapabilities: ['treasury.grant', 'lawmaking.summarize'],
    treasury: {
      caps: [
        { category: 'grant', perActionMax: '1000', perWindowMax: '5000', windowSeconds: 86_400 },
      ],
      minIntervalSeconds: 0,
      timelockSeconds: 3_600,
      materialThreshold: '500',
      requireCoiFor: ['grant'],
      investment: null,
    },
    election: {
      weightModel: 'one_civic_account_one_vote',
      perAccountCap: 1,
      minQuorum: 3,
      minTurnout: 0.1,
      termSeconds: 31_536_000,
    },
    humanSummary: 'Grants up to 1000 minor units with COI review; charter amendments.',
    disallowedProposalTypes: ['bounty'],
    roleDefinitions: {
      steward: { permissions: ['execute'], signingRequired: true },
    },
    quorumRules: {
      capped_grant: { basis: 'eligible_voters', minFraction: 0.2 },
      charter_update: { basis: 'eligible_voters', minFraction: 0.3 },
    },
    thresholdRules: {
      capped_grant: { minAffirmativeFraction: 0.5 },
      charter_update: { minAffirmativeFraction: 0.667 },
    },
    timelockRules: {
      capped_grant: { seconds: 172_800 },
      charter_update: { seconds: 259_200 },
    },
    weightModel: 'one_civic_account_one_vote',
    maxVotingWeightPerAccount: 1,
    eligibility: {
      minMembershipDays: 30,
      minContributions: 3,
      requireVerifiedIdentity: false,
      newWalletCoolingOffDays: 7,
    },
    coiRequirements: {
      disclosureTriggers: ['financial relationship with the recipient'],
      recusalRequired: true,
      independentReviewFor: ['capped_grant'],
    },
    appealRules: {
      whoCanAppeal: ['any_member'],
      timelineSeconds: 604_800,
      process: 'Appeal to the platform legal floor.',
    },
    forkExitRules: {
      conditions: 'Two-thirds of members request an exit.',
      process: 'Fork the room; the treasury follows the documented split.',
      fundHandling: 'Unallocated deposits return to depositors.',
    },
    emergencyConstraints: {
      freezeTriggers: ['reconciliation divergence', 'suspected compromise'],
      escalation: 'Platform security + legal review.',
    },
    actionBudgetRules: {
      costs: { proposal_submission: 5, treasury_operation: 10 },
      refill: { periodSeconds: 86_400, units: 10, max: 100 },
    },
    testFixtureCorpusRef: 'corpus-1',
    hashCommitment: 'a'.repeat(64),
  });

const corpus = (): LawPackFixtureCorpus =>
  lawPackFixtureCorpusSchema.parse({
    fixtures: [
      {
        kind: 'treasury_action',
        label: 'grant within caps + COI declared accepts',
        action: {
          category: 'grant',
          amount: '900',
          asset: 'USDC',
          coiDeclared: true,
          proposedAt: '2026-07-01T00:00:00.000Z',
          targetAllocation: null,
        },
        history: [],
        now: '2026-07-02T00:00:00.000Z',
        expect: 'accepted',
      },
      {
        kind: 'treasury_action',
        label: 'grant above per-action cap rejects',
        action: {
          category: 'grant',
          amount: '1001',
          asset: 'USDC',
          coiDeclared: true,
          proposedAt: '2026-07-01T00:00:00.000Z',
          targetAllocation: null,
        },
        history: [],
        now: '2026-07-02T00:00:00.000Z',
        expect: 'per_action_cap_exceeded',
      },
      {
        kind: 'treasury_action',
        label: 'grant without COI declaration rejects',
        action: {
          category: 'grant',
          amount: '100',
          asset: 'USDC',
          coiDeclared: false,
          proposedAt: '2026-07-01T00:00:00.000Z',
          targetAllocation: null,
        },
        history: [],
        now: '2026-07-02T00:00:00.000Z',
        expect: 'coi_required',
      },
      {
        kind: 'proposal_tally',
        label: 'grant passes a simple majority at quorum',
        proposalType: 'capped_grant',
        votes: [
          { voterUserId: 'a', choice: 'approve', weightSnapshot: 1 },
          { voterUserId: 'b', choice: 'approve', weightSnapshot: 1 },
          { voterUserId: 'c', choice: 'reject', weightSnapshot: 1 },
        ],
        eligibleCount: 10,
        deadlinePassed: true,
        expect: 'passed',
      },
      {
        kind: 'proposal_tally',
        label: 'charter update below supermajority rejects',
        proposalType: 'charter_update',
        votes: [
          { voterUserId: 'a', choice: 'approve', weightSnapshot: 1 },
          { voterUserId: 'b', choice: 'approve', weightSnapshot: 1 },
          { voterUserId: 'c', choice: 'reject', weightSnapshot: 1 },
        ],
        eligibleCount: 10,
        deadlinePassed: true,
        expect: 'rejected',
      },
      {
        kind: 'eligibility',
        label: 'cooling-off wallet recused from treasury votes',
        facts: {
          userId: 'v1',
          membershipDays: 60,
          contributionCount: 10,
          verifiedIdentity: true,
          newestWalletAgeDays: 2,
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
      },
    ],
  });

describe('validateLawPackBundle (WS-M.1.3c structural)', () => {
  it('accepts the full extended bundle', () => {
    expect(validateLawPackBundle(fullPack())).toEqual([]);
  });

  it('rejects duplicate multisig signers (W9 review)', () => {
    const pack = fullPack();
    // Execution counts DISTINCT approvals: [u1, u1] with required 2 could
    // never execute any proposal.
    const parsed = lawPackSchema.safeParse({
      ...pack,
      multisig: { signers: ['u1', 'u1'], required: 2 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a role_class quorum basis without a multisig signer set (W6 review)', () => {
    const pack = fullPack();
    const quorum = pack.quorumRules ?? {};
    const firstType = Object.keys(quorum)[0] ?? 'capped_grant';
    const problems = validateLawPackBundle({
      ...pack,
      multisig: undefined,
      quorumRules: { ...quorum, [firstType]: { basis: 'role_class', minFraction: 0.5 } },
    });
    expect(problems.some((p) => p.path === `quorumRules.${firstType}`)).toBe(true);
  });

  it('accepts a minimal shipped WS-U pack (no WS-M blocks)', () => {
    const minimal = lawPackSchema.parse({
      lawPackId: 'mod-only',
      version: '1',
      allowedProposalTypes: ['model_prompt_approval'],
      permittedCapabilities: ['moderate.flag'],
      treasury: {
        caps: [],
        minIntervalSeconds: 0,
        timelockSeconds: 0,
        materialThreshold: 0,
        requireCoiFor: [],
        investment: null,
      },
      election: {
        weightModel: 'one_civic_account_one_vote',
        perAccountCap: 1,
        minQuorum: 1,
        minTurnout: 0,
        termSeconds: 31_536_000,
      },
    });
    expect(validateLawPackBundle(minimal)).toEqual([]);
  });

  it('rejects overlapping allowed/disallowed proposal types', () => {
    const pack = { ...fullPack(), disallowedProposalTypes: ['capped_grant'] };
    expect(validateLawPackBundle(pack)).toContainEqual(
      expect.objectContaining({ path: 'disallowedProposalTypes' }),
    );
  });

  it('rejects a per-action cap exceeding the per-window cap', () => {
    const pack = fullPack();
    pack.treasury.caps[0] = {
      category: 'grant',
      perActionMax: '6000',
      perWindowMax: '5000',
      windowSeconds: 86_400,
    };
    expect(validateLawPackBundle(pack)).toContainEqual(
      expect.objectContaining({ path: 'treasury.caps.grant' }),
    );
  });

  it('rejects duplicate cap categories', () => {
    const pack = fullPack();
    pack.treasury.caps.push({
      category: 'grant',
      perActionMax: '1',
      perWindowMax: '1',
      windowSeconds: 60,
    });
    expect(validateLawPackBundle(pack)).toContainEqual(
      expect.objectContaining({ problem: expect.stringContaining('duplicate cap') }),
    );
  });

  it('rejects a COI requirement on a category with no cap (unreachable)', () => {
    const pack = fullPack();
    pack.treasury.requireCoiFor = ['grant', 'bounty'];
    expect(validateLawPackBundle(pack)).toContainEqual(
      expect.objectContaining({ path: 'treasury.requireCoiFor.bounty' }),
    );
  });

  it('requires quorum/threshold/timelock rules for every allowed type', () => {
    const pack = fullPack();
    delete pack.quorumRules?.['charter_update'];
    delete pack.thresholdRules?.['charter_update'];
    delete pack.timelockRules?.['charter_update'];
    const problems = validateLawPackBundle(pack);
    expect(problems).toContainEqual(
      expect.objectContaining({ path: 'quorumRules.charter_update' }),
    );
    expect(problems).toContainEqual(
      expect.objectContaining({ path: 'thresholdRules.charter_update' }),
    );
    expect(problems).toContainEqual(
      expect.objectContaining({ path: 'timelockRules.charter_update' }),
    );
  });

  it('rejects dangling rules for unlisted proposal types', () => {
    const pack = fullPack();
    (pack.quorumRules ?? {})['unlisted_type'] = { basis: 'eligible_voters', minFraction: 0.1 };
    expect(validateLawPackBundle(pack)).toContainEqual(
      expect.objectContaining({ path: 'quorumRules.unlisted_type' }),
    );
  });

  it('rejects a zero threshold under a non-zero quorum', () => {
    const pack = fullPack();
    (pack.thresholdRules ?? {})['capped_grant'] = { minAffirmativeFraction: 0 };
    expect(validateLawPackBundle(pack)).toContainEqual(
      expect.objectContaining({ path: 'thresholdRules.capped_grant' }),
    );
  });

  it('requires the per-account cap alongside a weight model', () => {
    const pack = fullPack();
    delete pack.maxVotingWeightPerAccount;
    expect(validateLawPackBundle(pack)).toContainEqual(
      expect.objectContaining({ path: 'maxVotingWeightPerAccount' }),
    );
  });

  it('requires a multisig policy under multisig_steward', () => {
    const pack = { ...fullPack(), weightModel: 'multisig_steward' as const };
    expect(validateLawPackBundle(pack)).toContainEqual(
      expect.objectContaining({ path: 'multisig' }),
    );
  });

  it('rejects independent review for an unlisted proposal type', () => {
    const pack = fullPack();
    (pack.coiRequirements ?? { independentReviewFor: [] }).independentReviewFor = ['bounty'];
    expect(validateLawPackBundle(pack)).toContainEqual(
      expect.objectContaining({ path: 'coiRequirements.independentReviewFor.bounty' }),
    );
  });
});

describe('validateLawPackForRealAssets (WS-M.1.2e law_pack_valid bar)', () => {
  it('accepts the complete extended bundle', () => {
    expect(validateLawPackForRealAssets(fullPack())).toEqual([]);
  });

  it('lists every missing WS-M block for a minimal WS-U pack', () => {
    const minimal = lawPackSchema.parse({
      lawPackId: 'mod-only',
      version: '1',
      allowedProposalTypes: [],
      permittedCapabilities: [],
      treasury: {
        caps: [],
        minIntervalSeconds: 0,
        timelockSeconds: 0,
        materialThreshold: 0,
        requireCoiFor: [],
        investment: null,
      },
      election: {
        weightModel: 'one_civic_account_one_vote',
        perAccountCap: 1,
        minQuorum: 1,
        minTurnout: 0,
        termSeconds: 31_536_000,
      },
    });
    const problems = validateLawPackForRealAssets(minimal);
    expect(problems.map((p) => p.path)).toEqual(
      expect.arrayContaining(['humanSummary', 'eligibility', 'hashCommitment']),
    );
  });

  it('flags gated weight models as requiring the §17.5 preconditions', () => {
    const pack = { ...fullPack(), weightModel: 'quadratic_capped' as const };
    expect(validateLawPackForRealAssets(pack)).toContainEqual(
      expect.objectContaining({ path: 'weightModel' }),
    );
  });
});

describe('lawPackCanonicalText (WS-M.1.3a hash commitment)', () => {
  it('excludes the hashCommitment field itself', () => {
    const pack = fullPack();
    expect(lawPackCanonicalText(pack)).not.toContain('hashCommitment');
    expect(lawPackCanonicalText(pack)).not.toContain('a'.repeat(64));
  });

  it('is key-order independent (deterministic canonicalization)', () => {
    const pack = fullPack();
    const reordered = Object.fromEntries(Object.entries(pack).reverse()) as unknown as LawPack;
    expect(lawPackCanonicalText(reordered)).toBe(lawPackCanonicalText(pack));
  });

  it('changes when any covered field changes', () => {
    const pack = fullPack();
    const modified = { ...pack, version: '1.0.1' };
    expect(lawPackCanonicalText(modified)).not.toBe(lawPackCanonicalText(pack));
  });
});

describe('runLawPackFixtures (WS-M.1.3c harness)', () => {
  it('passes the full corpus against the same runtime engines', () => {
    const result = runLawPackFixtures(fullPack(), corpus());
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.total).toBe(6);
  });

  it('fails when a fixture expectation disagrees with the engine', () => {
    const broken = corpus();
    const first = broken.fixtures[0];
    if (first?.kind === 'treasury_action') first.expect = 'per_window_cap_exceeded';
    const result = runLawPackFixtures(fullPack(), broken);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatchObject({ expected: 'per_window_cap_exceeded' });
  });

  it('fails a tally fixture whose proposal type has no rules', () => {
    const pack = fullPack();
    delete pack.quorumRules?.['capped_grant'];
    const result = runLawPackFixtures(pack, corpus());
    expect(result.passed).toBe(false);
  });

  it('fails an eligibility fixture when the pack has no eligibility block', () => {
    const pack = fullPack();
    delete pack.eligibility;
    const result = runLawPackFixtures(pack, corpus());
    expect(result.failures.some((f) => f.actual.includes('no eligibility block'))).toBe(true);
  });

  it('applies the role_class basis: quorum is measured over the multisig signer set', () => {
    // Mirror the runtime — a role_class quorum's basis is the signer set, NOT the
    // fixture eligibleCount, and only signer ballots count toward quorum.
    const pack = fullPack();
    pack.multisig = { signers: ['s1', 's2'], required: 2 };
    pack.quorumRules = {
      ...pack.quorumRules,
      capped_grant: { basis: 'role_class', minFraction: 1 },
    };

    // Both SIGNERS vote → the signer-set quorum is met → passes, even though the
    // (ignored) eligibleCount is deliberately wrong.
    const signerCorpus = corpus();
    signerCorpus.fixtures = signerCorpus.fixtures.map((f) =>
      f.kind === 'proposal_tally' && f.proposalType === 'capped_grant'
        ? {
            ...f,
            votes: [
              { voterUserId: 's1', choice: 'approve' as const, weightSnapshot: 1 },
              { voterUserId: 's2', choice: 'approve' as const, weightSnapshot: 1 },
            ],
            eligibleCount: 99,
            expect: 'passed' as const,
          }
        : f,
    );
    expect(runLawPackFixtures(pack, signerCorpus).failures).toEqual([]);

    // NON-signers cannot clear the signer-set quorum, whatever eligibleCount claims:
    // the harness catches the wrong `expect` (quorum_not_met), NOT a false pass.
    const nonSignerCorpus = corpus();
    nonSignerCorpus.fixtures = nonSignerCorpus.fixtures.map((f) =>
      f.kind === 'proposal_tally' && f.proposalType === 'capped_grant'
        ? {
            ...f,
            votes: [
              { voterUserId: 'x', choice: 'approve' as const, weightSnapshot: 1 },
              { voterUserId: 'y', choice: 'approve' as const, weightSnapshot: 1 },
            ],
            eligibleCount: 2,
            expect: 'passed' as const,
          }
        : f,
    );
    const result = runLawPackFixtures(pack, nonSignerCorpus);
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({ actual: 'quorum_not_met' }));
  });
});

describe('fixtureCoverageProblems (WS-M.1.3c coverage)', () => {
  it('accepts the covering corpus', () => {
    expect(fixtureCoverageProblems(fullPack(), corpus())).toEqual([]);
  });

  it('flags an allowed proposal type with no tally fixture', () => {
    const partial = corpus();
    partial.fixtures = partial.fixtures.filter(
      (f) => !(f.kind === 'proposal_tally' && f.proposalType === 'charter_update'),
    );
    expect(fixtureCoverageProblems(fullPack(), partial)).toContainEqual(
      expect.objectContaining({ path: 'fixtures.charter_update' }),
    );
  });

  it('flags a cap category with no treasury fixture', () => {
    const partial = corpus();
    partial.fixtures = partial.fixtures.filter((f) => f.kind !== 'treasury_action');
    expect(fixtureCoverageProblems(fullPack(), partial)).toContainEqual(
      expect.objectContaining({ path: 'fixtures.treasury.grant' }),
    );
  });

  it('flags an eligibility block with no covering fixture', () => {
    const partial = corpus();
    partial.fixtures = partial.fixtures.filter((f) => f.kind !== 'eligibility');
    expect(fixtureCoverageProblems(fullPack(), partial)).toContainEqual(
      expect.objectContaining({ path: 'fixtures.eligibility' }),
    );
  });
});
