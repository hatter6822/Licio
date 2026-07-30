// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE DRIFT GUARD for the ballot predicate.
//
// `signProposal` (the ballot gate) and the frozen quorum basis must answer the same
// question about the same member. They had drifted three ways at once: the gate built
// `VoterFacts` in one place, the basis built it TWICE in another with a different
// `reputationScore` in each half, and `isDesignatedSigner` was read from the pinned pack
// on one side and hard-coded false on the other.
//
// `buildVoterFacts` is now the single assembly. The risk that remains is a NEW field
// being added to `VoterFacts` and silently defaulting on the basis side — which is
// exactly how the last three happened. So every field is classified here, once:
//
//   per_member          — derived from this member's own facts on BOTH sides
//   derived             — computed from another field, identically on both sides
//   platform_constant   — the same literal for every member, everywhere
//   basis_exclusion     — the gate derives it, the basis substitutes; MUST be declared
//                         in BASIS_EXCLUSIONS with its reason
//
// The classification is `satisfies Record<keyof VoterFacts, …>`, so adding a field to
// the schema fails to COMPILE until someone says which kind it is. That is the guard;
// the assertions below are what make the classification honest rather than decorative.
import { type VoterFacts, voterFactsSchema } from '@licio/governance';
import { describe, expect, it } from 'vitest';
import { BASIS_EXCLUSIONS, buildVoterFacts } from '../treasury/ballot-predicate.js';

type Classification = 'per_member' | 'derived' | 'platform_constant' | 'basis_exclusion';

const CLASSIFICATION = {
  userId: 'per_member',
  membershipDays: 'per_member',
  contributionCount: 'per_member',
  verifiedIdentity: 'per_member',
  /** The qualifying-participation count, identically on both sides. */
  reputationScore: 'derived',
  /** The token models are §17.5-refused wholesale, so this is 0 for everyone. */
  tokenVoteUnits: 'platform_constant',
  newestWalletAgeDays: 'basis_exclusion',
  walletClusterId: 'basis_exclusion',
  hasDisclosedConflict: 'basis_exclusion',
  roleClasses: 'basis_exclusion',
  isDesignatedSigner: 'basis_exclusion',
} as const satisfies Record<keyof VoterFacts, Classification>;

describe('the ballot predicate and the basis are one projection', () => {
  it('classifies EVERY VoterFacts field, and the schema has no field it missed', () => {
    // The compiler already refuses a MISSING classification. This catches the other
    // direction — a classification naming a field the schema dropped — and pins the
    // two lists to each other rather than to a comment.
    const schemaKeys = Object.keys(voterFactsSchema.shape).sort();
    expect(Object.keys(CLASSIFICATION).sort()).toEqual(schemaKeys);
  });

  it('every declared basis_exclusion is actually IN the exclusion list, and vice versa', () => {
    // The pairing that matters: a field the basis substitutes but does not DECLARE is
    // the silent default that caused all three drifts. Classifying it without listing
    // it — or listing it without classifying it — fails here.
    const classified = Object.entries(CLASSIFICATION)
      .filter(([, kind]) => kind === 'basis_exclusion')
      .map(([key]) => key)
      .sort();
    expect(Object.keys(BASIS_EXCLUSIONS).sort()).toEqual(classified);
  });

  it('the exclusion values are what the basis actually substitutes', () => {
    // `BASIS_EXCLUSIONS` is spread into `buildVoterFacts` by the basis, so the facts it
    // produces must carry exactly these values — otherwise the list documents an
    // intention the code does not implement.
    const facts = buildVoterFacts({
      userId: 'u1',
      facts: { membershipDays: 10, contributionCount: 3, verifiedIdentity: true },
      ...BASIS_EXCLUSIONS,
    });
    for (const [key, value] of Object.entries(BASIS_EXCLUSIONS)) {
      expect(facts[key as keyof VoterFacts], `exclusion ${key}`).toEqual(value);
    }
    // …and the per-member fields still come from the member, not the exclusions.
    expect(facts.membershipDays).toBe(10);
    expect(facts.contributionCount).toBe(3);
    expect(facts.verifiedIdentity).toBe(true);
    // `reputationScore` is DERIVED from the contribution count on both sides. It was
    // 0 in the basis's eligibility half and `contributionCount` in its weight half —
    // two answers about one member inside one function.
    expect(facts.reputationScore).toBe(3);
    expect(facts.tokenVoteUnits).toBe(0);
  });

  it('an unknown member reads as unknown, not as zero', () => {
    // `null` facts mean no active membership. `membershipDays`/`contributionCount` must
    // stay NULL so the eligibility gate can treat them conservatively; only the
    // derived score falls back to 0, which is the weakest true claim.
    const facts = buildVoterFacts({ userId: 'u2', facts: null, ...BASIS_EXCLUSIONS });
    expect(facts.membershipDays).toBeNull();
    expect(facts.contributionCount).toBeNull();
    expect(facts.verifiedIdentity).toBe(false);
    expect(facts.reputationScore).toBe(0);
  });
});
