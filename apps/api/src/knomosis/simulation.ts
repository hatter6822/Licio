// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.4 — governance simulation (K1).  Simulated proposals, the SIM-asset
// treasury, one-account-one-vote voting, timelocked simulated execution, the
// comprehension gate, and the append-only governance audit log.
//
// STRUCTURAL SEPARATION (WS-L.4.1d, asserted by an import-graph test): this
// module NEVER imports `submission.ts`, `gateway.ts`, `ingest.ts`, or
// `standing.ts` — the simulated execution path shares no function with real
// execution, and no simulated action can produce a `KnomosisActionRecord` or
// an `OnChainEvent` (it has no reference to those stores at all).
//
// Every simulated element is unmistakably simulation: assets are SIM-*, every
// audit entry carries `simulation_mode: true`, and the wire responses carry
// the undismissable SIMULATION_LABEL banner (WS-L.4.1c).

import { decCompare, decSum } from '@licio/governance';
import {
  type ComprehensionQuestion,
  type GovernanceMode,
  type GovernanceProposalCreate,
  SIM_TREASURY_MAX_ASSETS,
  SIMULATION_LABEL,
  type SimTreasuryResponse,
} from '@licio/shared';
import type { PwattConfigStore } from '../events/stores.js';
import type { KnomosisRuntimeConfig } from './config.js';
import { killSwitchDecision } from './killswitch.js';
import type {
  ComprehensionStore,
  GovernanceAuditStore,
  GovernanceProposalRecord,
  GovernanceProposalStore,
  ProposalVoteChoice,
  ProposalVoteStore,
  SimTreasuryStore,
} from './stores.js';

export interface SimulationDeps {
  proposals: GovernanceProposalStore;
  votes: ProposalVoteStore;
  simTreasury: SimTreasuryStore;
  governanceAudit: GovernanceAuditStore;
  comprehension: ComprehensionStore;
  configStore: PwattConfigStore;
  config: () => KnomosisRuntimeConfig;
  now: () => number;
  uuid: () => string;
  log: (event: string, meta: Record<string, unknown>) => void;
  /** Comprehension metric sink (§28.3 "transaction comprehension"). */
  metric: (name: string, value: number) => void;
  regionForUser: (userId: string) => Promise<string | null>;
  /** The room's CURRENT governance mode (null when unknown/unavailable) — both
   *  the manual execute route AND the background sweep must refuse to debit a
   *  retired simulated treasury once the room leaves `simulated` (WS-L.4.1d). */
  roomMode: (roomId: string) => Promise<GovernanceMode | null>;
}

export type SimulationError = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 503;
  code: string;
  message: string;
};
const err = (
  status: SimulationError['status'],
  code: string,
  message: string,
): SimulationError => ({ ok: false, status, code, message });

// ---------------------------------------------------------------------------
// Comprehension testing (WS-L.4.1e)
// ---------------------------------------------------------------------------

export const COMPREHENSION_QUIZ_VERSION = '1';

interface QuizQuestion extends ComprehensionQuestion {
  readonly correctChoice: number;
}

/** The v1 quiz: fake assets, non-binding outcomes, sim-vs-real, labeling. */
export const COMPREHENSION_QUIZ: readonly QuizQuestion[] = [
  {
    question_id: 'fake-assets',
    prompt: 'What are the SIM-USDC amounts shown in simulated governance worth?',
    choices: [
      'Nothing — they are fake assets with no real value',
      'Real dollars held by Licio',
      'Cryptocurrency that can be withdrawn later',
    ],
    correctChoice: 0,
    explanation:
      'Simulated treasuries use fake assets (SIM-*). They have no real value and can never be withdrawn or exchanged.',
  },
  {
    question_id: 'non-binding',
    prompt: 'A simulated proposal passes. Who is obligated to act on it?',
    choices: [
      'The room stewards must implement it',
      'No one — simulated outcomes are practice and do not obligate anyone',
      'Licio must fund it from the platform treasury',
    ],
    correctChoice: 1,
    explanation:
      'Simulated governance outcomes are educational. They create no obligation for anyone.',
  },
  {
    question_id: 'real-vs-sim',
    prompt: 'How does real governance (if a room later enables it) differ from simulation?',
    choices: [
      'It looks different but works the same',
      'Real governance involves real funds and binding decisions',
      'There is no difference',
    ],
    correctChoice: 1,
    explanation:
      'Real governance (testnet and beyond) involves real assets and binding, recorded decisions — simulation does not.',
  },
  {
    question_id: 'label',
    prompt: 'What does the persistent "SIMULATION" label on the governance tab indicate?',
    choices: [
      'A temporary bug in the page',
      'The room is in non-real, educational mode — nothing here has real value',
      'The room is being moderated',
    ],
    correctChoice: 1,
    explanation:
      'The label marks every simulated element so simulation can never be mistaken for real governance.',
  },
];

