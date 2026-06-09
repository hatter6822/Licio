// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Imperative auth guard for route `beforeLoad` (WS-C.1.1d). Pure decision logic
// lives in guards.ts; this wires it to the router redirect + the session store +
// a privacy-safe guard-outcome telemetry event. An unauthenticated user is
// redirected to login with an allowlisted destination preserved.
import { redirect } from '@tanstack/react-router';
import { track } from '../lib/telemetry.js';
import { selectIsAuthenticated, useAuthStore } from '../stores/index.js';

export function requireAuth({ location }: { location: { href: string } }): void {
  if (!selectIsAuthenticated(useAuthStore.getState())) {
    track({ name: 'route_guard', metric: 'redirected' });
    throw redirect({ to: '/login', search: { redirect: location.href } });
  }
}
