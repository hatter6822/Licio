// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1.3c — comprehensive law-pack validation.  Three layers on top of the
// zod shape: (1) STRUCTURAL cross-field consistency (disjoint proposal types,
// per-action ≤ per-window caps, threshold rules matching quorum rules, no
// dangling rules); (2) REAL-ASSET completeness — the bar the `law_pack_valid`
// readiness item applies before a room may leave `simulated`; (3) the FIXTURE
// harness, which re-evaluates the pack's scenario corpus through the SAME
// engines the runtime executes (kernel / tally / eligibility gate), so a
// fixture pass guarantees runtime behavior.  The canonical text for the
// hash commitment excludes the `hashCommitment` field itself; the caller
// (api/web) digests it with SHA-256 — this package stays I/O- and crypto-free.

import { canonicalize } from './canonical-json.js';
import { decCompare } from './decimal.js';
import { evaluateTreasuryAction } from './kernel.js';
import { tallyProposalVotes } from './proposal-tally.js';
import type { LawPack } from './schemas/law-pack.js';
import { GATED_WEIGHT_MODELS } from './schemas/law-pack.js';
import type { LawPackFixture, LawPackFixtureCorpus } from './schemas/law-pack-fixtures.js';
import { checkVoterEligibility } from './weight-resolver.js';

export interface LawPackProblem {
  /** Dotted path of the offending field (or field pair). */
  path: string;
  problem: string;
}

/** The WS-M bundle blocks whose presence marks a pack as "extended". */
function hasWsmBlock(pack: LawPack): boolean {
  return (
    pack.quorumRules !== undefined ||
    pack.thresholdRules !== undefined ||
    pack.timelockRules !== undefined ||
    pack.weightModel !== undefined ||
    pack.eligibility !== undefined
  );
}

/**
 * Structural cross-field validation (WS-M.1.3c).  Returns every problem found
 * (never just the first) so a steward can fix a pack in one pass.
 */
export function validateLawPackBundle(pack: LawPack): LawPackProblem[] {
  const problems: LawPackProblem[] = [];
  const allowed = new Set(pack.allowedProposalTypes);

  // Allowed and disallowed proposal types must be disjoint.
  for (const type of pack.disallowedProposalTypes ?? []) {
    if (allowed.has(type)) {
      problems.push({
        path: 'disallowedProposalTypes',
        problem: `proposal type "${type}" appears in both allowed and disallowed lists`,
      });
    }
  }

  // Per-action cap must not exceed the per-window cap for the same category,
  // and a category may carry at most one cap entry (a duplicate would make the
  // kernel's `find` silently prefer the first).
  const seenCapCategories = new Set<string>();
  for (const cap of pack.treasury.caps) {
    if (seenCapCategories.has(cap.category)) {
      problems.push({
        path: `treasury.caps.${cap.category}`,
        problem: `duplicate cap entry for category "${cap.category}"`,
      });
    }
    seenCapCategories.add(cap.category);
    if (decCompare(cap.perActionMax, cap.perWindowMax) > 0) {
      problems.push({
        path: `treasury.caps.${cap.category}`,
        problem: `per-action cap ${cap.perActionMax} exceeds the per-window cap ${cap.perWindowMax}`,
      });
    }
  }

  // COI-required categories must have a configured cap (otherwise the category
  // can never execute, making the COI rule unreachable).
  for (const category of pack.treasury.requireCoiFor) {
    if (!seenCapCategories.has(category)) {
      problems.push({
        path: `treasury.requireCoiFor.${category}`,
        problem: `category "${category}" requires COI but has no spend cap configured (unreachable)`,
      });
    }
  }

  if (hasWsmBlock(pack)) {
    const quorum = pack.quorumRules ?? {};
    const threshold = pack.thresholdRules ?? {};
    const timelock = pack.timelockRules ?? {};
    // Every allowed proposal type needs its three rules.
    for (const type of pack.allowedProposalTypes) {
      if (quorum[type] === undefined) {
        problems.push({ path: `quorumRules.${type}`, problem: 'missing quorum rule' });
      }
      if (threshold[type] === undefined) {
        problems.push({ path: `thresholdRules.${type}`, problem: 'missing threshold rule' });
      }
      if (timelock[type] === undefined) {
        problems.push({ path: `timelockRules.${type}`, problem: 'missing timelock rule' });
      }
    }
    // No dangling rules for types the pack does not allow (a silent rule for a
    // disallowed type suggests a drafting error worth surfacing).
    for (const [rules, name] of [
      [quorum, 'quorumRules'],
      [threshold, 'thresholdRules'],
      [timelock, 'timelockRules'],
    ] as const) {
      for (const type of Object.keys(rules)) {
        if (!allowed.has(type)) {
          problems.push({
            path: `${name}.${type}`,
            problem: `rule references proposal type "${type}" which is not in allowedProposalTypes`,
          });
        }
      }
    }
    // A non-zero quorum with a zero threshold is a logical hole: a vote could
    // "pass" with zero affirmative weight (WS-M.1.3c cross-field consistency).
    for (const [type, rule] of Object.entries(quorum)) {
      const bar = threshold[type];
      if (rule.minFraction > 0 && bar !== undefined && bar.minAffirmativeFraction <= 0) {
        problems.push({
          path: `thresholdRules.${type}`,
          problem: 'threshold must be > 0 for a proposal type with a non-zero quorum',
        });
      }
    }
    if (pack.weightModel !== undefined && pack.maxVotingWeightPerAccount === undefined) {
      problems.push({
        path: 'maxVotingWeightPerAccount',
        problem: 'a weight model requires the per-account weight cap (§17.5 anti-capture)',
      });
    }
    if (pack.weightModel === 'multisig_steward' && pack.multisig === undefined) {
      problems.push({
        path: 'multisig',
        problem: 'the multisig_steward model requires a multisig policy (signers + required)',
      });
    }
    if (pack.coiRequirements !== undefined) {
      for (const type of pack.coiRequirements.independentReviewFor) {
        if (!allowed.has(type)) {
          problems.push({
            path: `coiRequirements.independentReviewFor.${type}`,
            problem: `independent review references proposal type "${type}" which is not allowed`,
          });
        }
      }
    }
  }
  return problems;
}