/** Public quiz projection (no correct answers on the wire). */
export function quizQuestions(): ComprehensionQuestion[] {
  return COMPREHENSION_QUIZ.map(({ correctChoice, ...question }) => {
    void correctChoice;
    return question;
  });
}

export async function hasPassedComprehension(
  deps: Pick<SimulationDeps, 'comprehension'>,
  userId: string,
): Promise<boolean> {
  const result = await deps.comprehension.get(userId, COMPREHENSION_QUIZ_VERSION);
  return result?.passed ?? false;
}

/** Grade a submission; all questions must be correct to pass (WS-L.4.1e). */
export async function submitComprehension(
  deps: SimulationDeps,
  args: { userId: string; quizVersion: string; answers: Record<string, number> },
): Promise<
  | {
      ok: true;
      passed: boolean;
      corrections: { question_id: string; correct_choice: number; explanation: string }[];
    }
  | SimulationError
> {
  if (args.quizVersion !== COMPREHENSION_QUIZ_VERSION) {
    return err(409, 'quiz_version_stale', 'The quiz version is out of date; reload and retry.');
  }
  const corrections: { question_id: string; correct_choice: number; explanation: string }[] = [];
  for (const question of COMPREHENSION_QUIZ) {
    if (args.answers[question.question_id] !== question.correctChoice) {
      corrections.push({
        question_id: question.question_id,
        correct_choice: question.correctChoice,
        explanation: question.explanation,
      });
    }
  }
  const passed = corrections.length === 0;
  await deps.comprehension.record(
    args.userId,
    COMPREHENSION_QUIZ_VERSION,
    passed,
    new Date(deps.now()).toISOString(),
  );
  deps.metric(passed ? 'knomosis.comprehension.passed' : 'knomosis.comprehension.failed', 1);
  if (passed) {
    deps.log('knomosis.comprehension.passed', { quiz_version: COMPREHENSION_QUIZ_VERSION });
  }
  return { ok: true, passed, corrections };
}

/** The gate before a user's FIRST simulated governance action (WS-L.4.1e). */
async function requireComprehension(
  deps: SimulationDeps,
  userId: string,
): Promise<SimulationError | null> {
  if (await hasPassedComprehension(deps, userId)) return null;
  return err(
    403,
    'comprehension_required',
    'Complete the short simulation-comprehension check before your first governance action.',
  );
}

// ---------------------------------------------------------------------------
// Simulated treasury (WS-L.4.1c)
// ---------------------------------------------------------------------------

/** The stored balance is numeric(78,0) — a summed balance may hold at most 78
 *  digits, matching `minorUnitAmountSchema` on the response boundary. */
const SIM_TREASURY_MAX_BALANCE_DIGITS = 78;

/** Idempotent bootstrap with the configured starting balance. */
export async function ensureSimTreasury(
  deps: SimulationDeps,
  roomId: string,
): Promise<{ roomId: string; balances: Record<string, string>; updatedAt: string }> {
  const existing = await deps.simTreasury.get(roomId);
  if (existing !== null) return existing;
  const config = deps.config();
  const record = {
    roomId,
    balances: { [config.simStartingAsset]: config.simStartingBalanceMinorUnits },
    updatedAt: new Date(deps.now()).toISOString(),
  };
  // Insert-if-absent: a concurrent create/deposit returns the authoritative row.
  return (await deps.simTreasury.put(record)) ?? record;
}

/**
 * Read-modify-write the sim treasury balances with optimistic-concurrency retry
 * (WS-L.4.1c): two racing deposits/executions can no longer read the same
 * snapshot and overwrite each other's delta.  `compute` runs against the LATEST
 * balances each attempt (so an execution's sufficiency check stays atomic with
 * the debit); it returns the next balances + a result, or a typed error.
 */
