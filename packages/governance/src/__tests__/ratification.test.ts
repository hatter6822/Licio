// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { tallyRatification } from '../ratification.js';
import type { RatificationBallot, RatificationRules } from '../schemas/ratification.js';

function rules(over: Partial<RatificationRules> = {}): RatificationRules {
  return { minQuorum: 2, minTurnout: 0.5, ...over };
}
const ballots = (pairs: [string, 'approve' | 'reject'][]): RatificationBallot[] =>
  pairs.map(([voterUserId, choice]) => ({ voterUserId, choice }));

describe('tallyRatification', () => {
  it('adopts on a quorum-meeting approving majority', () => {
    const r = tallyRatification(
      ballots([
        ['v1', 'approve'],
        ['v2', 'approve'],
        ['v3', 'reject'],
      ]),
      rules(),
      { eligibleCount: 4 },
    );
    expect(r.settled).toBe(true);
    expect(r.outcome).toBe('approved');
    expect(r.approve).toBe(2);
    expect(r.reject).toBe(1);
  });

  it('is FAIL-SAFE below quorum (not adopted)', () => {
    const r = tallyRatification(ballots([['v1', 'approve']]), rules({ minQuorum: 2 }), {
      eligibleCount: 4,
    });
    expect(r.settled).toBe(false);
    expect(r.outcome).toBe('rejected');
  });

  it('is FAIL-SAFE below turnout (not adopted)', () => {
    const r = tallyRatification(
      ballots([
        ['v1', 'approve'],
        ['v2', 'approve'],
      ]),
      rules({ minQuorum: 1, minTurnout: 0.9 }),
      { eligibleCount: 10 },
    );
    expect(r.settled).toBe(false);
    expect(r.outcome).toBe('rejected');
  });

  it('is FAIL-SAFE on a tie (no approving majority)', () => {
    const r = tallyRatification(
      ballots([
        ['v1', 'approve'],
        ['v2', 'reject'],
      ]),
      rules({ minQuorum: 2, minTurnout: 0 }),
      { eligibleCount: 2 },
    );
    expect(r.settled).toBe(true);
    expect(r.outcome).toBe('rejected');
  });

  it('rejects on an opposing majority', () => {
    const r = tallyRatification(
      ballots([
        ['v1', 'reject'],
        ['v2', 'reject'],
        ['v3', 'approve'],
      ]),
      rules({ minTurnout: 0 }),
      { eligibleCount: 3 },
    );
    expect(r.outcome).toBe('rejected');
    expect(r.settled).toBe(true);
  });

  it('dedupes repeat voters (first ballot wins)', () => {
    const r = tallyRatification(
      ballots([
        ['v1', 'approve'],
        ['v1', 'reject'],
        ['v2', 'approve'],
      ]),
      rules({ minQuorum: 2, minTurnout: 0 }),
      { eligibleCount: 2 },
    );
    expect(r.distinctVoters).toBe(2);
    expect(r.approve).toBe(2);
    expect(r.outcome).toBe('approved');
  });
});
