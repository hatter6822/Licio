// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The banner's one governance slot, in both of its states (WS-U §24.6): a blue
// sign-in link while signed out, the green governance trigger once signed in.
// The pair replaced two full-width buttons that used to sit at the top of every
// room page.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth.js';
import { checkA11y } from '../../test/axe.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    search,
    className,
    'aria-label': ariaLabel,
    title,
  }: {
    children?: ReactNode;
    to?: string;
    search?: Record<string, string>;
    className?: string;
    'aria-label'?: string;
    title?: string;
  }) => {
    const query = search ? `?${new URLSearchParams(search).toString()}` : '';
    return (
      <a href={`${to ?? '#'}${query}`} className={className} aria-label={ariaLabel} title={title}>
        {children}
      </a>
    );
  },
}));

const { GovernanceButton } = await import('./GovernanceButton.js');

const ROOM_PATH = '/rooms/11111111-1111-4111-8111-111111111111';

function signIn(): void {
  useAuthStore.setState({ status: 'authenticated', user: { id: 'u1' } } as never);
}

afterEach(() => {
  useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
});

describe('GovernanceButton (WS-U §24.6)', () => {
  it('signed OUT: a blue sign-in LINK carrying the return path', () => {
    render(<GovernanceButton onOpen={vi.fn()} signInRedirect={ROOM_PATH} />);
    const link = screen.getByRole('link', { name: 'Sign in to take part in governance' });
    // A link, not a button: it navigates, so middle-click / open-in-new-tab work.
    expect(link.getAttribute('href')).toContain('/login');
    expect(link.getAttribute('href')).toContain(encodeURIComponent(ROOM_PATH));
    expect(link.className.split(/\s+/)).toContain('bg-primary');
    // …and the governance trigger is NOT also rendered — one slot, one control.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('signed IN: the same slot becomes the green governance trigger', async () => {
    signIn();
    const onOpen = vi.fn();
    render(<GovernanceButton onOpen={onOpen} signInRedirect={ROOM_PATH} />);
    const button = screen.getByRole('button', { name: 'Governance' });
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(button.className.split(/\s+/)).toContain('bg-success');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    await userEvent.setup().click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('makes the shield glow gold when an AI agent governs — and says so in the name', () => {
    signIn();
    const { container, rerender } = render(
      <GovernanceButton onOpen={vi.fn()} signInRedirect={ROOM_PATH} />,
    );
    // Not governed: a plain shield, no glow.
    expect(container.querySelector('svg')?.getAttribute('class')).not.toContain('glow-governed');

    rerender(<GovernanceButton onOpen={vi.fn()} signInRedirect={ROOM_PATH} agentActive />);
    // The glow rides on the GLYPH itself (the circle keeps its shape) …
    const glyph = container.querySelector('svg')?.getAttribute('class')?.split(/\s+/) ?? [];
    expect(glyph).toEqual(expect.arrayContaining(['text-governed', 'glow-governed']));
    // … and never carries the meaning alone: the accessible name states it too.
    expect(
      screen.getByRole('button', { name: 'Governance — AI agent active' }),
    ).toBeInTheDocument();
  });

  it('an unreachable surface hides the trigger — but never the sign-in', () => {
    // A signed-in reader who cannot read the room yet: the join affordance in
    // the page body is their next step, not this.
    signIn();
    const { container, rerender } = render(
      <GovernanceButton onOpen={vi.fn()} signInRedirect={ROOM_PATH} reachable={false} />,
    );
    expect(container).toBeEmptyDOMElement();

    // Signed OUT below the same bar, the sign-in survives: signing in is
    // precisely how a reader gets past it.
    useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
    rerender(<GovernanceButton onOpen={vi.fn()} signInRedirect={ROOM_PATH} reachable={false} />);
    expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();
  });

  it('has no axe violations in either state', async () => {
    const out = render(<GovernanceButton onOpen={vi.fn()} signInRedirect={ROOM_PATH} />);
    expect(await checkA11y(out.container)).toHaveNoViolations();
    out.unmount();
    signIn();
    const inn = render(<GovernanceButton onOpen={vi.fn()} signInRedirect={ROOM_PATH} />);
    expect(await checkA11y(inn.container)).toHaveNoViolations();
  });
});