async function mutateSimTreasury<T>(
  deps: SimulationDeps,
  roomId: string,
  compute: (
    balances: Record<string, string>,
  ) => { balances: Record<string, string>; result: T } | { error: SimulationError },
): Promise<{ ok: true; result: T } | SimulationError> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await ensureSimTreasury(deps, roomId);
    const computed = compute(current.balances);
    if ('error' in computed) return computed.error;
    // The version MUST advance even under a static test clock, or a same-ms
    // second writer would see an unchanged version and lose its update.
    const nextUpdatedAt = new Date(
      Math.max(deps.now(), Date.parse(current.updatedAt) + 1),
    ).toISOString();
    const written = await deps.simTreasury.put(
      { roomId, balances: computed.balances, updatedAt: nextUpdatedAt },
      current.updatedAt,
    );
    if (written !== null) return { ok: true, result: computed.result };
  }
  return err(409, 'treasury_contended', 'The simulated treasury is busy; please retry.');
}

export async function simTreasuryView(
  deps: SimulationDeps,
  roomId: string,
): Promise<SimTreasuryResponse> {
  const treasury = await ensureSimTreasury(deps, roomId);
  return {
    room_id: roomId,
    simulation_label: SIMULATION_LABEL,
    balances: Object.entries(treasury.balances).map(([asset, amount]) => ({ asset, amount })),
    updated_at: treasury.updatedAt,
  };
}

/** Simulated deposit; gated by the payment-intent kill switch (WS-L.3.5b). */
export async function simDeposit(
  deps: SimulationDeps,
  args: { roomId: string; userId: string; asset: string; amount: string },
): Promise<{ ok: true; treasury: SimTreasuryResponse } | SimulationError> {
  const comprehension = await requireComprehension(deps, args.userId);
  if (comprehension !== null) return comprehension;

  const region = await deps.regionForUser(args.userId);
  const decision = await killSwitchDecision(deps.configStore, 'payment_intent_creation', {
    roomId: args.roomId,
    region,
  });
  if (decision.engaged) {
    return err(503, 'kill_switch_active', 'Payment creation is temporarily paused.');
  }

  // Atomic read-modify-write: the asset-cap check + the balance add re-run against
  // the LATEST balances each attempt, so concurrent deposits cannot lose an update
  // or slip a distinct asset past the schema cap (WS-L.4.1c).
  const applied = await mutateSimTreasury(deps, args.roomId, (balances) => {
    const isNewAsset = !Object.hasOwn(balances, args.asset);
    if (isNewAsset && Object.keys(balances).length >= SIM_TREASURY_MAX_ASSETS) {
      return {
        error: err(
          409,
          'too_many_sim_assets',
          `A simulated treasury holds at most ${SIM_TREASURY_MAX_ASSETS} distinct assets.`,
        ),
      };
    }
    // Each deposit fits `minorUnitAmountSchema` (≤ 78 digits), but the SUM can
    // overflow the numeric(78,0) balance.  Reject BEFORE persisting — else the
    // oversized row saves and then fails `simTreasuryResponseSchema` on every
    // future read, wedging the treasury behind 500s (WS-L.4.1c).
    const next = decSum([balances[args.asset] ?? '0', args.amount]);
    if (next.replace('-', '').length > SIM_TREASURY_MAX_BALANCE_DIGITS) {
      return {
        error: err(
          409,
          'sim_balance_overflow',
          'This deposit would overflow the simulated treasury balance.',
        ),
      };
    }
    return {
      balances: { ...balances, [args.asset]: next },
      result: null,
    };
  });
  if (!applied.ok) return applied;
  const nowIso = new Date(deps.now()).toISOString();
  await deps.simTreasury.appendEntry({
    entryId: deps.uuid(),
    roomId: args.roomId,
    kind: 'deposit',
    asset: args.asset,
    amount: args.amount,
    actorUserId: args.userId,
    proposalId: null,
    createdAt: nowIso,
  });
  await deps.governanceAudit.append({
    entryId: deps.uuid(),
    roomId: args.roomId,
    actionType: 'treasury_deposit_simulated',
    actorUserId: args.userId,
    actionDetails: { asset: args.asset, amount: args.amount },
    simulationMode: true,
    createdAt: nowIso,
  });
  return { ok: true, treasury: await simTreasuryView(deps, args.roomId) };
}

// ---------------------------------------------------------------------------
// Proposal templates (WS-L.4.1b)
// ---------------------------------------------------------------------------

