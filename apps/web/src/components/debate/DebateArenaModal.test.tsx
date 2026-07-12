// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DebateArenaPublic, DebateContent } from '@licio/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postMutate = vi.fn();
const overrideMutate = vi.fn();
const withdrawMutate = vi.fn();
const concedeMutate = vi.fn();
let queryState: { data?: { debate: DebateArenaPublic }; isLoading?: boolean; isError?: boolean };

vi.mock('../../lib/debate-stream.js', () => ({ useDebateStream: () => {} }));
vi.mock('../../lib/queries.js', () => ({
  useDebateQuery: () => queryState,
  usePostDebatePositionMutation: () => ({ mutate: postMutate, isPending: false }),
  useOverrideDebateMutation: () => ({ mutate: overrideMutate, isPending: false }),
  useCloseDebateMutation: (_debateId: string, action: 'withdraw' | 'concede') => ({
    mutate: action === 'withdraw' ? withdrawMutate : concedeMutate,
    isPending: false,
    isError: false,
  }),
}));

import { DebateArenaContent, DebateArenaModal } from './DebateArenaModal.js';

const PAST = '2026-07-05T00:00:00.000Z';
/** 30 minutes ago — a "recent" last edit, so the expedited idle countdown is
 *  still running (idle deadline = last edit + 1h, before the edit deadline). */
const RECENT = new Date(Date.now() - 30 * 60 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
/** The scheduled AI-resolution instant (edit deadline + the 1h lock window). */
const LATER = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

function position(side: 'incumbent' | 'challenger', over: Record<string, unknown> = {}) {
  return {
    side,
    author_handle: side,
    author_display_name: side === 'incumbent' ? 'Ivy' : 'Cal',
    is_author: false,
    summary: '',
    citations: [],
    updated_at: null,
    submitted: false,
    ...over,
  };
}

function content(
  kind: 'story' | 'comment' | 'correction',
  over: Partial<DebateContent> = {},
): DebateContent {
  return {
    kind,
    title: null,
    body:
      kind === 'correction'
        ? 'The official minutes record a 6-3 vote.'
        : 'The vote passed 5-4 with two abstentions.',
    citations: [],
    updated_at: null,
    removed: false,
    locked: false,
    ...over,
  };
}

function arena(over: Partial<DebateArenaPublic> = {}): DebateArenaPublic {
  return {
    debate_id: '00000000-0000-4000-8000-0000000000d1',
    story_id: '00000000-0000-4000-8000-0000000000d2',
    thread_id: '00000000-0000-4000-8000-0000000000d3',
    room_id: null,
    target_type: 'comment',
    target_contribution_id: '00000000-0000-4000-8000-0000000000d4',
    challenger_contribution_id: '00000000-0000-4000-8000-0000000000d5',
    state: 'open',
    incumbent: position('incumbent') as DebateArenaPublic['incumbent'],
    challenger: position('challenger', {
      submitted: true,
      summary: 'The record disagrees.',
      citations: [{ url: 'https://example.org/record' }],
      updated_at: FUTURE,
    }) as DebateArenaPublic['challenger'],
    target_content: content('comment', { citations: [{ url: 'https://example.org/minutes' }] }),
    correction_content: content('correction', {
      citations: [{ url: 'https://example.org/tally' }],
    }),
    edit_deadline_at: FUTURE,
    resolve_due_at: LATER,
    locked_at: null,
    incumbent_last_active_at: RECENT,
    challenger_last_active_at: RECENT,
    verdict: null,
    winner: null,
    decided_by: null,
    rationale: null,
    confidence: null,
    ai_output_id: null,
    verdict_at: null,
    override_deadline_at: null,
    overridden_by_handle: null,
    override_reason: null,
    resolved_at: null,
    viewer_role: 'observer',
    created_at: PAST,
    updated_at: PAST,
    ...over,
  };
}

function renderArena() {
  return render(<DebateArenaContent debateId="00000000-0000-4000-8000-0000000000d1" />);
}

beforeEach(() => {
  postMutate.mockReset();
  overrideMutate.mockReset();
  withdrawMutate.mockReset();
  concedeMutate.mockReset();
  queryState = { data: { debate: arena() } };
});
afterEach(() => vi.clearAllMocks());

describe('DebateArenaModal', () => {
  it('opens as a modal sheet while a debate id is present and renders nothing without one', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <DebateArenaModal debateId="00000000-0000-4000-8000-0000000000d1" onClose={onClose} />,
    );
    // The Sheet carries the accessible dialog title; the arena body loads inside.
    expect(screen.getByRole('heading', { name: 'Debate arena' })).toBeInTheDocument();
    expect(screen.getByText(/this is not a vote/i)).toBeInTheDocument();
    rerender(<DebateArenaModal debateId={null} onClose={onClose} />);
    expect(screen.queryByRole('heading', { name: 'Debate arena' })).not.toBeInTheDocument();
  });
});

