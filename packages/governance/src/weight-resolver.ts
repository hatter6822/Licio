// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.4.2c-1/c-2 — the §17.5 voter-eligibility gate and voting-weight resolver.
// Pure and deterministic: every fact is passed in, so serving, replay, and the
// law-pack fixture harness all execute the same math.  The gate runs BEFORE the
// resolver (an ineligible voter never reaches a weight computation); the resolver
// applies the law-pack's per-account cap to EVERY model and refuses the gated
// token models unless the room's Sybil/anti-bribery/legal-review preconditions
// are recorded as satisfied (fail-closed, §17.5).  All weight arithmetic is
// exact decimal (`decimal.ts`) — capped fractional weights never float-drift.

import { decAdd, decCompare, decSub } from './decimal.js';
import type { EligibilityRules, WeightModel } from './schemas/law-pack.js';
import { GATED_WEIGHT_MODELS } from './schemas/law-pack.js';
import type {
  EligibilityDecision,
  IncomingDelegation,
  VoterFacts,
  VoteWeight,
  WeightModelGates,
  WeightResolution,
} from './schemas/voting.js';

export interface EligibilityContext {
  rules: EligibilityRules;
  /** Whether THIS vote controls treasury funds (cooling-off + fail-closed apply). */
  treasuryControlling: boolean;
  /** Law-pack COI recusal applies to this proposal (WS-M.2.3d). */
  recusalRequired: boolean;
  /** Cluster ids that have ALREADY voted on this proposal (Sybil collapse). */
  clustersAlreadyVoted: ReadonlySet<string>;
}

/**
 * The §17.5 eligibility gate.  Unknown facts (null) are conservative: a
 * treasury-controlling vote REJECTS on unknown membership/contribution facts
 * rather than admitting an unverifiable voter (fail-closed); a non-treasury
 * vote treats unknown as zero (the weakest true claim).
 */
export function checkVoterEligibility(
  facts: VoterFacts,
  ctx: EligibilityContext,
): EligibilityDecision {
  const { rules } = ctx;
  if (
    ctx.treasuryControlling &&
    (facts.membershipDays === null || facts.contributionCount === null)
  ) {
    return {
      eligible: false,
      code: 'facts_unavailable',
      reason:
        'Membership or contribution history could not be verified; treasury-controlling votes fail closed.',
    };
  }
  const membershipDays = facts.membershipDays ?? 0;
  if (membershipDays < rules.minMembershipDays) {
    return {
      eligible: false,
      code: 'membership_too_new',
      reason: `Membership of ${membershipDays}d is below the required ${rules.minMembershipDays}d.`,
    };
  }
  const contributions = facts.contributionCount ?? 0;
  if (contributions < rules.minContributions) {
    return {
      eligible: false,
      code: 'insufficient_contributions',
      reason: `${contributions} contributions is below the required ${rules.minContributions}.`,
    };
  }
  if (rules.requireVerifiedIdentity && !facts.verifiedIdentity) {
    return {
      eligible: false,
      code: 'identity_unverified',
      reason: 'This vote requires a verified identity.',
    };
  }
  if (
    ctx.treasuryControlling &&
    rules.newWalletCoolingOffDays > 0 &&
    facts.newestWalletAgeDays !== null &&
    facts.newestWalletAgeDays < rules.newWalletCoolingOffDays
  ) {
    return {
      eligible: false,
      code: 'wallet_cooling_off',
      reason: `A wallet linked ${facts.newestWalletAgeDays}d ago is inside the ${rules.newWalletCoolingOffDays}d cooling-off for treasury-controlling votes.`,
    };
  }
  if (ctx.recusalRequired && facts.hasDisclosedConflict) {
    return {
      eligible: false,
      code: 'coi_recusal',
      reason: 'A disclosed conflict of interest requires recusal on this proposal.',
    };
  }
  if (facts.walletClusterId !== null && ctx.clustersAlreadyVoted.has(facts.walletClusterId)) {
    return {
      eligible: false,
      code: 'cluster_already_voted',
      reason: 'Another account in the same wallet cluster has already voted on this proposal.',
    };
  }
  return { eligible: true, reason: 'Meets the room’s eligibility requirements.' };
}

