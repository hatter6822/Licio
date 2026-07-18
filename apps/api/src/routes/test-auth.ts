// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TEST-ONLY authentication route for the BFF-in-the-loop E2E harness. It mints a
// REAL server session cookie for a seeded user so Playwright can drive the
// authenticated WS-Q flows (compose → submit, room join, visibility change)
// without a WebAuthn ceremony in a headless browser.
//
// SECURITY: this route is mounted ONLY by the in-memory e2e-server
// (apps/api/src/e2e-server.ts), NEVER by the production app (apps/api/src/app.ts
// or src/index.ts). The e2e-server refuses to start when NODE_ENV=production and
// requires LICIO_E2E=1, so this can never be reachable as a production backdoor.
// It also runs entirely on in-memory stores (no production data).
import { Hono } from 'hono';
import type { IdentityServices } from '../identity/services.js';
import { buildSessionCookie, createSession } from '../identity/sessions.js';
import { SEED_USER } from '../lib/demo-seed.js';

/**
 * A test-auth sub-app. Mount it BEFORE the CSRF-protected production app so the
 * login needs no CSRF token (it is the bootstrap that establishes the session).
 */
export function createTestAuthRoute(identity: IdentityServices) {
  return new Hono().post('/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { userId?: unknown };
    const userId = typeof body.userId === 'string' ? body.userId : SEED_USER.userId;
    const user = await identity.store.getUser(userId);
    if (user?.accountState !== 'active') {
      return c.json({ ok: false, error: 'no_such_active_user' }, 404);
    }
    // Seeded operator accounts arrive fully MFA-cleared so EVERY step-up-gated
    // surface is testable in the harness — steward (moderation console), admin
    // (all consoles — final line of defense), compliance/counsel (the WS-N
    // console + counsel plane).  BOTH halves matter (codex on PR #146): the
    // require* guards check `mfaActive && mfaVerified`, and authMiddleware
    // derives `mfaActive` from the identity record's `mfaEnabled` — a session
    // flag alone still answers `mfa_required`.
    const operator = (['steward', 'admin', 'compliance', 'counsel'] as const).some((role) =>
      user.roles.includes(role),
    );
    if (operator) {
      await identity.store.setAuth(userId, { mfaEnabled: true, mfaPending: false });
    }
    const created = await createSession(identity.sessions, {
      userId,
      authMethod: 'webauthn',
      credentialRef: `e2e-${userId}`,
      deviceLabel: 'e2e',
      rememberMe: false,
      mfaVerified: operator,
    });
    c.header('Set-Cookie', buildSessionCookie(created.token, created.maxAgeSec));
    return c.json({ ok: true, userId });
  });
}
