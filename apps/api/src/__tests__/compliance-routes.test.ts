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
import {
  type ComplianceServices,
  createInMemoryComplianceServices,
  resetComplianceServicesForTests,
  setComplianceServices,
} from '../compliance/services.js';
import { getEventPipelineServices } from '../events/services.js';
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
    const overrides = await app().request(
      put(
        '/v1/compliance/admin/config/eventRetentionOverrides',
        { value: { sensitive: 30 } },
        reviewer.cookie,
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
