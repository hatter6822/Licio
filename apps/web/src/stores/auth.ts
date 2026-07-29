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
 * Purge the SW's `licio-api` runtime cache on sign-out.  Cached /v1 GETs (the
 * NetworkFirst offline fallback) hold the signed-out user's data for up to
 * 24h, and on a shared browser the next user (or any same-origin script)
 * could read them from Cache Storage.  /v1/auth/* never enters the cache at
 * all (excluded in the SW's runtime-caching pattern — codex on PR #146: a
 * cached /status could answer a later login as an older session, and this
 * fire-and-forget purge races any in-flight auth GET whose NetworkFirst
 * write lands after the delete); this purge clears the REST of the user's
 * cached data.  Best-effort: Cache Storage may be absent (older WebViews,
 * some test environments), and a failed purge must never block sign-out.
 */
function purgeApiCache(): void {
  if (typeof caches === 'undefined') return;
  void caches.delete('licio-api').catch(() => undefined);
}

// --- In-memory query-cache purge (WS-C.1.3a) ------------------------------
// `purgeApiCache` clears the SW Cache Storage, but the previous account's
// fetched data ALSO sits in the in-memory TanStack Query cache (profile,
// treasury, compliance, private-room reads, …). On a shared browser the next
// user — or any same-origin script — could read it back until GC/refetch. The
// QueryClient is created at boot (main.tsx), not a module singleton, so the app
// registers a purge here and BOTH sign-out paths (local + cross-tab) call it.
let queryCachePurge: (() => void) | null = null;

/** Register the app's TanStack Query cache purge (call once at boot). */
export function registerQueryCachePurge(purge: () => void): void {
  queryCachePurge = purge;
}

function purgeAllCaches(): void {
  purgeApiCache();
  queryCachePurge?.();
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
    purgeAllCaches();
    set({ status: 'unauthenticated', user: null });
    postLogout();
  },
  applyRemoteLogout: () => {
    clearPersisted(PERSIST.key);
    purgeAllCaches();
    set({ status: 'unauthenticated', user: null });
  },
}));

/** True only when authenticated with an active (non-suspended) account. */
export function selectIsAuthenticated(state: AuthState): boolean {
  // "Has a live session", NOT "is unrestricted".  A `restricted` account (WS-J
  // `restrict`) is allowed to sign in precisely so it can appeal, exercise data
  // rights, and read its notices; requiring `active` here made `requireAuth`
  // redirect it to /login on every one of those pages, so the server admitted a
  // session the client refused to believe in.  What restriction costs is the
  // WRITE paths, which the server denies per-route (403 `account_restricted`)
  // and `selectIsRestricted` renders — it was never meant to cost access to the
  // account itself.
  return (
    state.status === 'authenticated' &&
    (state.user?.account_state === 'active' || state.user?.account_state === 'restricted')
  );
}

/**
 * The user id the attention pipeline may attribute uploads to: the session user
 * iff the session is genuinely authenticated (`selectIsAuthenticated`), otherwise
 * `null`. The store retains `user` across `session-expired` (so the UI can show
 * whose session lapsed) and optimistically rehydrates it from localStorage at
 * boot, so the mere presence of `user` does NOT imply a live session. Every
 * attention upload is authenticated at the WS-E ingestion boundary, so EVERY
 * collection-policy writer (the boot policy + the live Privacy-page sync) must
 * gate on this, never on the raw `user?.id` — otherwise an expired session keeps
 * uploading straight into 401s.
 */
export function selectCollectionUserId(state: AuthState): string | null {
  return selectIsAuthenticated(state) ? (state.user?.id ?? null) : null;
}

/** True when the rehydrated/loaded account is restricted or suspended. */
export function selectIsRestricted(state: AuthState): boolean {
  return (
    state.status === 'authenticated' && state.user !== null && state.user.account_state !== 'active'
  );
}