/** Template completeness beyond the zod shape (WS-L.4.1b). */
export function validateProposalTemplate(
  create: GovernanceProposalCreate,
): { field: string; problem: string }[] {
  const problems: { field: string; problem: string }[] = [];
  const budgeted = create.proposal_type === 'bounty' || create.proposal_type === 'capped_grant';
  if (budgeted) {
    if (create.requested_amount === null) {
      problems.push({ field: 'requested_amount', problem: 'a budget amount is required' });
    }
    if (create.asset === null) {
      problems.push({ field: 'asset', problem: 'a simulated asset is required' });
    }
    if (create.recipient_ref === null) {
      problems.push({ field: 'recipient_ref', problem: 'a recipient is required' });
    }
    if (create.conflict_disclosures === null || create.conflict_disclosures.trim().length === 0) {
      problems.push({
        field: 'conflict_disclosures',
        problem: 'a conflict-of-interest disclosure is required for grants and bounties',
      });
    }
  } else {
    // A NON-budgeted proposal (charter_update) must NOT carry budget fields —
    // otherwise it would deduct the simulated treasury on execution while
    // skipping the recipient/conflict-disclosure checks a spend requires.
    if (create.requested_amount !== null) {
      problems.push({
        field: 'requested_amount',
        problem: 'a budget amount is not allowed for this proposal type',
      });
    }
    if (create.asset !== null) {
      problems.push({ field: 'asset', problem: 'an asset is not allowed for this proposal type' });
    }
  }
  return problems;
}

export async function createSimProposal(
  deps: SimulationDeps,
  args: { roomId: string; userId: string; create: GovernanceProposalCreate },
): Promise<{ ok: true; proposal: GovernanceProposalRecord } | SimulationError> {
  const comprehension = await requireComprehension(deps, args.userId);
  if (comprehension !== null) return comprehension;

  const problems = validateProposalTemplate(args.create);
  if (problems.length > 0) {
    return err(
      400,
      'template_incomplete',
      problems.map((p) => `${p.field}: ${p.problem}`).join('; '),
    );
  }

  // Budget impact must fit the SIMULATED treasury (WS-L.4.1b).
  if (args.create.requested_amount !== null && args.create.asset !== null) {
    const treasury = await ensureSimTreasury(deps, args.roomId);
    const available = treasury.balances[args.create.asset] ?? '0';
    if (decCompare(args.create.requested_amount, available) > 0) {
      return err(
        400,
        'budget_exceeded',
        'The requested amount exceeds the simulated treasury balance.',
      );
    }
  }

  const nowIso = new Date(deps.now()).toISOString();
  const proposal: GovernanceProposalRecord = {
    proposalId: deps.uuid(),
    roomId: args.roomId,
    proposerUserId: args.userId,
    proposalType: args.create.proposal_type,
    title: args.create.title,
    plainLanguageSummary: args.create.plain_language_summary,
    requestedAmount: args.create.requested_amount,
    asset: args.create.asset,
    recipientRef: args.create.recipient_ref,
    conflictDisclosures: args.create.conflict_disclosures,
    riskAssessment: args.create.risk_assessment,
    requestedAction: args.create.requested_action,
    expectedDeliverable: args.create.expected_deliverable,
    preflightState: 'passed', // completeness check IS the simulated preflight
    votingState: 'open',
    challengeState: 'none',
    executionState: 'not_executed',
    simulationMode: true,
    executableAfter: null,
    createdAt: nowIso,
    executedAt: null,
  };
  await deps.proposals.insert(proposal);
  await deps.governanceAudit.append({
    entryId: deps.uuid(),
    roomId: args.roomId,
    actionType: 'proposal_created',
    actorUserId: args.userId,
    actionDetails: { proposal_id: proposal.proposalId, proposal_type: proposal.proposalType },
    simulationMode: true,
    createdAt: nowIso,
  });
  return { ok: true, proposal };
}

// ---------------------------------------------------------------------------
// Simulated voting + execution (WS-L.4.1d)
// ---------------------------------------------------------------------------

