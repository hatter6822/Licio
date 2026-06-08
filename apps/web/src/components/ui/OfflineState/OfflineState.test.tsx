// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { OfflineState } from './OfflineState.js';

describe('OfflineState', () => {
  it('renders a default title and cached-content explanation', () => {
    render(<OfflineState />);
    expect(screen.getByRole('heading', { name: "You're offline" })).toBeInTheDocument();
    expect(
      screen.getByText('Showing the latest content saved on this device.'),
    ).toBeInTheDocument();
  });

  it('accepts a custom cachedDescription', () => {
    render(<OfflineState cachedDescription="Saved stories are still readable." />);
    expect(screen.getByText('Saved stories are still readable.')).toBeInTheDocument();
  });

  it('accepts a custom title', () => {
    render(<OfflineState title="No connection" />);
    expect(screen.getByRole('heading', { name: 'No connection' })).toBeInTheDocument();
  });

  it('announces politely via aria-live', () => {
    const { container } = render(<OfflineState />);
    const region = container.firstElementChild as HTMLElement;
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('renders the wifi-off icon as decorative', () => {
    const { container } = render(<OfflineState />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders a Retry button and fires onRetry on click', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<OfflineState onRetry={onRetry} />);
    const button = screen.getByRole('button', { name: 'Try again' });
    await user.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders no Retry button when onRetry is not provided', () => {
    render(<OfflineState />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('respects a custom heading level', () => {
    render(<OfflineState headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: "You're offline" })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <OfflineState cachedDescription="Cached stories remain available." onRetry={() => {}} />,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
