// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { EligibilityRules } from '../schemas/law-pack.js';
import type { VoterFacts, WeightModelGates } from '../schemas/voting.js';
import {
  checkVoterEligibility,
  type EligibilityContext,
  resolveVotingWeight,
  type WeightResolverInput,
} from '../weight-resolver.js';

const rules: EligibilityRules = {
  minMembershipDays: 30,
  minContributions: 5,
  requireVerifiedIdentity: false,
  newWalletCoolingOffDays: 7,
};

const facts = (overrides: Partial<VoterFacts> = {}): VoterFacts => ({
  userId: 'voter-1',
  membershipDays: 90,
  contributionCount: 20,
  verifiedIdentity: true,
  newestWalletAgeDays: 30,
  walletClusterId: null,
  hasDisclosedConflict: false,
  roleClasses: [],
  reputationScore: 0,
  tokenVoteUnits: 0,
  isDesignatedSigner: false,
  ...overrides,
});

const ctx = (overrides: Partial<EligibilityContext> = {}): EligibilityContext => ({
  rules,
  treasuryControlling: false,
  recusalRequired: false,
  clustersAlreadyVoted: new Set<string>(),
  ...overrides,
});

const openGates: WeightModelGates = {
  sybilControlsVerified: true,
  antiBriberyMonitoring: true,
  legalReviewPassed: true,
};
const closedGates: WeightModelGates = {
  sybilControlsVerified: false,
  antiBriberyMonitoring: true,
  legalReviewPassed: true,
};

describe('checkVoterEligibility (WS-M.4.2c-2)', () => {
  it('accepts a voter meeting every requirement', () => {
    const decision = checkVoterEligibility(facts(), ctx());
    expect(decision.eligible).toBe(true);
  });

  it('rejects below-threshold membership duration', () => {
    const decision = checkVoterEligibility(facts({ membershipDays: 10 }), ctx());
    expect(decision).toMatchObject({ eligible: false, code: 'membership_too_new' });
  });

  it('rejects insufficient contribution history', () => {
    const decision = checkVoterEligibility(facts({ contributionCount: 2 }), ctx());
    expect(decision).toMatchObject({ eligible: false, code: 'insufficient_contributions' });
  });

  it('rejects an unverified identity when the law-pack requires one', () => {
    const decision = checkVoterEligibility(facts({ verifiedIdentity: false }), {
      ...ctx(),
      rules: { ...rules, requireVerifiedIdentity: true },
    });
    expect(decision).toMatchObject({ eligible: false, code: 'identity_unverified' });
  });

  it('rejects a new wallet inside the cooling-off window for treasury-controlling votes', () => {
    const decision = checkVoterEligibility(
      facts({ newestWalletAgeDays: 3 }),
      ctx({ treasuryControlling: true }),
    );
    expect(decision).toMatchObject({ eligible: false, code: 'wallet_cooling_off' });
  });

  it('ignores the cooling-off window for non-treasury votes', () => {
    const decision = checkVoterEligibility(facts({ newestWalletAgeDays: 3 }), ctx());
    expect(decision.eligible).toBe(true);
  });

  it('recuses a voter with a disclosed conflict where the law-pack requires it', () => {
    const decision = checkVoterEligibility(
      facts({ hasDisclosedConflict: true }),
      ctx({ recusalRequired: true }),
    );
    expect(decision).toMatchObject({ eligible: false, code: 'coi_recusal' });
  });

  it('allows a disclosed conflict where recusal is not required', () => {
    const decision = checkVoterEligibility(facts({ hasDisclosedConflict: true }), ctx());
    expect(decision.eligible).toBe(true);
  });

  it('collapses a wallet cluster to one eligibility subject', () => {
    const decision = checkVoterEligibility(
      facts({ walletClusterId: 'cluster-a' }),
      ctx({ clustersAlreadyVoted: new Set(['cluster-a']) }),
    );
    expect(decision).toMatchObject({ eligible: false, code: 'cluster_already_voted' });
  });

  it('fails closed on unknown facts for treasury-controlling votes', () => {
    const decision = checkVoterEligibility(
      facts({ membershipDays: null }),
      ctx({ treasuryControlling: true }),
    );
    expect(decision).toMatchObject({ eligible: false, code: 'facts_unavailable' });
  });

  it('treats unknown facts as zero for non-treasury votes', () => {
    const decision = checkVoterEligibility(facts({ membershipDays: null }), ctx());
    expect(decision).toMatchObject({ eligible: false, code: 'membership_too_new' });
  });
});

