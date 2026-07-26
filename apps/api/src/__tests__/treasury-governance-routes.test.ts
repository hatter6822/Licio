// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M route surface over the in-process Hono app with real sessions: the
// governance profile, charters, law-pack registration/adoption, attestations,
// freeze/pause, the EXTENDED readiness + full mode-transition machine, the
// real-asset treasury + payment intents, and the accounting export.

import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createInMemoryGovernanceStores } from '../governance/stores.js';
import { storeKnomosisConfigValue } from '../knomosis/config.js';
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

  it('governed rooms change charters via proposal, never the direct route (W10 review)', async () => {
    const fixture = await wsmFixture();
    fixture.mode.value = 'testnet';
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    const res = await req('POST', `/rooms/${ROOM}/governance/charter`, cookie, {
      sections: SECTIONS,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('proposal_required');
  });

  it('production delegation carries the verified + adult gates (W11 review)', async () => {
    const fixture = await wsmFixture();
    fixture.mode.value = 'testnet';
    const { cookie, userId } = await seedUserWithSession(fixture.identity, { steward: true });
    await fixture.identity.store.updateUser(userId, { ageBand: 'teen_16_17' });
    const res = await req('POST', `/rooms/${ROOM}/governance/delegations`, cookie, {
      delegate_user_id: crypto.randomUUID(),
      scope: { all: true },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('adult_required');
  });

  it('the tab bundle serves ACTIVE production proposals in their own shape (review-body)', async () => {
    const fixture = await wsmFixture();
    fixture.mode.value = 'testnet';
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    // An ACTIVE production spend row (USDC): the sim projection's SIM-* asset
    // contract would make the old single-shape tab response THROW.
    const productionId = crypto.randomUUID();
    await fixture.treasury.proposals.insert({
      proposalId: productionId,
      roomId: ROOM,
      proposerUserId: crypto.randomUUID(),
      proposalType: 'capped_grant',
      title: 'Fund the sprint',
      plainLanguageSummary: 'Pay a contributor.',
      requestedAmount: '500',
      asset: 'USDC',
      recipientRef: null,
      conflictDisclosures: 'None.',
      riskAssessment: 'Low.',
      requestedAction: { kind: 'grant' },
      expectedDeliverable: 'A deliverable.',
      preflightState: 'passed',
      votingState: 'open',
      challengeState: 'none',
      executionState: 'not_executed',
      simulationMode: false,
      executableAfter: null,
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: null,
      lawPackVersionId: crypto.randomUUID(),
      category: 'grant',
      deliberationEndsAt: null,
      votingEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
      challengeWindowEndsAt: null,
      tallySnapshot: null,
    });
    // A leftover SIMULATED practice row must stay OFF the production list.
    await fixture.treasury.proposals.insert({
      proposalId: crypto.randomUUID(),
      roomId: ROOM,
      proposerUserId: crypto.randomUUID(),
      proposalType: 'capped_grant',
      title: 'Practice round',
      plainLanguageSummary: 'Simulated.',
      requestedAmount: '10',
      asset: 'SIM-USD',
      recipientRef: null,
      conflictDisclosures: null,
      riskAssessment: 'Low.',
      requestedAction: {},
      expectedDeliverable: 'None.',
      preflightState: 'passed',
      votingState: 'open',
      challengeState: 'none',
      executionState: 'not_executed',
      simulationMode: true,
      executableAfter: null,
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: null,
      lawPackVersionId: null,
      category: null,
      deliberationEndsAt: null,
      votingEndsAt: null,
      challengeWindowEndsAt: null,
      tallySnapshot: null,
    });
    const tab = await req('GET', `/rooms/${ROOM}/governance`, cookie);
    expect(tab.status).toBe(200);
    const body = (await tab.json()) as {
      active_proposals: unknown[];
      active_production_proposals: { proposal_id: string; asset: string | null }[];
    };
    expect(body.active_proposals).toHaveLength(0);
    expect(body.active_production_proposals).toHaveLength(1);
    expect(body.active_production_proposals[0]?.proposal_id).toBe(productionId);
    expect(body.active_production_proposals[0]?.asset).toBe('USDC');
  });

  it('production proposal execution is adult-gated (review-body)', async () => {
    const fixture = await wsmFixture();
    fixture.mode.value = 'testnet';
    const { cookie, userId } = await seedUserWithSession(fixture.identity, { steward: true });
    await fixture.identity.store.updateUser(userId, { ageBand: 'teen_16_17' });
    const res = await req(
      'POST',
      `/rooms/${ROOM}/governance/proposals/${crypto.randomUUID()}/execute`,
      cookie,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('adult_required');
  });

  it('real-asset mode transitions are adult-gated (W12 review)', async () => {
    const fixture = await wsmFixture();
    const { cookie, userId } = await seedUserWithSession(fixture.identity, { steward: true });
    await fixture.identity.store.updateUser(userId, { ageBand: 'teen_16_17' });
    const res = await req('POST', `/rooms/${ROOM}/governance/mode`, cookie, {
      target_mode: 'testnet',
      reason: 'graduating',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('adult_required');
  });

  it('grant review clearance is verified+adult gated (sweep)', async () => {
    const fixture = await wsmFixture();
    fixture.mode.value = 'testnet';
    const { cookie, userId } = await seedUserWithSession(fixture.identity, { steward: true });
    await fixture.identity.store.updateUser(userId, { ageBand: 'teen_16_17' });
    const res = await req(
      'POST',
      `/rooms/${ROOM}/treasury/grants/${crypto.randomUUID()}/review`,
      cookie,
      { review_state: 'cleared' },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('adult_required');
  });

  it('grant milestone transitions are verified+adult gated (W12 review)', async () => {
    const fixture = await wsmFixture();
    fixture.mode.value = 'testnet';
    const { cookie, userId } = await seedUserWithSession(fixture.identity, { steward: true });
    await fixture.identity.store.updateUser(userId, { ageBand: 'teen_16_17' });
    const res = await req(
      'POST',
      `/rooms/${ROOM}/treasury/grants/${crypto.randomUUID()}/milestones/${crypto.randomUUID()}`,
      cookie,
      { state: 'accepted' },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('adult_required');
  });

  it('challenge resolution is verified+adult gated (W14)', async () => {
    const fixture = await wsmFixture();
    fixture.mode.value = 'testnet';
    const { cookie, userId } = await seedUserWithSession(fixture.identity, { steward: true });
    await fixture.identity.store.updateUser(userId, { ageBand: 'teen_16_17' });
    // Resolution clears the LAST execution blocker on a real-asset proposal —
    // a teen steward must not open the door another steward walks through.
    const res = await req(
      'POST',
      `/rooms/${ROOM}/governance/challenges/${crypto.randomUUID()}/resolve`,
      cookie,
      { resolution: 'dismissed', resolution_note: 'Should never reach the service.' },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('adult_required');
  });

  it('production proposal creation is adult-gated (W9 review)', async () => {
    const fixture = await wsmFixture();
    fixture.mode.value = 'testnet';
    const { cookie, userId } = await seedUserWithSession(fixture.identity, { steward: true });
    await fixture.identity.store.updateUser(userId, { ageBand: 'teen_16_17' });
    const res = await req('POST', `/rooms/${ROOM}/governance/proposals`, cookie, {
      proposal_type: 'capped_grant',
      title: 'Teen spend attempt',
      plain_language_summary: 'Should never reach the service.',
      category: 'grant',
      requested_amount: '100',
      asset: 'USDC',
      recipient_ref: 'coop:alpha',
      conflict_disclosures: 'None.',
      risk_assessment: 'Low.',
      requested_action: { kind: 'grant' },
      expected_deliverable: 'None.',
      idempotency_key: crypto.randomUUID(),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('adult_required');
  });

  it('the proposal DETAIL read returns the production shape in real-asset rooms (W7)', async () => {
    const fixture = await wsmFixture();
    fixture.mode.value = 'testnet';
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    const proposalId = crypto.randomUUID();
    await fixture.treasury.proposals.insert({
      proposalId,
      roomId: ROOM,
      proposerUserId: crypto.randomUUID(),
      proposalType: 'capped_grant',
      title: 'Fund the sprint',
      plainLanguageSummary: 'Pay a contributor.',
      requestedAmount: '500',
      asset: 'USDC',
      recipientRef: null,
      conflictDisclosures: 'None.',
      riskAssessment: 'Low.',
      requestedAction: { kind: 'grant' },
      expectedDeliverable: 'A deliverable.',
      preflightState: 'passed',
      votingState: 'deliberation',
      challengeState: 'none',
      executionState: 'not_executed',
      simulationMode: false,
      executableAfter: null,
      createdAt: new Date().toISOString(),
      executedAt: null,
      executionClaimedAt: null,
      lawPackVersionId: crypto.randomUUID(),
      category: 'grant',
      deliberationEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
      votingEndsAt: new Date(Date.now() + 7_200_000).toISOString(),
      challengeWindowEndsAt: null,
      tallySnapshot: null,
    });
    const detail = await req('GET', `/rooms/${ROOM}/governance/proposals/${proposalId}`, cookie);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      proposal: Record<string, unknown>;
    };
    // The PRODUCTION wire shape: lifecycle fields present, no sim vote block.
    expect(body.proposal['preflight_state']).toBe('passed');
    expect(body.proposal['law_pack_version_id']).toBeDefined();
    expect(body.proposal['votes']).toBeUndefined();
  });

  it('a stranger cannot advance someone else’s payment intent (PR #144 review)', async () => {
    const fixture = await wsmFixture({ steward: false });
    const owner = await seedUserWithSession(fixture.identity, { handle: 'intent_owner' });
    const stranger = await seedUserWithSession(fixture.identity, { handle: 'intent_stranger' });
    // Provision via the container directly (the fixture's rooms port treats
    // everyone as a member but NOT a steward here).
    const inserted = await fixture.treasury.treasuries.insert({
      treasuryId: crypto.randomUUID(),
      roomId: ROOM,
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      treasuryAddress: ADDRESS,
      acceptedAssets: ['USDC'],
      balanceSnapshot: null,
      balancesReconciledAt: null,
      depositLimits: {
        perUserPerPeriod: '1000000',
        perRoomPerPeriod: '10000000',
        perDepositMax: '500000',
        periodSeconds: 86_400,
      },
      freezeState: 'active',
      freezeReason: null,
      freezeCascade: false,
      pauseFlags: { deposits: false, proposals: false, executions: false },
      reconciliationState: 'pending',
      createdAt: new Date().toISOString(),
    });
    expect(inserted).not.toBeNull();
    const created = await req('POST', `/rooms/${ROOM}/treasury/payment-intents`, owner.cookie, {
      target_type: 'treasury_deposit',
      target_id: ROOM,
      asset: 'USDC',
      amount: '1000',
      idempotency_key: crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    const intentId = ((await created.json()) as { payment_intent_id: string }).payment_intent_id;

    // The stranger (member, not owner, not steward) cannot drive the lifecycle…
    const foreign = await req(
      'POST',
      `/rooms/${ROOM}/treasury/payment-intents/${intentId}/advance`,
      stranger.cookie,
      { step: 'preflight' },
    );
    expect(foreign.status).toBe(404);
    // …and a room mismatch 404s even for the owner.
    const wrongRoom = await req(
      'POST',
      `/rooms/${crypto.randomUUID()}/treasury/payment-intents/${intentId}/advance`,
      owner.cookie,
      { step: 'preflight' },
    );
    expect(wrongRoom.status).toBe(404);
    // The owner still advances it.
    const owned = await req(
      'POST',
      `/rooms/${ROOM}/treasury/payment-intents/${intentId}/advance`,
      owner.cookie,
      { step: 'preflight' },
    );
    expect(owned.status).toBe(200);
  });

  it('the ATTACH step bypasses the crypto gate; a mint step does not (bookkeeping vs. authorization)', async () => {
    const fixture = await wsmFixture();
    const owner = await seedUserWithSession(fixture.identity, { handle: 'attach_owner' });
    await fixture.treasury.treasuries.insert({
      treasuryId: crypto.randomUUID(),
      roomId: ROOM,
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      treasuryAddress: ADDRESS,
      acceptedAssets: ['USDC'],
      balanceSnapshot: null,
      balancesReconciledAt: null,
      depositLimits: {
        perUserPerPeriod: '1000000',
        perRoomPerPeriod: '10000000',
        perDepositMax: '500000',
        periodSeconds: 86_400,
      },
      freezeState: 'active',
      freezeReason: null,
      freezeCascade: false,
      pauseFlags: { deposits: false, proposals: false, executions: false },
      reconciliationState: 'pending',
      createdAt: new Date().toISOString(),
    });
    const created = await req('POST', `/rooms/${ROOM}/treasury/payment-intents`, owner.cookie, {
      target_type: 'treasury_deposit',
      target_id: ROOM,
      asset: 'USDC',
      amount: '1000',
      idempotency_key: crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    const intentId = ((await created.json()) as { payment_intent_id: string }).payment_intent_id;
    // Crypto is disabled AFTER the intent exists (an operator pausing between
    // submit and the client's attach call).
    await storeKnomosisConfigValue(fixture.knomosis.configStore, 'cryptoEnabled', false);
    await fixture.knomosis.reloadConfig();
    // A MINT step (preflight) is blocked by the crypto gate…
    const pf = await req(
      'POST',
      `/rooms/${ROOM}/treasury/payment-intents/${intentId}/advance`,
      owner.cookie,
      { step: 'preflight' },
    );
    expect(pf.status).toBe(503);
    expect(((await pf.json()) as { error: { code: string } }).error.code).toBe('crypto_disabled');
    // …but the ATTACH (signed + action_record_id) is BOOKKEEPING for money the
    // WS-L submit already placed on chain, so it bypasses the mint-only gate: it
    // reaches attachIntentSubmission (which 404s an unknown action id here), and
    // is NEVER refused crypto_disabled.
    const attach = await req(
      'POST',
      `/rooms/${ROOM}/treasury/payment-intents/${intentId}/advance`,
      owner.cookie,
      { step: 'signed', action_record_id: crypto.randomUUID() },
    );
    expect(attach.status).not.toBe(503);
  });

  it('the public intent path is deposit-class only (PR #144 review)', async () => {
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
    const payout = await req('POST', `/rooms/${ROOM}/treasury/payment-intents`, cookie, {
      target_type: 'grant_payout',
      target_id: ROOM,
      asset: 'USDC',
      amount: '1000',
      idempotency_key: crypto.randomUUID(),
    });
    expect(payout.status).toBe(403);
    expect(((await payout.json()) as { error: { code: string } }).error.code).toBe(
      'target_not_allowed',
    );
  });

  it('staff cannot bootstrap WS-M state for a room the gate refuses (W15)', async () => {
    const fixture = await wsmFixture({ steward: false });
    // The port answers null for p2p and unknown rooms (WS-S §8): freeze,
    // pause, and attestations all CREATE profile/attestation state, so the
    // staff bypass must still resolve the room first.
    Object.assign(fixture.knomosis.rooms ?? {}, {
      roomGovernance: async () => null,
    });
    const staff = await seedUserWithSession(fixture.identity, { admin: true });
    const freeze = await req('POST', `/rooms/${ROOM}/governance/freeze`, staff.cookie, {
      action: 'freeze',
      scope: 'room',
      source: 'platform_security',
      reason: 'not a server room',
    });
    expect(freeze.status).toBe(404);
    const pause = await req('POST', `/rooms/${ROOM}/governance/pause`, staff.cookie, {
      deposits: true,
      reason: 'not a server room',
    });
    expect(pause.status).toBe(404);
    const attest = await req('POST', `/rooms/${ROOM}/governance/attestations`, staff.cookie, {
      item: 'external_audit_passed',
      note: 'not a server room',
    });
    expect(attest.status).toBe(404);
  });

  // STEWARD_ROLES.md: "`ROLE_INTEGRITY` owns the cross-room surface and can
  // `room-governance-freeze` / `treasury-freeze` any room's agent", with
  // treasury scope additionally "Requires counsel co-approval" (WS-A.1.2c).
  describe('cross-room freeze carries the doctrine capability', () => {
    it('refuses a cross-room TREASURY freeze — counsel co-approval is unprovable today', async () => {
      // Fail-closed, and deliberately so: proving a SECOND person consented needs
      // an authenticated approval bound to this room and reason, which does not
      // exist yet (tracked in docs/treasury/README.md).  Accepting a
      // client-named counsel id would have recorded an approval nobody gave.
      const fixture = await wsmFixture({ steward: false });
      const staff = await seedUserWithSession(fixture.identity, { admin: true });
      const res = await req('POST', `/rooms/${ROOM}/governance/freeze`, staff.cookie, {
        action: 'freeze',
        scope: 'treasury',
        source: 'platform_security',
        reason: 'suspected drain',
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'co_approval_required',
      );
    });

    it('ALLOWS a cross-room ROOM freeze, which cascades onto the treasury', async () => {
      // So the emergency capability is never stranded by the refusal above: a
      // room-scope freeze halts the treasury too (`freezeCascade`).
      const fixture = await wsmFixture({ steward: false });
      const staff = await seedUserWithSession(fixture.identity, { admin: true });
      const res = await req('POST', `/rooms/${ROOM}/governance/freeze`, staff.cookie, {
        action: 'freeze',
        scope: 'room',
        source: 'platform_security',
        reason: 'governance paused pending review',
      });
      expect(res.status).toBe(200);
    });

    it('does NOT demand co-approval to CLEAR a treasury hold', async () => {
      // Doctrine attaches co-approval to placing a hold; requiring it to lift one
      // could strand a room whose counsel is unavailable.  Reaching the domain
      // (`no_treasury` on this fixture) proves the gate let the unfreeze through.
      const fixture = await wsmFixture({ steward: false });
      const staff = await seedUserWithSession(fixture.identity, { admin: true });
      const res = await req('POST', `/rooms/${ROOM}/governance/freeze`, staff.cookie, {
        action: 'unfreeze',
        scope: 'treasury',
        source: 'platform_security',
        reason: 'investigation closed',
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('no_treasury');
    });

    // The two grants are DISJOINT in the doctrine — ROLE_SAFETY holds `restrict`
    // and neither freeze; ROLE_INTEGRITY holds both freezes and not `restrict`.
    // Every test above seeds `admin`, which implicitly holds all five roles and
    // therefore cannot tell the two authorities apart.  These do.
    it('lets a ROLE_SAFETY operator (platform staff, no freeze grant) LIFT a hold', async () => {
      // `setGovernanceFreeze`'s contract is "only platform staff may UNFREEZE",
      // and platform staff IS the `restrict` capability.  Keying the precheck on
      // the freeze capability 404'd exactly this operator.
      const fixture = await wsmFixture({ steward: false });
      const safety = await seedUserWithSession(fixture.identity, {
        handle: 'safety_only',
        stewardRoles: ['ROLE_SAFETY'],
      });
      const res = await req('POST', `/rooms/${ROOM}/governance/freeze`, safety.cookie, {
        action: 'unfreeze',
        scope: 'treasury',
        source: 'platform_security',
        reason: 'investigation closed',
      });
      // Reaching the domain (`no_treasury` on this fixture) proves the route
      // gate let it through; a 404 `not_found` would be the regression.
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('no_treasury');
    });

    it('refuses that same operator a cross-room FREEZE — 403, not 404', async () => {
      // They have business on this endpoint (they lift holds), so the existence
      // check must not hide the room from them; PLACING a hold is the narrower
      // ROLE_INTEGRITY capability and is refused on its merits.
      const fixture = await wsmFixture({ steward: false });
      const safety = await seedUserWithSession(fixture.identity, {
        handle: 'safety_only_freeze',
        stewardRoles: ['ROLE_SAFETY'],
      });
      const res = await req('POST', `/rooms/${ROOM}/governance/freeze`, safety.cookie, {
        action: 'freeze',
        scope: 'room',
        source: 'platform_security',
        reason: 'not my capability',
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'insufficient_capability',
      );
    });

    it('lets a ROLE_INTEGRITY operator (freeze grant, no `restrict`) place AND lift', async () => {
      const fixture = await wsmFixture({ steward: false });
      const integrity = await seedUserWithSession(fixture.identity, {
        handle: 'integrity_only',
        stewardRoles: ['ROLE_INTEGRITY'],
      });
      const placed = await req('POST', `/rooms/${ROOM}/governance/freeze`, integrity.cookie, {
        action: 'freeze',
        scope: 'room',
        source: 'platform_security',
        reason: 'governance paused pending review',
      });
      expect(placed.status).toBe(200);
      // And back out again: `isPlatformStaff` is `restrict`, which this actor
      // does NOT hold, so the domain would refuse without the route vouching for
      // the cross-room authority it just verified.
      const lifted = await req('POST', `/rooms/${ROOM}/governance/freeze`, integrity.cookie, {
        action: 'unfreeze',
        scope: 'room',
        source: 'platform_security',
        reason: 'review complete',
      });
      expect(lifted.status).toBe(200);
      expect((await lifted.json()) as { freeze_state: string }).toMatchObject({
        freeze_state: 'active',
      });
    });

    it('404s a plain member rather than leaking that the room exists', async () => {
      const fixture = await wsmFixture({ steward: false });
      const { cookie } = await seedUserWithSession(fixture.identity, { handle: 'plain_one' });
      const res = await req('POST', `/rooms/${ROOM}/governance/freeze`, cookie, {
        action: 'freeze',
        scope: 'room',
        source: 'steward',
        reason: 'not mine to freeze',
      });
      expect(res.status).toBe(404);
    });

    it("leaves the room's OWN steward able to stop its treasury unaided", async () => {
      // ELECTED_ROOM_STEWARD is deliberately outside the platform ROLE_*
      // namespace; the cross-room rule governs acting on rooms you do NOT
      // steward.  Unfreeze still requires platform staff, so a room can stop its
      // own bleeding but never release itself.
      const fixture = await wsmFixture(); // every user is the room's steward here
      const { cookie } = await seedUserWithSession(fixture.identity, { handle: 'room_steward' });
      const res = await req('POST', `/rooms/${ROOM}/governance/freeze`, cookie, {
        action: 'freeze',
        scope: 'treasury',
        source: 'steward',
        reason: 'pausing while we investigate',
      });
      // Reaches the domain with no co-approver — the gate never fired.
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('no_treasury');
    });
  });

  it('platform staff reach the mode machine without room stewardship (PR #144 review)', async () => {
    const fixture = await wsmFixture({ steward: false });
    const staff = await seedUserWithSession(fixture.identity, { admin: true });
    // NOT a 404: the staff account passes the precheck and the edge table
    // answers (an unknown/simulated→simulated edge is a clean 409 here).
    const outcome = await req('POST', `/rooms/${ROOM}/governance/mode`, staff.cookie, {
      target_mode: 'simulated',
      reason: 'platform recovery drill',
    });
    expect(outcome.status).not.toBe(404);
    // A plain member still 404s (no steward oracle).
    const member = await seedUserWithSession(fixture.identity, { handle: 'plain_member' });
    const blocked = await req('POST', `/rooms/${ROOM}/governance/mode`, member.cookie, {
      target_mode: 'simulated',
      reason: 'not mine to move',
    });
    expect(blocked.status).toBe(404);
  });

  it('grant review clearance is a reviewer authority, not mere membership (W3)', async () => {
    const fixture = await wsmFixture({ steward: false });
    const member = await seedUserWithSession(fixture.identity, { handle: 'grant_member' });
    const review = await req(
      'POST',
      `/rooms/${ROOM}/treasury/grants/${crypto.randomUUID()}/review`,
      member.cookie,
      { review_state: 'cleared' },
    );
    // A joined member without steward/platform authority never reaches the
    // service (404-over-403, no reviewer oracle).
    expect(review.status).toBe(404);
  });

  it('a frozen room cannot provision a treasury (PR #144 review)', async () => {
    const fixture = await wsmFixture();
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    const frozen = await req('POST', `/rooms/${ROOM}/governance/freeze`, cookie, {
      action: 'freeze',
      scope: 'room',
      source: 'steward',
      reason: 'incident under review',
    });
    expect(frozen.status).toBe(200);
    const blocked = await req('POST', `/rooms/${ROOM}/treasury`, cookie, {
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
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
      'governance_frozen',
    );
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