export interface WeightResolverInput {
  model: WeightModel;
  facts: VoterFacts;
  /** The law-pack's per-account weight ceiling (applies to EVERY model). */
  maxVotingWeightPerAccount: number;
  /** §17.5 preconditions for the gated token models. */
  gates: WeightModelGates;
  /** Active, scope-matching incoming delegations (delegated model only). */
  delegations: readonly IncomingDelegation[];
}

/** Exact min over `number | string` decimals, rendered canonically. */
function decMin(a: VoteWeight, b: VoteWeight): string {
  return decCompare(a, b) <= 0 ? canonical(a) : canonical(b);
}

function canonical(value: VoteWeight): string {
  // decAdd normalizes either input form to the canonical decimal string.
  return decAdd(value, 0);
}

/**
 * Exact integer square root (Newton's method on bigints).  IEEE `Math.sqrt`
 * loses precision above 2^52 and would violate this module's exact-decimal
 * invariant, so the quadratic model floors √units through this helper — the
 * documented ⌊√units⌋ contract holds for arbitrarily large inputs.
 */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Resolve a voter's effective weight for one proposal (WS-M.4.2c-1).  The
 * caller has already run `checkVoterEligibility`; this function only computes
 * the capped weight and its explanation.  Deterministic and pure.
 */
