// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U lawmaking facilitation (SPEC §24.6 Stage 4; ADR-8): deterministic
// summary/schedule/attest. The agent facilitates but never computes an outcome —
// attestOutcome only restates a settled tally, and an unsettled tally is
// inconclusive (never silently rejected).
import { describe, expect, it } from 'vitest';
import { attestOutcome, scheduleProposalVote, summarizeProposal } from '../lawmaking.js';
import { proposalInputSchema } from '../schemas/lawmaking.js';

describe('summarizeProposal', () => {
  it('produces a neutral, deterministic summary with the option count', () => {
    const proposal = proposalInputSchema.parse({
      proposalId: 'p1',
      title: '  Adopt   a weekly   digest  ',
      body: 'We propose a weekly digest of the room.\nIt would be opt-in.',
      options: ['Yes', 'No'],
    });
    const a = summarizeProposal(proposal);
    const b = summarizeProposal(proposal);
    expect(a).toEqual(b); // deterministic
    expect(a.headline).toBe('Adopt a weekly digest'); // whitespace collapsed
    expect(a.optionCount).toBe(2);
    expect(a.summary).toContain('Proposal: Adopt a weekly digest.');
    expect(a.summary).toContain('Options (2): Yes; No.');
  });

  it('truncates an over-long title/body with an ellipsis and omits an empty option line', () => {
    const proposal = proposalInputSchema.parse({
      proposalId: 'p2',
      title: 'x'.repeat(200),
      body: '',
    });
    const summary = summarizeProposal(proposal);
    expect(summary.headline.endsWith('…')).toBe(true);
    expect(summary.headline.length).toBeLessThanOrEqual(120);
    expect(summary.optionCount).toBe(0);
    expect(summary.summary).not.toContain('Options');
  });
});

describe('scheduleProposalVote', () => {
  it('computes a deterministic open/close window', () => {
    const opensAtMs = Date.parse('2026-06-20T00:00:00.000Z');
    const schedule = scheduleProposalVote('p3', opensAtMs, 7 * 24 * 60 * 60);
    expect(schedule.opensAt).toBe('2026-06-20T00:00:00.000Z');
    expect(schedule.closesAt).toBe('2026-06-27T00:00:00.000Z');
  });
});

describe('attestOutcome', () => {
  it('restates a settled adoption', () => {
    const a = attestOutcome('p4', { settled: true, adopted: true, inFavor: 9, against: 2 });
    expect(a.outcome).toBe('adopted');
    expect(a.statement).toContain('adopted');
    expect(a.statement).toContain('in favour 9, against 2');
  });

  it('restates a settled rejection', () => {
    expect(
      attestOutcome('p5', { settled: true, adopted: false, inFavor: 1, against: 8 }).outcome,
    ).toBe('rejected');
  });

  it('is inconclusive when the tally never settled (quorum/turnout not met)', () => {
    expect(
      attestOutcome('p6', { settled: false, adopted: false, inFavor: 0, against: 0 }).outcome,
    ).toBe('inconclusive');
  });
});
