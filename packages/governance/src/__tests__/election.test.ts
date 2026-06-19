// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { tallyElection } from '../election.js';
import type { Ballot } from '../schemas/election.js';
import type { ElectionRules } from '../schemas/law-pack.js';

function rules(over: Partial<ElectionRules> = {}): ElectionRules {
  return {
    weightModel: 'one_civic_account_one_vote',
    perAccountCap: 1,
    minQuorum: 2,
    minTurnout: 0.5,
    termSeconds: 31_536_000,
    ...over,
  };
}

const ballots = (pairs: [string, string][]): Ballot[] =>
  pairs.map(([voterUserId, candidateUserId]) => ({ voterUserId, candidateUserId }));

describe('tallyElection', () => {
  it('settles a clear winner above quorum and turnout', () => {
    const r = tallyElection(
      ballots([
        ['v1', 'cA'],
        ['v2', 'cA'],
        ['v3', 'cB'],
      ]),
      rules(),
      { eligibleCount: 4, incumbentUserId: 'cB' },
    );
    expect(r.settled).toBe(true);
    expect(r.winnerUserId).toBe('cA');
    expect(r.distinctVoters).toBe(3);
    expect(r.turnout).toBeCloseTo(0.75);
  });

  it('keeps the incumbent below quorum (fail-safe)', () => {
    const r = tallyElection(ballots([['v1', 'cA']]), rules(), {
      eligibleCount: 4,
      incumbentUserId: 'inc',
    });
    expect(r.settled).toBe(false);
    expect(r.winnerUserId).toBe('inc');
  });

  it('keeps the incumbent below turnout even when quorum is met', () => {
    const r = tallyElection(
      ballots([
        ['v1', 'cA'],
        ['v2', 'cB'],
      ]),
      rules(),
      {
        eligibleCount: 10,
        incumbentUserId: 'inc',
      },
    );
    expect(r.settled).toBe(false);
    expect(r.winnerUserId).toBe('inc');
  });

  it('breaks ties toward the incumbent when present in the top tier', () => {
    const r = tallyElection(
      ballots([
        ['v1', 'cA'],
        ['v2', 'cB'],
      ]),
      rules(),
      {
        eligibleCount: 2,
        incumbentUserId: 'cB',
      },
    );
    expect(r.settled).toBe(true);
    expect(r.winnerUserId).toBe('cB');
  });

  it('breaks ties by earliest id when no incumbent is in the top tier', () => {
    const r = tallyElection(
      ballots([
        ['v1', 'cB'],
        ['v2', 'cC'],
      ]),
      rules(),
      {
        eligibleCount: 2,
        incumbentUserId: null,
      },
    );
    expect(r.winnerUserId).toBe('cB');
  });

  it('handles no ballots, dedupes a double-voter, and auto-confirms a sole member', () => {
    expect(tallyElection([], rules(), { eligibleCount: 0, incumbentUserId: 'inc' })).toMatchObject({
      settled: false,
      winnerUserId: 'inc',
      distinctVoters: 0,
    });

    const deduped = tallyElection(
      ballots([
        ['v1', 'cA'],
        ['v1', 'cB'],
      ]),
      rules({ minQuorum: 1 }),
      {
        eligibleCount: 1,
        incumbentUserId: null,
      },
    );
    expect(deduped.distinctVoters).toBe(1);
    expect(deduped.winnerUserId).toBe('cA'); // first ballot wins the dedupe

    const sole = tallyElection(ballots([['m1', 'm1']]), rules({ minQuorum: 1 }), {
      eligibleCount: 1,
      incumbentUserId: 'm1',
    });
    expect(sole).toMatchObject({ settled: true, winnerUserId: 'm1', turnout: 1 });
  });
});