export async function castSimVote(
  deps: SimulationDeps,
  args: { roomId: string; proposalId: string; userId: string; choice: ProposalVoteChoice },
): Promise<{ ok: true; proposal: GovernanceProposalRecord } | SimulationError> {
  const comprehension = await requireComprehension(deps, args.userId);
  if (comprehension !== null) return comprehension;

  const region = await deps.regionForUser(args.userId);
  const decision = await killSwitchDecision(deps.configStore, 'governance_voting', {
    roomId: args.roomId,
    region,
  });
  if (decision.engaged) {
    return err(503, 'kill_switch_active', 'Voting is temporarily paused.');
  }

  const proposal = await deps.proposals.getById(args.proposalId);
  if (proposal === null || proposal.roomId !== args.roomId) {
    return err(404, 'not_found', 'Resource not found');
  }
  if (proposal.votingState !== 'open') {
    return err(409, 'voting_closed', 'Voting on this proposal has closed.');
  }
  const cast = await deps.votes.cast({
    proposalId: args.proposalId,
    voterUserId: args.userId,
    choice: args.choice,
    castAt: new Date(deps.now()).toISOString(),
  });
  if (cast === null) return err(409, 'already_voted', 'You have already voted on this proposal.');

  await deps.governanceAudit.append({
    entryId: deps.uuid(),
    roomId: args.roomId,
    actionType: 'vote_cast',
    actorUserId: args.userId,
    actionDetails: { proposal_id: args.proposalId, choice: args.choice },
    simulationMode: true,
    createdAt: new Date(deps.now()).toISOString(),
  });

  const updated = await evaluateSimVote(deps, proposal);
  return { ok: true, proposal: updated };
}

/**
 * Quorum + threshold evaluation (WS-L.4.1d; MVP defaults, law-pack later):
 * quorum = distinct voters ≥ simQuorumMinVoters; threshold = approve strictly
 * greater than simApprovalThresholdPercent of (approve + reject).  Passing
 * starts the simulated timelock; a rejecting majority (with quorum) rejects.
 */
export async function evaluateSimVote(
  deps: SimulationDeps,
  proposal: GovernanceProposalRecord,
): Promise<GovernanceProposalRecord> {
  const config = deps.config();
  const tally = await deps.votes.tally(proposal.proposalId);
  const voters = tally.approve + tally.reject + tally.abstain;
  if (voters < config.simQuorumMinVoters) return proposal;

  const decided = tally.approve + tally.reject;
  if (decided === 0) return proposal;

  const nowMs = deps.now();
  const approvePct = (tally.approve / decided) * 100;
  if (approvePct > config.simApprovalThresholdPercent) {
    const updated: GovernanceProposalRecord = {
      ...proposal,
      votingState: 'passed',
      executionState: 'timelocked',
      executableAfter: new Date(nowMs + config.simTimelockSeconds * 1000).toISOString(),
    };
    await deps.proposals.update(updated);
    await deps.governanceAudit.append({
      entryId: deps.uuid(),
      roomId: proposal.roomId,
      actionType: 'proposal_passed',
      actorUserId: null,
      actionDetails: { proposal_id: proposal.proposalId, tally },
      simulationMode: true,
      createdAt: new Date(nowMs).toISOString(),
    });
    return updated;
  }
  // STRICT rejecting majority (mirrors the strict approval bar): a tie — e.g. a
  // quorum-reaching 1 approve / 1 reject / 1 abstain — crosses NEITHER threshold
  // and stays OPEN rather than being prematurely rejected.
  if ((tally.reject / decided) * 100 > 100 - config.simApprovalThresholdPercent) {
    const updated: GovernanceProposalRecord = { ...proposal, votingState: 'rejected' };
    await deps.proposals.update(updated);
    await deps.governanceAudit.append({
      entryId: deps.uuid(),
      roomId: proposal.roomId,
      actionType: 'proposal_rejected',
      actorUserId: null,
      actionDetails: { proposal_id: proposal.proposalId, tally },
      simulationMode: true,
      createdAt: new Date(nowMs).toISOString(),
    });
    return updated;
  }
  return withTally(proposal, tally);
}

function withTally(
  proposal: GovernanceProposalRecord,
  _tally: { approve: number; reject: number; abstain: number },
): GovernanceProposalRecord {
  return proposal;
}

/**
 * Execute a passed, timelock-elapsed proposal IN SIMULATION (WS-L.4.1d): the
 * simulated treasury is deducted for budgeted templates; charter updates are
 * recorded in the audit log.  No on-chain state, no KnomosisActionRecord, no
 * OnChainEvent — this module cannot produce them by construction.
 */
