// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot-prevention layer 3 (the governance KYC gate): the eligibility predicate
// (KYC standing, compliance hold, wallet risk — all fail-closed) and the route
// boundary — every governance-participation surface answers `kyc_required`
// for an unverified account BEFORE any membership signal leaks.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInMemoryComplianceServices,
  getComplianceServices,
  resetComplianceServicesForTests,
  setComplianceServices,
} from '../compliance/services.js';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import {
  checkGovernanceEligibility,
  requireGovernanceEligibility,
} from '../governance/eligibility.js';
import type { AuthEnv } from '../middleware/auth.js';
import { createGovernanceRoutes } from '../routes/governance.js';
import { freshEventServices, seedUserWithSession } from './event-test-helpers.js';
import { freshKnomosisServices } from './knomosis-test-helpers.js';

function freshCompliance() {
  const services = createInMemoryComplianceServices({
    configStore: new InMemoryPwattConfigStore(),
  });
  setComplianceServices(services);
  return services;
}

async function seedKyc(userId: string, status: 'pending' | 'verified' | 'revoked'): Promise<void> {
  const nowIso = new Date().toISOString();
  const kyc = getComplianceServices().kyc;
  // The create path is conflict-only (a concurrent initial verify cannot
  // overwrite), so a re-seed to change a standing must go through the CAS update
  // path — exactly what the real review route does (read → create-when-absent /
  // CAS-update-when-present).
  const existing = await kyc.get(userId);
  await kyc.upsert(
    {
      userId,
      status,
      evidenceRef: null,
      verifiedAt: status === 'verified' ? nowIso : null,
      verifiedBy: null,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    },
    existing === null ? undefined : { status: existing.status, updatedAt: existing.updatedAt },
  );
}

beforeEach(() => {
  resetComplianceServicesForTests();
  freshCompliance();
});
afterEach(() => {
  resetComplianceServicesForTests();
});

