// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The pure list model behind the live-debates surfaces: which deadline each
// state counts down to, the duration format, the orderings (with the
// story-challenge pin that no sort may outrank), and the search predicate.
import type { DebateArenaSummary } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  DEBATE_SORT_MODES,
  debateDeadline,
  debateMatchesTokens,
  debateSearchText,
  remainingLabel,
  soonestDeadline,
  sortDebates,
  storyChallengeCount,
} from './debate-summary.js';

const NOW = Date.parse('2026-07-22T12:00:00.000Z');
const inMinutes = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

function summary(overrides: Partial<DebateArenaSummary> = {}): DebateArenaSummary {
  return {
    debate_id: '99999999-9999-4999-8999-999999999999',
    story_id: '11111111-1111-4111-8111-111111111111',
    target_type: 'comment',
    target_contribution_id: '33333333-3333-4333-8333-333333333333',
    challenger_contribution_id: '44444444-4444-4444-8444-444444444444',
    state: 'open',
    edit_deadline_at: inMinutes(125),
    resolve_due_at: inMinutes(185),
    override_deadline_at: null,
    verdict: null,
    winner: null,
    incumbent_display_name: 'Alice',
    challenger_display_name: 'Bob',
    target_excerpt: 'The vote passed 5-4.',
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('debateDeadline', () => {
  it('counts an open debate down to its editing deadline', () => {
    expect(debateDeadline(summary())).toEqual({ kind: 'edit', at: inMinutes(125) });
  });

  it('counts a locked debate down to AI resolution', () => {
    expect(debateDeadline(summary({ state: 'locked' }))).toEqual({
      kind: 'resolve',
      at: inMinutes(185),
    });
  });

  it('counts a judged debate down to the steward-override deadline', () => {
    expect(
      debateDeadline(summary({ state: 'judged', override_deadline_at: inMinutes(30) })),
    ).toEqual({ kind: 'override', at: inMinutes(30) });
  });

  it('has no countdown while queued for the AI, or once the override window is gone', () => {
    expect(debateDeadline(summary({ state: 'awaiting_verdict' }))).toBeNull();
    expect(debateDeadline(summary({ state: 'judged', override_deadline_at: null }))).toBeNull();
    expect(debateDeadline(summary({ state: 'resolved' }))).toBeNull();
  });
});

describe('remainingLabel', () => {
  it('formats hours + minutes, sub-minute, and drops a passed deadline', () => {
    expect(remainingLabel(inMinutes(125), NOW)).toBe('2h 5m');
    expect(remainingLabel(inMinutes(9), NOW)).toBe('9m');
    expect(remainingLabel(new Date(NOW + 30_000).toISOString(), NOW)).toBe('<1m');
    expect(remainingLabel(inMinutes(-1), NOW)).toBeNull();
  });

  it('degrades to no countdown on an unparseable instant — never a "NaN" label', () => {
    expect(remainingLabel('not-a-date', NOW)).toBeNull();
  });
});

describe('soonestDeadline', () => {
  it('picks the nearest FUTURE deadline and skips past-due ones', () => {
    const debates = [
      // Past due (the lifecycle sweep has not caught up) — must not win.
      summary({ debate_id: 'a', edit_deadline_at: inMinutes(-5) }),
      summary({ debate_id: 'b', edit_deadline_at: inMinutes(90) }),
      summary({ debate_id: 'c', edit_deadline_at: inMinutes(20) }),
      // No countdown at all.
      summary({ debate_id: 'd', state: 'awaiting_verdict' }),
    ];
    expect(soonestDeadline(debates, NOW)).toBe(inMinutes(20));
  });

  it('is null when nothing is counting down', () => {
    expect(soonestDeadline([summary({ state: 'awaiting_verdict' })], NOW)).toBeNull();
    expect(soonestDeadline([], NOW)).toBeNull();
  });
});

describe('storyChallengeCount', () => {
  it('counts only the challenges aimed at the story itself', () => {
    expect(
      storyChallengeCount([
        summary({ debate_id: 'a', target_type: 'story' }),
        summary({ debate_id: 'b' }),
        summary({ debate_id: 'c', target_type: 'story' }),
      ]),
    ).toBe(2);
  });
});

describe('sortDebates', () => {
  const storyChallenge = summary({
    debate_id: 'a0000000-0000-4000-8000-000000000000',
    target_type: 'story',
    // Deliberately the LAST by every mode's own key: newest-created, latest
    // deadline, most stale update — the pin must still lift it to the top.
    edit_deadline_at: inMinutes(600),
    created_at: '2026-07-21T12:00:00.000Z',
    updated_at: '2026-07-19T00:00:00.000Z',
  });
  const urgent = summary({
    debate_id: 'b0000000-0000-4000-8000-000000000000',
    edit_deadline_at: inMinutes(10),
    created_at: '2026-07-19T00:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
  });
  const queued = summary({
    debate_id: 'c0000000-0000-4000-8000-000000000000',
    state: 'awaiting_verdict',
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: '2026-07-21T06:00:00.000Z',
  });
  const debates = [queued, urgent, storyChallenge];
  const ids = (list: readonly DebateArenaSummary[]): string[] =>
    list.map((debate) => debate.debate_id[0] as string);

  it.each(DEBATE_SORT_MODES)('pins story challenges first under the %s sort', (mode) => {
    expect(ids(sortDebates(debates, mode))[0]).toBe('a');
  });

  it('orders the comment challenges by soonest deadline, queued ones last', () => {
    expect(ids(sortDebates(debates, 'urgent'))).toEqual(['a', 'b', 'c']);
  });

  it('orders by last activity, newest, and oldest', () => {
    expect(ids(sortDebates(debates, 'recent'))).toEqual(['a', 'c', 'b']);
    expect(ids(sortDebates(debates, 'newest'))).toEqual(['a', 'c', 'b']);
    expect(ids(sortDebates(debates, 'oldest'))).toEqual(['a', 'b', 'c']);
  });

  it('is total and stable: ties break on the debate id, and the input is not mutated', () => {
    const tied = [
      summary({ debate_id: 'z0000000-0000-4000-8000-000000000000' }),
      summary({ debate_id: 'y0000000-0000-4000-8000-000000000000' }),
    ];
    expect(ids(sortDebates(tied, 'urgent'))).toEqual(['y', 'z']);
    expect(ids(tied)).toEqual(['z', 'y']);
  });
});

describe('debateSearchText / debateMatchesTokens', () => {
  const labels = { target: 'Challenges to comments', state: 'Live', verdict: undefined };

  it('matches the subject, either party, and the row labels', () => {
    const text = debateSearchText(summary(), labels);
    expect(debateMatchesTokens(text, ['vote'])).toBe(true);
    expect(debateMatchesTokens(text, ['alice'])).toBe(true);
    expect(debateMatchesTokens(text, ['bob'])).toBe(true);
    expect(debateMatchesTokens(text, ['live'])).toBe(true);
    expect(debateMatchesTokens(text, ['quorum'])).toBe(false);
  });

  it('requires EVERY token (typing more narrows) and matches everything when empty', () => {
    const text = debateSearchText(summary(), labels);
    expect(debateMatchesTokens(text, ['vote', 'alice'])).toBe(true);
    expect(debateMatchesTokens(text, ['vote', 'quorum'])).toBe(false);
    expect(debateMatchesTokens(text, [])).toBe(true);
  });

  it('survives a withheld excerpt and anonymous parties', () => {
    const text = debateSearchText(
      summary({ target_excerpt: null, incumbent_display_name: null }),
      labels,
    );
    expect(debateMatchesTokens(text, ['bob'])).toBe(true);
    expect(debateMatchesTokens(text, ['vote'])).toBe(false);
  });
});
