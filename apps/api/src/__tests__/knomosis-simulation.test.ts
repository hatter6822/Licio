// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.4 governance simulation: comprehension gate, SIM-asset treasury,
// proposal templates (completeness + budget), one-account-one-vote voting +
// quorum/threshold + simulated timelock execution, the append-only audit log,
// the readiness gate, and — structurally — that NO simulated action produces a
// KnomosisActionRecord or OnChainEvent and the sim path imports no real
// execution module.

import { readFileSync } from 'node:fs';
import type { GovernanceProposalCreate } from '@licio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateReadiness, requestModeTransition } from '../knomosis/readiness.js';
import { simulationDeps } from '../knomosis/services.js';
import {
  COMPREHENSION_QUIZ,
  COMPREHENSION_QUIZ_VERSION,
  castSimVote,
  createSimProposal,
  ensureSimTreasury,
  executeSimProposal,
  simDeposit,
  submitComprehension,
} from '../knomosis/simulation.js';
import { seedUserWithSession } from './event-test-helpers.js';
import {
  freshKnomosisServices,
  type KnomosisFixture,
  resetKnomosisFixture,
} from './knomosis-test-helpers.js';

const ROOM = '66666666-6666-4666-8666-666666666666';

afterEach(() => resetKnomosisFixture());

async function passComprehension(fixture: KnomosisFixture, userId: string): Promise<void> {
  const answers: Record<string, number> = {};
  for (const q of COMPREHENSION_QUIZ) answers[q.question_id] = q.correctChoice;
  const result = await submitComprehension(simulationDeps(fixture.knomosis), {
    userId,
    quizVersion: COMPREHENSION_QUIZ_VERSION,
    answers,
  });
  if (!result.ok || !result.passed) throw new Error('comprehension setup failed');
}

const bountyTemplate = (
  over: Partial<GovernanceProposalCreate> = {},
): GovernanceProposalCreate => ({
  proposal_type: 'bounty',
  title: 'Fund evidence for the water-quality story',
  plain_language_summary: 'A bounty to acquire primary-source lab results.',
  requested_amount: '5000000',
  asset: 'SIM-USDC',
  recipient_ref: 'user-abc',
  conflict_disclosures: 'No conflicts of interest.',
  risk_assessment: 'Low risk; standard evidence acquisition.',
  requested_action: { kind: 'bounty' },
  expected_deliverable: 'Cited lab results attached to the thread.',
  ...over,
});

describe('WS-L.4.1e comprehension gate', () => {
  it('requires all questions correct to pass; wrong answers return corrections', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    const deps = simulationDeps(fixture.knomosis);
    const wrong = await submitComprehension(deps, {
      userId,
      quizVersion: COMPREHENSION_QUIZ_VERSION,
      answers: { 'fake-assets': 1 },
    });
    expect(wrong.ok && wrong.passed).toBe(false);
    if (wrong.ok) expect(wrong.corrections.length).toBeGreaterThan(0);

    await passComprehension(fixture, userId);
  });

  it('blocks the first simulated action until comprehension passes', async () => {
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' } });
    const { userId } = await seedUserWithSession(fixture.identity);
    const before = await createSimProposal(simulationDeps(fixture.knomosis), {
      roomId: ROOM,
      userId,
      create: bountyTemplate(),
    });
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.code).toBe('comprehension_required');
    await passComprehension(fixture, userId);
    const after = await createSimProposal(simulationDeps(fixture.knomosis), {
      roomId: ROOM,
      userId,
      create: bountyTemplate(),
    });
    expect(after.ok).toBe(true);
  });
});

