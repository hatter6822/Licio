// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N routes — the authorization planes and the critical flows over the real
// v1 router with authenticated sessions:
//   • the compliance plane is least-privilege BOTH ways (user/steward/admin
//     all 403; compliance without per-session MFA is mfa_required);
//   • SAR/STR surfaces demand the COUNSEL capability even to READ
//     (anti-tipping-off — a compliance reviewer is rejected);
//   • enabling a policy cell takes COUNSEL plus the four-eyes approval_ref (a
//     reviewer cannot self-authorize); narrowing writes stay reviewer-open;
//   • a policy write whose audit entry cannot commit is rolled back;
//   • the declaration flow: declare (pending, never a basis) → reviewer
//     verify → verified basis; revoke reverts;
//   • disclosures: counsel publish → user list → acknowledge → gate clears;
//   • the case console's guarded lifecycle, the fraud queue, wallet pins, and
//     runtime config; the counsel SAR + lawful-access workflows.
import { randomUUID } from 'node:crypto';
import {
  ALL_DISABLED_CELLS,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
} from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveCaseInTx, transitionCase } from '../compliance/cases.js';
import {
  buildCaseDeps,
  type ComplianceServices,
  createDedupWindow,
  createInMemoryComplianceServices,
  resetComplianceServicesForTests,
  setComplianceServices,
} from '../compliance/services.js';
import { getEventPipelineServices } from '../events/services.js';
import type { Role } from '../identity/rbac.js';
import type { IdentityServices } from '../identity/services.js';
import { buildSessionCookie, createSession } from '../identity/sessions.js';
import { createV1Routes } from '../routes/v1.js';
import { resetTreasuryServicesForTests, setTreasuryServices } from '../treasury/services.js';
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
const put = (path: string, body: unknown, cookie?: string) =>
  new Request(`http://localhost${path}`, {
    method: 'PUT',
    headers: json(cookie),
    body: JSON.stringify(body),
  });
const del = (path: string, cookie?: string) =>
  new Request(`http://localhost${path}`, { method: 'DELETE', headers: json(cookie) });

/** Seed a counsel-grade operator (counsel ⊇ compliance.review) with MFA. */
const seedCounsel = () =>
  seedUser({ handle: `k${randomUUID().slice(0, 8)}`, platformRoles: ['counsel'], mfa: true });
const seedReviewer = () =>
  seedUser({ handle: `r${randomUUID().slice(0, 8)}`, platformRoles: ['compliance'], mfa: true });

