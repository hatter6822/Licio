// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Route-guard decision logic (WS-C.1.1d, SPEC §25.3). Pure functions so the
// guard table is unit-testable. Two categories: auth-protected routes (redirect
// to login, preserving an allowlisted destination to prevent open-redirect) and
// feature-flag-gated routes (render RestrictedState when the flag is off — flags
// FAIL CLOSED, so an error/offline flag resolves to off).
import { uuidSchema } from '@licio/shared';

export type RouteAccess = 'render' | 'redirect-login' | 'restricted';

export interface RouteAccessInput {
  /** Whether the route requires authentication. */
  requiresAuth: boolean;
  /** Whether the user is authenticated with an active account. */
  authed: boolean;
  /**
   * Flag state for a flag-gated route: `true` enabled, `false` disabled (incl.
   * fail-closed error/offline), or `null` for a route that is not flag-gated.
   */
  flagEnabled: boolean | null;
}

/**
 * Resolve route access per the WS-C.1.1d decision table. Auth is checked first
 * (an unauthenticated user is redirected to login regardless of the flag); a
 * disabled flag then yields RestrictedState (fail closed).
 */
export function resolveRouteAccess(input: RouteAccessInput): RouteAccess {
  if (input.requiresAuth && !input.authed) return 'redirect-login';
  if (input.flagEnabled === false) return 'restricted';
  return 'render';
}

/** True if the string contains an ASCII control char (newline/tab smuggling). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whether a post-login redirect target is a safe in-app path. Rejects anything
 * that could escape the app: protocol-relative (`//host`), backslash tricks,
 * scheme URLs, control characters, or non-absolute paths. Open-redirect defense.
 */
export function isSafeRedirect(dest: unknown): dest is string {
  if (typeof dest !== 'string' || dest.length === 0) return false;
  if (!dest.startsWith('/')) return false; // must be an absolute in-app path
  if (dest.startsWith('//')) return false; // protocol-relative ⇒ off-site
  if (dest.includes('\\')) return false; // backslash normalisation tricks
  if (hasControlChar(dest)) return false;
  return true;
}

/** Return a safe redirect destination, or the fallback when unsafe/absent. */
export function sanitizeRedirect(dest: unknown, fallback = '/'): string {
  return isSafeRedirect(dest) ? dest : fallback;
}

/** Whether a route param is a valid UUID (invalid params ⇒ error state). */
export function isValidUuidParam(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}