describe('WS-L.4.1b/c proposal templates + simulated treasury', () => {
  it('bootstraps the SIM-asset treasury with the configured balance', async () => {
    const fixture = await freshKnomosisServices();
    const treasury = await ensureSimTreasury(simulationDeps(fixture.knomosis), ROOM);
    expect(treasury.balances['SIM-USDC']).toBe(
      fixture.knomosis.config().simStartingBalanceMinorUnits,
    );
  });

  it('a deposit increases the simulated balance and logs a sim audit entry', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    await passComprehension(fixture, userId);
    const deps = simulationDeps(fixture.knomosis);
    const result = await simDeposit(deps, {
      roomId: ROOM,
      userId,
      asset: 'SIM-USDC',
      amount: '1000000',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const balance = result.treasury.balances.find((b) => b.asset === 'SIM-USDC');
      expect(balance?.amount).toBe('10001000000'); // 10,000.000000 + 1
      expect(result.treasury.simulation_label).toBe('SIMULATED — NO REAL VALUE');
    }
  });

  it('rejects a bounty missing the conflict disclosure (template completeness)', async () => {
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' } });
    const { userId } = await seedUserWithSession(fixture.identity);
    await passComprehension(fixture, userId);
    const result = await createSimProposal(simulationDeps(fixture.knomosis), {
      roomId: ROOM,
      userId,
      create: bountyTemplate({ conflict_disclosures: '' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('template_incomplete');
  });

  it('rejects a budget exceeding the simulated treasury', async () => {
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' } });
    const { userId } = await seedUserWithSession(fixture.identity);
    await passComprehension(fixture, userId);
    const result = await createSimProposal(simulationDeps(fixture.knomosis), {
      roomId: ROOM,
      userId,
      create: bountyTemplate({ requested_amount: '999999999999999' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('budget_exceeded');
  });
});

describe('WS-L.4.1d simulated voting + execution', () => {
  it('passes on quorum + threshold, times-lock, executes, and never creates a real record', async () => {
    let clock = Date.now();
    const fixture = await freshKnomosisServices({
      rooms: { mode: 'simulated' },
      now: () => clock,
    });
    const proposer = await seedUserWithSession(fixture.identity, { handle: 'prop1' });
    const voters = await Promise.all(
      Array.from({ length: 3 }, (_v, i) =>
        seedUserWithSession(fixture.identity, { handle: `voter${i}` }),
      ),
    );
    for (const u of [proposer, ...voters]) await passComprehension(fixture, u.userId);
    const deps = simulationDeps(fixture.knomosis);

    const created = await createSimProposal(deps, {
      roomId: ROOM,
      userId: proposer.userId,
      create: bountyTemplate({ requested_amount: '1000000' }),
    });
    if (!created.ok) throw new Error('proposal failed');
    const proposalId = created.proposal.proposalId;

    // Quorum = 3 voters; approve majority.
    for (const voter of voters) {
      await castSimVote(deps, {
        roomId: ROOM,
        proposalId,
        userId: voter.userId,
        choice: 'approve',
      });
    }
    const afterVotes = await fixture.knomosis.proposals.getById(proposalId);
    expect(afterVotes?.votingState).toBe('passed');
    expect(afterVotes?.executionState).toBe('timelocked');

    // Timelock not elapsed yet.
    const early = await executeSimProposal(deps, { roomId: ROOM, proposalId, actorUserId: null });
    expect(early.ok).toBe(false);

    // Advance past the timelock and execute.
    clock += (fixture.knomosis.config().simTimelockSeconds + 1) * 1000;
    const executed = await executeSimProposal(deps, {
      roomId: ROOM,
      proposalId,
      actorUserId: null,
    });
    expect(executed.ok).toBe(true);
    if (executed.ok) expect(executed.proposal.executionState).toBe('executed');

    // The simulated treasury was deducted; balance never negative.
    const treasury = await ensureSimTreasury(deps, ROOM);
    expect(treasury.balances['SIM-USDC']).toBe('9999000000'); // 10,000 − 1

    // NO real record anywhere (structural guarantee).
    expect(await fixture.knomosis.actions.listByRoom(ROOM, 100)).toHaveLength(0);
    expect(await fixture.knomosis.events.listByDeployment('any', 100)).toHaveLength(0);
  });

  it('gates a MANUAL execution on the actor’s comprehension (never a first action)', async () => {
    let clock = Date.now();
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' }, now: () => clock });
    const proposer = await seedUserWithSession(fixture.identity, { handle: 'propX' });
    const voters = await Promise.all(
      Array.from({ length: 3 }, (_v, i) =>
        seedUserWithSession(fixture.identity, { handle: `xvoter${i}` }),
      ),
    );
    for (const u of [proposer, ...voters]) await passComprehension(fixture, u.userId);
    const deps = simulationDeps(fixture.knomosis);
    const created = await createSimProposal(deps, {
      roomId: ROOM,
      userId: proposer.userId,
      create: bountyTemplate({ requested_amount: '1000000' }),
    });
    if (!created.ok) throw new Error('proposal failed');
    const proposalId = created.proposal.proposalId;
    for (const voter of voters) {
      await castSimVote(deps, {
        roomId: ROOM,
        proposalId,
        userId: voter.userId,
        choice: 'approve',
      });
    }
    clock += (fixture.knomosis.config().simTimelockSeconds + 1) * 1000;

    // A newcomer who never passed the quiz cannot make execution their FIRST action.
    const newcomer = await seedUserWithSession(fixture.identity, { handle: 'newcomerX' });
    const blocked = await executeSimProposal(deps, {
      roomId: ROOM,
      proposalId,
      actorUserId: newcomer.userId,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('comprehension_required');

    // After passing comprehension the same member may execute.
    await passComprehension(fixture, newcomer.userId);
    const executed = await executeSimProposal(deps, {
      roomId: ROOM,
      proposalId,
      actorUserId: newcomer.userId,
    });
    expect(executed.ok).toBe(true);
  });

  it('does not pass below quorum', async () => {
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' } });
    const proposer = await seedUserWithSession(fixture.identity, { handle: 'prop2' });
    const voter = await seedUserWithSession(fixture.identity, { handle: 'v1' });
    await passComprehension(fixture, proposer.userId);
    await passComprehension(fixture, voter.userId);
    const deps = simulationDeps(fixture.knomosis);
    const created = await createSimProposal(deps, {
      roomId: ROOM,
      userId: proposer.userId,
      create: bountyTemplate({ requested_amount: '1000000' }),
    });
    if (!created.ok) throw new Error('proposal failed');
    await castSimVote(deps, {
      roomId: ROOM,
      proposalId: created.proposal.proposalId,
      userId: voter.userId,
      choice: 'approve',
    });
    const after = await fixture.knomosis.proposals.getById(created.proposal.proposalId);
    expect(after?.votingState).toBe('open'); // quorum (3) not met
  });

  it('rejects a double vote from the same account', async () => {
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' } });
    const proposer = await seedUserWithSession(fixture.identity, { handle: 'prop3' });
    await passComprehension(fixture, proposer.userId);
    const deps = simulationDeps(fixture.knomosis);
    const created = await createSimProposal(deps, {
      roomId: ROOM,
      userId: proposer.userId,
      create: bountyTemplate({ requested_amount: '1000000' }),
    });
    if (!created.ok) throw new Error('proposal failed');
    const first = await castSimVote(deps, {
      roomId: ROOM,
      proposalId: created.proposal.proposalId,
      userId: proposer.userId,
      choice: 'approve',
    });
    expect(first.ok).toBe(true);
    const second = await castSimVote(deps, {
      roomId: ROOM,
      proposalId: created.proposal.proposalId,
      userId: proposer.userId,
      choice: 'reject',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('already_voted');
  });
});

describe('WS-L.4.1g readiness gate + mode transitions', () => {
  it('blocks the transition out of simulation until every item is satisfied', async () => {
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' } });
    const { userId } = await seedUserWithSession(fixture.identity);
    // With the fail-closed checklist port and no track record, nothing is ready.
    fixture.knomosis.roomMode = {
      currentMode: async () => 'simulated',
      setMode: async () => true,
    };
    const readinessDeps = {
      checklist: fixture.knomosis.readinessChecklist,
      roomMode: fixture.knomosis.roomMode,
      governanceAudit: fixture.knomosis.governanceAudit,
      comprehension: fixture.knomosis.comprehension,
      audit: fixture.knomosis.audit,
      config: fixture.knomosis.config,
      now: fixture.knomosis.now,
      uuid: fixture.knomosis.uuid,
    };
    const readiness = await evaluateReadiness(readinessDeps, ROOM, userId);
    expect(readiness.ready).toBe(false);
    expect(readiness.unmet.length).toBeGreaterThan(0);
    const transition = await requestModeTransition(readinessDeps, {
      roomId: ROOM,
      targetMode: 'testnet',
      userId,
      reason: 'graduating',
    });
    expect(transition.ok).toBe(false);
    if (!transition.ok) expect(transition.code).toBe('readiness_unmet');
  });

  it('allows ordinary → simulated (the safe direction) with no readiness gate', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    let mode = 'ordinary';
    fixture.knomosis.roomMode = {
      currentMode: async () => mode as never,
      setMode: async (_r, m) => {
        mode = m;
        return true;
      },
    };
    const readinessDeps = {
      checklist: fixture.knomosis.readinessChecklist,
      roomMode: fixture.knomosis.roomMode,
      governanceAudit: fixture.knomosis.governanceAudit,
      comprehension: fixture.knomosis.comprehension,
      audit: fixture.knomosis.audit,
      config: fixture.knomosis.config,
      now: fixture.knomosis.now,
      uuid: fixture.knomosis.uuid,
    };
    const transition = await requestModeTransition(readinessDeps, {
      roomId: ROOM,
      targetMode: 'simulated',
      userId,
      reason: 'opting in',
    });
    expect(transition.ok).toBe(true);
    if (transition.ok) expect(transition.mode).toBe('simulated');
  });
});

describe('structural separation (WS-L.4.1d)', () => {
  it('simulation.ts imports NO real-execution module', () => {
    const source = readFileSync(new URL('../knomosis/simulation.ts', import.meta.url), 'utf8');
    for (const forbidden of ['./submission.js', './gateway.js', './ingest.js', './standing.js']) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
  });
});