export function resolveVotingWeight(input: WeightResolverInput): WeightResolution {
  const cap = input.maxVotingWeightPerAccount;
  if (GATED_WEIGHT_MODELS.has(input.model)) {
    const { sybilControlsVerified, antiBriberyMonitoring, legalReviewPassed } = input.gates;
    if (!sybilControlsVerified || !antiBriberyMonitoring || !legalReviewPassed) {
      return {
        resolved: false,
        code: 'weight_model_gated',
        reason:
          `The "${input.model}" model requires verified Sybil controls, anti-bribery ` +
          'monitoring, and legal review; one or more are not recorded for this room.',
      };
    }
  }
  switch (input.model) {
    case 'one_civic_account_one_vote': {
      const weight = decMin(1, cap);
      return {
        resolved: true,
        weight,
        eligibilityReason: `One civic account, one vote (weight ${weight}, cap ${cap}).`,
      };
    }
    case 'reputation_bounded': {
      const weight = decMin(input.facts.reputationScore, cap);
      return {
        resolved: true,
        weight,
        eligibilityReason:
          `Reputation-bounded: score ${input.facts.reputationScore} capped at ` +
          `${cap} ⇒ weight ${weight}.`,
      };
    }
    case 'role_based_quorum': {
      // Role classes shape the QUORUM basis, not the per-account weight: each
      // account in a participating role class carries one capped vote.
      const weight = decMin(1, cap);
      const roles = input.facts.roleClasses.length > 0 ? input.facts.roleClasses.join(', ') : '—';
      return {
        resolved: true,
        weight,
        eligibilityReason: `Role-based quorum (roles: ${roles}); one capped vote (weight ${weight}).`,
      };
    }
    case 'capped_token': {
      const weight = decMin(input.facts.tokenVoteUnits, cap);
      return {
        resolved: true,
        weight,
        eligibilityReason:
          `Capped token: ${input.facts.tokenVoteUnits} vote units capped at ${cap} ` +
          `⇒ weight ${weight}.`,
      };
    }
    case 'quadratic_capped': {
      // Quadratic voting: weight grows with the square root of committed units,
      // floored to keep the tally integral, then capped per account.
      const quadratic = isqrt(BigInt(Math.trunc(input.facts.tokenVoteUnits))).toString();
      const weight = decMin(quadratic, cap);
      return {
        resolved: true,
        weight,
        eligibilityReason:
          `Quadratic capped: ⌊√${input.facts.tokenVoteUnits}⌋ = ${quadratic} capped at ` +
          `${cap} ⇒ weight ${weight}.`,
      };
    }
    case 'delegated': {
      // Own vote (1) plus eligible incoming delegations; an ineligible delegator
      // confers nothing, and the AGGREGATE is capped — a delegate cannot exceed
      // the per-account ceiling by accumulating delegations (WS-M.4.2c-3).
      //
      // The fold STOPS at the ceiling, and names the delegators it consumed.
      // Summing every delegation and capping the total afterwards produced the
      // same weight but lost which units the cap had dropped, and the caller's
      // double-count guard reads exactly that: a delegator whose unit the cap
      // discarded was still treated as having voted through their delegate, so
      // their weight vanished from the tally while they were refused a direct
      // ballot.  With a cap of 1 — the default when a law pack sets none —
      // EVERY delegated unit is discarded, which turned delegation into pure
      // disenfranchisement.  Consumption is now decided here, by the same fold
      // that decides the weight, and cannot drift from it.
      //
      // Fold order is the caller's order and is load-bearing: it decides which
      // delegators the ceiling admits, so the caller must present a canonical,
      // stable one.
      // A DELEGATED UNIT IS INDIVISIBLE — it is folded only if it fits WHOLE.
      //
      // Counting a partially-absorbed unit as consumed lost most of it.
      // `maxVotingWeightPerAccount` is `z.number().positive()` with no integer
      // constraint, and each delegated unit is the literal weight 1, so with a cap
      // of 1.01 the boundary delegation folded (there was headroom), the resolved
      // weight became 1.01, and that delegator was marked CONSUMED — 0.01 of their
      // unit absorbed, 0.99 erased from the tally, and their own direct ballot
      // refused 409 `delegated_weight_already_cast`.  A cap of 1.5 lost 0.5 the
      // same way.
      //
      // Skipping it instead leaves that fraction of the ceiling unused, which is
      // the right trade: a fraction of a member's vote is not a thing that can be
      // conferred, and the delegator keeps the direct ballot that carries their
      // whole unit.  The alternative — count them as unconsumed while their
      // fraction still moved the weight — would double-count that fraction.
      //
      // `continue`, not `break`: a later delegation with a smaller weight may
      // still fit the remaining headroom, and the caller's canonical order makes
      // that deterministic.
      let running = '1';
      const countedDelegatorIds: string[] = [];
      for (const delegation of input.delegations) {
        if (!delegation.delegatorEligible) continue;
        const next = decAdd(running, delegation.weight);
        if (decCompare(next, cap) > 0) continue; // would not fit whole
        running = next;
        countedDelegatorIds.push(delegation.delegatorUserId);
      }
      const weight = decMin(running, cap);
      // The own vote is 1, so anything above it is delegated — unless the cap
      // itself sits below 1, in which case no delegated unit fit at all.
      const delegated = decCompare(weight, '1') > 0 ? decSub(weight, '1') : '0';
      return {
        resolved: true,
        weight,
        eligibilityReason:
          `Delegated: own vote + ${countedDelegatorIds.length} eligible delegations ` +
          `(${delegated}) capped at ${cap} ⇒ weight ${weight}.`,
        countedDelegatorIds,
      };
    }
    case 'multisig_steward': {
      if (!input.facts.isDesignatedSigner) {
        return {
          resolved: false,
          code: 'not_designated_signer',
          reason: 'Only designated multisig signers carry weight under multisig_steward.',
        };
      }
      const weight = decMin(1, cap);
      return {
        resolved: true,
        weight,
        eligibilityReason: `Designated multisig signer (weight ${weight}, cap ${cap}).`,
      };
    }
    default: {
      const exhaustive: never = input.model;
      throw new Error(`unhandled weight model: ${String(exhaustive)}`);
    }
  }
}
