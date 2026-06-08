// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { LoadingState } from './LoadingState.js';

describe('LoadingState', () => {
  it('marks the container as busy', () => {
    const { container } = render(<LoadingState />);
    const region = container.firstElementChild as HTMLElement;
    expect(region).toHaveAttribute('aria-busy', 'true');
  });

  it('announces a default sr-only loading status', () => {
    render(<LoadingState />);
    const status = screen.getByText('Loading…');
    expect(status).toHaveClass('sr-only');
  });

  it('accepts a custom status label', () => {
    render(<LoadingState label="Fetching room" />);
    expect(screen.getByText('Fetching room')).toHaveClass('sr-only');
  });

  it('renders the requested number of placeholder rows', () => {
    const { container } = render(<LoadingState rows={4} />);
    // Each row is a bordered card; count the card containers.
    const cards = container.querySelectorAll('.border-line');
    expect(cards).toHaveLength(4);
  });

  it('defaults to three rows', () => {
    const { container } = render(<LoadingState />);
    expect(container.querySelectorAll('.border-line')).toHaveLength(3);
  });

  it('renders decorative, aria-hidden skeleton blocks (no exposed text)', () => {
    const { container } = render(<LoadingState rows={1} />);
    const pulses = container.querySelectorAll('.animate-pulse');
    expect(pulses.length).toBeGreaterThan(0);
    // The only exposed text is the single sr-only status line.
    expect(container.textContent).toBe('Loading…');
  });

  it('has no axe violations', async () => {
    const { container } = render(<LoadingState rows={2} />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
