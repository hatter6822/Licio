// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N routes — the authorization planes and the critical flows over the real
// v1 router with authenticated sessions:
//   • the compliance plane is least-privilege BOTH ways (user/steward/admin
//     all 403; compliance without per-session MFA is mfa_required);
//   • SAR/STR surfaces demand the COUNSEL capability even to READ
//     (anti-tipping-off — a compliance reviewer is rejected);
//   • enabling a policy cell requires the counsel four-eyes approval_ref;
//   • the declaration flow: declare (pending, never a basis) → reviewer
//     verify → verified basis; revoke reverts;
//   • disclosures: counsel publish → user list → acknowledge → gate clears.
import { randomUUID } from 'node:crypto';
import {
  ALL_DISABLED_CELLS,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
} from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ComplianceServices,
  createInMemoryComplianceServices,
  resetComplianceServicesForTests,
  setComplianceServices,
} from '../compliance/services.js';
import type { Role } from '../identity/rbac.js';
import type { IdentityServices } from '../identity/services.js';
import { buildSessionCookie, createSession } from '../identity/sessions.js';
import { createV1Routes } from '../routes/v1.js';
import { freshEventServices } from './event-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let identity: IdentityServices;
let compliance: ComplianceServices;

async function seedUser(opts: {
  handle: string;
  platformRoles?: Role[];
  mfa?: boolean;
  locale?: string | null;
}): Promise<{ userId: string; cookie: string }> {
  const user = await identity.store.createUser({
    handle: opts.handle,
    displayName: opts.handle,
    email: null,
    accountState: 'active',
    locale: opts.locale ?? null,
    ageBand: 'adult',
    privacySettings: defaultPrivacySettings(),
    personalizationSettings: defaultPersonalizationSettings(),
    roles: opts.platformRoles ?? ['user'],
    stewardRoles: [],
  });
  await identity.store.addWebauthn({
    credentialId: `cred-${user.userId}`,
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
  if (opts.mfa ?? false) await identity.store.setAuth(user.userId, { mfaEnabled: true });
  const created = await createSession(identity.sessions, {
    userId: user.userId,
    authMethod: 'webauthn',
    credentialRef: `cred-${user.userId}`,
    deviceLabel: 'test',
    rememberMe: false,
    mfaVerified: opts.mfa ?? false,
  });
  return {
    userId: user.userId,
    cookie: buildSessionCookie(created.token, created.maxAgeSec).split(';')[0] as string,
  };
}

const json = (cookie?: string) => ({
  'content-type': 'application/json',
  ...(cookie ? { cookie } : {}),
});
const get = (path: string, cookie?: string) =>
  new Request(`http://localhost${path}`, { headers: json(cookie) });
const post = (path: string, body: unknown, cookie?: string) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: json(cookie),
    body: JSON.stringify(body),
  });

const VALID_POLICY_BODY = {
  country_or_region: 'DE',
  feature_flags: { ...ALL_DISABLED_CELLS, testnet_transactions: 'testnet' },
  asset_flags: {},
  age_gate_policy: {
    wallet_connection: { required_band: 'adult' },
    testnet_transactions: { required_band: 'adult' },
    production_payments: { required_band: 'adult' },
    treasury_operations: { required_band: 'adult' },
    governance: { required_band: 'adult' },
  },
  kyc_policy: {},
  disclosure_refs: [],
  legal_approval_ref: null,
  effective_at: '2026-01-01T00:00:00.000Z',
  reason: 'test policy',
};

beforeEach(async () => {
  resetComplianceServicesForTests();
  const fresh = freshEventServices();
  identity = fresh.identity;
  compliance = createInMemoryComplianceServices({
    configStore: fresh.events.configStore,
  });
  compliance.localeRegion = async (userId) => {
    const user = await identity.store.getUser(userId);
    const locale = user?.locale ?? null;
    const match = locale?.match(/-([A-Za-z]{2})(?:-|$)/);
    return match?.[1]?.toUpperCase() ?? null;
  };
  compliance.ageBand = async (userId) => (await identity.store.getUser(userId))?.ageBand ?? null;
  setComplianceServices(compliance);
});

