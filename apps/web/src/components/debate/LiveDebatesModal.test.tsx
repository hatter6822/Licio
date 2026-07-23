// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The live-debates modal: short summary rows that open the full arena, the
// story-challenge pin (which no sort or search may bury), search over what a
// row shows, and the four sort orders.
import type { DebateArenaSummary } from '@licio/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateMock = vi.fn();
const refetchMock = vi.fn();
let debatesState: {
  data?: { debates: DebateArenaSummary[] };
  isLoading?: boolean;
  isError?: boolean;
};

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }));
vi.mock('../../lib/queries.js', () => ({
  useStoryDebatesQuery: () => ({
    data: debatesState.data,
    isLoading: debatesState.isLoading ?? false,
    isError: debatesState.isError ?? false,
    refetch: refetchMock,
  }),
}));

import { LiveDebatesList, LiveDebatesModal } from './LiveDebatesModal.js';

const storyId = '11111111-1111-4111-8111-111111111111';
const inMinutes = (minutes: number): string =>
  new Date(Date.now() + minutes * 60_000).toISOString();

function summary(overrides: Partial<DebateArenaSummary> = {}): DebateArenaSummary {
  return {
    debate_id: '99999999-9999-4999-8999-999999999999',
    story_id: storyId,
    target_type: 'comment',
    target_contribution_id: '33333333-3333-4333-8333-333333333333',
    challenger_contribution_id: '44444444-4444-4444-8444-444444444444',
    state: 'open',
    edit_deadline_at: inMinutes(125.5),
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

/** The story-root challenge; deliberately the newest + latest-deadline row, so
 *  only the PIN can put it first. */
const storyChallenge = summary({
  debate_id: 'a1111111-1111-4111-8111-111111111111',
  target_type: 'story',
  target_contribution_id: null,
  target_excerpt: 'Council approves the harbour plan',
  incumbent_display_name: 'Dana',
  challenger_display_name: 'Eli',
  edit_deadline_at: inMinutes(900),
  created_at: '2026-07-21T12:00:00.000Z',
  updated_at: '2026-07-21T12:00:00.000Z',
});
const commentChallenge = summary({ debate_id: 'b2222222-2222-4222-8222-222222222222' });

/** The rendered rows, in DOM order, by their subject line. */
function rowSubjects(): string[] {
  return screen
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '')
    .map((text) => (text.includes('harbour') ? 'story' : text.includes('vote') ? 'comment' : text));
}

describe('LiveDebatesList', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    refetchMock.mockReset();
    debatesState = { data: { debates: [commentChallenge, storyChallenge] } };
  });

  it('renders one short summary per debate, and opens the ARENA for the one pressed', () => {
    render(<LiveDebatesList storyId={storyId} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // A summary — state, countdown, subject, both parties — not the arena.
    const comment = rows.find((row) => row.textContent?.includes('vote')) as HTMLElement;
    expect(comment).toHaveTextContent('Live');
    expect(comment).toHaveTextContent('Editing closes in 2h 5m');
    expect(comment).toHaveTextContent('Alice defends · Bob challenges');

    fireEvent.click(within(comment).getByRole('button'));
    const call = navigateMock.mock.calls.at(-1)?.[0] as {
      to: string;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.to).toBe('.');
    // The list param stays put, so closing the arena lands back in the list.
    expect(call.search({ debates: true })).toEqual({
      debates: true,
      debate: 'b2222222-2222-4222-8222-222222222222',
    });
  });

  it('pins challenges to the STORY above the comment challenges, in their own group', () => {
    render(<LiveDebatesList storyId={storyId} />);
    expect(rowSubjects()).toEqual(['story', 'comment']);
    expect(
      within(screen.getByRole('region', { name: 'Challenges to this story' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole('region', { name: 'Challenges to comments' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(1);
  });

  it('keeps the story challenge pinned under every sort order', async () => {
    const user = userEvent.setup();
    render(<LiveDebatesList storyId={storyId} />);
    for (const label of ['Recently active', 'Newest first', 'Oldest first']) {
      await user.click(screen.getByRole('combobox'));
      await user.click(screen.getByRole('option', { name: label }));
      expect(rowSubjects()).toEqual(['story', 'comment']);
    }
  });

  it('sorts the comment challenges by the chosen order', async () => {
    const user = userEvent.setup();
    debatesState = {
      data: {
        debates: [
          summary({
            debate_id: 'c3333333-3333-4333-8333-333333333333',
            target_excerpt: 'Older, further out',
            edit_deadline_at: inMinutes(600),
            created_at: '2026-07-18T00:00:00.000Z',
          }),
          summary({
            debate_id: 'd4444444-4444-4444-8444-444444444444',
            target_excerpt: 'Newer, ending soon',
            edit_deadline_at: inMinutes(30),
            created_at: '2026-07-21T00:00:00.000Z',
          }),
        ],
      },
    };
    render(<LiveDebatesList storyId={storyId} />);
    const subjects = (): string[] =>
      screen
        .getAllByRole('listitem')
        .map((item) => (item.textContent?.includes('Older') ? 'older' : 'newer'));
    // The default is "Ending soonest" — the debates a reader can still influence.
    expect(subjects()).toEqual(['newer', 'older']);
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Oldest first' }));
    expect(subjects()).toEqual(['older', 'newer']);
  });

  it('searches the subject, the parties, and the state — and reports the narrowing', async () => {
    const user = userEvent.setup();
    render(<LiveDebatesList storyId={storyId} />);
    const search = screen.getByRole('searchbox', { name: 'Search live debates' });

    await user.type(search, 'harbour');
    expect(rowSubjects()).toEqual(['story']);
    expect(screen.getByRole('status')).toHaveTextContent('Showing 1 of 2');

    await user.clear(search);
    await user.type(search, 'Alice');
    expect(rowSubjects()).toEqual(['comment']);
  });

  it('offers a way back when a search matches nothing', async () => {
    const user = userEvent.setup();
    render(<LiveDebatesList storyId={storyId} />);
    await user.type(screen.getByRole('searchbox'), 'quorum');
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('Showing 0 of 2');

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('labels each lifecycle state and its countdown', () => {
    debatesState = {
      data: {
        debates: [
          summary({ debate_id: 'e1', state: 'locked', resolve_due_at: inMinutes(45.5) }),
          summary({ debate_id: 'e2', state: 'awaiting_verdict' }),
          summary({
            debate_id: 'e3',
            state: 'judged',
            verdict: 'corrected',
            winner: 'challenger',
            override_deadline_at: inMinutes(20.5),
          }),
        ],
      },
    };
    render(<LiveDebatesList storyId={storyId} />);
    expect(screen.getByText('AI resolution in 45m')).toBeInTheDocument();
    expect(screen.getByText('In the AI queue')).toBeInTheDocument();
    expect(screen.getByText('Judged')).toBeInTheDocument();
    expect(screen.getByText('Corrected')).toBeInTheDocument();
    expect(screen.getByText('Override window: 20m')).toBeInTheDocument();
  });

  it('says so — rather than showing a blank row — when the target is withheld', () => {
    debatesState = { data: { debates: [summary({ target_excerpt: null })] } };
    render(<LiveDebatesList storyId={storyId} />);
    expect(screen.getByText(/not currently shown/i)).toBeInTheDocument();
  });

  it('renders the loading, error (retryable) and empty states', async () => {
    const user = userEvent.setup();
    debatesState = { isLoading: true };
    const { rerender } = render(<LiveDebatesList storyId={storyId} />);
    expect(screen.getByText('Loading live debates…')).toBeInTheDocument();

    debatesState = { isError: true };
    rerender(<LiveDebatesList storyId={`${storyId}x`} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded/i);
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetchMock).toHaveBeenCalled();

    debatesState = { data: { debates: [] } };
    rerender(<LiveDebatesList storyId={storyId} />);
    expect(screen.getByRole('heading', { name: 'No live debates' })).toBeInTheDocument();
  });
});

describe('LiveDebatesModal', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    debatesState = { data: { debates: [commentChallenge] } };
  });

  it('renders nothing while closed — no dialog, and no list under an open arena', () => {
    const { container } = render(
      <LiveDebatesModal storyId={storyId} open={false} onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('hosts the list in a titled modal dialog that closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<LiveDebatesModal storyId={storyId} open onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Live debates' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
