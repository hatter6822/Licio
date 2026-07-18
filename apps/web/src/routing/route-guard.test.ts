// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UserContext } from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../stores/index.js';
import { requireAuth } from './route-guard.js';

const ACTIVE_USER: UserContext = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'ada',
  display_name: 'Ada',
  account_state: 'active',
  locale: 'en',
  roles: [],
  steward_roles: [],
};

beforeEach(() => {
  useAuthStore.getState().logout();
});

describe('requireAuth', () => {
  it('throws a redirect when unauthenticated', () => {
    expect(() => requireAuth({ location: { href: '/profile' } })).toThrow();
  });

  it('throws when the account is suspended (not active)', () => {
    useAuthStore.getState().setAuthenticated({ ...ACTIVE_USER, account_state: 'suspended' });
    expect(() => requireAuth({ location: { href: '/profile' } })).toThrow();
  });

  it('does not throw for an authenticated, active account', () => {
    useAuthStore.getState().setAuthenticated(ACTIVE_USER);
    expect(() => requireAuth({ location: { href: '/profile' } })).not.toThrow();
  });
});
