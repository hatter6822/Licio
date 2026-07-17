// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L route surface (over the in-process Hono app): the fail-closed
// availability gate (crypto flag off ⇒ 503; wallet kill switch ⇒ 503), the
// adult + step-up guards, deployment/manifest reads, the full wallet-link HTTP
// flow with REAL SIWE, action access control (404-over-403), and the
// kill-switch admin surface (steward-gated).

import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { hashFinancialWalletAddress } from '../identity/siwe.js';
import { createV1Routes } from '../routes/v1.js';
import { resetTreasuryServicesForTests, setTreasuryServices } from '../treasury/services.js';
import { seedUserWithSession } from './event-test-helpers.js';
import {
  freshKnomosisServices,
  type KnomosisFixture,
  LOCAL_DEPLOYMENT,
  resetKnomosisFixture,
  signedSiweLink,
  signedTypedData,
  testAccount,
} from './knomosis-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

async function post(path: string, cookie: string, body: unknown) {
  return app().request(
    new Request(`http://localhost/v1${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function get(path: string, cookie: string, headers: Record<string, string> = {}) {
  return app().request(
    new Request(`http://localhost/v1${path}`, { headers: { cookie, ...headers } }),
  );
}

afterEach(() => resetKnomosisFixture());

describe('availability gate (fail-closed)', () => {
  it('wallet nonce is 503 when the crypto flag is off', async () => {
    const fixture = await freshKnomosisServices({ cryptoEnabled: false });
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await post('/wallet/nonce', cookie, {});
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('crypto_disabled');
  });

  it('the feature-flags route reflects the runtime crypto flag', async () => {
    await freshKnomosisServices({ cryptoEnabled: true, governanceEnabled: true });
    const res = await get('/feature-flags', '');
    const body = (await res.json()) as { cryptoEnabled: boolean; governanceEnabled: boolean };
    expect(body.cryptoEnabled).toBe(true);
    expect(body.governanceEnabled).toBe(true);
    // And OFF when disabled.
    resetKnomosisFixture();
    await freshKnomosisServices({ cryptoEnabled: false, governanceEnabled: false });
    const off = (await (await get('/feature-flags', '')).json()) as { cryptoEnabled: boolean };
    expect(off.cryptoEnabled).toBe(false);
  });
});

describe('wallet HTTP flow (WS-L.2)', () => {
  async function linkOverHttp(cookie: string) {
    const nonceRes = await post('/wallet/nonce', cookie, {});
    expect(nonceRes.status).toBe(200);
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    const signed = await signedSiweLink(nonce, testAccount);
    return post('/wallet/link', cookie, {
      message: signed.message,
      signature: signed.signature,
    });
  }

  it('links a wallet end-to-end and lists it (no full address on the wire)', async () => {
    const fixture = await freshKnomosisServices();
    const { cookie } = await seedUserWithSession(fixture.identity);
    const link = await linkOverHttp(cookie);
    expect(link.status).toBe(201);
    const linkBody = await link.text();
    expect(linkBody.toLowerCase()).not.toContain(testAccount.address.toLowerCase());

    const list = await get('/wallets', cookie);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: Array<{ label: string; risk_state: string }> };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]?.label).toBe('Wallet 1');
    expect(listBody.items[0]?.risk_state).toBe('pending');
  });

  it('risk-state is owner-scoped (404-over-403 for another user)', async () => {
    const fixture = await freshKnomosisServices();
    const owner = await seedUserWithSession(fixture.identity, { handle: 'own1' });
    await linkOverHttp(owner.cookie);
    const wallets = (await (await get('/wallets', owner.cookie)).json()) as {
      items: Array<{ wallet_account_id: string }>;
    };
    const walletId = wallets.items[0]?.wallet_account_id as string;

    const attacker = await seedUserWithSession(fixture.identity, { handle: 'att1' });
    const res = await get(`/wallets/${walletId}/risk-state`, attacker.cookie);
    expect(res.status).toBe(404);
  });

  it('PATCH relabels, GET risk-state succeeds for the owner, and unlink schedules', async () => {
    const fixture = await freshKnomosisServices();
    const owner = await seedUserWithSession(fixture.identity, { handle: 'own2' });
    await linkOverHttp(owner.cookie);
    const wallets = (await (await get('/wallets', owner.cookie)).json()) as {
      items: Array<{ wallet_account_id: string }>;
    };
    const walletId = wallets.items[0]?.wallet_account_id as string;

    // PATCH label.
    const patch = await app().request(
      new Request(`http://localhost/v1/wallets/${walletId}`, {
        method: 'PATCH',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Cold storage' }),
      }),
    );
    expect(patch.status).toBe(200);

    // Owner risk-state read succeeds (fail-closed `pending`).
    const risk = await get(`/wallets/${walletId}/risk-state`, owner.cookie);
    expect(risk.status).toBe(200);
    const riskBody = (await risk.json()) as { risk_state: string };
    expect(riskBody.risk_state).toBe('pending');

    // Unlink with no obligations schedules the cooling-off.
    const unlink = await post('/wallet/unlink/request', owner.cookie, {
      wallet_account_id: walletId,
    });
    expect(unlink.status).toBe(200);
    const unlinkBody = (await unlink.json()) as { unlink_state: string };
    expect(unlinkBody.unlink_state).toBe('pending_unlink');
  });

  it('a region block bars a NEW link but never traps an existing wallet (WS-N.1.1c)', async () => {
    const fixture = await freshKnomosisServices();
    const { cookie } = await seedUserWithSession(fixture.identity, { handle: 'reg1' });
    // Linked while the region allowed it…
    expect((await linkOverHttp(cookie)).status).toBe(201);
    const walletId = (
      (await (await get('/wallets', cookie)).json()) as {
        items: Array<{ wallet_account_id: string }>;
      }
    ).items[0]?.wallet_account_id as string;
    // …then the region's policy disables the `wallet_connection` cell.
    fixture.knomosis.compliance = {
      ...fixture.knomosis.compliance,
      jurisdiction: async ({ featureCell }) =>
        featureCell === 'wallet_connection' ? 'blocked' : 'allowed',
    };
    // A NEW connection is barred — nonce (and by the same gate, link)…
    const nonce = await post('/wallet/nonce', cookie, {});
    expect(nonce.status).toBe(503);
    expect(((await nonce.json()) as { error: { code: string } }).error.code).toBe(
      'wallet_region_blocked',
    );
    // …but the member can still LIST, read risk, and — the point — UNLINK the
    // wallet they already linked (the region block never strands it).
    expect((await get('/wallets', cookie)).status).toBe(200);
    expect((await get(`/wallets/${walletId}/risk-state`, cookie)).status).toBe(200);
    const unlink = await post('/wallet/unlink/request', cookie, { wallet_account_id: walletId });
    expect(unlink.status).toBe(200);
  });
});

