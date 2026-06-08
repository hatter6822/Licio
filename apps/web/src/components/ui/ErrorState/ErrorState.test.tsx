// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { ErrorState } from './ErrorState.js';

describe('ErrorState', () => {
  it('renders a default title and description', () => {
    render(<ErrorState />);
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByText('We could not load this. Please try again.')).toBeInTheDocument();
  });

  it('accepts a custom title and description', () => {
    render(<ErrorState title="Feed unavailable" description="The room could not be reached." />);
    expect(screen.getByRole('heading', { name: 'Feed unavailable' })).toBeInTheDocument();
    expect(screen.getByText('The room could not be reached.')).toBeInTheDocument();
  });

  it('announces the failure assertively via role="alert"', () => {
    const { container } = render(<ErrorState />);
    const region = container.firstElementChild as HTMLElement;
    expect(region).toHaveAttribute('role', 'alert');
  });

  it('renders a Retry button and fires onRetry on click', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} />);
    const button = screen.getByRole('button', { name: 'Retry' });
    await user.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders no Retry button when onRetry is not provided', () => {
    render(<ErrorState />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('respects a custom heading level', () => {
    render(<ErrorState headingLevel={3} />);
    expect(
      screen.getByRole('heading', { level: 3, name: 'Something went wrong' }),
    ).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ErrorState
        title="Feed unavailable"
        description="Something went wrong while loading."
        onRetry={() => {}}
      />,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