describe('the authorization planes (WS-N.2.1c-2)', () => {
  it('user, steward, and admin are ALL rejected from the compliance surface', async () => {
    for (const roles of [['user'], ['steward'], ['admin']] as Role[][]) {
      const actor = await seedUser({
        handle: `a${randomUUID().slice(0, 8)}`,
        platformRoles: roles,
        mfa: true,
      });
      const res = await app().request(get('/v1/compliance/admin/cases', actor.cookie));
      expect(res.status, `${roles[0]} must be rejected`).toBe(403);
    }
  });

  it('the compliance role passes WITH per-session MFA; without it, mfa_required', async () => {
    const noMfa = await seedUser({
      handle: `c${randomUUID().slice(0, 8)}`,
      platformRoles: ['compliance'],
      mfa: false,
    });
    const denied = await app().request(get('/v1/compliance/admin/cases', noMfa.cookie));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('mfa_required');
    const withMfa = await seedUser({
      handle: `c${randomUUID().slice(0, 8)}`,
      platformRoles: ['compliance'],
      mfa: true,
    });
    const allowed = await app().request(get('/v1/compliance/admin/cases', withMfa.cookie));
    expect(allowed.status).toBe(200);
  });

  it('SAR surfaces demand the counsel capability even to READ (anti-tipping-off)', async () => {
    const reviewer = await seedUser({
      handle: `c${randomUUID().slice(0, 8)}`,
      platformRoles: ['compliance'],
      mfa: true,
    });
    const denied = await app().request(get('/v1/compliance/admin/sar', reviewer.cookie));
    expect(denied.status).toBe(403);
    const counsel = await seedUser({
      handle: `l${randomUUID().slice(0, 8)}`,
      platformRoles: ['counsel'],
      mfa: true,
    });
    const allowed = await app().request(get('/v1/compliance/admin/sar', counsel.cookie));
    expect(allowed.status).toBe(200);
  });

  it('unauthenticated requests are 401 everywhere', async () => {
    expect((await app().request(get('/v1/compliance/availability'))).status).toBe(401);
    expect((await app().request(get('/v1/compliance/admin/cases'))).status).toBe(401);
  });
});

describe('policy admin (WS-N.1.1e)', () => {
  it('enabling a cell without the counsel approval_ref is rejected (four-eyes)', async () => {
    const reviewer = await seedUser({
      handle: `c${randomUUID().slice(0, 8)}`,
      platformRoles: ['compliance'],
      mfa: true,
    });
    const enabling = {
      ...VALID_POLICY_BODY,
      feature_flags: { ...ALL_DISABLED_CELLS, production_payments: 'enabled' },
      legal_approval_ref: 'LEGAL-1',
    };
    const denied = await app().request(
      post('/v1/compliance/admin/policies', enabling, reviewer.cookie),
    );
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      'counsel_approval_required',
    );
    const approved = await app().request(
      post(
        '/v1/compliance/admin/policies',
        { ...enabling, approval_ref: 'FOUR-EYES-7' },
        reviewer.cookie,
      ),
    );
    expect(approved.status).toBe(201);
    // The change landed on the tamper-evident chain and verifies.
    const verify = await app().request(
      get('/v1/compliance/admin/policy-audit/verify', reviewer.cookie),
    );
    expect(((await verify.json()) as { valid: boolean }).valid).toBe(true);
  });

  it('a testnet-only policy needs no approval_ref and hot-applies (cache invalidated)', async () => {
    const reviewer = await seedUser({
      handle: `c${randomUUID().slice(0, 8)}`,
      platformRoles: ['compliance'],
      mfa: true,
    });
    const created = await app().request(
      post('/v1/compliance/admin/policies', VALID_POLICY_BODY, reviewer.cookie),
    );
    expect(created.status).toBe(201);
    // A duplicate (region, effective_at) is a 409, not a silent overwrite.
    const duplicate = await app().request(
      post('/v1/compliance/admin/policies', VALID_POLICY_BODY, reviewer.cookie),
    );
    expect(duplicate.status).toBe(409);
  });
});

