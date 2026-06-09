// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UserContext } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACTIVE_USER: UserContext = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'ada',
  display_name: 'Ada',
  account_state: 'active',
  locale: 'en',
};

const SUSPENDED_USER: UserContext = { ...ACTIVE_USER, account_state: 'suspended' };

/** Import a fresh auth-store module after optionally seeding persisted state. */
async function freshAuth(persistedUser?: UserContext) {
  localStorage.clear();
  if (persistedUser) {
    localStorage.setItem(
      'licio:auth',
      JSON.stringify({ version: 1, state: { user: persistedUser } }),
    );
  }
  vi.resetModules();
  return import('./auth.js');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('auth store transitions', () => {
  it('starts unauthenticated with no persisted user', async () => {
    const { useAuthStore } = await freshAuth();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('moves through authenticating → authenticated and persists the user', async () => {
    const { useAuthStore } = await freshAuth();
    useAuthStore.getState().beginAuthentication();
    expect(useAuthStore.getState().status).toBe('authenticating');
    useAuthStore.getState().setAuthenticated(ACTIVE_USER);
    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().user).toEqual(ACTIVE_USER);
    expect(localStorage.getItem('licio:auth')).not.toBeNull();
  });

  it('keeps the user but flags session-expired on expiry', async () => {
    const { useAuthStore } = await freshAuth();
    useAuthStore.getState().setAuthenticated(ACTIVE_USER);
    useAuthStore.getState().expireSession();
    expect(useAuthStore.getState().status).toBe('session-expired');
    expect(useAuthStore.getState().user).toEqual(ACTIVE_USER);
  });

  it('logout clears state and persisted context', async () => {
    const { useAuthStore } = await freshAuth();
    useAuthStore.getState().setAuthenticated(ACTIVE_USER);
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(useAuthStore.getState().user).toBeNull();
    expect(localStorage.getItem('licio:auth')).toBeNull();
  });
});

describe('auth store rehydration', () => {
  it('optimistically rehydrates a valid persisted user as authenticated', async () => {
    const { useAuthStore } = await freshAuth(ACTIVE_USER);
    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().user).toEqual(ACTIVE_USER);
  });

  it('falls back to unauthenticated when persisted state is corrupt', async () => {
    localStorage.setItem('licio:auth', '{ corrupt');
    vi.resetModules();
    const { useAuthStore } = await import('./auth.js');
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('discards a persisted user with a wrong shape', async () => {
    localStorage.setItem(
      'licio:auth',
      JSON.stringify({ version: 1, state: { user: { id: 'not-a-uuid' } } }),
    );
    vi.resetModules();
    const { useAuthStore } = await import('./auth.js');
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });
});

describe('auth selectors', () => {
  it('treats an active authenticated account as authenticated, not restricted', async () => {
    const { useAuthStore, selectIsAuthenticated, selectIsRestricted } = await freshAuth();
    useAuthStore.getState().setAuthenticated(ACTIVE_USER);
    expect(selectIsAuthenticated(useAuthStore.getState())).toBe(true);
    expect(selectIsRestricted(useAuthStore.getState())).toBe(false);
  });

  it('treats a suspended account as restricted, not authenticated', async () => {
    const { useAuthStore, selectIsAuthenticated, selectIsRestricted } = await freshAuth();
    useAuthStore.getState().setAuthenticated(SUSPENDED_USER);
    expect(selectIsAuthenticated(useAuthStore.getState())).toBe(false);
    expect(selectIsRestricted(useAuthStore.getState())).toBe(true);
  });
});

describe('auth cross-tab sync', () => {
  it('applyRemoteLogout clears state without throwing', async () => {
    const { useAuthStore } = await freshAuth();
    useAuthStore.getState().setAuthenticated(ACTIVE_USER);
    useAuthStore.getState().applyRemoteLogout();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(localStorage.getItem('licio:auth')).toBeNull();
  });

  it('initAuthSync returns a teardown that is safe to call', async () => {
    const { initAuthSync } = await freshAuth();
    const teardown = initAuthSync();
    expect(typeof teardown).toBe('function');
    expect(() => teardown()).not.toThrow();
  });
});