/** The WS-M blocks a REAL-ASSET pack must carry (the `law_pack_valid` bar). */
const REAL_ASSET_REQUIRED_FIELDS: readonly (keyof LawPack)[] = [
  'humanSummary',
  'quorumRules',
  'thresholdRules',
  'timelockRules',
  'weightModel',
  'maxVotingWeightPerAccount',
  'eligibility',
  'coiRequirements',
  'appealRules',
  'forkExitRules',
  'emergencyConstraints',
  'actionBudgetRules',
  'hashCommitment',
  'testFixtureCorpusRef',
];

/**
 * Real-asset completeness (WS-M.1.2e `law_pack_valid`): structural validity
 * plus every WS-M block present.  A gated weight model additionally surfaces a
 * reminder that the room must record its §17.5 preconditions (enforced live by
 * the resolver, which refuses gated models without them).
 */
export function validateLawPackForRealAssets(pack: LawPack): LawPackProblem[] {
  const problems = validateLawPackBundle(pack);
  for (const field of REAL_ASSET_REQUIRED_FIELDS) {
    if (pack[field] === undefined) {
      problems.push({ path: field, problem: 'required for real-asset governance modes' });
    }
  }
  if (pack.weightModel !== undefined && GATED_WEIGHT_MODELS.has(pack.weightModel)) {
    problems.push({
      path: 'weightModel',
      problem:
        `"${pack.weightModel}" is a gated §17.5 model: the room must have recorded Sybil ` +
        'controls, anti-bribery monitoring, and legal review before votes can resolve weights',
    });
  }
  return problems;
}

/**
 * The canonical serialization the hash commitment covers: the full bundle with
 * `hashCommitment` EXCLUDED (a hash cannot cover itself).  Deterministic —
 * `canonicalize` sorts keys recursively — so two semantically identical bundles
 * with reordered keys produce identical text (WS-M.1.3a).
 */
export function lawPackCanonicalText(pack: LawPack): string {
  const { hashCommitment, ...rest } = pack;
  void hashCommitment;
  return canonicalize(rest);
}

// ---------------------------------------------------------------------------
// Fixture harness (WS-M.1.3c): same engines as runtime, zero drift.
// ---------------------------------------------------------------------------

export interface FixtureFailure {
  label: string;
  expected: string;
  actual: string;
}

export interface FixtureRunResult {
  passed: boolean;
  total: number;
  failures: FixtureFailure[];
}

