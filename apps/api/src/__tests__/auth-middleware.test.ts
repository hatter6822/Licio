// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgeBand } from '@licio/shared';
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
} from '@licio/shared';
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
  type AuthEnv,
  assuranceStale,
  authMiddleware,
  requireAdult,
  requireStepUp,
  requireSteward,
  requireVerifiedAccount,
} from '../middleware/auth.js';

const CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
};

let services: IdentityServices;

beforeEach(() => {
  services = createInMemoryIdentityServices(CONFIG);
});

interface SeedOpts {
  ageBand?: AgeBand | null;
  roles?: Role[];
  mfa?: boolean;
  verified?: boolean;
  sessionAge?: number; // ms ago the session was created (for step-up staleness)
}

async function seedSessionCookie(opts: SeedOpts = {}): Promise<string> {
  const user = services.store.createUser({
    handle: 'guarduser',
    displayName: 'Guard',
    email: opts.verified === false ? 'g@example.com' : null,
    accountState: 'active',
    locale: null,
    ageBand: opts.ageBand === undefined ? 'adult' : opts.ageBand,
    privacySettings: defaultPrivacySettings(),
    personalizationSettings: defaultPersonalizationSettings(),
    reputationSummary: emptyReputationSummary(),
    roles: opts.roles ?? ['user'],
  });
  // A "verified" account needs a credential; simulate a passkey unless verified===false.
  if (opts.verified !== false) {
    services.store.addWebauthn({
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
  if (opts.mfa) services.store.setAuth(user.userId, { mfaEnabled: true });
  const created = await createSession(
    services.sessions,
    {
      userId: user.userId,
      authMethod: 'webauthn',
      credentialRef: 'cred-guard',
      ipHash: 'h',
      userAgent: 'test',
      deviceLabel: 'test',
      country: null,
      rememberMe: false,
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
    .get('/stepup', authMiddleware(resolve), requireStepUp(), (c) => c.json({ ok: true }));
}

describe('assuranceStale', () => {
  it('is false within the window and true beyond it', () => {
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

describe('requireSteward (role + active MFA)', () => {
  it('requires both a steward role and active MFA', async () => {
    expect(
      (
        await guardedApp().request('/steward', {
          headers: { cookie: await seedSessionCookie({ roles: ['user'] }) },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await guardedApp().request('/steward', {
          headers: { cookie: await seedSessionCookie({ roles: ['steward'], mfa: false }) },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await guardedApp().request('/steward', {
          headers: { cookie: await seedSessionCookie({ roles: ['steward'], mfa: true }) },
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