export async function executeSimProposal(
  deps: SimulationDeps,
  args: { roomId: string; proposalId: string; actorUserId: string | null },
): Promise<{ ok: true; proposal: GovernanceProposalRecord } | SimulationError> {
  // A manual execution IS a first-class governance action: enforce the
  // comprehension gate for a member actor exactly as proposal creation/voting/
  // deposit do, so executing a timelock-elapsed proposal cannot become an
  // unquizzed member's first action.  The automated scheduler path passes a
  // null actor and is never user-gated.
  if (args.actorUserId !== null) {
    const comprehension = await requireComprehension(deps, args.actorUserId);
    if (comprehension !== null) return comprehension;
  }
  const proposal = await deps.proposals.getById(args.proposalId);
  if (proposal === null || proposal.roomId !== args.roomId) {
    return err(404, 'not_found', 'Resource not found');
  }
  // The room must STILL be in simulated mode: a room that transitioned out of
  // `simulated` must never have its retired simulated treasury debited or an
  // `execution_simulated` audit row appended — enforced HERE so BOTH the manual
  // route and the background sweep are covered; fail-closed on an unknown mode
  // (WS-L.4.1d).
  const mode = await deps.roomMode(args.roomId);
  if (mode !== 'simulated') {
    return err(
      409,
      'mode_invalid',
      'This room has left simulated mode; simulated execution is disabled.',
    );
  }
  if (proposal.executionState !== 'timelocked' || proposal.votingState !== 'passed') {
    return err(409, 'not_executable', 'This proposal is not ready to execute.');
  }
  const nowMs = deps.now();
  if (proposal.executableAfter === null || Date.parse(proposal.executableAfter) > nowMs) {
    return err(409, 'timelocked', 'The simulated timelock has not elapsed yet.');
  }

  // ATOMICALLY CLAIM the proposal (CAS timelocked→executed) BEFORE any debit:
  // two concurrent executes (a double-click racing the scheduler, or two
  // scheduler processes) can both pass the stale `timelocked` check above, so the
  // claim is the single-execution gate that prevents a double debit (WS-L.4.1c).
  const claimed = await deps.proposals.claimForExecution(args.proposalId);
  if (claimed === null) {
    return err(409, 'not_executable', 'This proposal is already being executed.');
  }

  const nowIso = new Date(nowMs).toISOString();
  if (claimed.requestedAmount !== null && claimed.asset !== null) {
    const asset = claimed.asset;
    const amount = claimed.requestedAmount;
    // Atomic sufficiency-check + debit: a lost-update race can never drive the
    // balance negative or double-spend the same grant (WS-L.4.1c).
    const applied = await mutateSimTreasury(deps, args.roomId, (balances) => {
      const available = balances[asset] ?? '0';
      if (decCompare(amount, available) > 0) {
        return {
          error: err(409, 'insufficient_sim_funds', 'The simulated treasury cannot cover this.'),
        };
      }
      return { balances: { ...balances, [asset]: subtractMinor(available, amount) }, result: null };
    });
    if (!applied.ok) {
      // Insufficient funds BLOCKS the (already-claimed) proposal; a transient
      // treasury contention RELEASES the claim back to `timelocked` so a retry
      // can execute — never leaving it stranded as `executed` without a debit.
      await deps.proposals.update({
        ...claimed,
        executionState: applied.code === 'insufficient_sim_funds' ? 'blocked' : 'timelocked',
        executedAt: null,
      });
      return applied;
    }
    await deps.simTreasury.appendEntry({
      entryId: deps.uuid(),
      roomId: args.roomId,
      kind: 'grant_execution',
      asset,
      amount,
      actorUserId: args.actorUserId,
      proposalId: claimed.proposalId,
      createdAt: nowIso,
    });
  }

  const executed: GovernanceProposalRecord = {
    ...claimed,
    executionState: 'executed',
    executedAt: nowIso,
  };
  await deps.proposals.update(executed);
  await deps.governanceAudit.append({
    entryId: deps.uuid(),
    roomId: args.roomId,
    actionType: 'execution_simulated',
    actorUserId: args.actorUserId,
    actionDetails: { proposal_id: proposal.proposalId, proposal_type: proposal.proposalType },
    simulationMode: true,
    createdAt: nowIso,
  });
  return { ok: true, proposal: executed };
}

/** Scheduler sweep: execute every timelock-elapsed simulated proposal. */
export async function executeElapsedSimProposals(deps: SimulationDeps): Promise<number> {
  const elapsed = await deps.proposals.listExecutable(new Date(deps.now()).toISOString());
  let executed = 0;
  for (const proposal of elapsed) {
    const result = await executeSimProposal(deps, {
      roomId: proposal.roomId,
      proposalId: proposal.proposalId,
      actorUserId: null,
    });
    if (result.ok) executed += 1;
  }
  return executed;
}

/** Exact minor-unit subtraction (guarded non-negative by the caller). */
function subtractMinor(a: string, b: string): string {
  return decSum([a, `-${b}`]);
}
