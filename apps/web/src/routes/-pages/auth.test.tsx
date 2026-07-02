// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LoginPage post-auth navigation must REPLACE /login, never push over it.
//
// The requireAuth guard redirects a guarded route to /login, and the router
// forces that redirect to REPLACE — so /login lands directly on the pre-login
// entry.  If the sign-in / already-authenticated bounce then PUSHES the
// destination, /login stays live one step back; pressing Back returns to /login,
// where the authenticated-bounce effect immediately fires and pushes the
// destination again — trapping the reader at /login <-> destination and never
// letting Back reach the pre-login page.  Replacing /login removes it from
// history, so Back reaches the real parent.  This is the same push-vs-replace
// loop class the useGoBack fix targets, closed here for the auth flow.
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeRedirect } from '../../routing/guards.js';

const navigate = vi.fn();
let status: string;

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ redirect: '/submit' }),
  useNavigate: () => navigate,
  Link: ({ children }: { children?: ReactNode }) => <a href="#test">{children}</a>,
}));
vi.mock('./usePageFocus.js', () => ({ usePageFocus: vi.fn() }));
vi.mock('../../stores/auth.js', () => ({
  useAuthStore: (selector: (s: { status: string; setAuthenticated: () => void }) => unknown) =>
    selector({ status, setAuthenticated: vi.fn() }),
}));

const { LoginPage } = await import('./auth.js');

beforeEach(() => {
  navigate.mockReset();
  status = 'authenticated';
});

describe('LoginPage post-auth navigation (back-loop regression)', () => {
  it('REPLACES /login when bouncing an already-authenticated reader to the destination', () => {
    status = 'authenticated';
    render(<LoginPage />);
    // A push here is what created the /login <-> destination trap.
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ to: sanitizeRedirect('/submit'), replace: true });
  });

  it('does not bounce an unauthenticated reader', () => {
    status = 'unauthenticated';
    render(<LoginPage />);
    expect(navigate).not.toHaveBeenCalled();
  });
});