describe('resolveVotingWeight (WS-M.4.2c-1)', () => {
  const base = (overrides: Partial<WeightResolverInput> = {}): WeightResolverInput => ({
    model: 'one_civic_account_one_vote',
    facts: facts(),
    maxVotingWeightPerAccount: 1,
    gates: openGates,
    delegations: [],
    ...overrides,
  });

  it('one_civic_account_one_vote returns weight 1 (capped)', () => {
    const resolution = resolveVotingWeight(base());
    expect(resolution).toMatchObject({ resolved: true, weight: '1' });
  });

  it('applies the per-account cap to every model', () => {
    const resolution = resolveVotingWeight(
      base({
        model: 'reputation_bounded',
        facts: facts({ reputationScore: 42 }),
        maxVotingWeightPerAccount: 5,
      }),
    );
    expect(resolution).toMatchObject({ resolved: true, weight: '5' });
  });

  it('reputation_bounded is explainable (inputs + cap in the reason)', () => {
    const resolution = resolveVotingWeight(
      base({
        model: 'reputation_bounded',
        facts: facts({ reputationScore: 2.5 }),
        maxVotingWeightPerAccount: 5,
      }),
    );
    expect(resolution.resolved).toBe(true);
    if (resolution.resolved) {
      expect(resolution.weight).toBe('2.5');
      expect(resolution.eligibilityReason).toContain('2.5');
      expect(resolution.eligibilityReason).toContain('5');
    }
  });

  it('role_based_quorum carries one capped vote and names the roles', () => {
    const resolution = resolveVotingWeight(
      base({ model: 'role_based_quorum', facts: facts({ roleClasses: ['reviewer'] }) }),
    );
    expect(resolution.resolved).toBe(true);
    if (resolution.resolved) {
      expect(resolution.weight).toBe('1');
      expect(resolution.eligibilityReason).toContain('reviewer');
    }
  });

  it('refuses gated token models without the §17.5 preconditions (fail-closed)', () => {
    for (const model of ['capped_token', 'quadratic_capped'] as const) {
      const resolution = resolveVotingWeight(base({ model, gates: closedGates }));
      expect(resolution).toMatchObject({ resolved: false, code: 'weight_model_gated' });
    }
  });

  it('capped_token resolves with the gates recorded', () => {
    const resolution = resolveVotingWeight(
      base({
        model: 'capped_token',
        facts: facts({ tokenVoteUnits: 12 }),
        maxVotingWeightPerAccount: 10,
      }),
    );
    expect(resolution).toMatchObject({ resolved: true, weight: '10' });
  });

  it('quadratic_capped takes the floored square root, then caps', () => {
    const resolution = resolveVotingWeight(
      base({
        model: 'quadratic_capped',
        facts: facts({ tokenVoteUnits: 26 }), // ⌊√26⌋ = 5
        maxVotingWeightPerAccount: 4,
      }),
    );
    expect(resolution).toMatchObject({ resolved: true, weight: '4' });
  });

  it('delegated sums only ELIGIBLE delegations and caps the aggregate', () => {
    const resolution = resolveVotingWeight(
      base({
        model: 'delegated',
        maxVotingWeightPerAccount: 3,
        delegations: [
          { delegatorUserId: 'd1', delegatorEligible: true, weight: 1 },
          { delegatorUserId: 'd2', delegatorEligible: true, weight: 1 },
          { delegatorUserId: 'd3', delegatorEligible: false, weight: 1 }, // ignored
          { delegatorUserId: 'd4', delegatorEligible: true, weight: 1 },
        ],
      }),
    );
    // Own 1 + three eligible delegations = 4, capped to 3.
    expect(resolution).toMatchObject({ resolved: true, weight: '3' });
  });

  it('multisig_steward gives designated signers one capped vote and refuses others', () => {
    const signer = resolveVotingWeight(
      base({ model: 'multisig_steward', facts: facts({ isDesignatedSigner: true }) }),
    );
    expect(signer).toMatchObject({ resolved: true, weight: '1' });
    const outsider = resolveVotingWeight(base({ model: 'multisig_steward' }));
    expect(outsider).toMatchObject({ resolved: false, code: 'not_designated_signer' });
  });

  it('is deterministic for identical inputs', () => {
    const input = base({
      model: 'delegated',
      delegations: [{ delegatorUserId: 'd1', delegatorEligible: true, weight: '0.5' }],
      maxVotingWeightPerAccount: 2,
    });
    expect(resolveVotingWeight(input)).toEqual(resolveVotingWeight(input));
  });

  it('sums fractional delegated weights exactly (no float drift)', () => {
    const resolution = resolveVotingWeight(
      base({
        model: 'delegated',
        maxVotingWeightPerAccount: 10,
        delegations: [
          { delegatorUserId: 'd1', delegatorEligible: true, weight: '0.1' },
          { delegatorUserId: 'd2', delegatorEligible: true, weight: '0.2' },
        ],
      }),
    );
    // 1 + 0.1 + 0.2 must be exactly 1.3 — never 1.3000000000000003.
    expect(resolution).toMatchObject({ resolved: true, weight: '1.3' });
  });
});
