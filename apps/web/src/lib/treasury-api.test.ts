// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M BFF client: every response is zod-validated before the cache, the
// mode-aware unions discriminate correctly (production vs simulated shapes),
// a blocked mode transition surfaces the server's LIVE unmet list as the
// typed error, and malformed responses fail closed as ApiClientError.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, resetApiClientState } from './api.js';
import {
  advancePaymentIntent,
  createCharter,
  createPaymentIntent,
  createProductionProposal,
  executeProposal,
  fetchAccountingExport,
  fetchAuditChainVerification,
  fetchCharterHistory,
  fetchDelegations,
  fetchGovernanceProfile,
  fetchGrants,
  fetchPaymentIntent,
  fetchProposals,
  fetchReadinessForTarget,
  fetchTreasuryTab,
  fileChallenge,
  isProductionProposal,
  isSimTreasury,
  ModeTransitionBlockedError,
  recordAttestation,
  requestModeTransition,
  setGovernanceFreeze,
  signProposal,
  updateGrantMilestone,
} from './treasury-api.js';

const ROOM = '77777777-7777-4777-8777-777777777777';
const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route-table fetch mock (mirrors wallet-api.test.ts); serves the CSRF token. */
function mockRoutes(routes: Record<string, (body: unknown, url: URL) => Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.includes('/api/csrf-token')) return jsonResponse({ token: 'csrf-token' });
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return jsonResponse({ error: { code: 'not_found', message: 'no route' } }, 404);
    return handler(body, url);
  }) as unknown as typeof fetch;
}

const PRODUCTION_PROPOSAL = {
  proposal_id: '11111111-1111-4111-8111-111111111111',
  room_id: ROOM,
  proposer_user_id: null,
  proposal_type: 'capped_grant',
  title: 'Fund the survey',
  plain_language_summary: 'Pay for the survey.',
  category: 'grant',
  requested_amount: '1000000',
  asset: 'USDC',
  recipient_ref: 'coop',
  conflict_disclosures: null,
  risk_assessment: 'Low.',
  requested_action: {},
  expected_deliverable: 'Report.',
  law_pack_version_id: null,
  preflight_state: 'passed',
  voting_state: 'open',
  challenge_state: 'none',
  execution_state: 'not_executed',
  tally: null,
  deliberation_ends_at: null,
  voting_ends_at: null,
  challenge_window_ends_at: null,
  executable_after: null,
  created_at: '2026-07-01T00:00:00.000Z',
  executed_at: null,
};

const SIM_PROPOSAL = {
  proposal_id: '22222222-2222-4222-8222-222222222222',
  room_id: ROOM,
  proposer_user_id: null,
  proposal_type: 'capped_grant',
  title: 'Practice',
  plain_language_summary: 'A practice run.',
  requested_amount: null,
  asset: null,
  recipient_ref: null,
  conflict_disclosures: null,
  risk_assessment: 'None.',
  requested_action: {},
  expected_deliverable: 'Practice.',
  preflight_state: 'passed',
  voting_state: 'open',
  challenge_state: 'none',
  execution_state: 'not_executed',
  votes_approve: 1,
  votes_reject: 0,
  votes_abstain: 0,
  executable_after: null,
  simulation_mode: true,
  created_at: '2026-07-01T00:00:00.000Z',
  executed_at: null,
};

