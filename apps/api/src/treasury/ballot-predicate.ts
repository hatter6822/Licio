// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE BALLOT PREDICATE — one spelling, two callers.
//
// Two places decide who governs a room, and they must agree or a governance outcome is
// silently wrong:
//
//   - `signProposal` (the BALLOT GATE) refuses a member who fails eligibility, and again
//     if their resolved weight is zero;
//   - the frozen quorum BASIS counts the members who would pass exactly that.
//
// They were assembled independently — and not even self-consistently. The basis built
// `VoterFacts` TWICE inside one function, passing `reputationScore: 0` to the eligibility
// check and `contributionCount ?? 0` to the weight resolver, so the two halves of one
// answer disagreed about the same member. Meanwhile `isDesignatedSigner` was hard-coded
// false in the basis while the gate reads it from the pinned pack, which under a
// `multisig_steward` pack froze the basis at zero and made quorum unreachable however
// many signers voted.
//
// So the facts are assembled HERE, once. What the basis deliberately does not mirror is
// named in `BASIS_EXCLUSIONS` rather than hard-coded at the call site: an exclusion you
// have to name is an exclusion someone can review, and `electorate-parity.test.ts`
// asserts every `VoterFacts` key is either derived per member or listed there.
import type { EligibilityRules, VoterFacts, WeightModel } from '@licio/governance';
import { checkVoterEligibility, decCompare, resolveVotingWeight } from '@licio/governance';

/** The room-membership facts both callers read from `MembershipFactsPort.memberFacts`. */
export interface MemberFacts {
  readonly membershipDays: number | null;
  readonly contributionCount: number | null;
  readonly verifiedIdentity: boolean;
}

/** The raw row either source produces: the live stores, or the electorate snapshot. */
export interface MemberFactsRow {
  /** An ACTIVE subscription backs this member. A per-room steward grant alone is false. */
  readonly subscribed: boolean;
  readonly joinedAt: string | null;
  readonly requestedAt: string | null;
  readonly emailVerified: boolean;
  readonly emailVerifiedAt: string | null;
  readonly contributionCount: number;
}

/**
 * Raw row → `MemberFacts`. The ONLY derivation, for both sources.
 *
 * `memberFacts` reads three stores per member and derives this; the basis folds the same
 * derivation over one snapshot. Writing it twice is how the two would come to disagree
 * about a member — which is the defect this whole area keeps producing — so it is written
 * once and called from both.
 *
 * MEMBERSHIP STARTS AT `joinedAt`, NOT AT THE REQUEST. In an approval-gated room the two
 * can be far apart, and reading the request instant reopens the electorate freeze: an
 * account could ask to join BEFORE a vote opened, sit pending and outside the frozen
 * denominator, be approved after, and then pass the cutoff on a timestamp predating a
 * membership it did not hold.
 *
 * The two answers take the fallback DIFFERENTLY, and deliberately. Every production writer
 * of an active subscription stamps `joinedAt`, so a null is a row from before the field —
 * and for the FREEZE the honest answer about such a row is "unknown", which the ballot
 * gate admits, exactly as it admits a steward whose grant carries no join instant. Judging
 * it by `requestedAt` would answer with the one instant already known to be wrong. For the
 * AGE the request instant is the pre-existing estimate and keeps the row eligible; a null
 * there fails a treasury-controlling vote CLOSED and would lock the member out entirely.
 */
export function deriveMemberFacts(
  row: MemberFactsRow,
  evaluatedAt: number,
  asOf?: string,
): (MemberFacts & { readonly memberSince: string | null }) | null {
  if (!row.subscribed) return null;
  const memberSince = row.joinedAt;
  const ageFrom = memberSince ?? row.requestedAt;
  const membershipDays =
    ageFrom === null ? null : Math.floor((evaluatedAt - Date.parse(ageFrom)) / 86_400_000);
  return {
    membershipDays:
      membershipDays !== null && Number.isFinite(membershipDays)
        ? Math.max(0, membershipDays)
        : null,
    contributionCount: row.contributionCount,
    // UNKNOWN STAYS ADMISSIBLE, exactly as `memberSince` does. A null `emailVerifiedAt` is
    // a row from before that field existed, so it cannot be shown to postdate the freeze —
    // treating it as unverified would refuse every such member on a
    // `requireVerifiedIdentity` pack, a governance lockout with no error they could act on.
    verifiedIdentity:
      row.emailVerified &&
      (asOf === undefined ||
        row.emailVerifiedAt === null ||
        Date.parse(row.emailVerifiedAt) <= Date.parse(asOf)),
    memberSince,
  };
}

/** Everything the predicate needs that is NOT a room-membership fact. */
export interface BallotFactsInput {
  readonly userId: string;
  /** Null ⇒ no active membership; every downstream fact then reads as unknown. */
  readonly facts: MemberFacts | null;
  /** Whole days since the newest non-finalized wallet link; null ⇒ no wallet. */
  readonly newestWalletAgeDays: number | null;
  readonly walletClusterId: string | null;
  readonly hasDisclosedConflict: boolean;
  readonly roleClasses: readonly string[];
  readonly isDesignatedSigner: boolean;
}

/**
 * Assemble `VoterFacts`. The ONLY place either caller builds one.
 *
 * `reputationScore` is the room-scoped qualifying-participation count the eligibility
 * gate already folds over — the one reputation-shaped quantity this platform computes.
 * Membership tenure is deliberately not mixed in: it is already a hard eligibility gate,
 * and folding it into weight would both double-count it and turn mere presence into
 * power. The quantity stays PRIVATE to one room's governance math — never a profile
 * field, never a ranking input (SIG-PROH-KARMA bans a public aggregate reputation).
 * Unknown facts read as 0, the weakest true claim; the zero-weight refusal downstream is
 * what stops a 0 being recorded as though it were a ballot.
 */
