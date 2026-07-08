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
import { switchConfigKey } from '../knomosis/killswitch.js';
import { evaluateReadiness, requestModeTransition } from '../knomosis/readiness.js';
import { simulationDeps } from '../knomosis/services.js';
import {
  COMPREHENSION_QUIZ,
  COMPREHENSION_QUIZ_VERSION,
  castSimVote,
  createSimProposal,
  ensureSimTreasury,
  executeElapsedSimProposals,
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

  it('a deposit is atomic with its ledger entry (H8)', async () => {
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
    // The credit and its `deposit` ledger entry commit together — a read never sees
    // a changed balance with no entry to explain it.
    const entries = await fixture.knomosis.simTreasury.listEntries(ROOM, 10);
    const deposits = entries.filter((e) => e.kind === 'deposit');
    expect(deposits).toHaveLength(1);
    expect(deposits[0]?.amount).toBe('1000000');
  });

  it('an idempotency-keyed deposit credits AT MOST once on retry (H8)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    await passComprehension(fixture, userId);
    const deps = simulationDeps(fixture.knomosis);
    const key = crypto.randomUUID();
    const first = await simDeposit(deps, {
      roomId: ROOM,
      userId,
      asset: 'SIM-USDC',
      amount: '1000000',
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    // The SAME key (a double-tap / network retry) is a no-op — the balance is
    // unchanged and no second ledger entry is written.
    const retry = await simDeposit(deps, {
      roomId: ROOM,
      userId,
      asset: 'SIM-USDC',
      amount: '1000000',
      idempotencyKey: key,
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.treasury.balances.find((b) => b.asset === 'SIM-USDC')?.amount).toBe(
        '10001000000', // 10,000 + 1, NOT + 2
      );
    }
    const deposits = (await fixture.knomosis.simTreasury.listEntries(ROOM, 10)).filter(
      (e) => e.kind === 'deposit',
    );
    expect(deposits).toHaveLength(1);
    // A DIFFERENT key credits again (distinct client intent).
    const distinct = await simDeposit(deps, {
      roomId: ROOM,
      userId,
      asset: 'SIM-USDC',
      amount: '1000000',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(distinct.ok).toBe(true);
    if (distinct.ok) {
      expect(distinct.treasury.balances.find((b) => b.asset === 'SIM-USDC')?.amount).toBe(
        '10002000000',
      );
    }
  });

  it('rejects a deposit whose SUMMED balance would overflow 78 digits (R7-6)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId } = await seedUserWithSession(fixture.identity);
    await passComprehension(fixture, userId);
    const deps = simulationDeps(fixture.knomosis);
    const big = '9'.repeat(78); // the max single deposit (78 digits)
    const first = await simDeposit(deps, { roomId: ROOM, userId, asset: 'SIM-BIG', amount: big });
    expect(first.ok).toBe(true);
    // A second 78-digit deposit would push the balance to 79 digits — rejected
    // BEFORE persisting (else the row saves and every future read 500s).
    const second = await simDeposit(deps, { roomId: ROOM, userId, asset: 'SIM-BIG', amount: big });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('sim_balance_overflow');
    // The stored balance is still the (valid) first deposit — not corrupted.
    const treasury = await ensureSimTreasury(deps, ROOM);
    expect(treasury.balances['SIM-BIG']).toBe(big);
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

  it('the sweep + manual execute REFUSE a proposal whose room left simulated mode (R6-2)', async () => {
    const clock = Date.now();
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' }, now: () => clock });
    const deps = simulationDeps(fixture.knomosis);
    await ensureSimTreasury(deps, ROOM);
    // A passed, timelock-ELAPSED simulated proposal ready to execute.
    const proposalId = crypto.randomUUID();
    await fixture.knomosis.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: crypto.randomUUID(),
      proposalType: 'bounty',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: '1000000',
      asset: 'SIM-USDC',
      recipientRef: 'r',
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'passed',
      challengeState: 'none',
      executionState: 'timelocked',
      simulationMode: true,
      executableAfter: new Date(clock - 1000).toISOString(),
      createdAt: new Date(clock).toISOString(),
      executedAt: null,
    });
    // The room transitions OUT of `simulated` before the timelock sweep runs.
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    // Manual execute is refused…
    const manual = await executeSimProposal(deps, { roomId: ROOM, proposalId, actorUserId: null });
    expect(manual.ok).toBe(false);
    if (!manual.ok) expect(manual.code).toBe('mode_invalid');
    // …and the background sweep executes NONE and never debits the retired treasury.
    expect(await executeElapsedSimProposals(deps)).toBe(0);
    const treasury = await ensureSimTreasury(deps, ROOM);
    expect(treasury.balances['SIM-USDC']).toBe('10000000000'); // untouched
    // No `execution_simulated` audit row was appended for the retired room.
    const audit = await fixture.knomosis.governanceAudit.listByRoom(ROOM, 50);
    expect(audit.some((e) => e.actionType === 'execution_simulated')).toBe(false);
  });

  it('two concurrent executes debit the simulated treasury EXACTLY once (R8-4 claim gate)', async () => {
    const clock = Date.now();
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' }, now: () => clock });
    const deps = simulationDeps(fixture.knomosis);
    await ensureSimTreasury(deps, ROOM); // 10,000.000000 SIM-USDC
    const proposalId = crypto.randomUUID();
    await fixture.knomosis.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: crypto.randomUUID(),
      proposalType: 'capped_grant',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: '1000000',
      asset: 'SIM-USDC',
      recipientRef: 'r',
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'passed',
      challengeState: 'none',
      executionState: 'timelocked',
      simulationMode: true,
      executableAfter: new Date(clock - 1000).toISOString(),
      createdAt: new Date(clock).toISOString(),
      executedAt: null,
    });
    // Both pass the stale `timelocked` check; only the claim winner may debit.
    const [a, b] = await Promise.all([
      executeSimProposal(deps, { roomId: ROOM, proposalId, actorUserId: null }),
      executeSimProposal(deps, { roomId: ROOM, proposalId, actorUserId: null }),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1); // EXACTLY one succeeds
    // The treasury was debited once (10,000 − 1); NOT twice.
    const treasury = await ensureSimTreasury(deps, ROOM);
    expect(treasury.balances['SIM-USDC']).toBe('9999000000');
    const entries = await fixture.knomosis.simTreasury.listEntries(ROOM, 10);
    expect(entries.filter((e) => e.kind === 'grant_execution')).toHaveLength(1);
    // F10: the winner ended `executed` (finalized AFTER the debit), not `executing`.
    expect((await fixture.knomosis.proposals.getById(proposalId))?.executionState).toBe('executed');
  });

  it('concurrent recovery of an `executing` proposal appends ONE audit row (J3)', async () => {
    const clock = Date.now();
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' }, now: () => clock });
    const deps = simulationDeps(fixture.knomosis);
    await ensureSimTreasury(deps, ROOM);
    const proposalId = crypto.randomUUID();
    // Already claimed (executing) with NO ledger entry yet — a crash before finalize.
    await fixture.knomosis.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: crypto.randomUUID(),
      proposalType: 'capped_grant',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: '1000000',
      asset: 'SIM-USDC',
      recipientRef: 'r',
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'passed',
      executionState: 'executing',
      challengeState: 'none',
      simulationMode: true,
      executableAfter: new Date(clock - 1000).toISOString(),
      createdAt: new Date(clock).toISOString(),
      executedAt: null,
    });
    // Two sweep pods recover it at once: idempotent debit + single-owner finalize.
    const [a, b] = await Promise.all([
      executeSimProposal(deps, { roomId: ROOM, proposalId, actorUserId: null }),
      executeSimProposal(deps, { roomId: ROOM, proposalId, actorUserId: null }),
    ]);
    expect(a.ok && b.ok).toBe(true); // both report success (idempotent)
    // Debited once, and EXACTLY ONE execution_simulated audit row — a live execution
    // never looks like a duplicate.
    expect((await ensureSimTreasury(deps, ROOM)).balances['SIM-USDC']).toBe('9999000000');
    const entries = await fixture.knomosis.simTreasury.listEntries(ROOM, 10);
    expect(entries.filter((e) => e.kind === 'grant_execution')).toHaveLength(1);
    const audits = await fixture.knomosis.governanceAudit.listByRoom(ROOM, 100);
    expect(audits.filter((r) => r.actionType === 'execution_simulated')).toHaveLength(1);
  });

  it('a MANUAL actor may NOT re-enter an `executing` proposal (J3)', async () => {
    const clock = Date.now();
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' }, now: () => clock });
    const { userId } = await seedUserWithSession(fixture.identity);
    await passComprehension(fixture, userId);
    const deps = simulationDeps(fixture.knomosis);
    await ensureSimTreasury(deps, ROOM);
    const proposalId = crypto.randomUUID();
    await fixture.knomosis.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: crypto.randomUUID(),
      proposalType: 'capped_grant',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: '1000000',
      asset: 'SIM-USDC',
      recipientRef: 'r',
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'passed',
      executionState: 'executing',
      challengeState: 'none',
      simulationMode: true,
      executableAfter: new Date(clock - 1000).toISOString(),
      createdAt: new Date(clock).toISOString(),
      executedAt: null,
    });
    // A double-click / manual retry of an in-flight execution is refused — only the
    // scheduler sweep (a null actor) recovers `executing`.
    const manual = await executeSimProposal(deps, {
      roomId: ROOM,
      proposalId,
      actorUserId: userId,
    });
    expect(manual.ok).toBe(false);
    if (!manual.ok) expect(manual.code).toBe('not_executable');
  });

  it('recovers a crash-left `executing` proposal whose debit never committed (H2)', async () => {
    const clock = Date.now();
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' }, now: () => clock });
    const deps = simulationDeps(fixture.knomosis);
    await ensureSimTreasury(deps, ROOM);
    const proposalId = crypto.randomUUID();
    // A crash between claim and DEBIT left the proposal honestly `executing` with NO
    // ledger entry: the treasury was never touched, so recovery must debit exactly once.
    await fixture.knomosis.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: crypto.randomUUID(),
      proposalType: 'capped_grant',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: '1000000',
      asset: 'SIM-USDC',
      recipientRef: 'r',
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'passed',
      executionState: 'executing',
      challengeState: 'none',
      simulationMode: true,
      executableAfter: new Date(clock - 1000).toISOString(),
      createdAt: new Date(clock).toISOString(),
      executedAt: null,
    });
    // The sweep re-drives the stranded `executing` proposal to completion.
    expect(await executeElapsedSimProposals(deps)).toBe(1);
    expect((await fixture.knomosis.proposals.getById(proposalId))?.executionState).toBe('executed');
    // Debited EXACTLY once (10,000 − 1) with exactly one grant_execution entry.
    expect((await ensureSimTreasury(deps, ROOM)).balances['SIM-USDC']).toBe('9999000000');
    const entries = await fixture.knomosis.simTreasury.listEntries(ROOM, 10);
    expect(entries.filter((e) => e.kind === 'grant_execution')).toHaveLength(1);
    // A SECOND sweep is a no-op — the proposal is already `executed`, never re-debited.
    expect(await executeElapsedSimProposals(deps)).toBe(0);
    expect((await ensureSimTreasury(deps, ROOM)).balances['SIM-USDC']).toBe('9999000000');
  });

  it('recovers a crash-left `executing` proposal whose debit already committed — no double debit (H2)', async () => {
    const clock = Date.now();
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' }, now: () => clock });
    const deps = simulationDeps(fixture.knomosis);
    const current = await ensureSimTreasury(deps, ROOM);
    const proposalId = crypto.randomUUID();
    // A crash between the DEBIT and finalize: the ledger entry (keyed by proposalId)
    // AND the reduced balance are already durable; only the finalize is missing.
    await fixture.knomosis.simTreasury.put(
      {
        roomId: ROOM,
        balances: { 'SIM-USDC': '9999000000' },
        updatedAt: new Date(clock + 1).toISOString(),
      },
      current.updatedAt,
      {
        entryId: crypto.randomUUID(),
        roomId: ROOM,
        kind: 'grant_execution',
        asset: 'SIM-USDC',
        amount: '1000000',
        actorUserId: null,
        proposalId,
        idempotencyKey: proposalId,
        createdAt: new Date(clock).toISOString(),
      },
    );
    await fixture.knomosis.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: crypto.randomUUID(),
      proposalType: 'capped_grant',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: '1000000',
      asset: 'SIM-USDC',
      recipientRef: 'r',
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'passed',
      executionState: 'executing',
      challengeState: 'none',
      simulationMode: true,
      executableAfter: new Date(clock - 1000).toISOString(),
      createdAt: new Date(clock).toISOString(),
      executedAt: null,
    });
    // Recovery finalizes WITHOUT re-debiting: the balance stays at the post-debit
    // value and there is still exactly one grant_execution entry (idempotent by id).
    expect(await executeElapsedSimProposals(deps)).toBe(1);
    expect((await fixture.knomosis.proposals.getById(proposalId))?.executionState).toBe('executed');
    expect((await ensureSimTreasury(deps, ROOM)).balances['SIM-USDC']).toBe('9999000000');
    const entries = await fixture.knomosis.simTreasury.listEntries(ROOM, 10);
    expect(entries.filter((e) => e.kind === 'grant_execution')).toHaveLength(1);
  });

  it('an engaged treasury_execution kill switch pauses simulated execution (F7)', async () => {
    const clock = Date.now();
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' }, now: () => clock });
    const deps = simulationDeps(fixture.knomosis);
    await ensureSimTreasury(deps, ROOM);
    const proposalId = crypto.randomUUID();
    await fixture.knomosis.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: crypto.randomUUID(),
      proposalType: 'capped_grant',
      title: 't',
      plainLanguageSummary: 's',
      requestedAmount: '1000000',
      asset: 'SIM-USDC',
      recipientRef: 'r',
      conflictDisclosures: null,
      riskAssessment: 'r',
      requestedAction: {},
      expectedDeliverable: 'd',
      preflightState: 'passed',
      votingState: 'passed',
      executionState: 'timelocked',
      challengeState: 'none',
      simulationMode: true,
      executableAfter: new Date(clock - 1000).toISOString(),
      createdAt: new Date(clock).toISOString(),
      executedAt: null,
    });
    // Engage the treasury-execution switch GLOBALLY.
    await fixture.knomosis.configStore.set(switchConfigKey('treasury_execution'), {
      scopes: { global: true, regions: [], room_ids: [] },
      release_card: null,
      engaged_at: new Date(clock).toISOString(),
      deactivation_requested_by: null,
    });
    // The manual route (scheduler actor = null) is paused with a 503.
    const manual = await executeSimProposal(deps, { roomId: ROOM, proposalId, actorUserId: null });
    expect(manual.ok).toBe(false);
    if (!manual.ok) {
      expect(manual.status).toBe(503);
      expect(manual.code).toBe('kill_switch_active');
    }
    // The scheduler sweep executes NONE, the treasury is untouched, no audit row.
    expect(await executeElapsedSimProposals(deps)).toBe(0);
    expect((await ensureSimTreasury(deps, ROOM)).balances['SIM-USDC']).toBe('10000000000');
    const audit = await fixture.knomosis.governanceAudit.listByRoom(ROOM, 50);
    expect(audit.some((e) => e.actionType === 'execution_simulated')).toBe(false);
  });

  it('two concurrent quorum-reaching votes close the proposal EXACTLY once (F6)', async () => {
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' } });
    const proposer = await seedUserWithSession(fixture.identity, { handle: 'f6Prop' });
    const v0 = await seedUserWithSession(fixture.identity, { handle: 'f6v0' });
    const v1 = await seedUserWithSession(fixture.identity, { handle: 'f6v1' });
    const v2 = await seedUserWithSession(fixture.identity, { handle: 'f6v2' });
    const v3 = await seedUserWithSession(fixture.identity, { handle: 'f6v3' });
    for (const u of [proposer, v0, v1, v2, v3]) await passComprehension(fixture, u.userId);
    const deps = simulationDeps(fixture.knomosis);
    const created = await createSimProposal(deps, {
      roomId: ROOM,
      userId: proposer.userId,
      create: bountyTemplate({ requested_amount: '1000000' }),
    });
    if (!created.ok) throw new Error('proposal failed');
    const proposalId = created.proposal.proposalId;
    // Two approvals below quorum keep it open…
    await castSimVote(deps, {
      roomId: ROOM,
      proposalId,
      userId: v0.userId,
      choice: 'approve',
    });
    await castSimVote(deps, {
      roomId: ROOM,
      proposalId,
      userId: v1.userId,
      choice: 'approve',
    });
    expect((await fixture.knomosis.proposals.getById(proposalId))?.votingState).toBe('open');
    // …then two CONCURRENT approvals each reach quorum and try to close it.
    const results = await Promise.all([
      castSimVote(deps, { roomId: ROOM, proposalId, userId: v2.userId, choice: 'approve' }),
      castSimVote(deps, { roomId: ROOM, proposalId, userId: v3.userId, choice: 'approve' }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    // The proposal is closed EXACTLY once — a single `proposal_passed` audit row,
    // not a double-close / timelock reset (F6 CAS gate).
    const audit = await fixture.knomosis.governanceAudit.listByRoom(ROOM, 100);
    expect(audit.filter((e) => e.actionType === 'proposal_passed')).toHaveLength(1);
    const final = await fixture.knomosis.proposals.getById(proposalId);
    expect(final?.votingState).toBe('passed');
    expect(final?.executionState).toBe('timelocked');
  });

  it('leaves a quorum-reaching TIE open (crosses neither threshold, WS-L review fix)', async () => {
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' } });
    const proposer = await seedUserWithSession(fixture.identity, { handle: 'tieProp' });
    const approver = await seedUserWithSession(fixture.identity, { handle: 'tieApprove' });
    const rejecter = await seedUserWithSession(fixture.identity, { handle: 'tieReject' });
    const abstainer = await seedUserWithSession(fixture.identity, { handle: 'tieAbstain' });
    for (const u of [proposer, approver, rejecter, abstainer]) {
      await passComprehension(fixture, u.userId);
    }
    const deps = simulationDeps(fixture.knomosis);
    const created = await createSimProposal(deps, {
      roomId: ROOM,
      userId: proposer.userId,
      create: bountyTemplate({ requested_amount: '1000000' }),
    });
    if (!created.ok) throw new Error('proposal failed');
    const proposalId = created.proposal.proposalId;
    // 1 approve / 1 reject / 1 abstain: quorum (3) met but the decided vote is 50/50.
    await castSimVote(deps, {
      roomId: ROOM,
      proposalId,
      userId: approver.userId,
      choice: 'approve',
    });
    await castSimVote(deps, {
      roomId: ROOM,
      proposalId,
      userId: rejecter.userId,
      choice: 'reject',
    });
    await castSimVote(deps, {
      roomId: ROOM,
      proposalId,
      userId: abstainer.userId,
      choice: 'abstain',
    });
    const final = await fixture.knomosis.proposals.getById(proposalId);
    expect(final?.votingState).toBe('open'); // neither passed NOR prematurely rejected
  });

  it('rejects a deposit introducing a DISTINCT asset beyond the treasury cap', async () => {
    const fixture = await freshKnomosisServices({ rooms: { mode: 'simulated' } });
    const { userId } = await seedUserWithSession(fixture.identity, { handle: 'assetCap' });
    await passComprehension(fixture, userId);
    const deps = simulationDeps(fixture.knomosis);
    // Bootstrap holds 1 asset (SIM-USDC); add 15 more to reach the 16-asset cap.
    for (let i = 0; i < 15; i++) {
      const r = await simDeposit(deps, { roomId: ROOM, userId, asset: `SIM-A${i}`, amount: '1' });
      expect(r.ok).toBe(true);
    }
    // The 17th DISTINCT asset would violate simTreasuryResponseSchema → reject it.
    const overflow = await simDeposit(deps, {
      roomId: ROOM,
      userId,
      asset: 'SIM-OVER',
      amount: '1',
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.code).toBe('too_many_sim_assets');
    // A top-up into an EXISTING asset still succeeds (not a new distinct asset).
    const existing = await simDeposit(deps, {
      roomId: ROOM,
      userId,
      asset: 'SIM-USDC',
      amount: '1',
    });
    expect(existing.ok).toBe(true);
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
