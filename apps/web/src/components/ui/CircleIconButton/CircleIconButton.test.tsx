// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared circular banner action (WS-B.1.5): an icon-only control whose
// `label` is its ONLY accessible name, sized to the 48px touch token so the
// banner's inline-end actions are geometrically symmetric with the back button.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { CircleIconButton } from './CircleIconButton.js';

describe('CircleIconButton (WS-B.1.5)', () => {
  it('names itself from `label`, renders an icon, and activates', async () => {
    const onClick = vi.fn();
    render(<CircleIconButton icon="search" label="Search this room" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Search this room' });
    // The label doubles as the tooltip for pointer users.
    expect(button).toHaveAttribute('title', 'Search this room');
    expect(button.querySelector('svg')).not.toBeNull();
    // Never a submit button — these live inside forms on some surfaces.
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.setup().click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('meets the 48px touch target and is circular', () => {
    render(<CircleIconButton icon="check-badge" label="Governance" />);
    const classes = screen.getByRole('button', { name: 'Governance' }).className.split(/\s+/);
    expect(classes).toContain('h-touch');
    expect(classes).toContain('w-touch');
    expect(classes).toContain('rounded-full');
  });

  it('carries a state on the GLYPH, never as a badge beside it', () => {
    // The circle must stay one clean control: a state treatment goes onto the
    // icon (a colour shift, a glow), and — being decorative — must always be
    // accompanied by the same state in the accessible name.
    const { container } = render(
      <CircleIconButton
        icon="check-badge"
        label="Governance — AI agent active"
        tone="success"
        iconClassName="text-governed glow-governed"
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Governance — AI agent active' }),
    ).toBeInTheDocument();
    const glyph = container.querySelector('svg');
    expect(glyph?.getAttribute('class')?.split(/\s+/)).toEqual(
      expect.arrayContaining(['text-governed', 'glow-governed']),
    );
    // No extra element rides alongside the glyph.
    expect(container.querySelectorAll('button > *')).toHaveLength(1);
  });

  it('pairs each filled tone with its OWN verified foreground and border', () => {
    // A filled tone that borrowed another hue's `*-fg` would silently break the
    // contrast pair the token suite verifies, so assert the pairing directly.
    const { rerender } = render(<CircleIconButton icon="log-in" label="Sign in" tone="primary" />);
    let classes = screen.getByRole('button', { name: 'Sign in' }).className.split(/\s+/);
    expect(classes).toContain('bg-primary');
    expect(classes).toContain('text-primary-fg');
    expect(classes).toContain('border-primary-active');

    rerender(<CircleIconButton icon="check-badge" label="Governance" tone="success" />);
    classes = screen.getByRole('button', { name: 'Governance' }).className.split(/\s+/);
    expect(classes).toContain('bg-success');
    expect(classes).toContain('text-success-fg');
    expect(classes).toContain('border-success-active');

    // Default stays the recessive surface fill (the search button).
    rerender(<CircleIconButton icon="search" label="Search" />);
    classes = screen.getByRole('button', { name: 'Search' }).className.split(/\s+/);
    expect(classes).toContain('bg-surface');
    expect(classes).not.toContain('bg-primary');
  });

  it('has no axe violations', async () => {
    const { container } = render(<CircleIconButton icon="search" label="Search" />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