/** Create one case through the console route; returns its id. */
async function createCaseVia(
  cookie: string,
  overrides: Partial<{
    trigger_type: string;
    risk_level: string;
    subject_kind: string;
    user_id_or_room_id: string;
  }> = {},
): Promise<string> {
  const res = await app().request(
    post(
      '/v1/compliance/admin/cases',
      {
        subject_kind: 'user',
        user_id_or_room_id: randomUUID(),
        trigger_type: 'fraud',
        risk_level: 'medium',
        note: 'route-test fixture',
        ...overrides,
      },
      cookie,
    ),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { case: { case_id: string } }).case.case_id;
}

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
  resetTreasuryServicesForTests();
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
  it('enabling a cell takes COUNSEL — a reviewer cannot self-authorize with any ref', async () => {
    const reviewer = await seedUser({
      handle: `c${randomUUID().slice(0, 8)}`,
      platformRoles: ['compliance'],
      mfa: true,
    });
    const counsel = await seedCounsel();
    const enabling = {
      ...VALID_POLICY_BODY,
      feature_flags: { ...ALL_DISABLED_CELLS, production_payments: 'enabled' },
      legal_approval_ref: 'LEGAL-1',
    };
    // A compliance reviewer cannot enable a cell — not even quoting a ref at
    // themselves. Turning real funds on for a region is counsel's call.
    const denied = await app().request(
      post('/v1/compliance/admin/policies', enabling, reviewer.cookie),
    );
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      'counsel_approval_required',
    );
    const invented = await app().request(
      post(
        '/v1/compliance/admin/policies',
        { ...enabling, approval_ref: 'I-APPROVE-MYSELF' },
        reviewer.cookie,
      ),
    );
    expect(invented.status).toBe(403);
    // Counsel still owes the approval reference (which legal approval applies).
    const noRef = await app().request(
      post('/v1/compliance/admin/policies', enabling, counsel.cookie),
    );
    expect(noRef.status).toBe(403);
    expect(((await noRef.json()) as { error: { code: string } }).error.code).toBe(
      'counsel_approval_required',
    );
    const approved = await app().request(
      post(
        '/v1/compliance/admin/policies',
        { ...enabling, approval_ref: 'FOUR-EYES-7' },
        counsel.cookie,
      ),
    );
    expect(approved.status).toBe(201);
    // The change landed on the tamper-evident chain and verifies.
    const verify = await app().request(
      get('/v1/compliance/admin/policy-audit/verify', reviewer.cookie),
    );
    expect(((await verify.json()) as { valid: boolean }).valid).toBe(true);
  });

  it('a NARROWING (non-enabling) write stays open to the compliance role', async () => {
    const reviewer = await seedUser({
      handle: `c${randomUUID().slice(0, 8)}`,
      platformRoles: ['compliance'],
      mfa: true,
    });
    // testnet/simulated/disabled can only reduce availability — no counsel needed.
    const narrowing = await app().request(
      post('/v1/compliance/admin/policies', VALID_POLICY_BODY, reviewer.cookie),
    );
    expect(narrowing.status).toBe(201);
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

describe('a published disclosure always names its publisher (WS-N.1.2d)', () => {
  const body = {
    disclosure_id: 'risk-general',
    region: 'DE',
    version: 1,
    locale: 'de',
    title: 'Risikohinweise',
    content_md: 'On-chain-Transaktionen sind unumkehrbar.',
    requires_acknowledgment: true,
  };

  it('the attribution rides the publish, so a failing audit mirror cannot lose it', async () => {
    const counsel = await seedUser({
      handle: `l${randomUUID().slice(0, 8)}`,
      platformRoles: ['counsel'],
      mfa: true,
    });
    // The identity audit log (a DIFFERENT bounded context — it cannot join the
    // publish's write) is down.
    const original = identity.audit.append.bind(identity.audit);
    identity.audit.append = async () => {
      throw new Error('identity audit down');
    };
    try {
      const published = await app().request(
        post('/v1/compliance/admin/disclosures', body, counsel.cookie),
      );
      // A 500 here would leave an IMMUTABLE published disclosure the client
      // believes failed — and the retry could only ever meet
      // `already_published`, so the attribution could never be added.
      expect(published.status).toBe(201);
    } finally {
      identity.audit.append = original;
    }
    const [stored] = await compliance.disclosures.listForRegion('DE');
    expect(stored?.publishedByRef).toBe(compliance.opaqueRef(counsel.userId));
  });
});

describe('a store fault is never reported as `already_published` (WS-N.1.2d)', () => {
  it('503s a broken publish, and 409s only the real duplicate', async () => {
    const counsel = await seedCounsel();
    const body = {
      disclosure_id: 'risk-general',
      region: 'DE',
      version: 1,
      locale: 'de',
      title: 'Risikohinweise',
      content_md: 'On-chain-Transaktionen sind unumkehrbar.',
      requires_acknowledgment: true,
    };
    const original = compliance.disclosures.publish.bind(compliance.disclosures);
    compliance.disclosures.publish = async () => {
      throw new Error('disclosure store down');
    };
    let broken: Response;
    try {
      broken = await app().request(post('/v1/compliance/admin/disclosures', body, counsel.cookie));
    } finally {
      compliance.disclosures.publish = original;
    }
    // Telling counsel the immutable version already exists would stop them
    // retrying — and the required risk disclosure would stay absent while every
    // surface that demands it fails closed.
    expect(broken.status).toBe(503);
    expect(((await broken.json()) as { error: { code: string } }).error.code).toBe('unavailable');

    // The real publish succeeds, and only the true duplicate is a 409.
    expect(
      (await app().request(post('/v1/compliance/admin/disclosures', body, counsel.cookie))).status,
    ).toBe(201);
    const dup = await app().request(post('/v1/compliance/admin/disclosures', body, counsel.cookie));
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe(
      'already_published',
    );
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

describe('the case console (WS-N.2.1b/c)', () => {
  it('walks the guarded lifecycle: create → assign → begin → note → resolve → reopen → escalate', async () => {
    const reviewer = await seedReviewer();
    const counsel = await seedCounsel();
    const caseId = await createCaseVia(reviewer.cookie);

    // The default list surfaces the open case; the state filter narrows it.
    const listed = (await (
      await app().request(get('/v1/compliance/admin/cases', reviewer.cookie))
    ).json()) as { cases: Array<{ case_id: string; review_state: string }> };
    expect(listed.cases.some((c) => c.case_id === caseId)).toBe(true);
    const filtered = (await (
      await app().request(get('/v1/compliance/admin/cases?state=resolved', reviewer.cookie))
    ).json()) as { cases: Array<{ case_id: string }> };
    expect(filtered.cases.some((c) => c.case_id === caseId)).toBe(false);

    // Assignment demands a compliance-capable assignee.
    const plain = await seedUser({ handle: `p${randomUUID().slice(0, 8)}` });
    const badAssign = await app().request(
      post(
        `/v1/compliance/admin/cases/${caseId}/assign`,
        { assignee_user_id: plain.userId },
        reviewer.cookie,
      ),
    );
    expect(badAssign.status).toBe(400);
    expect(((await badAssign.json()) as { error: { code: string } }).error.code).toBe(
      'assignee_not_reviewer',
    );
    const assigned = await app().request(
      post(
        `/v1/compliance/admin/cases/${caseId}/assign`,
        { assignee_user_id: reviewer.userId },
        reviewer.cookie,
      ),
    );
    expect(assigned.status).toBe(200);

    const begun = await app().request(
      post(`/v1/compliance/admin/cases/${caseId}/begin`, {}, reviewer.cookie),
    );
    expect(begun.status).toBe(200);
    const noted = await app().request(
      post(
        `/v1/compliance/admin/cases/${caseId}/note`,
        { note: 'checked the ledger' },
        reviewer.cookie,
      ),
    );
    expect(noted.status).toBe(200);
    const resolved = await app().request(
      post(
        `/v1/compliance/admin/cases/${caseId}/resolve`,
        { outcome: 'cleared', notes: 'no pattern found' },
        reviewer.cookie,
      ),
    );
    expect(resolved.status).toBe(200);

    // resolved → investigating is reason-guarded (the route always sends one).
    const reopened = await app().request(
      post(
        `/v1/compliance/admin/cases/${caseId}/reopen`,
        { reason: 'new evidence' },
        reviewer.cookie,
      ),
    );
    expect(reopened.status).toBe(200);
    const escalated = await app().request(
      post(
        `/v1/compliance/admin/cases/${caseId}/escalate`,
        { reason: 'cross-border' },
        reviewer.cookie,
      ),
    );
    expect(escalated.status).toBe(200);

    // escalated → resolved is SENIOR-guarded: the reviewer is rejected, counsel passes.
    const juniorResolve = await app().request(
      post(
        `/v1/compliance/admin/cases/${caseId}/resolve`,
        { outcome: 'cleared', notes: 'done' },
        reviewer.cookie,
      ),
    );
    expect(juniorResolve.status).toBe(403);
    const seniorResolve = await app().request(
      post(
        `/v1/compliance/admin/cases/${caseId}/resolve`,
        { outcome: 'cleared', notes: 'counsel sign-off' },
        counsel.cookie,
      ),
    );
    expect(seniorResolve.status).toBe(200);

    // The detail read carries the full hash-chained audit trail.
    const detail = (await (
      await app().request(get(`/v1/compliance/admin/cases/${caseId}`, reviewer.cookie))
    ).json()) as { case: { review_state: string }; audit: Array<{ action: string }> };
    expect(detail.case.review_state).toBe('resolved');
    expect(detail.audit.map((a) => a.action)).toContain('created');
    expect(detail.audit.map((a) => a.action)).toContain('note');
  });

  it('open → escalated is critical-only; an unknown case is 404', async () => {
    const reviewer = await seedReviewer();
    const mediumCase = await createCaseVia(reviewer.cookie, { risk_level: 'medium' });
    const blocked = await app().request(
      post(`/v1/compliance/admin/cases/${mediumCase}/escalate`, { reason: 'try' }, reviewer.cookie),
    );
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_CASE_TRANSITION',
    );
    const criticalCase = await createCaseVia(reviewer.cookie, { risk_level: 'critical' });
    const allowed = await app().request(
      post(
        `/v1/compliance/admin/cases/${criticalCase}/escalate`,
        { reason: 'go' },
        reviewer.cookie,
      ),
    );
    expect(allowed.status).toBe(200);
    const missing = await app().request(
      post(`/v1/compliance/admin/cases/${randomUUID()}/begin`, {}, reviewer.cookie),
    );
    expect(missing.status).toBe(404);
  });

  it('the policy-audit chain verifies and a forced refresh invalidates the cache', async () => {
    const counsel = await seedCounsel();
    const created = await app().request(
      post('/v1/compliance/admin/policies', VALID_POLICY_BODY, counsel.cookie),
    );
    expect(created.status).toBe(201);
    const verification = (await (
      await app().request(get('/v1/compliance/admin/policy-audit/verify', counsel.cookie))
    ).json()) as { valid: boolean; chainedEntries: number };
    expect(verification.valid).toBe(true);
    expect(verification.chainedEntries).toBeGreaterThanOrEqual(1);
    const refreshed = await app().request(
      post('/v1/compliance/admin/policies/refresh', {}, counsel.cookie),
    );
    expect(((await refreshed.json()) as { refreshed: boolean }).refreshed).toBe(true);
  });

  it('declaration verification rejects the absent and honors the reject decision', async () => {
    const reviewer = await seedReviewer();
    const member = await seedUser({ handle: `m${randomUUID().slice(0, 8)}` });
    const absent = await app().request(
      post(
        `/v1/compliance/admin/declarations/${member.userId}/verify`,
        { decision: 'verify', note: 'no declaration exists' },
        reviewer.cookie,
      ),
    );
    expect(absent.status).toBe(404);
    const declared = await app().request(
      post('/v1/compliance/region/declaration', { declared_region: 'DE' }, member.cookie),
    );
    expect(declared.status).toBe(201);
    const rejected = await app().request(
      post(
        `/v1/compliance/admin/declarations/${member.userId}/verify`,
        { decision: 'reject', note: 'evidence insufficient' },
        reviewer.cookie,
      ),
    );
    expect(rejected.status).toBe(200);
    const body = (await rejected.json()) as {
      declaration: { status: string; verification_level: string };
    };
    expect(body.declaration.status).toBe('pending');
    expect(body.declaration.verification_level).toBe('unverified');
  });

  it('a decision on an already-verified declaration is refused — no silent un-verify (thread-L)', async () => {
    const reviewer = await seedReviewer();
    const member = await seedUser({ handle: `m${randomUUID().slice(0, 8)}` });
    await app().request(
      post('/v1/compliance/region/declaration', { declared_region: 'DE' }, member.cookie),
    );
    const verified = await app().request(
      post(
        `/v1/compliance/admin/declarations/${member.userId}/verify`,
        { decision: 'verify', note: 'passport checked' },
        reviewer.cookie,
      ),
    );
    expect(verified.status).toBe(200);
    // A stale reviewer form or a duplicate queue action on the now-verified row —
    // verify OR reject — is refused with 409, BEFORE any write, so it can never
    // set the verified declaration back to pending and disable real-fund region
    // resolution behind the member's back.
    for (const decision of ['reject', 'verify'] as const) {
      const stale = await app().request(
        post(
          `/v1/compliance/admin/declarations/${member.userId}/verify`,
          { decision, note: 'stale form' },
          reviewer.cookie,
        ),
      );
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
        'declaration_not_pending',
      );
    }
  });
});

describe('the fraud queue + wallet pins + runtime config', () => {
  it('the queue lists fraud-class cases with SLA due times; intent review 404s without treasury', async () => {
    const reviewer = await seedReviewer();
    await createCaseVia(reviewer.cookie, { trigger_type: 'velocity' });
    await createCaseVia(reviewer.cookie, { trigger_type: 'manual' }); // NOT fraud-class
    const queue = (await (
      await app().request(get('/v1/compliance/admin/fraud-queue', reviewer.cookie))
    ).json()) as { items: Array<{ case: { trigger_type: string }; sla_due_at: string }> };
    expect(queue.items.length).toBe(1);
    expect(queue.items[0]?.case.trigger_type).toBe('velocity');
    expect(Date.parse(queue.items[0]?.sla_due_at ?? '')).toBeGreaterThan(0);
    // With no treasury wired the release/reject surfaces answer 404.
    const release = await app().request(
      post(
        '/v1/compliance/admin/fraud-queue/release',
        { payment_intent_id: randomUUID(), reason: 'ok' },
        reviewer.cookie,
      ),
    );
    expect(release.status).toBe(404);
    const reject = await app().request(
      post(
        '/v1/compliance/admin/fraud-queue/reject',
        { payment_intent_id: randomUUID(), reason: 'no' },
        reviewer.cookie,
      ),
    );
    expect(reject.status).toBe(404);
  });

  it('pins a wallet (201), releases it once, and 404s a double release', async () => {
    const reviewer = await seedReviewer();
    const walletId = randomUUID();
    const pinned = await app().request(
      post(
        `/v1/compliance/admin/wallets/${walletId}/pin`,
        { reason: 'suspected compromise' },
        reviewer.cookie,
      ),
    );
    expect(pinned.status).toBe(201);
    const released = await app().request(
      del(`/v1/compliance/admin/wallets/${walletId}/pin`, reviewer.cookie),
    );
    expect(released.status).toBe(200);
    const again = await app().request(
      del(`/v1/compliance/admin/wallets/${walletId}/pin`, reviewer.cookie),
    );
    expect(again.status).toBe(404);
  });

  it('config PUT validates, applies, and pushes retention overrides to the events job', async () => {
    const reviewer = await seedReviewer();
    const counsel = await seedCounsel();
    const bad = await app().request(
      put('/v1/compliance/admin/config/retentionSweepIntervalMs', { value: -5 }, reviewer.cookie),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_config_value',
    );
    const ok = await app().request(
      put(
        '/v1/compliance/admin/config/retentionSweepIntervalMs',
        { value: 3_600_000 },
        reviewer.cookie,
      ),
    );
    expect(ok.status).toBe(200);
    expect(compliance.config().retentionSweepIntervalMs).toBe(3_600_000);
    // The retention SCHEDULE is counsel-approved: a reviewer may tune the
    // operational knobs above but cannot rewrite how long records are kept.
    const byReviewer = await app().request(
      put(
        '/v1/compliance/admin/config/eventRetentionOverrides',
        { value: { sensitive: 30 } },
        reviewer.cookie,
      ),
    );
    expect(byReviewer.status).toBe(403);
    expect(((await byReviewer.json()) as { error: { code: string } }).error.code).toBe(
      'counsel_approval_required',
    );
    const overrides = await app().request(
      put(
        '/v1/compliance/admin/config/eventRetentionOverrides',
        { value: { sensitive: 30 } },
        counsel.cookie,
      ),
    );
    expect(overrides.status).toBe(200);
    expect(getEventPipelineServices().retention.overrides).toEqual({ maxDays: { sensitive: 30 } });
  });
});

describe('SAR/STR (WS-N.2.1e) + lawful access (WS-N.2.3d)', () => {
  it('draft applies a NEUTRAL legal hold; approve → file is order-enforced', async () => {
    const counsel = await seedCounsel();
    const caseId = await createCaseVia(counsel.cookie, { trigger_type: 'sanctions' });
    const drafted = await app().request(
      post(
        `/v1/compliance/admin/cases/${caseId}/sar`,
        { jurisdiction: 'DE', narrative: 'Counsel narrative for the regulator.' },
        counsel.cookie,
      ),
    );
    expect(drafted.status).toBe(201);
    const sarId = ((await drafted.json()) as { report: { sar_id: string } }).report.sar_id;

    // Anti-tipping-off: the case trail shows only the neutral hold entry —
    // no SAR wording anywhere a compliance reviewer can read.
    const detail = (await (
      await app().request(get(`/v1/compliance/admin/cases/${caseId}`, counsel.cookie))
    ).json()) as { audit: Array<{ action: string; note: string | null }> };
    expect(detail.audit.map((a) => a.action)).toContain('legal_hold_applied');
    expect(JSON.stringify(detail.audit).toLowerCase()).not.toContain('sar');

    // Filing before approval is rejected; the order is draft → approved → filed.
    const early = await app().request(
      post(
        `/v1/compliance/admin/sar/${sarId}/file`,
        { filing_ref: 'FIU-1', partner_filed: false },
        counsel.cookie,
      ),
    );
    expect(early.status).toBe(409);
    const approved = await app().request(
      post(`/v1/compliance/admin/sar/${sarId}/approve`, {}, counsel.cookie),
    );
    expect(approved.status).toBe(200);
    const reApproved = await app().request(
      post(`/v1/compliance/admin/sar/${sarId}/approve`, {}, counsel.cookie),
    );
    expect(reApproved.status).toBe(409);
    const filed = await app().request(
      post(
        `/v1/compliance/admin/sar/${sarId}/file`,
        { filing_ref: 'FIU-2026-042', partner_filed: true },
        counsel.cookie,
      ),
    );
    expect(filed.status).toBe(200);
    const listed = (await (
      await app().request(get('/v1/compliance/admin/sar', counsel.cookie))
    ).json()) as { reports: Array<{ sar_id: string; status: string; filing_ref: string | null }> };
    expect(listed.reports).toHaveLength(1);
    expect(listed.reports[0]).toMatchObject({ sar_id: sarId, status: 'filed' });
    // An unknown SAR is 404 on both verbs.
    const missing = await app().request(
      post(`/v1/compliance/admin/sar/${randomUUID()}/approve`, {}, counsel.cookie),
    );
    expect(missing.status).toBe(404);
  });

  it('lawful access: intake opens a held case; production demands the approved review', async () => {
    const counsel = await seedCounsel();
    const subject = await seedUser({ handle: `s${randomUUID().slice(0, 8)}` });
    const intake = await app().request(
      post(
        '/v1/compliance/admin/lawful-access',
        {
          agency: 'District Court',
          jurisdiction: 'DE',
          legal_basis: 'court_order',
          scope: {
            subject_kind: 'user',
            subject_ref: subject.userId,
            time_range_start: null,
            time_range_end: null,
          },
          contact: 'court@example.test',
        },
        counsel.cookie,
      ),
    );
    expect(intake.status).toBe(201);
    const request = (
      (await intake.json()) as {
        request: { request_id: string; status: string; case_id: string | null };
      }
    ).request;
    expect(request.status).toBe('received');
    expect(request.case_id).not.toBeNull();
    // The linked case is under legal hold from intake.
    const linked = await compliance.cases.getById(request.case_id as string);
    expect(linked?.retentionPolicy.legal_hold).toBe(true);

    // Production before review is rejected (mandatory legal sign-off).
    const premature = await app().request(
      post(
        `/v1/compliance/admin/lawful-access/${request.request_id}/produce`,
        { production_summary: 'account identity records', user_notified: false },
        counsel.cookie,
      ),
    );
    expect(premature.status).toBe(409);
    expect(((await premature.json()) as { error: { code: string } }).error.code).toBe(
      'legal_review_required',
    );

    const reviewed = await app().request(
      post(
        `/v1/compliance/admin/lawful-access/${request.request_id}/review`,
        { decision: 'approved', note: 'valid order, scope is narrow' },
        counsel.cookie,
      ),
    );
    expect(reviewed.status).toBe(200);
    const reReviewed = await app().request(
      post(
        `/v1/compliance/admin/lawful-access/${request.request_id}/review`,
        { decision: 'denied', note: 'flip-flop' },
        counsel.cookie,
      ),
    );
    expect(reReviewed.status).toBe(409);

    const produced = await app().request(
      post(
        `/v1/compliance/admin/lawful-access/${request.request_id}/produce`,
        { production_summary: 'account identity records', user_notified: true },
        counsel.cookie,
      ),
    );
    expect(produced.status).toBe(200);
    const body = (await produced.json()) as {
      request: { status: string; production_summary: string; user_notified_at: string | null };
    };
    expect(body.request.status).toBe('produced');
    expect(body.request.user_notified_at).not.toBeNull();
    const all = (await (
      await app().request(get('/v1/compliance/admin/lawful-access', counsel.cookie))
    ).json()) as { requests: Array<{ status: string }> };
    expect(all.requests).toHaveLength(1);
  });

  it('a private-P2P room production is FORCED to carry the honest §8/§11.4 determination', async () => {
    const counsel = await seedCounsel();
    compliance.roomStorageMode = async () => 'p2p';
    const intake = await app().request(
      post(
        '/v1/compliance/admin/lawful-access',
        {
          agency: 'Agency',
          jurisdiction: 'US',
          legal_basis: 'warrant',
          scope: {
            subject_kind: 'room',
            subject_ref: randomUUID(),
            time_range_start: null,
            time_range_end: null,
          },
          contact: 'agent@example.test',
        },
        counsel.cookie,
      ),
    );
    const request = ((await intake.json()) as { request: { request_id: string } }).request;
    await app().request(
      post(
        `/v1/compliance/admin/lawful-access/${request.request_id}/review`,
        { decision: 'approved', note: 'valid warrant' },
        counsel.cookie,
      ),
    );
    const produced = (await (
      await app().request(
        post(
          `/v1/compliance/admin/lawful-access/${request.request_id}/produce`,
          { production_summary: 'directory stub metadata only', user_notified: false },
          counsel.cookie,
        ),
      )
    ).json()) as { request: { production_summary: string } };
    expect(produced.request.production_summary).toContain('HONEST CAPABILITY BOUNDARY');
    expect(produced.request.production_summary).toContain('directory stub metadata only');
  });

  it('an UNKNOWN room class blocks the production rather than omitting the determination', async () => {
    const counsel = await seedCounsel();
    // The forum store is transiently down (or the port is unwired).
    compliance.roomStorageMode = async () => {
      throw new Error('forum store down');
    };
    const intake = await app().request(
      post(
        '/v1/compliance/admin/lawful-access',
        {
          agency: 'Agency',
          jurisdiction: 'US',
          legal_basis: 'warrant',
          scope: {
            subject_kind: 'room',
            subject_ref: randomUUID(),
            time_range_start: null,
            time_range_end: null,
          },
          contact: 'agent@example.test',
        },
        counsel.cookie,
      ),
    );
    const request = ((await intake.json()) as { request: { request_id: string } }).request;
    await app().request(
      post(
        `/v1/compliance/admin/lawful-access/${request.request_id}/review`,
        { decision: 'approved', note: 'valid warrant' },
        counsel.cookie,
      ),
    );
    const produced = await app().request(
      post(
        `/v1/compliance/admin/lawful-access/${request.request_id}/produce`,
        { production_summary: 'some records', user_notified: false },
        counsel.cookie,
      ),
    );
    // If the room IS p2p, producing here would record a summary with the
    // no-content/no-keys boundary silently missing — the one sentence the
    // record exists to carry.  Not-reported-as-p2p is not the same as
    // known-to-be-server.
    expect(produced.status).toBe(503);
    expect(((await produced.json()) as { error: { code: string } }).error.code).toBe(
      'room_class_unknown',
    );

    // A confirmed `server` room produces normally (no determination needed).
    compliance.roomStorageMode = async () => 'server';
    const retried = await app().request(
      post(
        `/v1/compliance/admin/lawful-access/${request.request_id}/produce`,
        { production_summary: 'some records', user_notified: false },
        counsel.cookie,
      ),
    );
    expect(retried.status).toBe(200);
    const body = (await retried.json()) as { request: { production_summary: string } };
    expect(body.request.production_summary).toBe('some records');
  });
});

describe('policy write ↔ audit atomicity (WS-N.1.1g)', () => {
  it('an unauditable policy write is ROLLED BACK, so no live policy lacks a chain entry', async () => {
    const counsel = await seedCounsel();
    // The audit store is down (contention exhaustion / outage).
    compliance.policyAudit.appendChained = async () => {
      throw new Error('audit store down');
    };
    const res = await app().request(
      post('/v1/compliance/admin/policies', VALID_POLICY_BODY, counsel.cookie),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'audit_unavailable',
    );
    // The half-written policy is gone: it never became active…
    expect(await compliance.policies.activeForRegion('DE', new Date().toISOString())).toBeNull();
    expect(await compliance.policies.listByRegion('DE')).toHaveLength(0);
    // …so the (region, effective_at) slot is free and the retry succeeds once
    // the audit store recovers (a stuck duplicate would strand the operator).
    compliance = createInMemoryComplianceServices({ configStore: compliance.configStore });
    setComplianceServices(compliance);
    const retry = await app().request(
      post('/v1/compliance/admin/policies', VALID_POLICY_BODY, counsel.cookie),
    );
    expect(retry.status).toBe(201);
    expect(await compliance.policies.listByRegion('DE')).toHaveLength(1);
    expect(await compliance.policyAudit.listChained()).toHaveLength(1);
  });
});

describe('the fraud queue attaches the RIGHT case to a held intent (WS-N.2.2c)', () => {
  it('rides the review case of THIS intent, never another intent’s', async () => {
    const reviewer = await seedReviewer();
    const subject = randomUUID();
    const intentId = randomUUID();
    const otherIntentId = randomUUID();
    // The high-value review `risk.ts` opened for THIS intent (its reviewRef IS
    // the intent id, so the case is keyed to the attempt).
    const own = await compliance.cases.insert({
      caseId: randomUUID(),
      userIdOrRoomId: subject,
      subjectKind: 'user',
      triggerType: 'pattern',
      riskLevel: 'high',
      partnerCaseRef: null,
      reviewState: 'open',
      assignedTo: null,
      resolution: null,
      retentionPolicy: {
        retention_period_days: 730,
        deletion_date: new Date(Date.now() + 86_400_000).toISOString(),
        legal_hold: false,
        legal_hold_refs: [],
      },
      idempotencyKey: `highvalue:user:${subject}:5000:${intentId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // …plus a NEWER fraud-class case for the SAME user, belonging to a
    // DIFFERENT flagged intent.  A subject-keyed lookup would attach this one.
    await compliance.cases.insert({
      caseId: randomUUID(),
      userIdOrRoomId: subject,
      subjectKind: 'user',
      triggerType: 'velocity',
      riskLevel: 'low',
      partnerCaseRef: null,
      reviewState: 'open',
      assignedTo: null,
      resolution: null,
      retentionPolicy: {
        retention_period_days: 730,
        deletion_date: new Date(Date.now() + 86_400_000).toISOString(),
        legal_hold: false,
        legal_hold_refs: [],
      },
      idempotencyKey: `highvalue:user:${subject}:9000:${otherIntentId}`,
      createdAt: new Date(Date.now() + 1000).toISOString(),
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    setTreasuryServices({
      intents: {
        listByComplianceState: async () => [
          {
            paymentIntentId: intentId,
            userId: subject,
            roomId: randomUUID(),
            targetType: 'treasury_deposit',
            amount: '5000',
            complianceState: 'flagged',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    } as never);

    const queue = (await (
      await app().request(get('/v1/compliance/admin/fraud-queue', reviewer.cookie))
    ).json()) as {
      items: Array<{
        case: { case_id: string; trigger_type: string; risk_level: string };
        payment_intent_id: string | null;
      }>;
    };
    const held = queue.items.find((item) => item.payment_intent_id === intentId);
    // The held row carries ITS OWN review's trigger/risk (and therefore its
    // SLA) — a subject-keyed lookup would have shown the other intent's case,
    // and a release would then have audited the wrong chain.
    expect(held?.case.case_id).toBe(own.caseId);
    expect(held?.case.risk_level).toBe('high');
  });

  it('falls back to the synthetic intent row when no fraud-class case is open', async () => {
    const reviewer = await seedReviewer();
    const subject = randomUUID();
    const intentId = randomUUID();
    // A fraud-class case exists for the subject but belongs to NO intent.
    await createCaseVia(reviewer.cookie, {
      trigger_type: 'velocity',
      risk_level: 'low',
      user_id_or_room_id: subject,
    });
    setTreasuryServices({
      intents: {
        listByComplianceState: async () => [
          {
            paymentIntentId: intentId,
            userId: subject,
            roomId: randomUUID(),
            targetType: 'treasury_deposit',
            amount: '5000',
            complianceState: 'flagged',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    } as never);
    const queue = (await (
      await app().request(get('/v1/compliance/admin/fraud-queue', reviewer.cookie))
    ).json()) as {
      items: Array<{ case: { case_id: string }; payment_intent_id: string | null }>;
    };
    const held = queue.items.find((item) => item.payment_intent_id === intentId);
    // The synthetic row describes the INTENT itself, not the unrelated case.
    expect(held?.case.case_id).toBe(intentId);
  });
});

describe('a declaration decision cannot overwrite a member’s change (WS-N.1.1f)', () => {
  it('409s when the member re-declares between the reviewer’s read and write', async () => {
    const reviewer = await seedReviewer();
    const member = await seedUser({ handle: `m${randomUUID().slice(0, 8)}` });
    await app().request(
      post('/v1/compliance/region/declaration', { declared_region: 'DE' }, member.cookie),
    );
    // The member moves and re-declares in the window between the reviewer's
    // handler reading the declaration and writing its decision back.
    const store = compliance.declarations;
    const originalGet = store.get.bind(store);
    let raced = false;
    store.get = async (userId: string) => {
      const row = await originalGet(userId);
      if (!raced && row !== null) {
        raced = true;
        await app().request(
          post('/v1/compliance/region/declaration', { declared_region: 'FR' }, member.cookie),
        );
      }
      return row; // the reviewer's handler holds the STALE row
    };
    let verify: Response;
    try {
      verify = await app().request(
        post(
          `/v1/compliance/admin/declarations/${member.userId}/verify`,
          { decision: 'verify', note: 'passport checked' },
          reviewer.cookie,
        ),
      );
    } finally {
      store.get = originalGet;
    }
    // A verified declaration IS the real-funds region basis, so verifying
    // evidence for a region the member has left must not stand.
    expect(verify.status).toBe(409);
    expect(((await verify.json()) as { error: { code: string } }).error.code).toBe(
      'declaration_changed',
    );
    const current = await compliance.declarations.get(member.userId);
    expect(current?.declaredRegion).toBe('FR');
    expect(current?.status).toBe('pending'); // NOT resurrected as verified DE

    // Deciding on the CURRENT declaration works.
    const again = await app().request(
      post(
        `/v1/compliance/admin/declarations/${member.userId}/verify`,
        { decision: 'verify', note: 'passport checked' },
        reviewer.cookie,
      ),
    );
    expect(again.status).toBe(200);
    expect((await compliance.declarations.get(member.userId))?.declaredRegion).toBe('FR');
  });
});

describe('the fraud queue shows every fraud case, not just the first page (WS-N.2.2c)', () => {
  it('caps fraud-class cases, not the case table', async () => {
    const reviewer = await seedReviewer();
    // A wall of unrelated open cases, older than the fraud case behind them.
    for (let i = 0; i < 205; i += 1) {
      await compliance.cases.insert({
        caseId: randomUUID(),
        userIdOrRoomId: randomUUID(),
        subjectKind: 'user',
        triggerType: 'manual', // NOT fraud-class
        riskLevel: 'low',
        partnerCaseRef: null,
        reviewState: 'open',
        assignedTo: null,
        resolution: null,
        retentionPolicy: {
          retention_period_days: 730,
          deletion_date: new Date(Date.now() + 86_400_000).toISOString(),
          legal_hold: false,
          legal_hold_refs: [],
        },
        idempotencyKey: null,
        createdAt: new Date(Date.now() - (300 - i) * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    const fraudCaseId = await createCaseVia(reviewer.cookie, { trigger_type: 'velocity' });
    const queue = (await (
      await app().request(get('/v1/compliance/admin/fraud-queue', reviewer.cookie))
    ).json()) as { items: Array<{ case: { case_id: string } }> };
    // Capping the case read at 200 and filtering after would have spent the
    // whole page on `manual` cases, and this velocity case would have no queue
    // row, no SLA, and no review action until 200 unrelated cases closed.
    expect(queue.items.map((item) => item.case.case_id)).toContain(fraudCaseId);
  });
});

describe('a fraud-queue decision CLOSES the review it decided (WS-N.2.2c)', () => {
  /** A flagged intent whose state the fake treasury actually tracks. */
  function wireFlaggedIntent(intentId: string, subject: string) {
    const intent = {
      paymentIntentId: intentId,
      userId: subject,
      roomId: randomUUID(),
      targetType: 'treasury_deposit',
      amount: '5000',
      complianceState: 'flagged',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setTreasuryServices({
      intents: {
        getById: async (id: string) => (id === intentId ? intent : null),
        listByComplianceState: async (state: string) =>
          intent.complianceState === state ? [intent] : [],
        updateComplianceState: async (id: string, from: string, to: string) => {
          if (id !== intentId || intent.complianceState !== from) return null;
          intent.complianceState = to;
          return intent;
        },
      },
    } as never);
    return intent;
  }

  /** The high-value review `risk.ts` opens for this intent. */
  async function seedReview(subject: string, intentId: string) {
    return await compliance.cases.insert({
      caseId: randomUUID(),
      userIdOrRoomId: subject,
      subjectKind: 'user',
      triggerType: 'pattern',
      riskLevel: 'medium',
      partnerCaseRef: null,
      reviewState: 'open',
      assignedTo: null,
      resolution: null,
      retentionPolicy: {
        retention_period_days: 730,
        deletion_date: new Date(Date.now() + 86_400_000).toISOString(),
        legal_hold: false,
        legal_hold_refs: [],
      },
      idempotencyKey: `highvalue:user:${subject}:5000:${intentId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  it('a release on a TERMINAL (abandoned) flagged intent is refused — no false cleared (thread-R)', async () => {
    const reviewer = await seedReviewer();
    const intentId = randomUUID();
    // The reviewer's queue was stale: the intent went `abandoned` (expiry /
    // clawback) after they loaded it, while its `complianceState` stayed
    // `flagged`.  Releasing it would flip the column and report `cleared` for an
    // intent that can never quote or submit.
    const intent = {
      paymentIntentId: intentId,
      userId: randomUUID(),
      roomId: randomUUID(),
      targetType: 'treasury_deposit',
      amount: '5000',
      complianceState: 'flagged',
      executionState: 'abandoned',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setTreasuryServices({
      intents: {
        getById: async (id: string) => (id === intentId ? intent : null),
        listByComplianceState: async () => [],
        updateComplianceState: async () => intent,
      },
    } as never);
    const released = await app().request(
      post(
        '/v1/compliance/admin/fraud-queue/release',
        { payment_intent_id: intentId, reason: 'looks fine' },
        reviewer.cookie,
      ),
    );
    expect(released.status).toBe(409);
    expect(((await released.json()) as { error: { code: string } }).error.code).toBe('not_flagged');
  });

  it('a release resolves the case `cleared` and the queue drains', async () => {
    const reviewer = await seedReviewer();
    const subject = randomUUID();
    const intentId = randomUUID();
    wireFlaggedIntent(intentId, subject);
    const review = await seedReview(subject, intentId);

    const released = await app().request(
      post(
        '/v1/compliance/admin/fraud-queue/release',
        { payment_intent_id: intentId, reason: 'verified with the depositor' },
        reviewer.cookie,
      ),
    );
    expect(released.status).toBe(200);

    // `risk.ts` reads the CASE, not the intent's column: a review left open
    // would meet the released deposit again at the WS-L leg and block it.
    const closed = await compliance.cases.getById(review.caseId);
    expect(closed?.reviewState).toBe('resolved');
    expect(closed?.resolution?.outcome).toBe('cleared');

    // …and the queue drains rather than showing a decided review forever.
    const queue = (await (
      await app().request(get('/v1/compliance/admin/fraud-queue', reviewer.cookie))
    ).json()) as { items: Array<{ payment_intent_id: string | null }> };
    expect(queue.items.find((item) => item.payment_intent_id === intentId)).toBeUndefined();
  });

  it('a rejection resolves the case `restricted`, so the retry stays blocked', async () => {
    const reviewer = await seedReviewer();
    const subject = randomUUID();
    const intentId = randomUUID();
    wireFlaggedIntent(intentId, subject);
    const review = await seedReview(subject, intentId);

    const rejected = await app().request(
      post(
        '/v1/compliance/admin/fraud-queue/reject',
        { payment_intent_id: intentId, reason: 'unexplained source of funds' },
        reviewer.cookie,
      ),
    );
    expect(rejected.status).toBe(200);
    const closed = await compliance.cases.getById(review.caseId);
    expect(closed?.reviewState).toBe('resolved');
    // NOT `cleared`: the high-value loop's exit is cleared-only, so the
    // attempt's retry keeps returning `elevated`.
    expect(closed?.resolution?.outcome).toBe('restricted');
  });

  it('finds a ROOM-owned payout’s review, which no steward’s id could locate', async () => {
    const reviewer = await seedReviewer();
    const roomId = randomUUID();
    const intentId = randomUUID();
    // A grant payout: room-owned (`userId: null`), so `risk.ts` filed its
    // high-value review against the ROOM — the queue never learns which steward
    // preflighted it, and a user-keyed lookup would find nothing and open a
    // second, unrelated case while the real review stayed open.
    const review = await compliance.cases.insert({
      caseId: randomUUID(),
      userIdOrRoomId: roomId,
      subjectKind: 'room',
      triggerType: 'pattern',
      riskLevel: 'medium',
      partnerCaseRef: null,
      reviewState: 'open',
      assignedTo: null,
      resolution: null,
      retentionPolicy: {
        retention_period_days: 730,
        deletion_date: new Date(Date.now() + 86_400_000).toISOString(),
        legal_hold: false,
        legal_hold_refs: [],
      },
      idempotencyKey: `highvalue:room:${roomId}:5000:${intentId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const intent = {
      paymentIntentId: intentId,
      userId: null,
      roomId,
      targetType: 'grant_payout',
      amount: '5000',
      complianceState: 'flagged',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setTreasuryServices({
      intents: {
        getById: async (id: string) => (id === intentId ? intent : null),
        listByComplianceState: async (state: string) =>
          intent.complianceState === state ? [intent] : [],
        updateComplianceState: async (id: string, from: string, to: string) => {
          if (id !== intentId || intent.complianceState !== from) return null;
          intent.complianceState = to;
          return intent;
        },
      },
    } as never);

    const queue = (await (
      await app().request(get('/v1/compliance/admin/fraud-queue', reviewer.cookie))
    ).json()) as { items: Array<{ case: { case_id: string }; payment_intent_id: string | null }> };
    expect(queue.items.find((i) => i.payment_intent_id === intentId)?.case.case_id).toBe(
      review.caseId,
    );

    const released = await app().request(
      post(
        '/v1/compliance/admin/fraud-queue/release',
        { payment_intent_id: intentId, reason: 'board approved' },
        reviewer.cookie,
      ),
    );
    expect(released.status).toBe(200);
    // The REAL review closed — not a second case opened beside it.
    expect((await compliance.cases.getById(review.caseId))?.resolution?.outcome).toBe('cleared');
    expect(await compliance.cases.findByIdempotencyKey(`intent-review:${intentId}`)).toBeNull();
  });

  it('a release on a case already resolved NOT-cleared is refused, never a false success', async () => {
    const reviewer = await seedReviewer();
    const subject = randomUUID();
    const intentId = randomUUID();
    const intent = wireFlaggedIntent(intentId, subject);
    const review = await seedReview(subject, intentId);
    // A reviewer resolved this case `restricted` through the case console.
    const deps = buildCaseDeps(compliance);
    for (const step of ['assigned', 'investigating', 'resolved'] as const) {
      await transitionCase(deps, {
        caseId: review.caseId,
        to: step,
        actorUserId: reviewer.userId,
        isSenior: false,
        ...(step === 'assigned' ? { assigneeUserId: reviewer.userId } : {}),
        ...(step === 'resolved'
          ? {
              resolution: {
                outcome: 'restricted' as const,
                notes: 'confirmed fraud',
                resolved_by: reviewer.userId,
                resolved_at: new Date().toISOString(),
              },
            }
          : {}),
      });
    }
    const released = await app().request(
      post(
        '/v1/compliance/admin/fraud-queue/release',
        { payment_intent_id: intentId, reason: 'looks fine to me' },
        reviewer.cookie,
      ),
    );
    // `risk.ts` reads the case's OUTCOME, not the queue's intent, so accepting
    // this would mark the intent cleared while the transfer stayed held — a
    // release that reports success and releases nothing.  Changing a colleague's
    // decision takes an audited reopen, not a queue click.
    expect(released.status).toBe(503);
    expect((await compliance.cases.getById(review.caseId))?.resolution?.outcome).toBe('restricted');
    // …and the compensator put the hold back rather than leave it cleared.
    expect(intent.complianceState).toBe('flagged');
  });

  it('the SAME decision on an already-resolved case is idempotent', async () => {
    const reviewer = await seedReviewer();
    const subject = randomUUID();
    const intentId = randomUUID();
    wireFlaggedIntent(intentId, subject);
    const review = await seedReview(subject, intentId);
    const first = await app().request(
      post(
        '/v1/compliance/admin/fraud-queue/release',
        { payment_intent_id: intentId, reason: 'verified' },
        reviewer.cookie,
      ),
    );
    expect(first.status).toBe(200);
    // The case is `resolved`/`cleared` now; a re-run of the same decision must
    // not fail on its own past work.
    expect(
      await resolveCaseInTx(compliance, buildCaseDeps(compliance), {
        caseId: review.caseId,
        actorUserId: reviewer.userId,
        resolution: {
          outcome: 'cleared',
          notes: 'again',
          resolved_by: reviewer.userId,
          resolved_at: new Date().toISOString(),
        },
      }),
    ).toBe(true);
  });

  it('the decision entry and the resolution are ONE unit: neither lands alone', async () => {
    const reviewer = await seedReviewer();
    const subject = randomUUID();
    const intentId = randomUUID();
    const intent = wireFlaggedIntent(intentId, subject);
    const review = await seedReview(subject, intentId);

    // The chain append fails mid-unit (a store fault at the worst moment).
    const original = compliance.caseAudit.appendChained.bind(compliance.caseAudit);
    compliance.caseAudit.appendChained = async () => {
      throw new Error('chain unavailable');
    };
    try {
      const released = await app().request(
        post(
          '/v1/compliance/admin/fraud-queue/release',
          { payment_intent_id: intentId, reason: 'ok' },
          reviewer.cookie,
        ),
      );
      expect(released.status).toBe(503);
    } finally {
      compliance.caseAudit.appendChained = original;
    }
    // The case never moved (no resolution recorded with no entry to show for
    // it), and the compensator put the hold back rather than release funds.
    const untouched = await compliance.cases.getById(review.caseId);
    expect(untouched?.reviewState).toBe('open');
    expect(untouched?.resolution).toBeNull();
    expect(intent.complianceState).toBe('flagged');
  });
});

describe('lawful access preserves the scope kind (WS-N.2.3d)', () => {
  it('a transaction-scoped request opens a TRANSACTION case, not a user one', async () => {
    const counsel = await seedCounsel();
    const txRef = `0x${'ab'.repeat(32)}`;
    const intake = await app().request(
      post(
        '/v1/compliance/admin/lawful-access',
        {
          agency: 'Financial Unit',
          jurisdiction: 'DE',
          legal_basis: 'subpoena',
          scope: {
            subject_kind: 'transaction',
            subject_ref: txRef,
            time_range_start: null,
            time_range_end: null,
          },
          contact: 'unit@example.test',
        },
        counsel.cookie,
      ),
    );
    expect(intake.status).toBe(201);
    const caseId = ((await intake.json()) as { request: { case_id: string | null } }).request
      .case_id as string;
    const record = await compliance.cases.getById(caseId);
    // Filing a transaction id as a `user` subject would put it in the user
    // queue, the erasure scrub, and user subject searches.
    expect(record?.subjectKind).toBe('transaction');
    expect(record?.userIdOrRoomId).toBe(txRef);
  });
});

describe('a denial closes the intake case from wherever it sits (WS-N.2.3d)', () => {
  async function intake(counselCookie: string): Promise<{ requestId: string; caseId: string }> {
    const res = await app().request(
      post(
        '/v1/compliance/admin/lawful-access',
        {
          agency: 'Agency',
          jurisdiction: 'US',
          legal_basis: 'subpoena',
          scope: {
            subject_kind: 'user',
            subject_ref: randomUUID(),
            time_range_start: null,
            time_range_end: null,
          },
          contact: 'agent@example.test',
        },
        counselCookie,
      ),
    );
    const request = ((await res.json()) as { request: { request_id: string; case_id: string } })
      .request;
    return { requestId: request.request_id, caseId: request.case_id };
  }

  it('denies even when a reviewer already picked the case up', async () => {
    const counsel = await seedCounsel();
    const reviewer = await seedReviewer();
    const { requestId, caseId } = await intake(counsel.cookie);
    // A compliance reviewer takes the case while counsel deliberates.
    expect(
      (
        await app().request(
          post(
            `/v1/compliance/admin/cases/${caseId}/assign`,
            { assignee_user_id: reviewer.userId },
            reviewer.cookie,
          ),
        )
      ).status,
    ).toBe(200);
    const denied = await app().request(
      post(
        `/v1/compliance/admin/lawful-access/${requestId}/review`,
        { decision: 'denied', note: 'overbroad' },
        counsel.cookie,
      ),
    );
    // A fixed open→assigned first step would be INVALID_CASE_TRANSITION here
    // and take the whole unit down — counsel could not record the denial or
    // release the hold because someone was already looking at the case.
    expect(denied.status).toBe(200);
    const closed = await compliance.cases.getById(caseId);
    expect(closed?.reviewState).toBe('resolved');
    expect(closed?.retentionPolicy.legal_hold).toBe(false);
  });

  it('a denial whose cleanup fails keeps NOTHING — not a half-denied request', async () => {
    const counsel = await seedCounsel();
    const { requestId, caseId } = await intake(counsel.cookie);
    // The chain dies after the request row is CAS-written to `denied`.
    const original = compliance.caseAudit.appendChained.bind(compliance.caseAudit);
    compliance.caseAudit.appendChained = async () => {
      throw new Error('chain unavailable');
    };
    let res: Response;
    try {
      res = await app().request(
        post(
          `/v1/compliance/admin/lawful-access/${requestId}/review`,
          { decision: 'denied', note: 'overbroad' },
          counsel.cookie,
        ),
      );
    } finally {
      compliance.caseAudit.appendChained = original;
    }
    expect(res.status).toBe(503);
    // Returning the cleanup error instead of throwing would have COMMITTED the
    // denial while the route reported failure: a denied request whose hold is
    // still on and whose case is still open.
    const stored = await compliance.lawfulAccess.getById(requestId);
    expect(stored?.status).toBe('received');
    const untouched = await compliance.cases.getById(caseId);
    expect(untouched?.retentionPolicy.legal_hold).toBe(true);
    expect(untouched?.reviewState).toBe('open');
  });
});

describe('holds and their records are all-or-nothing (WS-N.2.1e / 2.3d)', () => {
  it('a SAR draft that cannot be stored leaves NO trace — hold, report, or entry', async () => {
    const counsel = await seedCounsel();
    const caseId = await createCaseVia(counsel.cookie, { trigger_type: 'sanctions' });
    compliance.sars.insert = async () => {
      throw new Error('sar store down');
    };
    const res = await app().request(
      post(
        `/v1/compliance/admin/cases/${caseId}/sar`,
        { jurisdiction: 'DE', narrative: 'A narrative that will not persist.' },
        counsel.cookie,
      ),
    );
    expect(res.status).toBe(503);
    // The hold exists FOR the report; with no report it would pin the case out
    // of retention forever and each retry would stack another hold.
    expect((await compliance.cases.getById(caseId))?.retentionPolicy.legal_hold).toBe(false);
    // The unit kept NOTHING — not even an applied-then-released blip. The
    // compensator this replaced could only undo the hold after committing it,
    // so the chain carried a pair of entries for an event that never happened;
    // a transaction leaves no trace to explain away.
    const actions = (await compliance.caseAudit.listChained(caseId)).map((e) => e.action);
    expect(actions).not.toContain('legal_hold_applied');
    expect(actions).not.toContain('legal_hold_released');
    expect(await compliance.sars.listByCase(caseId)).toHaveLength(0);
  });

  it('lawful-access intake ABORTS when the legal hold cannot be applied', async () => {
    const counsel = await seedCounsel();
    const subject = await seedUser({ handle: `s${randomUUID().slice(0, 8)}` });
    // The hold's audit append fails ⇒ setLegalHold rolls back and errors.
    let created = 0;
    const realAppend = compliance.caseAudit.appendChained.bind(compliance.caseAudit);
    compliance.caseAudit.appendChained = async (entry) => {
      created += 1;
      if (created > 1) throw new Error('audit store down'); // let 'created' land
      return realAppend(entry);
    };
    const res = await app().request(
      post(
        '/v1/compliance/admin/lawful-access',
        {
          agency: 'Court',
          jurisdiction: 'DE',
          legal_basis: 'court_order',
          scope: {
            subject_kind: 'user',
            subject_ref: subject.userId,
            time_range_start: null,
            time_range_end: null,
          },
          contact: 'court@example.test',
        },
        counsel.cookie,
      ),
    );
    // Recording the request while its hold failed would look compliant and not
    // be: retention could then sweep the very records it obliges us to keep.
    expect(res.status).toBe(503);
    expect(await compliance.lawfulAccess.list(null, 10)).toHaveLength(0);
  });
});

describe('the declaration-verification audit records its subject (WS-N.1.1f)', () => {
  it('puts the opaque subject in targetRef, which redactContext preserves', async () => {
    const appended: Array<{
      event_type: string;
      target_ref: string | null;
      context: { setting: string | null; reason: string | null };
    }> = [];
    const realAppend = identity.audit.append.bind(identity.audit);
    identity.audit.append = async (input, createdAt) => {
      const entry = await realAppend(input, createdAt);
      appended.push(entry as unknown as (typeof appended)[number]);
      return entry;
    };
    const reviewer = await seedReviewer();
    const member = await seedUser({ handle: `m${randomUUID().slice(0, 8)}` });
    await app().request(
      post('/v1/compliance/region/declaration', { declared_region: 'DE' }, member.cookie),
    );
    const res = await app().request(
      post(
        `/v1/compliance/admin/declarations/${member.userId}/verify`,
        { decision: 'verify', note: 'passport reviewed' },
        reviewer.cookie,
      ),
    );
    expect(res.status).toBe(200);
    // `append` returns the PERSISTED entry — already through redactContext —
    // so this asserts the subject actually survives redaction, not merely that
    // the route passed it.
    const entry = appended.find(
      (e) => e.event_type === 'region_declaration_change' && e.target_ref !== null,
    );
    // Without a target the entry would say a reviewer verified *something* —
    // useless for the one anti-circumvention control the region ladder has.
    expect(entry).toBeDefined();
    expect(entry?.target_ref).toBe(compliance.opaqueRef(member.userId));
    // …and the subject is an opaque ref, never the raw user id.
    expect(entry?.target_ref).not.toBe(member.userId);
    // The decision + note ride the allowlisted context keys.
    expect(entry?.context.setting).toBe('verify');
    expect(entry?.context.reason).toBe('passport reviewed');
  });
});

describe('a rolled-back SAR never releases an EARLIER hold (WS-N.2.1e)', () => {
  it('leaves a pre-existing legal hold intact when its own insert fails', async () => {
    const counsel = await seedCounsel();
    const caseId = await createCaseVia(counsel.cookie, { trigger_type: 'sanctions' });
    // An EARLIER obligation already holds this case (a first SAR).
    const first = await app().request(
      post(
        `/v1/compliance/admin/cases/${caseId}/sar`,
        { jurisdiction: 'DE', narrative: 'The first report, which persists.' },
        counsel.cookie,
      ),
    );
    expect(first.status).toBe(201);
    expect((await compliance.cases.getById(caseId))?.retentionPolicy.legal_hold).toBe(true);

    // A SECOND draft fails to store. Its rollback must undo only what IT did.
    compliance.sars.insert = async () => {
      throw new Error('sar store down');
    };
    const second = await app().request(
      post(
        `/v1/compliance/admin/cases/${caseId}/sar`,
        { jurisdiction: 'FR', narrative: 'The second report, which does not persist.' },
        counsel.cookie,
      ),
    );
    expect(second.status).toBe(503);
    // Blindly clearing the hold here would expose records the FIRST report
    // still obliges us to keep.
    expect((await compliance.cases.getById(caseId))?.retentionPolicy.legal_hold).toBe(true);
  });
});

describe('a DENIED lawful-access request releases its hold (WS-N.2.3d)', () => {
  it('frees the subject once counsel rejects the legal basis', async () => {
    const counsel = await seedCounsel();
    const subject = await seedUser({ handle: `s${randomUUID().slice(0, 8)}` });
    const intake = await app().request(
      post(
        '/v1/compliance/admin/lawful-access',
        {
          agency: 'Court',
          jurisdiction: 'DE',
          legal_basis: 'subpoena',
          scope: {
            subject_kind: 'user',
            subject_ref: subject.userId,
            time_range_start: null,
            time_range_end: null,
          },
          contact: 'court@example.test',
        },
        counsel.cookie,
      ),
    );
    const request = ((await intake.json()) as { request: { request_id: string; case_id: string } })
      .request;
    expect((await compliance.cases.getById(request.case_id))?.retentionPolicy.legal_hold).toBe(
      true,
    );

    const denied = await app().request(
      post(
        `/v1/compliance/admin/lawful-access/${request.request_id}/review`,
        { decision: 'denied', note: 'the legal basis does not hold' },
        counsel.cookie,
      ),
    );
    expect(denied.status).toBe(200);
    // A rejected request obliges nothing: leaving the hold would keep
    // retention and the erasure scrub skipping the subject's records, and the
    // open high-risk case would keep their crypto features disabled.
    const record = await compliance.cases.getById(request.case_id);
    expect(record?.retentionPolicy.legal_hold).toBe(false);
    expect(record?.reviewState).toBe('resolved');
    expect(
      await compliance.cases.countOpenByRisk(subject.userId, 'user', ['high', 'critical']),
    ).toBe(0);
  });

  it('an APPROVED request keeps its hold, and production records who disclosed', async () => {
    const counsel = await seedCounsel();
    const subject = await seedUser({ handle: `s${randomUUID().slice(0, 8)}` });
    const intake = await app().request(
      post(
        '/v1/compliance/admin/lawful-access',
        {
          agency: 'Court',
          jurisdiction: 'DE',
          legal_basis: 'warrant',
          scope: {
            subject_kind: 'user',
            subject_ref: subject.userId,
            time_range_start: null,
            time_range_end: null,
          },
          contact: 'court@example.test',
        },
        counsel.cookie,
      ),
    );
    const request = ((await intake.json()) as { request: { request_id: string; case_id: string } })
      .request;
    await app().request(
      post(
        `/v1/compliance/admin/lawful-access/${request.request_id}/review`,
        { decision: 'approved', note: 'valid warrant' },
        counsel.cookie,
      ),
    );
    expect((await compliance.cases.getById(request.case_id))?.retentionPolicy.legal_hold).toBe(
      true,
    );

    // A second counsel user performs the production — the approver is not
    // necessarily the discloser, and the record keeps only `reviewedByRef`.
    const producer = await seedCounsel();
    await app().request(
      post(
        `/v1/compliance/admin/lawful-access/${request.request_id}/produce`,
        { production_summary: 'account identity records', user_notified: true },
        producer.cookie,
      ),
    );
    const trail = await compliance.caseAudit.listChained(request.case_id);
    // The producer's action is recorded under GENERIC wording (the case chain is
    // COMPLIANCE-readable; the production detail is counsel-only), so it is found
    // by the producer's opaque ref, not a lawful-access action string.
    const produced = trail.find(
      (entry) => entry.actorRef === compliance.opaqueRef(producer.userId),
    );
    expect(produced).toBeDefined();
    expect(produced?.actorRef).not.toBe(compliance.opaqueRef(counsel.userId));
    // …and the compliance-readable chain reveals NO lawful-access detail (W).
    const chain = trail
      .map((e) => `${e.action} ${e.note ?? ''}`)
      .join(' ')
      .toLowerCase();
    expect(chain).not.toContain('lawful-access');
    expect(chain).not.toContain('produced');
    expect(chain).not.toContain('notified');
  });
});

describe('the disabled-event dedup window is bounded (WS-N.1.1c memory safety)', () => {
  it('emits once per window and re-emits after it', () => {
    const WINDOW = 1000;
    const dedup = createDedupWindow(WINDOW, 100);
    expect(dedup.should('a', 0)).toBe(true); // first sight emits
    expect(dedup.should('a', WINDOW - 1)).toBe(false); // deduped inside the window
    expect(dedup.should('a', WINDOW)).toBe(true); // re-emits once it elapses
  });

  it('prunes expired keys at the cap so the map cannot grow unbounded', () => {
    const WINDOW = 1000;
    const MAX = 3;
    const dedup = createDedupWindow(WINDOW, MAX);
    // Fill to the cap with keys stamped in the distant past.
    dedup.should('x', 0);
    dedup.should('y', 0);
    dedup.should('z', 0);
    expect(dedup.size()).toBe(MAX);
    // A fresh key well past their window triggers the prune: the three expired
    // keys drop, leaving only the newcomer — a plain Map would hold all four.
    expect(dedup.should('w', 10 * WINDOW)).toBe(true);
    expect(dedup.size()).toBe(1);
  });

  it('evicts oldest-first at the cap when nothing has expired (HARD bound)', () => {
    const WINDOW = 1000;
    const dedup = createDedupWindow(WINDOW, 2);
    // Two LIVE keys fill the cap; a third within the window has nothing expired
    // to prune, so the OLDEST ('a') is evicted — the map never grows past 2.
    dedup.should('a', 0);
    dedup.should('b', 0);
    expect(dedup.should('c', 1)).toBe(true);
    expect(dedup.size()).toBe(2);
    // 'a' was evicted, so it re-emits (no longer deduped); 'c' is still live.
    expect(dedup.should('a', 2)).toBe(true);
    expect(dedup.size()).toBe(2);
    expect(dedup.should('c', 2)).toBe(false);
    // Refreshing an EXISTING key past its window updates in place — no eviction.
    const d2 = createDedupWindow(WINDOW, 2);
    d2.should('x', 0);
    d2.should('y', 0);
    expect(d2.should('x', WINDOW + 1)).toBe(true); // x's window elapsed → re-emit
    expect(d2.size()).toBe(2); // still x + y, not grown
  });
});
