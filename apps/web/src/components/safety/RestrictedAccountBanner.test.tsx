// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/index.js';
import { checkA11y } from '../../test/axe.js';
import { RestrictedAccountBanner } from './RestrictedAccountBanner.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={`#${to}`}>{children}</a>
  ),
}));

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'reader',
  display_name: 'Reader',
  account_state: 'active' as const,
  locale: 'en-US',
  roles: [] as never[],
  steward_roles: [] as never[],
};

afterEach(() => useAuthStore.getState().applyRemoteLogout());

describe('RestrictedAccountBanner', () => {
  it('renders NOTHING for an active account', () => {
    useAuthStore.getState().setAuthenticated(USER);
    const { container } = render(<RestrictedAccountBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the restriction and links to the appeal', async () => {
    // The sanction is enforced per WRITE route (403 `account_restricted`), so
    // without this the account browses a UI that looks entirely normal until a
    // post fails with no explanation — silent failure, which is a worse answer
    // than the login bounce it replaced.
    useAuthStore.getState().setAuthenticated({ ...USER, account_state: 'restricted' });
    const { container } = render(<RestrictedAccountBanner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/your account is restricted/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /appeal/i })).toHaveAttribute(
      'href',
      '#/profile/safety',
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
