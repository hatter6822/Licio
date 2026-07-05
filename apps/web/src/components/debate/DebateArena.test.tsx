// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DebateArenaPublic } from '@licio/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postMutate = vi.fn();
const overrideMutate = vi.fn();
let queryState: { data?: { debate: DebateArenaPublic }; isLoading?: boolean; isError?: boolean };

vi.mock('../../lib/debate-stream.js', () => ({ useDebateStream: () => {} }));
vi.mock('../../lib/queries.js', () => ({
  useDebateQuery: () => queryState,
  usePostDebatePositionMutation: () => ({ mutate: postMutate, isPending: false }),
  useOverrideDebateMutation: () => ({ mutate: overrideMutate, isPending: false }),
}));

import { DebateArena } from './DebateArena.js';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

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
    edit_deadline_at: FUTURE,
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
    created_at: '2026-07-05T00:00:00.000Z',
    updated_at: '2026-07-05T00:00:00.000Z',
    ...over,
  };
}

function renderArena() {
  return render(<DebateArena debateId="00000000-0000-4000-8000-0000000000d1" storyId="s1" />);
}

beforeEach(() => {
  postMutate.mockReset();
  overrideMutate.mockReset();
  queryState = { data: { debate: arena() } };
});
afterEach(() => vi.clearAllMocks());

describe('DebateArena', () => {
  it('renders loading and error states', () => {
    queryState = { isLoading: true };
    const { rerender } = renderArena();
    expect(screen.getByText('Loading the debate…')).toBeInTheDocument();
    queryState = { isError: true };
    rerender(<DebateArena debateId="d1" storyId="s1" />);
    expect(screen.getByRole('heading', { name: 'Debate unavailable' })).toBeInTheDocument();
  });

  it('shows the challenger draft, the countdown, and no vote (observer view)', () => {
    renderArena();
    expect(screen.getByRole('heading', { name: 'Debate arena' })).toBeInTheDocument();
    expect(screen.getByText(/this is not a vote/i)).toBeInTheDocument();
    expect(screen.getByText(/Editing window:/)).toBeInTheDocument();
    expect(screen.getByText('The record disagrees.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://example.org/record' })).toBeInTheDocument();
    // The incumbent has not posted yet.
    expect(screen.getByText('No position posted yet.')).toBeInTheDocument();
    // Observer sees no edit affordance.
    expect(screen.queryByRole('button', { name: 'Post your case' })).not.toBeInTheDocument();
  });

  it('lets the incumbent post a position (validating the source floor)', () => {
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
    fireEvent.change(screen.getByLabelText('Your incumbent case'), {
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
          edit_deadline_at: '2026-07-05T00:00:00.000Z',
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
        }),
      },
    };
    renderArena();
    expect(screen.getByText('Upheld — the incumbent stands')).toBeInTheDocument();
    expect(screen.getByText(/Overruled by steward stew/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Overrule verdict' })).not.toBeInTheDocument();
  });
});
