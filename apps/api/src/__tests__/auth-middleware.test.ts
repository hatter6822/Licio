// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgeBand, UserAccountState } from '@licio/shared';
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '../identity/rbac.js';
import {
  createInMemoryIdentityServices,
  type IdentityConfig,
  type IdentityServices,
} from '../identity/services.js';
import { buildSessionCookie, createSession, type SessionStore } from '../identity/sessions.js';
import {
  type AuthContext,
  type AuthEnv,
  assuranceStale,
  authMiddleware,
  requireAdult,
  requireAuth,
  requireStepUp,
  requireSteward,
  requireUnrestricted,
  requireVerifiedAccount,
} from '../middleware/auth.js';

const CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
};

let services: IdentityServices;

beforeEach(async () => {
  services = createInMemoryIdentityServices(CONFIG);
});

interface SeedOpts {
  ageBand?: AgeBand | null;
  roles?: Role[];
  mfa?: boolean;
  /** Whether the SESSION has cleared TOTP (per-session steward MFA, WS-D.1.5b). */
  mfaVerified?: boolean;
  verified?: boolean;
  sessionAge?: number; // ms ago the session was created (for step-up staleness)
  accountState?: UserAccountState;
}

async function seedSessionCookie(opts: SeedOpts = {}): Promise<string> {
  const user = await services.store.createUser({
    handle: 'guarduser',
    displayName: 'Guard',
    email: opts.verified === false ? 'g@example.com' : null,
    accountState: opts.accountState ?? 'active',
    locale: null,
    ageBand: opts.ageBand === undefined ? 'adult' : opts.ageBand,
    privacySettings: defaultPrivacySettings(),
    personalizationSettings: defaultPersonalizationSettings(),
    roles: opts.roles ?? ['user'],
  });
  // A "verified" account needs a credential; simulate a passkey unless verified===false.
  if (opts.verified !== false) {
    await services.store.addWebauthn({
      credentialId: 'cred-guard',
      userId: user.userId,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      deviceType: 'platform',
      deviceName: null,
      transports: [],
      backedUp: false,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
  }
  if (opts.mfa) await services.store.setAuth(user.userId, { mfaEnabled: true });
  const created = await createSession(
    services.sessions,
    {
      userId: user.userId,
      authMethod: 'webauthn',
      credentialRef: 'cred-guard',
      deviceLabel: 'test',
      rememberMe: false,
      mfaVerified: opts.mfaVerified ?? false,
    },
    Date.now() - (opts.sessionAge ?? 0),
  );
  return buildSessionCookie(created.token, created.maxAgeSec).split(';')[0] as string;
}

function guardedApp() {
  const resolve = () => services;
  return new Hono<AuthEnv>()
    .get('/verified', authMiddleware(resolve), requireVerifiedAccount(), (c) =>
      c.json({ ok: true }),
    )
    .get('/adult', authMiddleware(resolve), requireAdult(), (c) => c.json({ ok: true }))
    .get('/steward', authMiddleware(resolve), requireSteward(), (c) => c.json({ ok: true }))
    .get('/stepup', authMiddleware(resolve), requireStepUp(), (c) => c.json({ ok: true }))
    .get('/open', authMiddleware(resolve), (c) => c.json({ ok: true }))
    .get('/unrestricted', authMiddleware(resolve), requireUnrestricted(), (c) =>
      c.json({ ok: true }),
    );
}

describe('requireAuth', () => {
  it('returns the attached AuthContext when authMiddleware ran', () => {
    const auth = { userId: 'u1' } as unknown as AuthContext;
    const c = { get: (_k: 'auth') => auth };
    expect(requireAuth(c)).toBe(auth);
  });

  it('throws when no auth context is present (a routing misconfiguration)', () => {
    const c = { get: (_k: 'auth') => undefined };
    expect(() => requireAuth(c)).toThrow(/without authMiddleware/);
  });
});

describe('assuranceStale', () => {
  it('is false within the window and true beyond it', async () => {
    const now = 1_700_000_000_000;
    expect(
      assuranceStale({ level: 'full', last_verified_at: new Date(now).toISOString() }, now),
    ).toBe(false);
    expect(
      assuranceStale(
        { level: 'full', last_verified_at: new Date(now - 10 * 60_000).toISOString() },
        now,
      ),
    ).toBe(true);
  });
});

describe('authMiddleware', () => {
  it('rejects requests with no session (401)', async () => {
    const res = await guardedApp().request('/adult');
    expect(res.status).toBe(401);
  });

  it('fails closed (503) when the session store throws', async () => {
    const brokenSessions: SessionStore = {
      async get() {
        throw new Error('redis down');
      },
      async put() {},
      async delete() {},
      async listForUser() {
        return [];
      },
      async clear() {},
    };
    const broken = { ...services, sessions: brokenSessions };
    const app = new Hono<AuthEnv>().get(
      '/x',
      authMiddleware(() => broken),
      (c) => c.json({ ok: true }),
    );
    const res = await app.request('/x', { headers: { cookie: '__Host-sid=anything' } });
    expect(res.status).toBe(503);
  });

  it('fails closed (503) when the account store throws mid-load, not a leaked 500', async () => {
    const cookie = await seedSessionCookie();
    const broken = {
      ...services,
      store: {
        ...services.store,
        async getUser() {
          throw new Error('postgres down');
        },
      },
    };
    const app = new Hono<AuthEnv>().get(
      '/x',
      authMiddleware(() => broken),
      (c) => c.json({ ok: true }),
    );
    const res = await app.request('/x', { headers: { cookie } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unavailable');
  });

  it('still serves a valid request when the best-effort slide refresh throws', async () => {
    // A store write blip on the throttled touchSession must NOT 500 an
    // already-validated request.  Age the session past the slide throttle so
    // touchSession reaches the failing put().
    const cookie = await seedSessionCookie({ sessionAge: 10 * 60_000 });
    // Delegate to the REAL store (a class with private fields — a spread would drop
    // its methods and make validateSession itself throw), overriding only `put` so
    // ONLY the throttled slide write fails.
    const brokenSessions = new Proxy(services.sessions, {
      get(target, prop, receiver) {
        if (prop === 'put') {
          return async () => {
            throw new Error('redis write blip');
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const brokenTouch = { ...services, sessions: brokenSessions };
    const app = new Hono<AuthEnv>().get(
      '/x',
      authMiddleware(() => brokenTouch),
      (c) => c.json({ ok: true }),
    );
    const res = await app.request('/x', { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});

describe('requireAdult (fails closed on teen/unknown)', () => {
  it('allows adults, blocks teens and unknown-age', async () => {
    expect(
      (
        await guardedApp().request('/adult', {
          headers: { cookie: await seedSessionCookie({ ageBand: 'adult' }) },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await guardedApp().request('/adult', {
          headers: { cookie: await seedSessionCookie({ ageBand: 'teen_16_17' }) },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await guardedApp().request('/adult', {
          headers: { cookie: await seedSessionCookie({ ageBand: null }) },
        })
      ).status,
    ).toBe(403);
  });
});

describe('requireSteward (role + MFA-verified session)', () => {
  it('requires a steward role AND a session that has cleared TOTP', async () => {
    // Non-steward → 403.
    expect(
      (
        await guardedApp().request('/steward', {
          headers: { cookie: await seedSessionCookie({ roles: ['user'] }) },
        })
      ).status,
    ).toBe(403);
    // Steward with no MFA enrolled → 403.
    expect(
      (
        await guardedApp().request('/steward', {
          headers: { cookie: await seedSessionCookie({ roles: ['steward'], mfa: false }) },
        })
      ).status,
    ).toBe(403);
    // Steward with MFA enrolled but session NOT yet MFA-verified → 403 (reduced assurance).
    expect(
      (
        await guardedApp().request('/steward', {
          headers: {
            cookie: await seedSessionCookie({ roles: ['steward'], mfa: true, mfaVerified: false }),
          },
        })
      ).status,
    ).toBe(403);
    // Steward with MFA enrolled AND a MFA-verified session → 200.
    expect(
      (
        await guardedApp().request('/steward', {
          headers: {
            cookie: await seedSessionCookie({ roles: ['steward'], mfa: true, mfaVerified: true }),
          },
        })
      ).status,
    ).toBe(200);
  });
});

describe('requireVerifiedAccount', () => {
  it('allows a credentialed account and blocks an unverified email-only one', async () => {
    expect(
      (
        await guardedApp().request('/verified', {
          headers: { cookie: await seedSessionCookie({ verified: true }) },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await guardedApp().request('/verified', {
          headers: { cookie: await seedSessionCookie({ verified: false }) },
        })
      ).status,
    ).toBe(403);
  });
});

describe('restricted account state (WS-J restrict sanction)', () => {
  it('authMiddleware ALLOWS a restricted account to authenticate + read', async () => {
    const res = await guardedApp().request('/open', {
      headers: { cookie: await seedSessionCookie({ accountState: 'restricted' }) },
    });
    expect(res.status).toBe(200); // read + self-service permitted
  });

  it('authMiddleware still DENIES a suspended account', async () => {
    const res = await guardedApp().request('/open', {
      headers: { cookie: await seedSessionCookie({ accountState: 'suspended' }) },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'account_suspended',
    );
  });

  it('requireUnrestricted blocks a restricted account from posting, allows an active one', async () => {
    const restricted = await guardedApp().request('/unrestricted', {
      headers: { cookie: await seedSessionCookie({ accountState: 'restricted' }) },
    });
    expect(restricted.status).toBe(403);
    expect(((await restricted.json()) as { error: { code: string } }).error.code).toBe(
      'account_restricted',
    );
    const active = await guardedApp().request('/unrestricted', {
      headers: { cookie: await seedSessionCookie() },
    });
    expect(active.status).toBe(200);
  });
});

describe('requireStepUp', () => {
  it('passes a fresh session and demands step-up for a stale one', async () => {
    expect(
      (
        await guardedApp().request('/stepup', {
          headers: { cookie: await seedSessionCookie({ sessionAge: 0 }) },
        })
      ).status,
    ).toBe(200);
    const staleRes = await guardedApp().request('/stepup', {
      headers: { cookie: await seedSessionCookie({ sessionAge: 10 * 60_000 }) },
    });
    expect(staleRes.status).toBe(401);
  });
});
