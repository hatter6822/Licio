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
  type GovernanceProposalCreate,
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
  return deps.simTreasury.put(record);
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

  const treasury = await ensureSimTreasury(deps, args.roomId);
  const nowIso = new Date(deps.now()).toISOString();
  const next = {
    ...treasury,
    balances: {
      ...treasury.balances,
      [args.asset]: decSum([treasury.balances[args.asset] ?? '0', args.amount]),
    },
    updatedAt: nowIso,
  };
  await deps.simTreasury.put(next);
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
  if ((tally.reject / decided) * 100 >= 100 - config.simApprovalThresholdPercent) {
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
  const proposal = await deps.proposals.getById(args.proposalId);
  if (proposal === null || proposal.roomId !== args.roomId) {
    return err(404, 'not_found', 'Resource not found');
  }
  if (proposal.executionState !== 'timelocked' || proposal.votingState !== 'passed') {
    return err(409, 'not_executable', 'This proposal is not ready to execute.');
  }
  const nowMs = deps.now();
  if (proposal.executableAfter === null || Date.parse(proposal.executableAfter) > nowMs) {
    return err(409, 'timelocked', 'The simulated timelock has not elapsed yet.');
  }

  const nowIso = new Date(nowMs).toISOString();
  if (proposal.requestedAmount !== null && proposal.asset !== null) {
    const treasury = await ensureSimTreasury(deps, args.roomId);
    const available = treasury.balances[proposal.asset] ?? '0';
    if (decCompare(proposal.requestedAmount, available) > 0) {
      // Balance can never go negative (WS-L.4.1c): execution blocks instead.
      const blocked: GovernanceProposalRecord = { ...proposal, executionState: 'blocked' };
      await deps.proposals.update(blocked);
      return err(409, 'insufficient_sim_funds', 'The simulated treasury cannot cover this.');
    }
    await deps.simTreasury.put({
      ...treasury,
      balances: {
        ...treasury.balances,
        [proposal.asset]: subtractMinor(available, proposal.requestedAmount),
      },
      updatedAt: nowIso,
    });
    await deps.simTreasury.appendEntry({
      entryId: deps.uuid(),
      roomId: args.roomId,
      kind: 'grant_execution',
      asset: proposal.asset,
      amount: proposal.requestedAmount,
      actorUserId: args.actorUserId,
      proposalId: proposal.proposalId,
      createdAt: nowIso,
    });
  }

  const executed: GovernanceProposalRecord = {
    ...proposal,
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