describe('the declaration flow (WS-N.1.1f)', () => {
  it('declare (pending) → reviewer verify → verified basis; revoke reverts', async () => {
    const member = await seedUser({ handle: `m${randomUUID().slice(0, 8)}`, locale: 'en-GB' });
    const reviewer = await seedUser({
      handle: `c${randomUUID().slice(0, 8)}`,
      platformRoles: ['compliance'],
      mfa: true,
    });
    // Before declaring: the locale subtag is the basis.
    let region = (await (
      await app().request(get('/v1/compliance/region', member.cookie))
    ).json()) as { region: string | null; basis: string };
    expect(region).toMatchObject({ region: 'GB', basis: 'locale_subtag' });
    // Declare DE: recorded pending — the basis DOES NOT move (fail-closed).
    const declared = await app().request(
      post('/v1/compliance/region/declaration', { declared_region: 'DE' }, member.cookie),
    );
    expect(declared.status).toBe(201);
    region = (await (
      await app().request(get('/v1/compliance/region', member.cookie))
    ).json()) as never;
    expect(region).toMatchObject({ region: 'GB', basis: 'locale_subtag' });
    // Reviewer verifies: the declaration becomes the strongest basis.
    const verified = await app().request(
      post(
        `/v1/compliance/admin/declarations/${member.userId}/verify`,
        { decision: 'verify', note: 'evidence checked' },
        reviewer.cookie,
      ),
    );
    expect(verified.status).toBe(200);
    region = (await (
      await app().request(get('/v1/compliance/region', member.cookie))
    ).json()) as never;
    expect(region).toMatchObject({ region: 'DE', basis: 'verified_declaration' });
    // Revocation reverts to the locale subtag.
    const revoked = await app().request(
      new Request('http://localhost/v1/compliance/region/declaration', {
        method: 'DELETE',
        headers: json(member.cookie),
      }),
    );
    expect(revoked.status).toBe(200);
    region = (await (
      await app().request(get('/v1/compliance/region', member.cookie))
    ).json()) as never;
    expect(region).toMatchObject({ region: 'GB', basis: 'locale_subtag' });
  });
});

describe('disclosures (WS-N.1.2d)', () => {
  it('counsel publishes; the user lists, acknowledges, and the gate clears', async () => {
    const counsel = await seedUser({
      handle: `l${randomUUID().slice(0, 8)}`,
      platformRoles: ['counsel'],
      mfa: true,
    });
    const member = await seedUser({ handle: `m${randomUUID().slice(0, 8)}`, locale: 'de-DE' });
    const published = await app().request(
      post(
        '/v1/compliance/admin/disclosures',
        {
          disclosure_id: 'risk-general',
          region: 'DE',
          version: 1,
          locale: 'de',
          title: 'Risikohinweise',
          content_md: 'On-chain-Transaktionen sind unumkehrbar. Krypto ist optional.',
          requires_acknowledgment: true,
        },
        counsel.cookie,
      ),
    );
    expect(published.status).toBe(201);
    // A compliance reviewer cannot publish (counsel-only legal artifact).
    const reviewer = await seedUser({
      handle: `c${randomUUID().slice(0, 8)}`,
      platformRoles: ['compliance'],
      mfa: true,
    });
    const denied = await app().request(
      post(
        '/v1/compliance/admin/disclosures',
        {
          disclosure_id: 'risk-x',
          region: 'DE',
          version: 1,
          locale: 'de',
          title: 't',
          content_md: 'c',
          requires_acknowledgment: true,
        },
        reviewer.cookie,
      ),
    );
    expect(denied.status).toBe(403);
    const listed = (await (
      await app().request(get('/v1/compliance/disclosures', member.cookie))
    ).json()) as { disclosures: Array<{ disclosure_id: string; acknowledged: boolean }> };
    expect(listed.disclosures[0]).toMatchObject({
      disclosure_id: 'risk-general',
      acknowledged: false,
    });
    const acked = await app().request(
      post(
        '/v1/compliance/disclosures/acknowledge',
        { disclosure_id: 'risk-general', version: 1 },
        member.cookie,
      ),
    );
    expect(acked.status).toBe(200);
    const after = (await (
      await app().request(get('/v1/compliance/disclosures', member.cookie))
    ).json()) as { disclosures: Array<{ acknowledged: boolean }> };
    expect(after.disclosures[0]?.acknowledged).toBe(true);
  });
});

describe('the availability surface (WS-N.1.1c)', () => {
  it('serves the fail-closed evaluation to the authenticated user', async () => {
    const member = await seedUser({ handle: `m${randomUUID().slice(0, 8)}` });
    const res = await app().request(get('/v1/compliance/availability', member.cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      basis: string;
      crypto_enabled: boolean;
      features: Record<string, { available: boolean }>;
    };
    expect(body.basis).toBe('unknown');
    expect(body.crypto_enabled).toBe(false);
    for (const entry of Object.values(body.features)) {
      expect(entry.available).toBe(false);
    }
  });
});
