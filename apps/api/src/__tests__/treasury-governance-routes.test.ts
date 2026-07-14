// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M route surface over the in-process Hono app with real sessions: the
// governance profile, charters, law-pack registration/adoption, attestations,
// freeze/pause, the EXTENDED readiness + full mode-transition machine, the
// real-asset treasury + payment intents, and the accounting export.

import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createInMemoryGovernanceStores } from '../governance/stores.js';
import { createV1Routes } from '../routes/v1.js';
import {
  createInMemoryTreasuryServices,
  resetTreasuryServicesForTests,
  setTreasuryServices,
  type TreasuryServices,
} from '../treasury/services.js';
import { seedUserWithSession } from './event-test-helpers.js';
import {
  freshKnomosisServices,
  type KnomosisFixture,
  LOCAL_DEPLOYMENT,
  resetKnomosisFixture,
} from './knomosis-test-helpers.js';

const ROOM = '77777777-7777-4777-8777-777777777777';
const ADDRESS = `0x${'ab'.repeat(20)}`;

function app() {
  return new Hono().route('/v1', createV1Routes());
}
async function req(method: string, path: string, cookie: string, body?: unknown) {
  return app().request(
    new Request(`http://localhost/v1${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const SECTION =
  'This section is written in plain language. It explains the rule simply. Everyone can read it.';
const SECTIONS = {
  purpose: SECTION,
  decision_making: SECTION,
  fund_management: SECTION,
  member_rights: SECTION,
  dispute_resolution: SECTION,
  amendment_process: SECTION,
  safety_override_acknowledgment: SECTION,
  appeals_path: SECTION,
};

const LAW_PACK = {
  lawPackId: 'placeholder',
  version: '1.0.0',
  allowedProposalTypes: ['capped_grant'],
  permittedCapabilities: ['treasury.grant'],
  treasury: {
    caps: [
      { category: 'grant', perActionMax: '1000', perWindowMax: '5000', windowSeconds: 86_400 },
    ],
    minIntervalSeconds: 0,
    timelockSeconds: 0,
    materialThreshold: '100000',
    requireCoiFor: ['grant'],
    investment: null,
  },
  election: {
    weightModel: 'one_civic_account_one_vote',
    perAccountCap: 1,
    minQuorum: 1,
    minTurnout: 0,
    termSeconds: 31_536_000,
  },
};

interface WsmFixture extends KnomosisFixture {
  treasury: TreasuryServices;
  mode: { value: string };
}

/** A fixture with a governed room (steward = the session user) + the WS-M
 *  container wired exactly like the boot. */
async function wsmFixture(options: { steward?: boolean } = {}): Promise<WsmFixture> {
  const fixture = await freshKnomosisServices();
  const mode = { value: 'simulated' };
  fixture.knomosis.rooms = {
    roomGovernance: async () => ({ mode: mode.value as never, name: 'Governed Room' }),
    isMember: async () => true,
    isSteward: async () => options.steward !== false,
    contentVisibleToUser: async () => true,
  };
  fixture.knomosis.roomMode = {
    currentMode: async () => mode.value as never,
    setMode: async (_r, m) => {
      mode.value = m;
      return true;
    },
    setModeIf: async (_r, expected, next) => {
      if (mode.value !== expected) return false;
      mode.value = next;
      return true;
    },
  };
  const governanceStores = createInMemoryGovernanceStores();
  const treasury = createInMemoryTreasuryServices({
    knomosis: fixture.knomosis,
    governanceStores,
    membership: {
      memberFacts: async () => ({
        membershipDays: 60,
        contributionCount: 10,
        verifiedIdentity: true,
      }),
      eligibleMemberCount: async () => 3,
    },
    treasuryExecutor: { execute: async () => ({ accepted: true, code: null }) },
    elections: { openElection: async () => true },
  });
  setTreasuryServices(treasury);
  return Object.assign(fixture, { treasury, mode });
}

afterEach(() => {
  resetTreasuryServicesForTests();
  resetKnomosisFixture();
});

describe('WS-M charters + law-packs + profile', () => {
  it('publishes a charter, registers + adopts a law-pack, and serves the profile', async () => {
    const fixture = await wsmFixture();
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });

    const charter = await req('POST', `/rooms/${ROOM}/governance/charter`, cookie, {
      sections: SECTIONS,
    });
    expect(charter.status).toBe(201);
    const charterBody = (await charter.json()) as { content_hash: string };
    expect(charterBody.content_hash).toMatch(/^0x[0-9a-f]{64}$/);

    const registered = await req('POST', `/rooms/${ROOM}/governance/law-packs/wsm`, cookie, {
      document: LAW_PACK,
      fixtures: null,
    });
    expect(registered.status).toBe(201);
    const packBody = (await registered.json()) as { law_pack_id: string; hash_commitment: string };
    expect(packBody.hash_commitment).toMatch(/^[0-9a-f]{64}$/);

    const adopted = await req(
      'POST',
      `/rooms/${ROOM}/governance/law-packs/${packBody.law_pack_id}/adopt`,
      cookie,
    );
    expect(adopted.status).toBe(200);

    const history = await req('GET', `/rooms/${ROOM}/governance/law-packs/history`, cookie);
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as { versions: { published: boolean }[] };
    expect(historyBody.versions[0]?.published).toBe(true);

    const profile = await req('GET', `/rooms/${ROOM}/governance/profile`, cookie);
    expect(profile.status).toBe(200);
    const profileBody = (await profile.json()) as {
      profile: { law_pack_id: string | null; freeze_state: string };
    };
    expect(profileBody.profile.law_pack_id).toBe(packBody.law_pack_id);
    expect(profileBody.profile.freeze_state).toBe('active');
  });

  it('validates law-packs without publishing (dry run)', async () => {
    const fixture = await wsmFixture();
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await req('POST', `/rooms/${ROOM}/governance/law-packs/validate`, cookie, {
      document: { ...LAW_PACK, disallowedProposalTypes: ['capped_grant'] },
      fixtures: null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { structural_problems: unknown[] };
    expect(body.structural_problems.length).toBeGreaterThan(0);
  });
});

describe('WS-M readiness + mode transitions (extended)', () => {
  it('serves the per-item checklist with requiredFor semantics', async () => {
    const fixture = await wsmFixture();
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    const res = await req('GET', `/rooms/${ROOM}/governance/readiness?target_mode=testnet`, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      target_mode: string;
      ready: boolean;
      items: { requirement: string; status: string; required_for: string[] }[];
    };
    expect(body.target_mode).toBe('testnet');
    expect(body.ready).toBe(false);
    const audit = body.items.find((i) => i.requirement === 'external_audit_passed');
    expect(audit?.required_for).toEqual(['mature_production']);
  });

  it('supports the rollback edge simulated → ordinary (WS-M.1.1b)', async () => {
    const fixture = await wsmFixture();
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    const res = await req('POST', `/rooms/${ROOM}/governance/mode`, cookie, {
      target_mode: 'ordinary',
      reason: 'winding governance down',
    });
    expect(res.status).toBe(200);
    expect(fixture.mode.value).toBe('ordinary');
  });

  it('rejects mode skips through the full edge table', async () => {
    const fixture = await wsmFixture();
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    const res = await req('POST', `/rooms/${ROOM}/governance/mode`, cookie, {
      target_mode: 'mature_production',
      reason: 'skipping ahead',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('transition_not_permitted');
  });
});

describe('WS-M freeze + attestations', () => {
  it('a steward can freeze but not unfreeze; the profile reflects it', async () => {
    const fixture = await wsmFixture();
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    const freeze = await req('POST', `/rooms/${ROOM}/governance/freeze`, cookie, {
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: 'Anomalous treasury activity under review.',
    });
    expect(freeze.status).toBe(200);
    expect(((await freeze.json()) as { freeze_state: string }).freeze_state).toBe('frozen');
    const unfreeze = await req('POST', `/rooms/${ROOM}/governance/freeze`, cookie, {
      action: 'unfreeze',
      scope: 'room',
      source: 'steward',
      reason: 'All clear.',
    });
    expect(unfreeze.status).toBe(403);
  });

  it('safety-override attestations are steward-recordable; external audit is platform-only', async () => {
    const fixture = await wsmFixture();
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    expect(
      (
        await req('POST', `/rooms/${ROOM}/governance/attestations`, cookie, {
          item: 'safety_override_acknowledged',
          note: 'Platform-moderation supremacy acknowledged by the stewards.',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await req('POST', `/rooms/${ROOM}/governance/attestations`, cookie, {
          item: 'external_audit_passed',
          note: 'Self-certifying our own audit.',
        })
      ).status,
    ).toBe(403);
  });
});

describe('WS-M treasury + payment intents', () => {
  it('provisions the treasury, serves the dashboard, and creates idempotent intents', async () => {
    const fixture = await wsmFixture();
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    const created = await req('POST', `/rooms/${ROOM}/treasury`, cookie, {
      deployment_id: LOCAL_DEPLOYMENT.deployment_id,
      treasury_address: ADDRESS,
      accepted_assets: ['USDC'],
      deposit_limits: {
        per_user_per_period: '1000000',
        per_room_per_period: '10000000',
        per_deposit_max: '500000',
        period_seconds: 86_400,
      },
    });
    expect(created.status).toBe(201);

    const dashboard = await req('GET', `/rooms/${ROOM}/treasury/dashboard`, cookie);
    expect(dashboard.status).toBe(200);
    const dashboardBody = (await dashboard.json()) as {
      treasury: { treasury_address: string; reconciliation_state: string };
    };
    expect(dashboardBody.treasury.treasury_address).toBe(ADDRESS);
    expect(dashboardBody.treasury.reconciliation_state).toBe('pending');

    const key = crypto.randomUUID();
    const intent = await req('POST', `/rooms/${ROOM}/treasury/payment-intents`, cookie, {
      target_type: 'treasury_deposit',
      target_id: ROOM,
      asset: 'USDC',
      amount: '1000',
      idempotency_key: key,
    });
    expect(intent.status).toBe(201);
    const replay = await req('POST', `/rooms/${ROOM}/treasury/payment-intents`, cookie, {
      target_type: 'treasury_deposit',
      target_id: ROOM,
      asset: 'USDC',
      amount: '1000',
      idempotency_key: key,
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { existing: boolean }).existing).toBe(true);
  });

  it('the accounting export is steward-gated and versioned', async () => {
    const fixture = await wsmFixture();
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    await req('POST', `/rooms/${ROOM}/treasury`, cookie, {
      deployment_id: LOCAL_DEPLOYMENT.deployment_id,
      treasury_address: ADDRESS,
      accepted_assets: ['USDC'],
      deposit_limits: {
        per_user_per_period: '1000000',
        per_room_per_period: '10000000',
        per_deposit_max: '500000',
        period_seconds: 86_400,
      },
    });
    const res = await req(
      'GET',
      `/rooms/${ROOM}/treasury/export?period_start=2026-07-01T00:00:00.000Z&period_end=2026-08-01T00:00:00.000Z`,
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { export_schema_version: number; rows: unknown[] };
    expect(body.export_schema_version).toBe(1);
  });

  it('the audit-chain verification endpoint reports a valid chain', async () => {
    const fixture = await wsmFixture();
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    await req('POST', `/rooms/${ROOM}/governance/charter`, cookie, { sections: SECTIONS });
    const res = await req('GET', `/rooms/${ROOM}/governance/audit-chain`, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; chained_entries: number };
    expect(body.valid).toBe(true);
    expect(body.chained_entries).toBeGreaterThan(0);
  });
});
