// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { SectionEndpoint } from './SectionEndpoint.js';

describe('SectionEndpoint', () => {
  it('renders the default caught-up message', () => {
    render(<SectionEndpoint />);
    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
  });

  it('accepts a custom message', () => {
    render(<SectionEndpoint message="End of this room" />);
    expect(screen.getByText('End of this room')).toBeInTheDocument();
  });

  it('announces the endpoint as a polite status region', () => {
    render(<SectionEndpoint />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent("You're all caught up");
  });

  it('renders no action by default', () => {
    render(<SectionEndpoint />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing below the endpoint (never auto-loads content)', () => {
    const { container } = render(<SectionEndpoint />);
    // The endpoint is the single rendered subtree; nothing follows it.
    const root = container.firstElementChild as HTMLElement;
    expect(root.nextElementSibling).toBeNull();
    // And it has no nested feed/list content that could imply more items.
    expect(container.querySelector('ul, ol, article')).toBeNull();
  });

  it('renders the optional action as a low-emphasis ghost button and fires it on click', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<SectionEndpoint action={{ label: 'Review muted topics', onAction }} />);
    const button = screen.getByRole('button', { name: 'Review muted topics' });
    // Ghost variant: no solid primary fill.
    expect(button).not.toHaveClass('bg-primary');
    await user.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <SectionEndpoint
        message="You're all caught up"
        action={{ label: 'See older stories', onAction: () => {} }}
      />,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
