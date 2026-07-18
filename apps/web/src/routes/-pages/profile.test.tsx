// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ProfilePage operations navigation (WS-J.2 / WS-N.2.1c-2 console
// reachability): the role-gated "Operations" group renders the moderation /
// compliance console links from the session context's roles.  The roles are a
// navigation HINT only — every console endpoint re-authorizes server-side
// (requireSteward / requireCompliance + step-up MFA) — so these tests assert
// link visibility per role, including the WS-N structural separation (admin
// sees moderation, never compliance).
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../test/axe.js';
import { ProfilePage } from './profile.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children?: ReactNode;
    to?: string;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useRouterState: (opts: { select: (s: unknown) => unknown }) =>
    opts.select({ location: { pathname: '/profile' } }),
}));

interface TestUser {
  id: string;
  handle: string;
  display_name: string;
  account_state: string;
  locale: string;
  roles: string[];
  steward_roles: string[];
}
const authUser = vi.hoisted(() => vi.fn<() => TestUser | null>(() => null));
vi.mock('../../stores/index.js', () => ({
  useAuthStore: (sel: (s: { user: unknown; logout: () => void; status: string }) => unknown) =>
    sel({ user: authUser(), logout: vi.fn(), status: 'authenticated' }),
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) => sel({}),
  useFeatureFlagStore: (sel: (s: Record<string, unknown>) => unknown) => sel({}),
  selectCollectionUserId: () => null,
  selectCryptoEnabled: () => false,
}));

function user(roles: string[], stewardRoles: string[] = []): TestUser {
  return {
    id: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
    handle: 'member',
    display_name: 'Member',
    account_state: 'active',
    locale: 'en-US',
    roles,
    steward_roles: stewardRoles,
  };
}

beforeEach(() => {
  authUser.mockReset();
  authUser.mockReturnValue(user(['user']));
});

describe('the role-gated Operations group', () => {
  it('renders NO operations group for an ordinary member', () => {
    render(<ProfilePage />);
    expect(screen.queryByText('Operations')).toBeNull();
    expect(screen.queryByText('Moderation console')).toBeNull();
    expect(screen.queryByText('Compliance console')).toBeNull();
  });

  it('a DOCTRINE-granted member sees the moderation console link (the console gates on grants, not the platform steward role)', () => {
    authUser.mockReturnValue(user(['user'], ['ROLE_SAFETY']));
    render(<ProfilePage />);
    expect(screen.getByText('Operations')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Moderation console/ });
    expect(link).toHaveAttribute('href', '/moderation');
    expect(screen.queryByText('Compliance console')).toBeNull();
  });

  it('a platform steward with NO doctrine grants gets no dead link (the console would 403 them)', () => {
    authUser.mockReturnValue(user(['user', 'steward']));
    render(<ProfilePage />);
    expect(screen.queryByText('Operations')).toBeNull();
    expect(screen.queryByText('Moderation console')).toBeNull();
  });

  it('an admin sees BOTH consoles (final line of defense: all five doctrine roles + the compliance plane)', () => {
    authUser.mockReturnValue(user(['user', 'admin']));
    render(<ProfilePage />);
    expect(screen.getByRole('link', { name: /Moderation console/ })).toHaveAttribute(
      'href',
      '/moderation',
    );
    expect(screen.getByRole('link', { name: /Compliance console/ })).toHaveAttribute(
      'href',
      '/compliance-console',
    );
  });

  it('the compliance role sees the compliance console link (and not moderation)', async () => {
    authUser.mockReturnValue(user(['user', 'compliance', 'counsel']));
    const { container } = render(<ProfilePage />);
    const link = screen.getByRole('link', { name: /Compliance console/ });
    expect(link).toHaveAttribute('href', '/compliance-console');
    expect(screen.queryByText('Moderation console')).toBeNull();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
