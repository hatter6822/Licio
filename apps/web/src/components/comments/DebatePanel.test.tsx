// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DebateArenaSummary } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DebatePanel } from './DebatePanel.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children?: ReactNode;
    to?: string;
    params?: Record<string, string>;
    className?: string;
  }) => {
    let href = to ?? '#';
    for (const [key, value] of Object.entries(params ?? {})) href = href.replace(`$${key}`, value);
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  },
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
  it('renders nothing when there are no active debates', () => {
    const { container } = render(<DebatePanel storyId={storyId} debates={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists an open debate with its subject, a countdown, and a link to the arena', () => {
    render(<DebatePanel storyId={storyId} debates={[summary()]} />);
    expect(screen.getByText('1 active debate')).toBeInTheDocument();
    expect(screen.getByText(/A comment is challenged/)).toBeInTheDocument();
    expect(screen.getByText(/The vote passed 5-4\./)).toBeInTheDocument();
    // An open arena shows a countdown to the editing deadline.
    expect(screen.getByText(/left$/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      `/stories/${storyId}/debate/99999999-9999-4999-8999-999999999999`,
    );
  });

  it('counts multiple debates and drops the countdown once the deadline passes', () => {
    render(
      <DebatePanel
        storyId={storyId}
        debates={[
          summary({ debate_id: 'a1111111-1111-4111-8111-111111111111' }),
          summary({
            debate_id: 'b2222222-2222-4222-8222-222222222222',
            state: 'awaiting_verdict',
            target_type: 'story',
            edit_deadline_at: '2000-01-01T00:00:00.000Z',
            target_excerpt: null,
          }),
        ]}
      />,
    );
    expect(screen.getByText('2 active debates')).toBeInTheDocument();
    expect(screen.getByText(/The story is challenged/)).toBeInTheDocument();
    expect(screen.getByText(/Editing closed/)).toBeInTheDocument();
  });
});