describe('deployments + manifest (WS-L.1.1a-1)', () => {
  it('lists active deployments and serves the manifest (domain-separation source)', async () => {
    const fixture = await freshKnomosisServices();
    const { cookie } = await seedUserWithSession(fixture.identity);
    const list = await get('/knomosis/deployments', cookie);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { deployments: Array<{ deployment_id: string }> };
    expect(body.deployments.length).toBeGreaterThan(0);
    const deploymentId = body.deployments[0]?.deployment_id as string;

    const manifest = await get(`/knomosis/deployments/${deploymentId}/manifest`, cookie);
    expect(manifest.status).toBe(200);
    const manifestBody = (await manifest.json()) as {
      verifying_contract_address: string;
      contract_allowlist: string[];
      chain_id: number;
    };
    expect(manifestBody.verifying_contract_address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(manifestBody.contract_allowlist).toContain(manifestBody.verifying_contract_address);
  });

  it('deployments are 503 under the crypto flag off', async () => {
    const fixture = await freshKnomosisServices({ cryptoEnabled: false });
    const { cookie } = await seedUserWithSession(fixture.identity);
    expect((await get('/knomosis/deployments', cookie)).status).toBe(503);
  });
});

describe('kill-switch admin (WS-L.3.5f, steward-gated)', () => {
  it('a non-steward cannot read/activate; a steward can', async () => {
    const fixture = await freshKnomosisServices();
    const user = await seedUserWithSession(fixture.identity, { handle: 'plain1' });
    const notSteward = await get('/knomosis/admin/killswitch', user.cookie);
    expect(notSteward.status).toBe(403);

    const steward = await seedUserWithSession(fixture.identity, { handle: 'stew1', steward: true });
    const read = await get('/knomosis/admin/killswitch', steward.cookie);
    expect(read.status).toBe(200);
    const body = (await read.json()) as { switches: unknown[] };
    expect(body.switches).toHaveLength(5);

    const activate = await app().request(
      new Request('http://localhost/v1/knomosis/admin/killswitch', {
        method: 'PUT',
        headers: { cookie: steward.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'activate',
          switch_id: 'wallet_connection',
          scopes: { global: true, regions: [], room_ids: [] },
          release_card: {
            owner: 'op',
            trigger_condition: 'incident',
            rollback_path: 'runbook',
            review_date: '2026-08-01T00:00:00.000Z',
          },
          reason: 'drill',
        }),
      }),
    );
    expect(activate.status).toBe(200);
    // With the wallet kill switch global-on, wallet nonce degrades to 503.
    const nonce = await post('/wallet/nonce', user.cookie, {});
    expect(nonce.status).toBe(503);
    const nonceBody = (await nonce.json()) as { error: { code: string } };
    expect(nonceBody.error.code).toBe('wallet_disabled');
  });

  async function admin(cookie: string, body: unknown) {
    return app().request(
      new Request('http://localhost/v1/knomosis/admin/killswitch', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  it('two-person deactivation over HTTP: request then a DIFFERENT steward confirms', async () => {
    const fixture = await freshKnomosisServices();
    const opA = await seedUserWithSession(fixture.identity, { handle: 'opA', steward: true });
    const opB = await seedUserWithSession(fixture.identity, { handle: 'opB', steward: true });
    await admin(opA.cookie, {
      action: 'activate',
      switch_id: 'action_submission',
      scopes: { global: true, regions: [], room_ids: [] },
      release_card: {
        owner: 'opA',
        trigger_condition: 'incident',
        rollback_path: 'runbook',
        review_date: '2026-08-01T00:00:00.000Z',
      },
      reason: 'drill',
    });
    const requested = await admin(opA.cookie, {
      action: 'request_deactivation',
      switch_id: 'action_submission',
      reason: 'resolved',
    });
    expect(requested.status).toBe(200);
    // The SAME operator cannot confirm (403 same_operator).
    const sameOp = await admin(opA.cookie, {
      action: 'confirm_deactivation',
      switch_id: 'action_submission',
      reason: 'confirm',
    });
    expect(sameOp.status).toBe(403);
    // A DIFFERENT steward confirms.
    const confirmed = await admin(opB.cookie, {
      action: 'confirm_deactivation',
      switch_id: 'action_submission',
      reason: 'confirm',
    });
    expect(confirmed.status).toBe(200);
  });

  it('a manifest for an unknown deployment is 404', async () => {
    const fixture = await freshKnomosisServices();
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await get(
      '/knomosis/deployments/00000000-0000-4000-8000-000000000000/manifest',
      cookie,
    );
    expect(res.status).toBe(404);
  });

  it('confirming a deactivation with no pending request is 409', async () => {
    const fixture = await freshKnomosisServices();
    const op = await seedUserWithSession(fixture.identity, { handle: 'opC', steward: true });
    await admin(op.cookie, {
      action: 'activate',
      switch_id: 'governance_voting',
      scopes: { global: true, regions: [], room_ids: [] },
      release_card: {
        owner: 'opC',
        trigger_condition: 'incident',
        rollback_path: 'runbook',
        review_date: '2026-08-01T00:00:00.000Z',
      },
      reason: 'drill',
    });
    const res = await admin(op.cookie, {
      action: 'confirm_deactivation',
      switch_id: 'governance_voting',
      reason: 'confirm without a request',
    });
    expect(res.status).toBe(409);
  });
});

describe('additional fail-closed route branches', () => {
  it('the receipts endpoint is 503 under the crypto flag off', async () => {
    const fixture = await freshKnomosisServices({ cryptoEnabled: false });
    const { cookie } = await seedUserWithSession(fixture.identity);
    expect((await get('/knomosis/receipts', cookie)).status).toBe(503);
  });

  it('unlink with an open obligation is blocked (409 with the obligation list)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId, cookie } = await seedUserWithSession(fixture.identity, { handle: 'obl1' });
    const nonceRes = await post('/wallet/nonce', cookie, {});
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    const signed = await signedSiweLink(nonce, testAccount);
    await post('/wallet/link', cookie, { message: signed.message, signature: signed.signature });
    const list = (await (await get('/wallets', cookie)).json()) as {
      items: Array<{ wallet_account_id: string }>;
    };
    const walletId = list.items[0]?.wallet_account_id as string;
    // Seed a non-terminal signed action against the wallet ⇒ an obligation.
    await fixture.knomosis.actions.insert({
      actionRecordId: crypto.randomUUID(),
      deploymentId: LOCAL_DEPLOYMENT.deployment_id,
      actionType: 'treasury_deposit',
      roomId: crypto.randomUUID(),
      actorWalletAccountId: walletId,
      actorUserId: userId,
      payloadHash: `0x${'11'.repeat(32)}`,
      typedDataHash: `0x${'11'.repeat(32)}`,
      signedAction: { message: {}, signature: '0x' },
      submissionState: 'accepted',
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: crypto.randomUUID(),
      paymentIntentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const unlink = await post('/wallet/unlink/request', cookie, { wallet_account_id: walletId });
    expect(unlink.status).toBe(409);
    const body = (await unlink.json()) as { blocking_obligations: unknown[] };
    expect(body.blocking_obligations.length).toBeGreaterThan(0);
  });

  it('caps the blocked-unlink obligation list at the schema max (409, never 500)', async () => {
    const fixture = await freshKnomosisServices();
    const { userId, cookie } = await seedUserWithSession(fixture.identity, { handle: 'obl2' });
    const nonceRes = await post('/wallet/nonce', cookie, {});
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    const signed = await signedSiweLink(nonce, testAccount);
    await post('/wallet/link', cookie, { message: signed.message, signature: signed.signature });
    const list = (await (await get('/wallets', cookie)).json()) as {
      items: Array<{ wallet_account_id: string }>;
    };
    const walletId = list.items[0]?.wallet_account_id as string;
    // Seed 150 non-terminal obligations — MORE than the 100 the response caps at.
    for (let i = 0; i < 150; i++) {
      await fixture.knomosis.actions.insert({
        actionRecordId: crypto.randomUUID(),
        deploymentId: LOCAL_DEPLOYMENT.deployment_id,
        actionType: 'treasury_deposit',
        roomId: crypto.randomUUID(),
        actorWalletAccountId: walletId,
        actorUserId: userId,
        payloadHash: `0x${'11'.repeat(32)}`,
        typedDataHash: `0x${i.toString(16).padStart(64, '0')}`,
        signedAction: { message: {}, signature: '0x' },
        submissionState: 'accepted',
        failureReason: null,
        indexedEventRef: null,
        reconciliationState: 'pending',
        idempotencyKey: crypto.randomUUID(),
        paymentIntentId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    const unlink = await post('/wallet/unlink/request', cookie, { wallet_account_id: walletId });
    // A usable 409 blocked response — NOT a 500 from the schema `.max(100)`.
    expect(unlink.status).toBe(409);
    const body = (await unlink.json()) as {
      blocking_obligations: unknown[];
      total_obligations: number;
    };
    expect(body.blocking_obligations.length).toBe(100);
    expect(body.total_obligations).toBe(150);
  });
});

describe('preflight → submit → status → standing → receipts over HTTP', () => {
  const ROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function depositMessage(deploymentId: string): Record<string, string> {
    return {
      roomId: ROOM,
      treasuryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      asset: 'USDC',
      amount: '1000000',
      actor: testAccount.address,
      nonce: '1',
      expiration: String(Math.floor(Date.now() / 1000) + 600),
      deploymentId,
    };
  }

  async function linkAndMapWallet(fixture: KnomosisFixture, userId: string): Promise<string> {
    const walletAccountId = fixture.knomosis.uuid();
    await fixture.knomosis.wallets.insert({
      walletAccountId,
      userId,
      addressHashHex: hashFinancialWalletAddress(
        fixture.knomosis.masterSecret,
        testAccount.address.toLowerCase(),
      ),
      addressTruncated: '0x1234…5678',
      chainId: LOCAL_DEPLOYMENT.chain_id,
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
    return walletAccountId;
  }

  it('drives the full signed-action lifecycle over the BFF', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const walletAccountId = await linkAndMapWallet(fixture, userId);
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const message = depositMessage(deploymentId);
    const signature = await signedTypedData('treasury_deposit', message);

    const preflight = await post('/knomosis/actions/preflight', cookie, {
      action_type: 'treasury_deposit',
      room_id: ROOM,
      deployment_id: deploymentId,
      wallet_account_id: walletAccountId,
      typed_data_message: message,
      signature,
    });
    expect(preflight.status).toBe(200);
    const preflightBody = (await preflight.json()) as {
      result: string;
      preflight_token?: string;
    };
    expect(preflightBody.result).toBe('pass');

    const submit = await post('/knomosis/actions/submit', cookie, {
      preflight_token: preflightBody.preflight_token,
      idempotency_key: crypto.randomUUID(),
      action_type: 'treasury_deposit',
      room_id: ROOM,
      deployment_id: deploymentId,
      wallet_account_id: walletAccountId,
      typed_data_message: message,
      signature,
    });
    expect(submit.status).toBe(202);
    const submitBody = (await submit.json()) as {
      action_record_id: string;
      submission_state: string;
    };
    expect(submitBody.submission_state).toBe('accepted');

    // Action status is owner-readable.
    const status = await get(`/knomosis/actions/${submitBody.action_record_id}`, cookie);
    expect(status.status).toBe(200);

    // The submission recorded the actor mapping, so standing resolves.
    const standing = await get(`/knomosis/standing/${walletAccountId}/${deploymentId}`, cookie);
    expect(standing.status).toBe(200);
    const standingBody = (await standing.json()) as { balances: Record<string, string> };
    expect(standingBody.balances['USDC']).toBe('1000000');

    // Private receipts are owner-scoped (empty until ingestion finalizes, but
    // the endpoint is reachable and returns a typed shape).
    const receipts = await get('/knomosis/receipts', cookie);
    expect(receipts.status).toBe(200);
  });

  it('a REPLAYED submit rebuilds a lost actor mapping (R10-5)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const walletAccountId = await linkAndMapWallet(fixture, userId);
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const message = depositMessage(deploymentId);
    const signature = await signedTypedData('treasury_deposit', message);
    const idem = crypto.randomUUID();
    const preflight = await post('/knomosis/actions/preflight', cookie, {
      action_type: 'treasury_deposit',
      room_id: ROOM,
      deployment_id: deploymentId,
      wallet_account_id: walletAccountId,
      typed_data_message: message,
      signature,
    });
    const pf = (await preflight.json()) as { preflight_token?: string };
    const submitBody = {
      idempotency_key: idem,
      action_type: 'treasury_deposit',
      room_id: ROOM,
      deployment_id: deploymentId,
      wallet_account_id: walletAccountId,
      typed_data_message: message,
      signature,
    };
    const submit1 = await post('/knomosis/actions/submit', cookie, {
      ...submitBody,
      preflight_token: pf.preflight_token,
    });
    expect(submit1.status).toBe(202);
    // The mapping is LOST (e.g. the original ensureActorMapping side effect failed
    // or the process died before it ran).
    await fixture.knomosis.actorMappings.clear();
    const gone = await get(`/knomosis/standing/${walletAccountId}/${deploymentId}`, cookie);
    expect(gone.status).not.toBe(200); // no_actor_mapping
    // A retry with the SAME idempotency key REPLAYS and rebuilds the mapping from
    // the stored (validated) signed action.  The idempotency replay short-circuits
    // BEFORE the preflight token is consumed, so any schema-valid token stands in.
    const submit2 = await post('/knomosis/actions/submit', cookie, {
      ...submitBody,
      preflight_token: 'replayed-token-stand-in',
    });
    expect(submit2.status).toBe(202);
    const standing = await get(`/knomosis/standing/${walletAccountId}/${deploymentId}`, cookie);
    expect(standing.status).toBe(200);
  });

  it('a retry REPLAYS even after a kill switch engages — gates are for NEW actions', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const walletAccountId = await linkAndMapWallet(fixture, userId);
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const message = depositMessage(deploymentId);
    const signature = await signedTypedData('treasury_deposit', message);
    const idem = crypto.randomUUID();
    const preflight = await post('/knomosis/actions/preflight', cookie, {
      action_type: 'treasury_deposit',
      room_id: ROOM,
      deployment_id: deploymentId,
      wallet_account_id: walletAccountId,
      typed_data_message: message,
      signature,
    });
    const pf = (await preflight.json()) as { preflight_token?: string };
    const submitBody = {
      idempotency_key: idem,
      action_type: 'treasury_deposit',
      room_id: ROOM,
      deployment_id: deploymentId,
      wallet_account_id: walletAccountId,
      typed_data_message: message,
      signature,
    };
    const first = await post('/knomosis/actions/submit', cookie, {
      ...submitBody,
      preflight_token: pf.preflight_token,
    });
    expect(first.status).toBe(202);
    const original = ((await first.json()) as { action_record_id: string }).action_record_id;

    // The response is lost; meanwhile an incident engages the kill switch.
    await fixture.knomosis.configStore.set('knomosis.killswitch.action_submission', {
      value: { engaged: true, scope: 'global' },
    });
    // The retry has ALREADY submitted — its action exists and may be on chain.
    // Re-gating it would answer a question that no longer applies and hand the
    // client a 503 instead of the action id, stranding the intent.
    const retry = await post('/knomosis/actions/submit', cookie, {
      ...submitBody,
      preflight_token: pf.preflight_token,
    });
    expect(retry.status).toBe(202);
    expect(((await retry.json()) as { action_record_id: string }).action_record_id).toBe(original);

    // …while a NEW submission still meets the switch.
    const fresh = await post('/knomosis/actions/submit', cookie, {
      ...submitBody,
      idempotency_key: crypto.randomUUID(),
      preflight_token: pf.preflight_token,
    });
    expect(fresh.status).toBe(503);
  });

  it('standing FAILS CLOSED when a gate trips between the balances and budget reads (O3)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const walletAccountId = await linkAndMapWallet(fixture, userId);
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    await fixture.knomosis.actorMappings.put({
      walletAccountId,
      deploymentId,
      actorId: testAccount.address.toLowerCase(),
      createdAt: new Date().toISOString(),
    });
    // `resolveActor` reads the wallet ONCE per standing dimension.  Let the FIRST read
    // (balances) see the ACTIVE wallet and the SECOND (budget) see it UNLINKED —
    // modelling the wallet being unlinked BETWEEN the two reads within one request.
    const realGetById = fixture.knomosis.wallets.getById.bind(fixture.knomosis.wallets);
    let reads = 0;
    fixture.knomosis.wallets.getById = async (id: string) => {
      reads += 1;
      const w = await realGetById(id);
      return reads >= 2 && w !== null ? { ...w, unlinkState: 'pending_unlink' as const } : w;
    };
    const res = await get(`/knomosis/standing/${walletAccountId}/${deploymentId}`, cookie);
    // Fail closed: 404 (wallet_not_active) — NOT 200 leaking balances with budget:null.
    expect(res.status).toBe(404);
  });

  it('a REPLAY of a FAILED (unvalidated) reservation does NOT rebuild the mapping (F8)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const walletAccountId = await linkAndMapWallet(fixture, userId);
    const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
    const message = depositMessage(deploymentId);
    const idem = crypto.randomUUID();
    // A stored action that FAILED a submit gate before forwarding — its `actor` is
    // the caller's UNVERIFIED payload value (the reviewer's attack shape).
    await fixture.knomosis.actions.insert({
      actionRecordId: crypto.randomUUID(),
      deploymentId,
      actionType: 'treasury_deposit',
      roomId: ROOM,
      actorWalletAccountId: walletAccountId,
      actorUserId: userId,
      payloadHash: '0x',
      typedDataHash: `0x${'cd'.repeat(32)}`,
      signedAction: { message, signature: '0x' },
      submissionState: 'failed',
      failureReason: 'preflight token missing/expired/used',
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: idem,
      paymentIntentId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Clear the mapping so we can detect whether the replay wrongly recreates it.
    await fixture.knomosis.actorMappings.clear();
    const signature = await signedTypedData('treasury_deposit', message);
    const submit = await post('/knomosis/actions/submit', cookie, {
      preflight_token: 'replayed-token-stand-in',
      idempotency_key: idem,
      action_type: 'treasury_deposit',
      room_id: ROOM,
      deployment_id: deploymentId,
      wallet_account_id: walletAccountId,
      typed_data_message: message,
      signature,
    });
    // The replay returns the stored (failed) state, but the route must NOT rebuild
    // an actor mapping from an unvalidated `failed` row — so standing stays unmapped.
    expect(submit.status).toBe(202);
    const standing = await get(`/knomosis/standing/${walletAccountId}/${deploymentId}`, cookie);
    expect(standing.status).not.toBe(200);
  });

  describe('a claimed payment_intent_id must BE this transfer (WS-N.2.2c)', () => {
    /** A treasury intent store the test drives directly. */
    function wireIntent(
      intent: Record<string, unknown> | null,
      grant: Record<string, unknown> | null = null,
    ) {
      setTreasuryServices({
        intents: { getById: async () => intent },
        // The payout recipient binding (WS-M) resolves the grant to check the
        // signed recipient BEFORE the action forwards; deposit intents never
        // reach it (bindPayoutRecipient returns early for non-payouts).
        grants: { getById: async () => grant },
        wallets: { listByUser: async () => [] },
        masterSecret: 'test-secret',
      } as never);
    }

    const liveIntent = (overrides: Record<string, unknown> = {}) => ({
      paymentIntentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      userId: null,
      roomId: ROOM,
      // The signed deposit message names this treasury; the intent must be for
      // the SAME target, not merely the same room/asset/amount.  (A deposit's
      // target IS its treasury — the payout classes name their own row.)
      targetType: 'treasury_deposit',
      treasuryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      targetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      asset: 'USDC',
      amount: '1000000',
      executionState: 'quoted',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...overrides,
    });

    afterEach(() => {
      resetTreasuryServicesForTests();
    });

    async function preflightClaiming(
      intentId: string,
      overrides: Record<string, unknown> = {},
    ): Promise<Response> {
      const fixture = await freshKnomosisServices();
      fixture.knomosis.rooms = {
        roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
        isMember: async () => true,
        isSteward: async () => false,
        contentVisibleToUser: async () => true,
      };
      const { userId, cookie } = await seedUserWithSession(fixture.identity);
      const walletAccountId = await linkAndMapWallet(fixture, userId);
      const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
      const message = depositMessage(deploymentId);
      wireIntent(liveIntent({ userId, ...overrides }));
      return await post('/knomosis/actions/preflight', cookie, {
        action_type: 'treasury_deposit',
        room_id: ROOM,
        deployment_id: deploymentId,
        wallet_account_id: walletAccountId,
        payment_intent_id: intentId,
        typed_data_message: message,
        signature: await signedTypedData('treasury_deposit', message),
      });
    }

    const INTENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    it('accepts the intent that matches the signed transfer', async () => {
      const res = await preflightClaiming(INTENT);
      expect(res.status).toBe(200);
    });

    it('rejects an intent for a DIFFERENT amount — the clearance-theft path', async () => {
      // The attack the verification exists to stop: a member whose high-value
      // intent for amount X was cleared names that id on a later transfer.  The
      // review case key names the same subject and amount, so `createCase` would
      // hand the new transfer the OLD cleared case and it would skip review.
      const res = await preflightClaiming(INTENT, { amount: '999' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'intent_mismatch',
      );
    });

    it('rejects another member’s intent, a different room, asset, or TARGET', async () => {
      for (const overrides of [
        { userId: '11111111-1111-4111-8111-111111111111' },
        { roomId: '22222222-2222-4222-8222-222222222222' },
        { asset: 'DAI' },
        // A cleared intent for ANOTHER target in the same room, for the same
        // asset and amount, must not cover this transfer.
        { treasuryId: '33333333-3333-4333-8333-333333333333' },
        { targetType: 'grant_payout' },
      ]) {
        const res = await preflightClaiming(INTENT, overrides);
        expect(res.status).toBe(400);
      }
    });

    it('accepts a steward_compensation intent settling through a grant_payout action', async () => {
      // The pairing is NOT the identity: a raw `targetType === actionType`
      // comparison rejected this valid payout, so its reviewer-cleared review
      // could never be reused and the compensation stayed held.
      const fixture = await freshKnomosisServices();
      fixture.knomosis.rooms = {
        roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
        isMember: async () => true,
        isSteward: async () => true,
        contentVisibleToUser: async () => true,
      };
      const { userId, cookie } = await seedUserWithSession(fixture.identity);
      const walletAccountId = await linkAndMapWallet(fixture, userId);
      const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
      const message: Record<string, string> = {
        roomId: ROOM,
        grantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        recipient: testAccount.address,
        asset: 'USDC',
        amount: '1000000',
        actor: testAccount.address,
        nonce: '7',
        expiration: String(Math.floor(Date.now() / 1000) + 600),
        deploymentId,
      };
      wireIntent(
        {
          paymentIntentId: INTENT,
          userId,
          roomId: ROOM,
          targetType: 'steward_compensation',
          targetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          treasuryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          asset: 'USDC',
          amount: '1000000',
          executionState: 'quoted',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        // The backing grant approves the signed recipient (address match).
        { recipientRef: testAccount.address.toLowerCase(), payoutState: 'active' },
      );
      const res = await post('/knomosis/actions/preflight', cookie, {
        action_type: 'grant_payout',
        room_id: ROOM,
        deployment_id: deploymentId,
        wallet_account_id: walletAccountId,
        payment_intent_id: INTENT,
        typed_data_message: message,
        signature: await signedTypedData('grant_payout', message),
      });
      // Not `intent_mismatch`: the claim is honoured (the action may still fail
      // its own gates, but never on the intent pairing).
      expect(res.status).not.toBe(400);
    });

    it('rejects a payout claim whose signed recipient is NOT the approved grant recipient — before it forwards (thread knomosis.ts:181)', async () => {
      const fixture = await freshKnomosisServices();
      fixture.knomosis.rooms = {
        roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
        isMember: async () => true,
        isSteward: async () => true,
        contentVisibleToUser: async () => true,
      };
      const { userId, cookie } = await seedUserWithSession(fixture.identity);
      const walletAccountId = await linkAndMapWallet(fixture, userId);
      const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
      // The steward signs a payout to their OWN address, but the grant approved a
      // DIFFERENT recipient.  Without the pre-forward binding this passes the
      // intent claim (target/amount/asset match), the WS-L action forwards, and
      // only the later attach catches it — after the money moved.
      const message: Record<string, string> = {
        roomId: ROOM,
        grantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        recipient: testAccount.address, // the steward's own address
        asset: 'USDC',
        amount: '1000000',
        actor: testAccount.address,
        nonce: '7',
        expiration: String(Math.floor(Date.now() / 1000) + 600),
        deploymentId,
      };
      wireIntent(
        {
          paymentIntentId: INTENT,
          userId,
          roomId: ROOM,
          targetType: 'grant_payout',
          targetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          treasuryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          asset: 'USDC',
          amount: '1000000',
          executionState: 'quoted',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        // The grant approved a DIFFERENT address.
        { recipientRef: `0x${'ab'.repeat(20)}`, payoutState: 'active' },
      );
      const res = await post('/knomosis/actions/preflight', cookie, {
        action_type: 'grant_payout',
        room_id: ROOM,
        deployment_id: deploymentId,
        wallet_account_id: walletAccountId,
        payment_intent_id: INTENT,
        typed_data_message: message,
        signature: await signedTypedData('grant_payout', message),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'action_mismatch',
      );
    });

    it('does not hand another member’s action to whoever quotes their intent id', async () => {
      // The retry lookup keys on the intent, so the claim must be AUTHORIZED
      // before it is trusted as evidence of a retry.  Otherwise a caller who
      // merely knows someone else's intent id is treated as its retry, skips
      // the ownership check that would have stopped them, collides on the
      // intent unique, and is handed that member's action id and state.
      const res = await preflightClaiming(INTENT, {
        userId: '11111111-1111-4111-8111-111111111111', // NOT the caller
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'intent_mismatch',
      );
    });

    it('a room-owned payout: a STEWARD may claim it, a non-steward may NOT (WS-N.2.3d)', async () => {
      // A null-owner payout is authorized by STEWARDSHIP, not ownership — the
      // check lives in the identity block so the submit retry replay (which skips
      // the pipeline's steward gate) cannot hand a non-steward the steward's
      // action id/state by merely naming the intent.
      async function payoutClaim(isSteward: boolean): Promise<Response> {
        const fixture = await freshKnomosisServices();
        fixture.knomosis.rooms = {
          roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
          isMember: async () => true,
          isSteward: async () => isSteward,
          contentVisibleToUser: async () => true,
        };
        const { userId, cookie } = await seedUserWithSession(fixture.identity);
        const walletAccountId = await linkAndMapWallet(fixture, userId);
        const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
        const message: Record<string, string> = {
          roomId: ROOM,
          grantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          recipient: testAccount.address,
          asset: 'USDC',
          amount: '1000000',
          actor: testAccount.address,
          nonce: '7',
          expiration: String(Math.floor(Date.now() / 1000) + 600),
          deploymentId,
        };
        wireIntent(
          {
            paymentIntentId: INTENT,
            userId: null, // ROOM-OWNED: authorized by stewardship alone
            roomId: ROOM,
            targetType: 'grant_payout',
            targetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            treasuryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            asset: 'USDC',
            amount: '1000000',
            executionState: 'quoted',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
          // The grant approves the signed recipient (the non-steward is denied
          // earlier, on the stewardship pairing, before this binding).
          { recipientRef: testAccount.address.toLowerCase(), payoutState: 'active' },
        );
        return await post('/knomosis/actions/preflight', cookie, {
          action_type: 'grant_payout',
          room_id: ROOM,
          deployment_id: deploymentId,
          wallet_account_id: walletAccountId,
          payment_intent_id: INTENT,
          typed_data_message: message,
          signature: await signedTypedData('grant_payout', message),
        });
      }
      // A steward's claim is honoured (it may still fail a later gate, never on
      // the intent pairing); a non-steward is rejected on the pairing itself.
      expect((await payoutClaim(true)).status).not.toBe(400);
      const denied = await payoutClaim(false);
      expect(denied.status).toBe(400);
      expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
        'intent_mismatch',
      );
    });

    it('a room-owned payout: the ORIGINAL actor may replay their submit after their role is revoked', async () => {
      const fixture = await freshKnomosisServices();
      fixture.knomosis.rooms = {
        roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
        isMember: async () => true,
        isSteward: async () => false, // role REVOKED after they submitted
        contentVisibleToUser: async () => true,
      };
      const { userId, cookie } = await seedUserWithSession(fixture.identity);
      const walletAccountId = await linkAndMapWallet(fixture, userId);
      const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
      const message: Record<string, string> = {
        roomId: ROOM,
        grantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        recipient: testAccount.address,
        asset: 'USDC',
        amount: '1000000',
        actor: testAccount.address,
        nonce: '7',
        expiration: String(Math.floor(Date.now() / 1000) + 600),
        deploymentId,
      };
      const key = crypto.randomUUID();
      // The steward ALREADY submitted this room-owned payout — the action is theirs.
      await fixture.knomosis.actions.insert({
        actionRecordId: crypto.randomUUID(),
        deploymentId,
        actionType: 'grant_payout',
        roomId: ROOM,
        actorWalletAccountId: walletAccountId,
        actorUserId: userId,
        payloadHash: `0x${'11'.repeat(32)}`,
        typedDataHash: `0x${'22'.repeat(32)}`,
        signedAction: { message, signature: `0x${'a'.repeat(130)}` },
        submissionState: 'submitted',
        failureReason: null,
        indexedEventRef: null,
        reconciliationState: 'pending',
        idempotencyKey: key,
        paymentIntentId: INTENT,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      wireIntent({
        paymentIntentId: INTENT,
        userId: null, // ROOM-OWNED
        roomId: ROOM,
        targetType: 'grant_payout',
        targetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        treasuryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        asset: 'USDC',
        amount: '1000000',
        executionState: 'signed',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
      // The lost-response retry is authorized by IDEMPOTENCY OWNERSHIP (their own
      // action), not current stewardship, so it REPLAYS the action id/status
      // instead of being denied intent_mismatch by the revoked role.
      const retry = await post('/knomosis/actions/submit', cookie, {
        preflight_token: 'replayed-token-stand-in',
        idempotency_key: key,
        action_type: 'grant_payout',
        room_id: ROOM,
        deployment_id: deploymentId,
        wallet_account_id: walletAccountId,
        payment_intent_id: INTENT,
        typed_data_message: message,
        signature: `0x${'a'.repeat(130)}`,
      });
      expect(retry.status).toBe(202);
      const body = (await retry.json()) as { submission_state?: string };
      expect(body.submission_state).toBe('submitted');
    });

    it('a room-owned payout: the ORIGINAL actor may replay even after their action FAILED and their role was revoked (thread knomosis.ts:138)', async () => {
      const fixture = await freshKnomosisServices();
      fixture.knomosis.rooms = {
        roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
        isMember: async () => true,
        isSteward: async () => false, // role REVOKED
        contentVisibleToUser: async () => true,
      };
      const { userId, cookie } = await seedUserWithSession(fixture.identity);
      const walletAccountId = await linkAndMapWallet(fixture, userId);
      const deploymentId = LOCAL_DEPLOYMENT.deployment_id;
      const message: Record<string, string> = {
        roomId: ROOM,
        grantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        recipient: testAccount.address,
        asset: 'USDC',
        amount: '1000000',
        actor: testAccount.address,
        nonce: '7',
        expiration: String(Math.floor(Date.now() / 1000) + 600),
        deploymentId,
      };
      const key = crypto.randomUUID();
      // Their submit reached the gateway and FAILED before the response landed —
      // a DEAD (`failed`) action the LIVE lookup skips.  The authz must still
      // recognize them as the original actor (via own-idempotency / all-state),
      // or the retry gets `intent_mismatch` before it can replay the failed status.
      await fixture.knomosis.actions.insert({
        actionRecordId: crypto.randomUUID(),
        deploymentId,
        actionType: 'grant_payout',
        roomId: ROOM,
        actorWalletAccountId: walletAccountId,
        actorUserId: userId,
        payloadHash: `0x${'11'.repeat(32)}`,
        typedDataHash: `0x${'22'.repeat(32)}`,
        signedAction: { message, signature: `0x${'a'.repeat(130)}` },
        submissionState: 'failed',
        failureReason: 'GATEWAY_TIMEOUT',
        indexedEventRef: null,
        reconciliationState: 'pending',
        idempotencyKey: key,
        paymentIntentId: INTENT,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      wireIntent({
        paymentIntentId: INTENT,
        userId: null, // ROOM-OWNED
        roomId: ROOM,
        targetType: 'grant_payout',
        targetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        treasuryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        asset: 'USDC',
        amount: '1000000',
        executionState: 'signed',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
      const retry = await post('/knomosis/actions/submit', cookie, {
        preflight_token: 'replayed-token-stand-in',
        idempotency_key: key,
        action_type: 'grant_payout',
        room_id: ROOM,
        deployment_id: deploymentId,
        wallet_account_id: walletAccountId,
        payment_intent_id: INTENT,
        typed_data_message: message,
        signature: `0x${'a'.repeat(130)}`,
      });
      // Authorized (NOT `intent_mismatch`) and replays the failed status so they
      // can learn the fate of a transfer that may be on chain.
      expect(retry.status).toBe(202);
      const body = (await retry.json()) as { submission_state?: string };
      expect(body.submission_state).toBe('failed');
    });

    it('rejects an intent past the pre-submission window, or expired', async () => {
      // `submitted` and beyond: the intent's action already exists, so naming it
      // in a NEW preflight would resurrect a spent clearance.
      expect((await preflightClaiming(INTENT, { executionState: 'submitted' })).status).toBe(400);
      expect(
        (await preflightClaiming(INTENT, { expiresAt: new Date(Date.now() - 1).toISOString() }))
          .status,
      ).toBe(400);
    });

    it('rejects an intent that does not exist', async () => {
      const fixture = await freshKnomosisServices();
      fixture.knomosis.rooms = {
        roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
        isMember: async () => true,
        isSteward: async () => false,
        contentVisibleToUser: async () => true,
      };
      const { userId, cookie } = await seedUserWithSession(fixture.identity);
      const walletAccountId = await linkAndMapWallet(fixture, userId);
      const message = depositMessage(LOCAL_DEPLOYMENT.deployment_id);
      wireIntent(null);
      const res = await post('/knomosis/actions/preflight', cookie, {
        action_type: 'treasury_deposit',
        room_id: ROOM,
        deployment_id: LOCAL_DEPLOYMENT.deployment_id,
        wallet_account_id: walletAccountId,
        payment_intent_id: INTENT,
        typed_data_message: message,
        signature: await signedTypedData('treasury_deposit', message),
      });
      expect(res.status).toBe(400);
    });
  });

  it('a preflight failure returns a typed reason (unknown action type)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Test Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const walletAccountId = await linkAndMapWallet(fixture, userId);
    const preflight = await post('/knomosis/actions/preflight', cookie, {
      action_type: 'pay_to_rank',
      room_id: ROOM,
      deployment_id: LOCAL_DEPLOYMENT.deployment_id,
      wallet_account_id: walletAccountId,
      typed_data_message: {},
      signature: `0x${'00'.repeat(65)}`,
    });
    expect(preflight.status).toBe(200);
    const body = (await preflight.json()) as { result: string; reason_code?: string };
    expect(body.result).toBe('fail');
    expect(body.reason_code).toBe('ACTION_TYPE_UNKNOWN');
  });
});
