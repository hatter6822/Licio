// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { EmptyState } from './EmptyState.js';

describe('EmptyState', () => {
  it('renders the title as a heading', () => {
    render(<EmptyState title="No stories yet" />);
    expect(screen.getByRole('heading', { name: 'No stories yet' })).toBeInTheDocument();
  });

  it('renders the optional description', () => {
    render(<EmptyState title="No stories yet" description="Check back later." />);
    expect(screen.getByText('Check back later.')).toBeInTheDocument();
  });

  it('omits the description when not provided', () => {
    const { container } = render(<EmptyState title="No stories yet" />);
    expect(container.querySelector('p')).toBeNull();
  });

  it('renders the default inbox icon', () => {
    const { container } = render(<EmptyState title="Empty" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // The icon is decorative (the heading conveys the meaning).
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders a primary action button and fires its callback on click', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<EmptyState title="No stories yet" action={{ label: 'Refresh feed', onAction }} />);
    const button = screen.getByRole('button', { name: 'Refresh feed' });
    await user.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('renders no action button when no action is given', () => {
    render(<EmptyState title="No stories yet" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('respects a custom heading level', () => {
    render(<EmptyState title="Empty" headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Empty' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <EmptyState
        title="No stories yet"
        description="Nothing matches your filters."
        action={{ label: 'Clear filters', onAction: () => {} }}
      />,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