beforeEach(() => resetApiClientState());
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('WS-M treasury client (zod-validated, mode-aware)', () => {
  it('parses the governance profile and rejects a malformed shape', async () => {
    mockRoutes({
      [`GET /v1/rooms/${ROOM}/governance/profile`]: () =>
        jsonResponse({
          profile: {
            room_id: ROOM,
            governance_mode: 'testnet',
            law_pack_id: null,
            charter_version_id: null,
            treasury_id: null,
            freeze_state: 'active',
            freeze_reason: null,
            pause_flags: { deposits: false, proposals: false, executions: false },
            updated_at: '2026-07-01T00:00:00.000Z',
          },
        }),
    });
    const profile = await fetchGovernanceProfile(ROOM);
    expect(profile.profile.governance_mode).toBe('testnet');

    mockRoutes({
      [`GET /v1/rooms/${ROOM}/governance/profile`]: () =>
        jsonResponse({ profile: { room_id: ROOM } }),
    });
    await expect(fetchGovernanceProfile(ROOM)).rejects.toBeInstanceOf(ApiClientError);
  });

  it('forwards the target mode on the readiness read', async () => {
    mockRoutes({
      [`GET /v1/rooms/${ROOM}/governance/readiness`]: (_body, url) =>
        jsonResponse({
          room_id: ROOM,
          current_mode: 'simulated',
          target_mode: url.searchParams.get('target_mode') ?? 'testnet',
          ready: false,
          unmet: [],
          items: [],
        }),
    });
    const explicit = await fetchReadinessForTarget(ROOM, 'mature_production');
    expect(explicit.target_mode).toBe('mature_production');
    const defaulted = await fetchReadinessForTarget(ROOM);
    expect(defaulted.target_mode).toBe('testnet');
  });

  it('surfaces a blocked mode transition as the typed unmet-list error', async () => {
    mockRoutes({
      [`POST /v1/rooms/${ROOM}/governance/mode`]: () =>
        jsonResponse(
          {
            error: { code: 'not_ready', message: 'Requirements unmet.' },
            unmet: [{ requirement: 'external_audit_passed', description: 'Audit missing.' }],
          },
          409,
        ),
    });
    const outcome = requestModeTransition(ROOM, { target_mode: 'testnet', reason: 'go' });
    await expect(outcome).rejects.toBeInstanceOf(ModeTransitionBlockedError);
    await outcome.catch((error: ModeTransitionBlockedError) => {
      expect(error.code).toBe('not_ready');
      expect(error.unmet[0]?.description).toBe('Audit missing.');
    });
  });

  it('resolves a successful mode transition and rejects an unknown target locally', async () => {
    mockRoutes({
      [`POST /v1/rooms/${ROOM}/governance/mode`]: (body) => {
        expect((body as { target_mode: string }).target_mode).toBe('testnet');
        return jsonResponse({ governance_mode: 'testnet' });
      },
    });
    const result = await requestModeTransition(ROOM, { target_mode: 'testnet', reason: 'go' });
    expect(result.governance_mode).toBe('testnet');
    // The shared request schema rejects an unknown target BEFORE any network I/O.
    await expect(
      requestModeTransition(ROOM, { target_mode: 'warp_speed', reason: 'go' }),
    ).rejects.toThrow();
  });

  it('discriminates the mode-aware treasury union', async () => {
    mockRoutes({
      [`GET /v1/rooms/${ROOM}/governance/treasury`]: () =>
        jsonResponse({
          room_id: ROOM,
          simulation_label: 'SIMULATED — NO REAL VALUE',
          balances: [],
          updated_at: '2026-07-01T00:00:00.000Z',
        }),
    });
    const sim = await fetchTreasuryTab(ROOM);
    expect(isSimTreasury(sim)).toBe(true);

    mockRoutes({
      [`GET /v1/rooms/${ROOM}/governance/treasury`]: () => jsonResponse({ treasury: null }),
    });
    const production = await fetchTreasuryTab(ROOM);
    expect(isSimTreasury(production)).toBe(false);
  });

  it('discriminates production vs simulated proposals in one list', async () => {
    mockRoutes({
      [`GET /v1/rooms/${ROOM}/governance/proposals`]: () =>
        jsonResponse({ proposals: [PRODUCTION_PROPOSAL] }),
    });
    const production = await fetchProposals(ROOM);
    expect(production).toHaveLength(1);
    const first = production[0];
    expect(first !== undefined && isProductionProposal(first)).toBe(true);

    mockRoutes({
      [`GET /v1/rooms/${ROOM}/governance/proposals`]: () =>
        jsonResponse({ proposals: [SIM_PROPOSAL] }),
    });
    const simulated = await fetchProposals(ROOM);
    const firstSim = simulated[0];
    expect(firstSim !== undefined && isProductionProposal(firstSim)).toBe(false);
  });

  it('creates payment intents and advances them (quote rides back)', async () => {
    const intentId = '33333333-3333-4333-8333-333333333333';
    mockRoutes({
      [`POST /v1/rooms/${ROOM}/treasury/payment-intents`]: (body) => {
        expect((body as { target_type: string }).target_type).toBe('treasury_deposit');
        return jsonResponse({ payment_intent_id: intentId, existing: false }, 201);
      },
      [`POST /v1/rooms/${ROOM}/treasury/payment-intents/${intentId}/advance`]: (body) => {
        const step = (body as { step: string }).step;
        return jsonResponse(
          step === 'quote'
            ? { execution_state: 'quoted', quote: { estimated_fee: '1000' } }
            : { execution_state: 'preflighted' },
        );
      },
    });
    const created = await createPaymentIntent(ROOM, {
      target_type: 'treasury_deposit',
      target_id: intentId,
      asset: 'USDC',
      amount: '1500000',
      idempotency_key: '44444444-4444-4444-8444-444444444444',
    });
    expect(created.existing).toBe(false);
    expect((await advancePaymentIntent(ROOM, intentId, 'preflight')).execution_state).toBe(
      'preflighted',
    );
    const quoted = await advancePaymentIntent(ROOM, intentId, 'quote');
    expect(quoted.quote).toEqual({ estimated_fee: '1000' });
  });

  it('parses the sign response (weight snapshot + live tally)', async () => {
    const proposalId = PRODUCTION_PROPOSAL.proposal_id;
    mockRoutes({
      [`POST /v1/rooms/${ROOM}/governance/proposals/${proposalId}/sign`]: () =>
        jsonResponse({
          signature_id: '55555555-5555-4555-8555-555555555555',
          weight_snapshot: '1',
          eligibility_reason: 'eligible',
          tally: {
            outcome: 'open',
            quorum_met: false,
            approve: '1',
            reject: '0',
            abstain: '0',
            distinct_voters: 1,
            turnout: 0.25,
          },
        }),
    });
    const result = await signProposal(ROOM, proposalId, {
      purpose: 'vote',
      choice: 'approve',
      deployment_id: '66666666-6666-4666-8666-666666666666',
      wallet_account_id: '99999999-9999-4999-8999-999999999999',
      typed_data_message: { roomId: ROOM },
      signature: `0x${'ab'.repeat(65)}`,
    });
    expect(result.weight_snapshot).toBe('1');
    expect(result.tally.outcome).toBe('open');
  });

  it('parses the audit-chain verification verdict', async () => {
    mockRoutes({
      [`GET /v1/rooms/${ROOM}/governance/audit-chain`]: () =>
        jsonResponse({ valid: false, chained_entries: 12, problems: ['entry x: tampered'] }),
    });
    const verdict = await fetchAuditChainVerification(ROOM);
    expect(verdict.valid).toBe(false);
    expect(verdict.problems).toHaveLength(1);
  });

  it('round-trips the charter, attestation, and freeze writes', async () => {
    const TEXT = 'This section is written in plain language for every member.';
    const SECTIONS = {
      purpose: TEXT,
      decision_making: TEXT,
      fund_management: TEXT,
      member_rights: TEXT,
      dispute_resolution: TEXT,
      amendment_process: TEXT,
      safety_override_acknowledgment: TEXT,
      appeals_path: TEXT,
    };
    mockRoutes({
      [`POST /v1/rooms/${ROOM}/governance/charter`]: () =>
        jsonResponse(
          {
            charter_version_id: '11111111-1111-4111-8111-111111111111',
            version: 1,
            content_hash: `0x${'ab'.repeat(32)}`,
          },
          201,
        ),
      [`GET /v1/rooms/${ROOM}/governance/charter`]: () =>
        jsonResponse({
          versions: [
            {
              charter_version_id: '11111111-1111-4111-8111-111111111111',
              room_id: ROOM,
              version: 1,
              sections: SECTIONS,
              content_hash: `0x${'ab'.repeat(32)}`,
              created_by_user_id: null,
              created_at: '2026-07-01T00:00:00.000Z',
            },
          ],
        }),
      [`POST /v1/rooms/${ROOM}/governance/attestations`]: (body) => {
        expect((body as { item: string }).item).toBe('external_audit_passed');
        return jsonResponse({ ok: true }, 201);
      },
      [`POST /v1/rooms/${ROOM}/governance/freeze`]: (body) => {
        expect((body as { action: string }).action).toBe('freeze');
        return jsonResponse({ freeze_state: 'frozen' });
      },
    });
    const created = await createCharter(ROOM, { sections: SECTIONS });
    expect(created.version).toBe(1);
    expect(await fetchCharterHistory(ROOM)).toHaveLength(1);
    await recordAttestation(ROOM, { item: 'external_audit_passed', note: 'passed' });
    expect(
      (
        await setGovernanceFreeze(ROOM, {
          action: 'freeze',
          scope: 'room',
          source: 'steward',
          reason: 'incident',
        })
      ).freeze_state,
    ).toBe('frozen');
  });

  it('reads grants, delegations, one intent, and the accounting export', async () => {
    const grantId = '11111111-1111-4111-8111-111111111111';
    const milestoneId = '22222222-2222-4222-8222-222222222222';
    const intentId = '33333333-3333-4333-8333-333333333333';
    mockRoutes({
      [`GET /v1/rooms/${ROOM}/treasury/grants`]: () =>
        jsonResponse({
          grants: [
            {
              grant_id: grantId,
              room_id: ROOM,
              treasury_id: intentId,
              proposal_id: PRODUCTION_PROPOSAL.proposal_id,
              recipient_ref: 'coop',
              purpose: 'Survey',
              amount: '1000',
              asset: 'USDC',
              milestones: [
                {
                  milestone_id: milestoneId,
                  description: 'All',
                  amount: '1000',
                  state: 'pending',
                  payment_intent_id: null,
                },
              ],
              milestone_state: 'pending',
              review_state: 'pending',
              payout_state: 'not_started',
              audit_summary: null,
              created_at: '2026-07-01T00:00:00.000Z',
            },
          ],
        }),
      [`POST /v1/rooms/${ROOM}/treasury/grants/${grantId}/milestones/${milestoneId}`]: () =>
        jsonResponse({ milestone_state: 'accepted' }),
      [`GET /v1/rooms/${ROOM}/governance/delegations`]: () =>
        jsonResponse({
          delegations: [
            {
              delegation_id: '44444444-4444-4444-8444-444444444444',
              room_id: ROOM,
              delegator_user_id: null,
              delegate_user_id: null,
              scope: { all: true },
              state: 'active',
              created_at: '2026-07-01T00:00:00.000Z',
              revoked_at: null,
            },
          ],
        }),
      [`GET /v1/rooms/${ROOM}/treasury/payment-intents/${intentId}`]: () =>
        jsonResponse({
          intent: {
            payment_intent_id: intentId,
            user_id: '55555555-5555-4555-8555-555555555555',
            room_id: ROOM,
            target_type: 'treasury_deposit',
            target_id: intentId,
            asset: 'USDC',
            amount: '100',
            jurisdiction_state: 'allowed',
            compliance_state: 'cleared',
            execution_state: 'finalized',
            retry_count: 0,
            action_record_id: null,
            receipt_id: null,
            expires_at: '2026-07-01T00:00:00.000Z',
            created_at: '2026-07-01T00:00:00.000Z',
            updated_at: '2026-07-01T00:00:00.000Z',
          },
        }),
      [`GET /v1/rooms/${ROOM}/treasury/export`]: (_body, url) => {
        expect(url.searchParams.get('period_start')).toBe('2026-07-01T00:00:00.000Z');
        return jsonResponse({
          treasury_id: intentId,
          period_start: '2026-07-01T00:00:00.000Z',
          period_end: '2026-07-02T00:00:00.000Z',
          export_schema_version: 1,
          rows: [],
          excluded_unreconciled: 2,
        });
      },
    });
    expect((await fetchGrants(ROOM))[0]?.purpose).toBe('Survey');
    expect(
      (await updateGrantMilestone(ROOM, grantId, milestoneId, { state: 'accepted', note: null }))
        .milestone_state,
    ).toBe('accepted');
    expect((await fetchDelegations(ROOM))[0]?.state).toBe('active');
    expect((await fetchPaymentIntent(ROOM, intentId)).execution_state).toBe('finalized');
    const accounting = await fetchAccountingExport(
      ROOM,
      '2026-07-01T00:00:00.000Z',
      '2026-07-02T00:00:00.000Z',
    );
    expect(accounting.excluded_unreconciled).toBe(2);
  });

  it('creates, executes, and challenges production proposals', async () => {
    const proposalId = PRODUCTION_PROPOSAL.proposal_id;
    mockRoutes({
      [`POST /v1/rooms/${ROOM}/governance/proposals`]: (body) => {
        expect((body as { title: string }).title).toBe('Fund the survey');
        return jsonResponse({ proposal: PRODUCTION_PROPOSAL }, 201);
      },
      [`POST /v1/rooms/${ROOM}/governance/proposals/${proposalId}/execute`]: () =>
        jsonResponse({
          proposal: { ...PRODUCTION_PROPOSAL, execution_state: 'timelocked' },
        }),
      [`POST /v1/rooms/${ROOM}/governance/proposals/${proposalId}/challenge`]: (body) => {
        expect((body as { challenge_type: string }).challenge_type).toBe('coi');
        return jsonResponse({ challenge_id: '66666666-6666-4666-8666-666666666666' }, 201);
      },
    });
    const created = await createProductionProposal(ROOM, {
      proposal_type: 'capped_grant',
      title: 'Fund the survey',
      plain_language_summary: 'Pay for the survey.',
      category: null,
      requested_amount: '1000000',
      asset: 'USDC',
      recipient_ref: 'coop',
      conflict_disclosures: 'None.',
      risk_assessment: 'Low.',
      requested_action: {},
      expected_deliverable: 'Report.',
      idempotency_key: '77777777-7777-4777-8777-777777777777',
    });
    expect(created.proposal_id).toBe(proposalId);
    expect((await executeProposal(ROOM, proposalId)).execution_state).toBe('timelocked');
    expect(
      (
        await fileChallenge(ROOM, proposalId, {
          challenge_type: 'coi',
          description: 'Undisclosed conflict.',
          evidence_refs: [],
        })
      ).challenge_id,
    ).toBe('66666666-6666-4666-8666-666666666666');
  });
});