describe('DebateArenaContent', () => {
  it('renders loading and error states', () => {
    queryState = { isLoading: true };
    const { rerender } = renderArena();
    expect(screen.getByText('Loading the debate…')).toBeInTheDocument();
    queryState = { isError: true };
    rerender(<DebateArenaContent debateId="d1" />);
    expect(screen.getByRole('heading', { name: 'Debate unavailable' })).toBeInTheDocument();
  });

  it('shows the live state, the challenger draft, both countdowns, and no vote (observer view)', () => {
    renderArena();
    expect(screen.getByText(/this is not a vote/i)).toBeInTheDocument();
    expect(screen.getByText(/Live — both sides are making their case/)).toBeInTheDocument();
    expect(screen.getByText(/Editing window:/)).toBeInTheDocument();
    // Both sides last edited 30m ago, so the expedited idle path resolves
    // before the 23h schedule — the early-resolution line is shown.
    expect(
      screen.getByText(/Resolves early once both sides stay idle for an hour/),
    ).toBeInTheDocument();
    expect(screen.getByText('The record disagrees.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://example.org/record' })).toBeInTheDocument();
    // The incumbent has not posted a rebuttal statement yet.
    expect(screen.getByText('No statement posted yet.')).toBeInTheDocument();
    // Observer sees no edit affordance and neither party-exit affordance.
    expect(screen.queryByRole('button', { name: 'Post your case' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Withdraw the correction…' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Concede the challenge…' }),
    ).not.toBeInTheDocument();
  });

  it('renders the REAL challenged material and the correction side by side, live', () => {
    queryState = {
      data: {
        debate: arena({
          target_type: 'story',
          target_contribution_id: null,
          target_content: content('story', {
            title: 'Council passes the budget',
            citations: [{ url: 'https://example.org/minutes' }],
          }),
        }),
      },
    };
    renderArena();
    // The challenged story: title + body + its source, marked Live while open.
    expect(screen.getByRole('heading', { name: /The challenged story/ })).toBeInTheDocument();
    expect(screen.getByText('Council passes the budget')).toBeInTheDocument();
    expect(screen.getByText('The vote passed 5-4 with two abstentions.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://example.org/minutes' })).toBeInTheDocument();
    // The correction: body + its source.
    expect(screen.getByRole('heading', { name: /The correction/ })).toBeInTheDocument();
    expect(screen.getByText('The official minutes record a 6-3 vote.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://example.org/tally' })).toBeInTheDocument();
    // Both cards carry the Live badge (neither is a locked snapshot yet).
    expect(screen.getAllByText('Live')).toHaveLength(2);
    // The rebuttal cards are the argument layer over the real material.
    expect(screen.getByRole('heading', { name: /Incumbent rebuttal/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Challenger argument/ })).toBeInTheDocument();
  });

  it('a locked arena shows the Locked in snapshots and the AI-resolution countdown', () => {
    queryState = {
      data: {
        debate: arena({
          state: 'locked',
          edit_deadline_at: PAST,
          resolve_due_at: FUTURE,
          locked_at: PAST,
          target_content: content('comment', { locked: true }),
          correction_content: content('correction', { locked: true }),
        }),
      },
    };
    renderArena();
    expect(
      screen.getByText(/Locked in — the final countdown to AI resolution/),
    ).toBeInTheDocument();
    // Both content cards show the locked-snapshot badge, not Live.
    expect(screen.getAllByText('Locked in')).toHaveLength(2);
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
    // The editing countdown is gone; the AI-resolution countdown runs instead.
    expect(screen.queryByText(/Editing window:/)).not.toBeInTheDocument();
    expect(screen.getByText(/AI resolution: .*remaining/)).toBeInTheDocument();
  });

  it('a withdrawn arena shows the no-verdict state line and nothing live', () => {
    queryState = {
      data: {
        debate: arena({
          state: 'withdrawn',
          viewer_role: 'challenger',
          resolved_at: '2026-07-06T00:00:00.000Z',
        }),
      },
    };
    renderArena();
    expect(screen.getByText(/Withdrawn by the challenger — no verdict/)).toBeInTheDocument();
    expect(screen.queryByText(/Editing window:/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Withdraw the correction…' }),
    ).not.toBeInTheDocument();
  });

  it('the challenger can withdraw while open (two-step confirm) but not once locked', () => {
    queryState = { data: { debate: arena({ viewer_role: 'challenger' }) } };
    const { rerender } = renderArena();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw the correction…' }));
    // The first tap only opens the inline confirm — nothing is sent yet.
    expect(withdrawMutate).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Withdraw the correction\? The debate closes with no verdict\./),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(withdrawMutate).toHaveBeenCalledTimes(1);
    expect(concedeMutate).not.toHaveBeenCalled();

    // Once the material is locked in, the affordance is gone entirely.
    queryState = {
      data: {
        debate: arena({
          viewer_role: 'challenger',
          state: 'locked',
          edit_deadline_at: PAST,
          resolve_due_at: FUTURE,
          locked_at: PAST,
        }),
      },
    };
    rerender(<DebateArenaContent debateId="00000000-0000-4000-8000-0000000000d1" />);
    expect(
      screen.queryByRole('button', { name: 'Withdraw the correction…' }),
    ).not.toBeInTheDocument();
  });

  it('the incumbent can concede while open (two-step confirm)', () => {
    queryState = { data: { debate: arena({ viewer_role: 'incumbent' }) } };
    renderArena();
    fireEvent.click(screen.getByRole('button', { name: 'Concede the challenge…' }));
    expect(concedeMutate).not.toHaveBeenCalled();
    // The confirm can be backed out of.
    fireEvent.click(screen.getByRole('button', { name: 'Keep debating' }));
    expect(screen.getByRole('button', { name: 'Concede the challenge…' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Concede the challenge…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Concede' }));
    expect(concedeMutate).toHaveBeenCalledTimes(1);
    expect(withdrawMutate).not.toHaveBeenCalled();
  });

  it('lets the incumbent post a rebuttal (validating the source floor)', () => {
    queryState = { data: { debate: arena({ viewer_role: 'incumbent' }) } };
    renderArena();
    fireEvent.click(screen.getByRole('button', { name: 'Post your case' }));
    // Saving with no summary/source surfaces an error rather than submitting.
    fireEvent.click(screen.getByRole('button', { name: 'Save position' }));
    expect(screen.getByText('A position summary is required.')).toBeInTheDocument();
    expect(postMutate).not.toHaveBeenCalled();
    // A malformed source is rejected.
    const sourceInput = screen.getByLabelText('Add a source');
    fireEvent.change(sourceInput, { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Enter a valid http(s) or doi: link.')).toBeInTheDocument();
    // A valid summary + source submits.
    fireEvent.change(screen.getByLabelText('Your incumbent rebuttal case'), {
      target: { value: 'The official transcript confirms it.' },
    });
    fireEvent.change(sourceInput, { target: { value: 'https://court.gov/transcript' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save position' }));
    expect(postMutate).toHaveBeenCalledTimes(1);
  });

  it('shows a corrected verdict + the steward override control within the window', () => {
    queryState = {
      data: {
        debate: arena({
          state: 'judged',
          viewer_role: 'steward',
          verdict: 'corrected',
          winner: 'challenger',
          decided_by: 'ai',
          confidence: 0.91,
          rationale: 'The challenger cited more independent sources.',
          override_deadline_at: FUTURE,
          edit_deadline_at: PAST,
          resolve_due_at: PAST,
          locked_at: PAST,
        }),
      },
    };
    renderArena();
    expect(screen.getByText('Corrected — the challenger prevailed')).toBeInTheDocument();
    expect(screen.getByText(/91% confidence/)).toBeInTheDocument();
    expect(screen.getByText(/cited more independent sources/)).toBeInTheDocument();
    expect(screen.getByText(/Steward-override window:/)).toBeInTheDocument();
    // Overruling requires a reason.
    fireEvent.click(screen.getByRole('button', { name: 'Overrule verdict' }));
    expect(overrideMutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reason for overruling'), {
      target: { value: 'The challenger misread the record.' },
    });
    fireEvent.click(screen.getByLabelText('Uphold'));
    fireEvent.click(screen.getByRole('button', { name: 'Overrule verdict' }));
    expect(overrideMutate).toHaveBeenCalledWith({
      winner: 'incumbent',
      reason: 'The challenger misread the record.',
    });
  });

  it('renders an upheld + a resolved/overridden verdict without an override control', () => {
    queryState = {
      data: {
        debate: arena({
          state: 'resolved',
          viewer_role: 'observer',
          verdict: 'upheld',
          winner: 'incumbent',
          decided_by: 'steward',
          overridden_by_handle: 'stew',
          override_reason: 'sources hold',
          resolved_at: '2026-07-06T00:00:00.000Z',
          edit_deadline_at: PAST,
        }),
      },
    };
    renderArena();
    expect(screen.getByText('Upheld — the incumbent stands')).toBeInTheDocument();
    expect(screen.getByText(/Overruled by steward stew/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Overrule verdict' })).not.toBeInTheDocument();
  });

  it('clamps a long body to a preview and expands to the full content + all sources', () => {
    const longBody = `The council minutes are unambiguous on this point. ${'Detail sentence. '.repeat(40)}FULL-DEPTH-MARKER.`;
    queryState = {
      data: {
        debate: arena({
          target_content: content('comment', {
            body: longBody,
            citations: [
              { url: 'https://example.org/a' },
              { url: 'https://example.org/b' },
              { url: 'https://example.org/c' },
              { url: 'https://example.org/d' },
            ],
          }),
        }),
      },
    };
    renderArena();
    // Collapsed: the preview cuts before the end marker and hides the tail
    // sources behind a "+N more" note.
    expect(screen.queryByText(/FULL-DEPTH-MARKER/)).not.toBeInTheDocument();
    expect(screen.getByText('+2 more sources')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'https://example.org/d' })).not.toBeInTheDocument();
    // Expand: the full body and every source appear; the toggle flips.
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByText(/FULL-DEPTH-MARKER/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://example.org/d' })).toBeInTheDocument();
    expect(screen.queryByText('+2 more sources')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText(/FULL-DEPTH-MARKER/)).not.toBeInTheDocument();
  });

  it("labels a concession-decided resolution as the incumbent's concession", () => {
    queryState = {
      data: {
        debate: arena({
          state: 'resolved',
          verdict: 'corrected',
          winner: 'challenger',
          decided_by: 'concession',
          resolved_at: '2026-07-06T00:00:00.000Z',
          edit_deadline_at: PAST,
        }),
      },
    };
    renderArena();
    expect(screen.getByText('Corrected — the challenger prevailed')).toBeInTheDocument();
    expect(screen.getByText(/Decided by the incumbent's concession/)).toBeInTheDocument();
  });
});
