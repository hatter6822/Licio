// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { decMul } from '../decimal.js';
import { tallyProposalVotes } from '../proposal-tally.js';
import type { RecordedVote } from '../schemas/voting.js';

const rules = (minFraction: number, minAffirmativeFraction: number) => ({
  quorum: { basis: 'eligible_voters' as const, minFraction },
  threshold: { minAffirmativeFraction },
});

const vote = (
  voterUserId: string,
  choice: RecordedVote['choice'],
  weightSnapshot: RecordedVote['weightSnapshot'] = 1,
): RecordedVote => ({ voterUserId, choice, weightSnapshot });

describe('decMul (exact product)', () => {
  it('multiplies decimal fractions exactly', () => {
    expect(decMul(3, 0.667)).toBe('2.001');
    expect(decMul('0.1', '0.2')).toBe('0.02');
    expect(decMul(10, 0)).toBe('0');
    expect(decMul('-2', '0.5')).toBe('-1');
    expect(decMul('1e2', '0.25')).toBe('25');
  });
});

describe('tallyProposalVotes (WS-M.4.2d)', () => {
  it('stays open before the deadline even when the current fraction crosses the bar', () => {
    const result = tallyProposalVotes(
      [vote('a', 'approve'), vote('b', 'approve'), vote('c', 'approve')],
      rules(0.1, 0.5),
      { eligibleCount: 10, deadlinePassed: false },
    );
    expect(result.outcome).toBe('open');
    expect(result.quorumMet).toBe(true);
  });

  it('expires below quorum at the deadline', () => {
    const result = tallyProposalVotes([vote('a', 'approve')], rules(0.5, 0.5), {
      eligibleCount: 10,
      deadlinePassed: true,
    });
    expect(result.outcome).toBe('quorum_not_met');
    expect(result.quorumMet).toBe(false);
  });

  it('passes when the affirmative weight strictly exceeds the threshold bar', () => {
    const result = tallyProposalVotes(
      [vote('a', 'approve'), vote('b', 'approve'), vote('c', 'reject')],
      rules(0.2, 0.5),
      { eligibleCount: 10, deadlinePassed: true },
    );
    expect(result.outcome).toBe('passed');
    expect(result.approve).toBe('2');
    expect(result.reject).toBe('1');
  });

  it('rejects on an exact-boundary tally (strict > bar, mirroring WS-L.4.1d)', () => {
    // 1 approve vs 1 reject at a 0.5 bar: approve == decided × 0.5, NOT strictly greater.
    const result = tallyProposalVotes(
      [vote('a', 'approve'), vote('b', 'reject')],
      rules(0.1, 0.5),
      {
        eligibleCount: 4,
        deadlinePassed: true,
      },
    );
    expect(result.outcome).toBe('rejected');
  });

  it('enforces a supermajority threshold exactly (2/3 with a 0.667 bar)', () => {
    // 6 approve / 3 reject: 6 > 9 × 0.667 = 6.003 is FALSE ⇒ rejected.
    const under = tallyProposalVotes(
      [
        ...Array.from({ length: 6 }, (_, i) => vote(`a${i}`, 'approve')),
        ...Array.from({ length: 3 }, (_, i) => vote(`r${i}`, 'reject')),
      ],
      rules(0.1, 0.667),
      { eligibleCount: 20, deadlinePassed: true },
    );
    expect(under.outcome).toBe('rejected');
    // 7 approve / 3 reject: 7 > 10 × 0.667 = 6.67 ⇒ passed.
    const over = tallyProposalVotes(
      [
        ...Array.from({ length: 7 }, (_, i) => vote(`a${i}`, 'approve')),
        ...Array.from({ length: 3 }, (_, i) => vote(`r${i}`, 'reject')),
      ],
      rules(0.1, 0.667),
      { eligibleCount: 20, deadlinePassed: true },
    );
    expect(over.outcome).toBe('passed');
  });

  it('sums weight snapshots, never head counts', () => {
    const result = tallyProposalVotes(
      [vote('a', 'approve', '2.5'), vote('b', 'reject', 1), vote('c', 'reject', 1)],
      rules(0.1, 0.5),
      { eligibleCount: 10, deadlinePassed: true },
    );
    // 2.5 > 4.5 × 0.5 = 2.25 ⇒ passed despite being outnumbered 2:1 by voters.
    expect(result.outcome).toBe('passed');
    expect(result.approve).toBe('2.5');
  });

  it('sums fractional weights exactly (no float drift at the bar)', () => {
    // approve = 0.1 + 0.2 = exactly 0.3; decided = 0.6; bar = 0.6 × 0.5 = 0.3.
    // Float math would give approve = 0.30000000000000004 > 0.3 (a wrong PASS);
    // exact math keeps it a boundary tie ⇒ rejected.
    const result = tallyProposalVotes(
      [vote('a', 'approve', '0.1'), vote('b', 'approve', '0.2'), vote('c', 'reject', '0.3')],
      rules(0.1, 0.5),
      { eligibleCount: 10, deadlinePassed: true },
    );
    expect(result.outcome).toBe('rejected');
    expect(result.approve).toBe('0.3');
  });

  it('dedupes voters (first recorded vote wins)', () => {
    const result = tallyProposalVotes(
      [vote('a', 'approve'), vote('a', 'approve'), vote('b', 'reject')],
      rules(0.1, 0.5),
      { eligibleCount: 4, deadlinePassed: true },
    );
    expect(result.distinctVoters).toBe(2);
    expect(result.approve).toBe('1');
  });

  it('quorum counts distinct participants against basis × minFraction exactly', () => {
    // 3 of 10 at a 0.3 quorum: 3 ≥ 10 × 0.3 = 3 ⇒ met (inclusive bar).
    const met = tallyProposalVotes(
      [vote('a', 'abstain'), vote('b', 'abstain'), vote('c', 'approve')],
      rules(0.3, 0.5),
      { eligibleCount: 10, deadlinePassed: false },
    );
    expect(met.quorumMet).toBe(true);
    const unmet = tallyProposalVotes(
      [vote('a', 'abstain'), vote('b', 'approve')],
      rules(0.3, 0.5),
      {
        eligibleCount: 10,
        deadlinePassed: false,
      },
    );
    expect(unmet.quorumMet).toBe(false);
  });

  it('abstentions satisfy quorum but can never pass a proposal', () => {
    const result = tallyProposalVotes(
      [vote('a', 'abstain'), vote('b', 'abstain'), vote('c', 'abstain')],
      rules(0.2, 0.5),
      { eligibleCount: 10, deadlinePassed: true },
    );
    expect(result.quorumMet).toBe(true);
    expect(result.outcome).toBe('rejected');
    expect(result.abstain).toBe('3');
  });

  it('clamps turnout to [0,1] when membership shrinks after casting', () => {
    const result = tallyProposalVotes(
      [vote('a', 'approve'), vote('b', 'approve'), vote('c', 'approve')],
      rules(0.1, 0.5),
      { eligibleCount: 2, deadlinePassed: false },
    );
    expect(result.turnout).toBe(1);
  });

  it('a zero eligible-count basis can never meet quorum', () => {
    const result = tallyProposalVotes([vote('a', 'approve')], rules(0, 0.5), {
      eligibleCount: 0,
      deadlinePassed: true,
    });
    expect(result.outcome).toBe('quorum_not_met');
  });
});