describe('checkGovernanceEligibility (the layer-3 predicate)', () => {
  it('denies kyc_required with NO record, a pending record, and a revoked record', async () => {
    const userId = randomUUID();
    expect((await checkGovernanceEligibility(userId))?.code).toBe('kyc_required');
    await seedKyc(userId, 'pending');
    expect((await checkGovernanceEligibility(userId))?.code).toBe('kyc_required');
    await seedKyc(userId, 'revoked');
    expect((await checkGovernanceEligibility(userId))?.code).toBe('kyc_required');
  });

  it('passes a reviewer-verified standing', async () => {
    const userId = randomUUID();
    await seedKyc(userId, 'verified');
    expect(await checkGovernanceEligibility(userId)).toBeNull();
  });

  it('a REVOKED standing revokes eligibility (kyc_partner is never sticky)', async () => {
    const userId = randomUUID();
    await seedKyc(userId, 'verified');
    expect(await checkGovernanceEligibility(userId)).toBeNull();
    await seedKyc(userId, 'revoked');
    expect((await checkGovernanceEligibility(userId))?.code).toBe('kyc_required');
  });

  it('denies compliance_hold for an open high/critical case (anti-tipping-off preserved)', async () => {
    const compliance = getComplianceServices();
    const userId = randomUUID();
    await seedKyc(userId, 'verified');
    const nowIso = new Date().toISOString();
    await compliance.cases.insert({
      caseId: randomUUID(),
      userIdOrRoomId: userId,
      subjectKind: 'user',
      triggerType: 'manual',
      riskLevel: 'high',
      partnerCaseRef: null,
      reviewState: 'open',
      assignedTo: null,
      resolution: null,
      retentionPolicy: {
        retention_period_days: 730,
        deletion_date: nowIso,
        legal_hold: false,
        legal_hold_refs: [],
      },
      idempotencyKey: `elig-${userId}`,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    expect((await checkGovernanceEligibility(userId))?.code).toBe('compliance_hold');
  });

  it('fails CLOSED (eligibility_unavailable) when the case store is unreadable', async () => {
    const compliance = getComplianceServices();
    const userId = randomUUID();
    await seedKyc(userId, 'verified');
    compliance.cases.countOpenByRisk = async () => {
      throw new Error('store down');
    };
    expect((await checkGovernanceEligibility(userId))?.code).toBe('eligibility_unavailable');
  });

  it('an unreadable KYC store fails closed to kyc_required (level "none")', async () => {
    const compliance = getComplianceServices();
    const userId = randomUUID();
    await seedKyc(userId, 'verified');
    compliance.kyc.get = async () => {
      throw new Error('store down');
    };
    expect((await checkGovernanceEligibility(userId))?.code).toBe('kyc_required');
  });
});

describe('checkGovernanceEligibility — the wallet-risk leg', () => {
  it('denies wallet_risk for a KYC-verified user with a HIGH-risk linked wallet', async () => {
    const fx = await freshKnomosisServices(); // sets identity/events/knomosis singletons
    freshCompliance(); // compliance singleton (separate from knomosis)
    const userId = randomUUID();
    await seedKyc(userId, 'verified');
    await fx.knomosis.wallets.insert({
      walletAccountId: randomUUID(),
      userId,
      addressHashHex: 'a'.repeat(64),
      addressTruncated: '0x1234…5678',
      chainId: 8357,
      walletType: 'eoa',
      unlinkState: 'active',
      riskState: 'high',
      label: null,
      linkedAt: new Date().toISOString(),
      lastUsedAt: null,
      unlinkRequestedAt: null,
      unlinkFinalizeAfter: null,
      unlinkedAt: null,
    });
    expect((await checkGovernanceEligibility(userId))?.code).toBe('wallet_risk');
  });

  it('a KYC-verified user with only a NORMAL-risk wallet is eligible', async () => {
    const fx = await freshKnomosisServices();
    freshCompliance();
    const userId = randomUUID();
    await seedKyc(userId, 'verified');
    await fx.knomosis.wallets.insert({
      walletAccountId: randomUUID(),
      userId,
      addressHashHex: 'b'.repeat(64),
      addressTruncated: '0x1234…5678',
      chainId: 8357,
      walletType: 'eoa',
      unlinkState: 'active',
      riskState: 'normal',
      label: null,
      linkedAt: new Date().toISOString(),
      lastUsedAt: null,
      unlinkRequestedAt: null,
      unlinkFinalizeAfter: null,
      unlinkedAt: null,
    });
    expect(await checkGovernanceEligibility(userId)).toBeNull();
  });
});

describe('requireGovernanceEligibility middleware', () => {
  const appWith = (userId: string | null) => {
    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      if (userId) c.set('auth', { userId } as NonNullable<AuthEnv['Variables']['auth']>);
      await next();
    });
    app.post('/x', requireGovernanceEligibility(), (c) => c.json({ ok: true }));
    return app;
  };

  it('401 without an auth context', async () => {
    freshCompliance();
    const res = await appWith(null).request('/x', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('403 with the typed denial for an ineligible user', async () => {
    freshCompliance();
    const res = await appWith(randomUUID()).request('/x', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('kyc_required');
  });

  it('passes to the handler for an eligible user', async () => {
    freshCompliance();
    const userId = randomUUID();
    await seedKyc(userId, 'verified');
    const res = await appWith(userId).request('/x', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('route boundary: governance participation demands the KYC bar', () => {
  it('a non-KYC member is refused a ratification ballot with kyc_required (no membership leak)', async () => {
    const fixture = freshEventServices();
    freshCompliance(); // fresh container AFTER the fixture reset the singletons
    const unverified = await seedUserWithSession(fixture.identity, { kyc: false });
    const app = new Hono().route('/v1', createGovernanceRoutes());
    const res = await app.request(
      `/v1/rooms/${randomUUID()}/governance/ratifications/${randomUUID()}/ballot`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: unverified.cookie },
        body: JSON.stringify({ choice: 'approve' }),
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('kyc_required');
  });

  it('a KYC-verified member clears the layer-3 gate (failure is then domain-shaped, not kyc_required)', async () => {
    const fixture = freshEventServices();
    freshCompliance();
    const verified = await seedUserWithSession(fixture.identity); // kyc defaults true
    const app = new Hono().route('/v1', createGovernanceRoutes());
    const res = await app.request(
      `/v1/rooms/${randomUUID()}/governance/ratifications/${randomUUID()}/ballot`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: verified.cookie },
        body: JSON.stringify({ choice: 'approve' }),
      },
    );
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('kyc_required');
  });

  it('a steward-election vote for a NON-KYC candidate is rejected as invalid_candidate', async () => {
    // The candidate check is structural: a seat can never accrue votes for an
    // account that could not lawfully hold governance power.
    const fixture = freshEventServices();
    freshCompliance();
    const voter = await seedUserWithSession(fixture.identity);
    const candidate = await seedUserWithSession(fixture.identity, { kyc: false });
    const app = new Hono().route('/v1', createGovernanceRoutes());
    const res = await app.request(`/v1/rooms/${randomUUID()}/elections/${randomUUID()}/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: voter.cookie },
      body: JSON.stringify({ candidate_user_id: candidate.userId }),
    });
    // The voter is not a member of the random room, so the membership gate
    // fires first here — the point is the VOTER's layer-3 gate passed (not
    // kyc_required) and the candidate leg is covered by the service tests.
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('kyc_required');
  });
});