function runOneFixture(pack: LawPack, fixture: LawPackFixture): FixtureFailure | null {
  switch (fixture.kind) {
    case 'treasury_action': {
      const verdict = evaluateTreasuryAction(
        {
          actionId: `fixture:${fixture.label}`,
          roomId: 'fixture-room',
          category: fixture.action.category,
          amount: fixture.action.amount,
          asset: fixture.action.asset,
          timestamp: fixture.now,
          proposedAt: fixture.action.proposedAt,
          coiDeclared: fixture.action.coiDeclared,
          proposalRef: null,
          targetAllocation: fixture.action.targetAllocation,
        },
        pack.treasury,
        fixture.history,
        // Fixtures prove LAW semantics; the runtime crypto flag is orthogonal.
        { cryptoEnabled: true, now: fixture.now },
      );
      const actual = verdict.accepted ? 'accepted' : verdict.code;
      return actual === fixture.expect
        ? null
        : { label: fixture.label, expected: fixture.expect, actual };
    }
    case 'proposal_tally': {
      const quorum = pack.quorumRules?.[fixture.proposalType];
      const threshold = pack.thresholdRules?.[fixture.proposalType];
      if (quorum === undefined || threshold === undefined) {
        return {
          label: fixture.label,
          expected: fixture.expect,
          actual: `no quorum/threshold rule for proposal type "${fixture.proposalType}"`,
        };
      }
      const result = tallyProposalVotes(
        fixture.votes,
        { quorum, threshold },
        {
          eligibleCount: fixture.eligibleCount,
          deadlinePassed: fixture.deadlinePassed,
        },
      );
      return result.outcome === fixture.expect
        ? null
        : { label: fixture.label, expected: fixture.expect, actual: result.outcome };
    }
    case 'eligibility': {
      if (pack.eligibility === undefined) {
        return {
          label: fixture.label,
          expected: fixture.expect,
          actual: 'law-pack has no eligibility block',
        };
      }
      const decision = checkVoterEligibility(fixture.facts, {
        rules: pack.eligibility,
        treasuryControlling: fixture.treasuryControlling,
        recusalRequired: fixture.recusalRequired,
        clustersAlreadyVoted: new Set(fixture.clustersAlreadyVoted),
      });
      const actual = decision.eligible ? 'eligible' : decision.code;
      return actual === fixture.expect
        ? null
        : { label: fixture.label, expected: fixture.expect, actual };
    }
    default: {
      const exhaustive: never = fixture;
      throw new Error(`unhandled fixture kind: ${String(exhaustive)}`);
    }
  }
}

/** Run the full corpus; a pack with ANY failing fixture cannot be published. */
export function runLawPackFixtures(pack: LawPack, corpus: LawPackFixtureCorpus): FixtureRunResult {
  const failures: FixtureFailure[] = [];
  for (const fixture of corpus.fixtures) {
    const failure = runOneFixture(pack, fixture);
    if (failure !== null) failures.push(failure);
  }
  return { passed: failures.length === 0, total: corpus.fixtures.length, failures };
}

/**
 * Corpus coverage (WS-M.1.3c): every allowed proposal type needs at least one
 * tally fixture; every configured cap category at least one treasury fixture;
 * an eligibility block at least one eligibility fixture.
 */
export function fixtureCoverageProblems(
  pack: LawPack,
  corpus: LawPackFixtureCorpus,
): LawPackProblem[] {
  const problems: LawPackProblem[] = [];
  const tallyTypes = new Set(
    corpus.fixtures.filter((f) => f.kind === 'proposal_tally').map((f) => f.proposalType),
  );
  for (const type of pack.allowedProposalTypes) {
    if (!tallyTypes.has(type)) {
      problems.push({
        path: `fixtures.${type}`,
        problem: `no proposal_tally fixture covers allowed proposal type "${type}"`,
      });
    }
  }
  const treasuryCategories = new Set(
    corpus.fixtures.filter((f) => f.kind === 'treasury_action').map((f) => f.action.category),
  );
  for (const cap of pack.treasury.caps) {
    if (!treasuryCategories.has(cap.category)) {
      problems.push({
        path: `fixtures.treasury.${cap.category}`,
        problem: `no treasury_action fixture covers cap category "${cap.category}"`,
      });
    }
  }
  if (pack.eligibility !== undefined && !corpus.fixtures.some((f) => f.kind === 'eligibility')) {
    problems.push({
      path: 'fixtures.eligibility',
      problem: 'the eligibility block has no covering fixture',
    });
  }
  return problems;
}
