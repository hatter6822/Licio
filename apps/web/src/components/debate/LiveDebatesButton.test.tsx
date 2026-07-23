// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The compact discovery row: a COUNT (never a tile per debate), the nearest
// deadline, and one press into the `?debates` list modal.
import type { DebateArenaSummary } from '@licio/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveDebatesButton } from './LiveDebatesButton.js';

// The row OPENS the list modal by adding `?debates` to the current location
// (useOpenDebateList → useNavigate); capture the navigations.
const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

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
    // Half a minute of slack past 2h 5m, so the floor-rounded label cannot flip
    // to "2h 4m" on the milliseconds between this call and the render.
    edit_deadline_at: inMinutes(125.5),
    resolve_due_at: inMinutes(185),
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

describe('LiveDebatesButton', () => {
  beforeEach(() => navigateMock.mockReset());

  it('renders nothing when there are no active debates', () => {
    const { container } = render(<LiveDebatesButton debates={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the debates query is still loading (undefined)', () => {
    const { container } = render(<LiveDebatesButton debates={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an explicit notice when the debates query failed — live debates never silently vanish', () => {
    render(<LiveDebatesButton debates={undefined} error />);
    expect(screen.getByRole('status')).toHaveTextContent(/could not be loaded/i);
  });

  it('counts the live debates, counts down to the nearest deadline, and opens the list', () => {
    render(<LiveDebatesButton debates={[summary()]} />);
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveTextContent('1 live debate');
    expect(trigger).toHaveTextContent('2h 5m left');
    // The SUBJECT is not here: the summaries live in the modal, so the section
    // stays one row tall however many debates are open.
    expect(screen.queryByText(/The vote passed 5-4\./)).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const call = navigateMock.mock.calls[0]?.[0] as {
      to: string;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.to).toBe('.');
    expect(call.search({ root: 'r1' })).toEqual({ root: 'r1', debates: true });
  });

  it('says how many of the debates challenge the STORY itself', () => {
    render(
      <LiveDebatesButton
        debates={[
          summary({ debate_id: 'a1111111-1111-4111-8111-111111111111' }),
          summary({ debate_id: 'b2222222-2222-4222-8222-222222222222', target_type: 'story' }),
          summary({ debate_id: 'c3333333-3333-4333-8333-333333333333', target_type: 'story' }),
        ]}
      />,
    );
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveTextContent('3 live debates');
    expect(trigger).toHaveTextContent('2 on the story');
  });

  it('drops the countdown when nothing is counting down (all queued for the AI)', () => {
    render(
      <LiveDebatesButton
        debates={[summary({ state: 'awaiting_verdict', edit_deadline_at: inMinutes(-10) })]}
      />,
    );
    expect(screen.getByRole('button')).not.toHaveTextContent(/left/);
  });

  it('names the action for assistive tech — a bare count is not an affordance', () => {
    render(<LiveDebatesButton debates={[summary()]} />);
    expect(screen.getByRole('button', { name: /open the live debates/i })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
  });
});
