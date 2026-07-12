// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DebateArenaSummary } from '@licio/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DebatePanel } from './DebatePanel.js';

// Each row OPENS the arena modal by adding `?debate=<id>` to the current
// location (useOpenDebate → useNavigate); capture the navigations.
const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

const storyId = '11111111-1111-4111-8111-111111111111';

function summary(overrides: Partial<DebateArenaSummary> = {}): DebateArenaSummary {
  return {
    debate_id: '99999999-9999-4999-8999-999999999999',
    story_id: storyId,
    target_type: 'comment',
    target_contribution_id: '33333333-3333-4333-8333-333333333333',
    challenger_contribution_id: '44444444-4444-4444-8444-444444444444',
    state: 'open',
    edit_deadline_at: '2999-01-01T00:00:00.000Z',
    resolve_due_at: '2999-01-01T01:00:00.000Z',
    override_deadline_at: null,
    verdict: null,
    winner: null,
    incumbent_display_name: 'Alice',
    challenger_display_name: 'Bob',
    target_excerpt: 'The vote passed 5-4.',
    created_at: '2026-06-18T00:00:00.000Z',
    updated_at: '2026-06-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('DebatePanel', () => {
  beforeEach(() => navigateMock.mockReset());

  it('renders nothing when there are no active debates', () => {
    const { container } = render(<DebatePanel debates={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists an open debate with its subject, a countdown, and opens the arena modal', () => {
    render(<DebatePanel debates={[summary()]} />);
    expect(screen.getByText('1 active debate')).toBeInTheDocument();
    expect(screen.getByText(/A comment is challenged/)).toBeInTheDocument();
    expect(screen.getByText(/The vote passed 5-4\./)).toBeInTheDocument();
    // An open arena shows a countdown to the editing deadline.
    expect(screen.getByText(/left$/)).toBeInTheDocument();
    // The row opens the arena MODAL via the `?debate=` param on the current
    // route (deep-linkable; the back button closes it).
    fireEvent.click(screen.getByRole('button', { name: /View debate/ }));
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const call = navigateMock.mock.calls[0]?.[0] as {
      to: string;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.to).toBe('.');
    expect(call.search({ root: 'r1' })).toEqual({
      root: 'r1',
      debate: '99999999-9999-4999-8999-999999999999',
    });
  });

  it('a locked debate shows the AI-resolution queue countdown', () => {
    render(
      <DebatePanel
        debates={[
          summary({
            state: 'locked',
            edit_deadline_at: '2000-01-01T00:00:00.000Z',
            resolve_due_at: '2999-01-01T00:00:00.000Z',
          }),
        ]}
      />,
    );
    expect(
      screen.getByText(/Locked in — the final countdown to AI resolution/),
    ).toBeInTheDocument();
    // The countdown now runs to the queue instant, not the (past) edit deadline.
    expect(screen.getByText(/left$/)).toBeInTheDocument();
  });

  it('counts multiple debates and drops the countdown once adjudication is queued', () => {
    render(
      <DebatePanel
        debates={[
          summary({ debate_id: 'a1111111-1111-4111-8111-111111111111' }),
          summary({
            debate_id: 'b2222222-2222-4222-8222-222222222222',
            state: 'awaiting_verdict',
            target_type: 'story',
            edit_deadline_at: '2000-01-01T00:00:00.000Z',
            resolve_due_at: '2000-01-01T01:00:00.000Z',
            target_excerpt: null,
          }),
        ]}
      />,
    );
    expect(screen.getByText('2 active debates')).toBeInTheDocument();
    expect(screen.getByText(/The story is challenged/)).toBeInTheDocument();
    expect(screen.getByText(/In the room's AI resolution queue/)).toBeInTheDocument();
    // Only the still-open first row carries a countdown.
    expect(screen.getAllByText(/left$/)).toHaveLength(1);
  });
});