export function buildVoterFacts(input: BallotFactsInput): VoterFacts {
  return {
    userId: input.userId,
    membershipDays: input.facts?.membershipDays ?? null,
    contributionCount: input.facts?.contributionCount ?? null,
    verifiedIdentity: input.facts?.verifiedIdentity ?? false,
    newestWalletAgeDays: input.newestWalletAgeDays,
    walletClusterId: input.walletClusterId,
    hasDisclosedConflict: input.hasDisclosedConflict,
    roleClasses: [...input.roleClasses],
    reputationScore: input.facts?.contributionCount ?? 0,
    tokenVoteUnits: 0,
    isDesignatedSigner: input.isDesignatedSigner,
  };
}

/**
 * The arms the BASIS deliberately does not mirror, with the value it substitutes and the
 * reason it is sound to do so.
 *
 * Every entry weakens the basis in the SAFE direction — it can only admit a member the
 * gate might refuse, never refuse one the gate would admit — so the denominator is never
 * smaller than the population that can vote, and quorum is never easier than the pack
 * asks for.
 *
 * `satisfies` pins the keys to `VoterFacts`, so an exclusion naming a field that no
 * longer exists fails to compile.
 */
export const BASIS_EXCLUSIONS = {
  /**
   * Wallet age and cluster are per-request facts about how the voter will SIGN, not
   * about whether they belong to the electorate: any member can link a sufficiently
   * aged wallet before the deadline. Substituting "infinitely old, unclustered" admits
   * them, which is the safe direction.
   */
  newestWalletAgeDays: Number.MAX_SAFE_INTEGER,
  walletClusterId: null,
  /**
   * A conflict of interest is a fact about a member AND THIS PROPOSAL (the proposer who
   * disclosed one, or the recipient being paid). The basis is measured once per proposal
   * over the whole roster, and a recusal removes a member from the vote rather than from
   * the electorate — so counting them keeps the denominator equal to who may show up.
   */
  hasDisclosedConflict: false,
  /**
   * Role classes drive `role_based_quorum`, and the gate derives them per member
   * (`isSteward` ⇒ `['steward']`). The basis substitutes none, which under that model
   * refuses every member and would freeze the basis at zero — so this exclusion is only
   * sound while no reachable pack uses `role_based_quorum` with a role-class quorum
   * basis. Declared rather than hidden precisely because that is a condition, not a
   * reason; `electorate-parity.test.ts` is where it will fail if it stops holding.
   */
  roleClasses: [],
} as const satisfies Partial<VoterFacts>;

/** The verdict both callers reduce to: eligible AND resolving to positive weight. */
export interface BallotVerdict {
  readonly admitted: boolean;
  /** Present when eligibility refused; absent when weight was the refusal. */
  readonly code?: string;
  readonly reason?: string;
}

export interface BallotContext {
  readonly rules: EligibilityRules;
  readonly treasuryControlling: boolean;
  readonly recusalRequired: boolean;
  readonly weight: { readonly model: WeightModel; readonly maxVotingWeightPerAccount: number };
}

/**
 * Does this member pass BOTH halves of the ballot gate?
 *
 * The §17.5 gates stay false: no deployment records Sybil/anti-bribery/legal review, so
 * the token models are refused wholesale at signing. The basis mirrors that rather than
 * inventing an electorate for ballots nobody can cast.
 *
 * `delegations` is empty by design — delegated units are a property of a BALLOT, not of
 * membership, and folding them into the basis would count one member several times.
 */
export function ballotVerdict(facts: VoterFacts, ctx: BallotContext): BallotVerdict {
  const eligibility = checkVoterEligibility(facts, {
    rules: ctx.rules,
    treasuryControlling: ctx.treasuryControlling,
    recusalRequired: ctx.recusalRequired,
    clustersAlreadyVoted: new Set(),
  });
  if (!eligibility.eligible) {
    return { admitted: false, code: eligibility.code, reason: eligibility.reason };
  }
  const resolved = resolveVotingWeight({
    model: ctx.weight.model,
    facts,
    maxVotingWeightPerAccount: ctx.weight.maxVotingWeightPerAccount,
    gates: {
      sybilControlsVerified: false,
      antiBriberyMonitoring: false,
      legalReviewPassed: false,
    },
    delegations: [],
  });
  if (!resolved.resolved || decCompare(resolved.weight, 0) <= 0) return { admitted: false };
  return { admitted: true };
}

/** The default rules a pack without an `eligibility` block is read as carrying. */
export const DEFAULT_ELIGIBILITY_RULES: EligibilityRules = {
  minMembershipDays: 0,
  minContributions: 0,
  requireVerifiedIdentity: false,
  newWalletCoolingOffDays: 0,
};

/**
 * Assemble the BASIS's `VoterFacts` — `buildVoterFacts` with `BASIS_EXCLUSIONS` applied
 * here rather than at the call site.
 *
 * The exclusions used to be spread in by the caller, which made the list a convention:
 * the basis was free to substitute a different value, or none, and nothing would say so.
 * The drift guard could not see it either — its check spread `BASIS_EXCLUSIONS` into the
 * call itself and then asserted the output carried them, which holds for any pass-through
 * regardless of what the basis does.  Applying them in ONE function makes the guard
 * observe the real substitution, and leaves the caller with only the fields that are
 * genuinely per-member.
 */
export function buildBasisVoterFacts(
  input: Omit<BallotFactsInput, keyof typeof BASIS_EXCLUSIONS>,
): VoterFacts {
  return buildVoterFacts({ ...input, ...BASIS_EXCLUSIONS });
}
