// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Auth store (WS-C.1.3a, SPEC §25.3). Tracks SESSION STATUS, never the token —
// the session token lives in an HttpOnly, SameSite=Strict cookie out of
// JavaScript's reach (XSS-token-theft defense, SPEC §25.2). Only the
// non-sensitive user context is persisted, and it is zod-validated on every
// rehydration; corrupt or wrong-shaped state falls back to unauthenticated.
import { type UserContext, userContextSchema } from '@licio/shared';
import { z } from 'zod';
import { create } from 'zustand';
import { clearPersisted, loadPersisted, type PersistConfig, savePersisted } from './persist.js';

export type AuthStatus = 'unauthenticated' | 'authenticating' | 'authenticated' | 'session-expired';

/** Only the non-sensitive user context is persisted (never any token). */
const authPersistedSchema = z.object({ user: userContextSchema });
type AuthPersisted = z.infer<typeof authPersistedSchema>;

const PERSIST: PersistConfig<AuthPersisted> = {
  key: 'auth',
  schema: authPersistedSchema,
  version: 1,
};

export interface AuthState {
  status: AuthStatus;
  user: UserContext | null;
  /** Move to `authenticating` while a sign-in is in flight. */
  beginAuthentication: () => void;
  /** Sign-in succeeded: store the user context and persist it. */
  setAuthenticated: (user: UserContext) => void;
  /** Refresh the user context (e.g. after confirming the session on boot). */
  setUser: (user: UserContext) => void;
  /** Session expired mid-use: guards redirect on the next protected nav. */
  expireSession: () => void;
  /** Explicit logout: clear state, drop persisted context, notify other tabs. */
  logout: () => void;
  /** Apply a logout that originated in another tab (no re-broadcast). */
  applyRemoteLogout: () => void;
}

// --- Cross-tab logout (WS-C.1.3a edge case) -------------------------------
// One BroadcastChannel instance per tab. A tab never receives its own posts, so
// `logout()` can broadcast freely without a feedback loop.
const AUTH_CHANNEL = 'licio:auth';
let channel: BroadcastChannel | undefined;

function postLogout(): void {
  channel?.postMessage({ type: 'logout' });
}

/**
 * Wire cross-tab auth sync. Call once at app startup. Returns a teardown so the
 * channel can be closed (tests, hot reload). A no-op where BroadcastChannel is
 * unavailable — single-tab behaviour is unaffected.
 */
export function initAuthSync(): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  channel = new BroadcastChannel(AUTH_CHANNEL);
  const onMessage = (event: MessageEvent): void => {
    if ((event.data as { type?: string } | null)?.type === 'logout') {
      useAuthStore.getState().applyRemoteLogout();
    }
  };
  channel.addEventListener('message', onMessage);
  return () => {
    channel?.removeEventListener('message', onMessage);
    channel?.close();
    channel = undefined;
  };
}

function initialState(): Pick<AuthState, 'status' | 'user'> {
  const persisted = loadPersisted(PERSIST);
  // Optimistic: if a valid user context survived, present authenticated UI and
  // let the boot-time session check downgrade to session-expired on a 401.
  if (persisted) return { status: 'authenticated', user: persisted.user };
  return { status: 'unauthenticated', user: null };
}

export const useAuthStore = create<AuthState>((set) => ({
  ...initialState(),
  beginAuthentication: () => set({ status: 'authenticating' }),
  setAuthenticated: (user) => {
    savePersisted(PERSIST, { user });
    set({ status: 'authenticated', user });
  },
  setUser: (user) => {
    savePersisted(PERSIST, { user });
    set((state) =>
      state.status === 'authenticated' ? { user } : { status: 'authenticated', user },
    );
  },
  // Keep the user context so the UI can show whose session lapsed, but the
  // guards treat session-expired as not-authenticated.
  expireSession: () => set({ status: 'session-expired' }),
  logout: () => {
    clearPersisted(PERSIST.key);
    set({ status: 'unauthenticated', user: null });
    postLogout();
  },
  applyRemoteLogout: () => {
    clearPersisted(PERSIST.key);
    set({ status: 'unauthenticated', user: null });
  },
}));

/** True only when authenticated with an active (non-suspended) account. */
export function selectIsAuthenticated(state: AuthState): boolean {
  return state.status === 'authenticated' && state.user?.account_state === 'active';
}

/** True when the rehydrated/loaded account is restricted or suspended. */
export function selectIsRestricted(state: AuthState): boolean {
  return (
    state.status === 'authenticated' && state.user !== null && state.user.account_state !== 'active'
  );
}
