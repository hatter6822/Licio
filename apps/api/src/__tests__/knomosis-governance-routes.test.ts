// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.4 governance-simulation route surface: the governance tab bundle (only
// for non-ordinary rooms, with the SIMULATION treasury), the comprehension
// quiz gate, proposal create/vote, and the audit log — all over the in-process
// Hono app with real sessions.

import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPREHENSION_QUIZ, COMPREHENSION_QUIZ_VERSION } from '../knomosis/simulation.js';
import { createV1Routes } from '../routes/v1.js';
import { seedUserWithSession } from './event-test-helpers.js';
import {
  freshKnomosisServices,
  type KnomosisFixture,
  resetKnomosisFixture,
} from './knomosis-test-helpers.js';

const ROOM = '77777777-7777-4777-8777-777777777777';

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

/** A fixture whose room port reports a SIMULATED room the user is a member of. */
async function simRoomFixture(): Promise<KnomosisFixture> {
  const fixture = await freshKnomosisServices();
  fixture.knomosis.rooms = {
    roomGovernance: async () => ({ mode: 'simulated', name: 'Sim Room' }),
    isMember: async () => true,
    isSteward: async () => false,
    contentVisibleToUser: async () => true,
  };
  return fixture;
}

async function passQuiz(cookie: string): Promise<void> {
  const answers: Record<string, number> = {};
  for (const q of COMPREHENSION_QUIZ) answers[q.question_id] = q.correctChoice;
  await req('POST', `/rooms/${ROOM}/governance/comprehension`, cookie, {
    quiz_version: COMPREHENSION_QUIZ_VERSION,
    answers,
  });
}

afterEach(() => resetKnomosisFixture());

describe('WS-L.4.1a governance tab', () => {
  it('serves the tab with the SIMULATION treasury for a simulated room', async () => {
    const fixture = await simRoomFixture();
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await req('GET', `/rooms/${ROOM}/governance`, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      simulation_mode: boolean;
      treasury: { simulation_label: string } | null;
    };
    expect(body.simulation_mode).toBe(true);
    expect(body.treasury?.simulation_label).toBe('SIMULATED — NO REAL VALUE');
  });

  it('404s the tab for an ORDINARY room (no governance surface)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'ordinary', name: 'Plain Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { cookie } = await seedUserWithSession(fixture.identity);
    expect((await req('GET', `/rooms/${ROOM}/governance`, cookie)).status).toBe(404);
  });

  it('503s when the governance flag is off', async () => {
    const fixture = await freshKnomosisServices({ governanceEnabled: false });
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'simulated', name: 'Sim Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { cookie } = await seedUserWithSession(fixture.identity);
    expect((await req('GET', `/rooms/${ROOM}/governance`, cookie)).status).toBe(503);
  });

  it('403s the READ for a private room the user cannot view (WS-L review fix)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'simulated', name: 'Private Room' }),
      isMember: async () => false,
      isSteward: async () => false,
      // A private room's governance content is not visible to this non-member.
      contentVisibleToUser: async () => false,
    };
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await req('GET', `/rooms/${ROOM}/governance`, cookie);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('membership_required');
    // The proposals + treasury read surfaces are gated by the same bar.
    expect((await req('GET', `/rooms/${ROOM}/governance/proposals`, cookie)).status).toBe(403);
  });
});

describe('WS-L.4.1e comprehension gate over HTTP', () => {
  it('blocks proposal creation until the quiz passes', async () => {
    const fixture = await simRoomFixture();
    const { cookie } = await seedUserWithSession(fixture.identity);
    const template = {
      proposal_type: 'bounty',
      title: 'A bounty',
      plain_language_summary: 'summary',
      requested_amount: '1000000',
      asset: 'SIM-USDC',
      recipient_ref: 'user-x',
      conflict_disclosures: 'none',
      risk_assessment: 'low',
      requested_action: { kind: 'bounty' },
      expected_deliverable: 'deliverable',
    };
    const blocked = await req('POST', `/rooms/${ROOM}/governance/proposals`, cookie, template);
    expect(blocked.status).toBe(403);

    await passQuiz(cookie);
    const created = await req('POST', `/rooms/${ROOM}/governance/proposals`, cookie, template);
    expect(created.status).toBe(201);
    const body = (await created.json()) as { proposal: { proposal_type: string } };
    expect(body.proposal.proposal_type).toBe('bounty');

    // The audit log records the simulated action.
    const log = await req('GET', `/rooms/${ROOM}/governance/audit-log`, cookie);
    const logBody = (await log.json()) as {
      entries: Array<{ action_type: string; simulation_mode: boolean }>;
    };
    expect(
      logBody.entries.some((e) => e.action_type === 'proposal_created' && e.simulation_mode),
    ).toBe(true);
  });

  it('quiz reports already_passed after a pass', async () => {
    const fixture = await simRoomFixture();
    const { cookie } = await seedUserWithSession(fixture.identity);
    await passQuiz(cookie);
    const res = await req('GET', `/rooms/${ROOM}/governance/comprehension`, cookie);
    const body = (await res.json()) as { already_passed: boolean };
    expect(body.already_passed).toBe(true);
  });
});

describe('WS-L.4.1d proposal → vote → execute + treasury over HTTP', () => {
  const bounty = {
    proposal_type: 'bounty',
    title: 'A bounty',
    plain_language_summary: 'summary',
    requested_amount: '1000000',
    asset: 'SIM-USDC',
    recipient_ref: 'user-x',
    conflict_disclosures: 'none',
    risk_assessment: 'low',
    requested_action: { kind: 'bounty' },
    expected_deliverable: 'deliverable',
  };

  it('runs a full simulated proposal lifecycle and reflects it in the treasury', async () => {
    let clock = Date.now();
    const fixture = await freshKnomosisServices({ now: () => clock });
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'simulated', name: 'Sim Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const proposer = await seedUserWithSession(fixture.identity, { handle: 'gprop' });
    await passQuiz(proposer.cookie);

    // Deposit into the sim treasury first.
    const deposit = await req(
      'POST',
      `/rooms/${ROOM}/governance/treasury/deposits`,
      proposer.cookie,
      {
        asset: 'SIM-USDC',
        amount: '1000000',
        idempotency_key: crypto.randomUUID(),
      },
    );
    expect(deposit.status).toBe(200);

    const create = await req(
      'POST',
      `/rooms/${ROOM}/governance/proposals`,
      proposer.cookie,
      bounty,
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { proposal: { proposal_id: string } };
    const proposalId = created.proposal.proposal_id;

    // Three members vote approve (quorum default 3).
    for (let i = 0; i < 3; i += 1) {
      const voter = await seedUserWithSession(fixture.identity, { handle: `gvoter${i}` });
      await passQuiz(voter.cookie);
      const vote = await req(
        'POST',
        `/rooms/${ROOM}/governance/proposals/${proposalId}/vote`,
        voter.cookie,
        { choice: 'approve' },
      );
      expect(vote.status).toBe(200);
    }

    // Advance past the timelock, execute.
    clock += (fixture.knomosis.config().simTimelockSeconds + 1) * 1000;
    const execute = await req(
      'POST',
      `/rooms/${ROOM}/governance/proposals/${proposalId}/execute`,
      proposer.cookie,
    );
    expect(execute.status).toBe(200);
    const executed = (await execute.json()) as { proposal: { execution_state: string } };
    expect(executed.proposal.execution_state).toBe('executed');

    // The proposal list + single-read reflect the outcome.
    const list = await req('GET', `/rooms/${ROOM}/governance/proposals`, proposer.cookie);
    expect(list.status).toBe(200);
    const single = await req(
      'GET',
      `/rooms/${ROOM}/governance/proposals/${proposalId}`,
      proposer.cookie,
    );
    expect(single.status).toBe(200);
  });

  it('a non-member cannot create a proposal (403)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'simulated', name: 'Sim Room' }),
      isMember: async () => false,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await req('POST', `/rooms/${ROOM}/governance/proposals`, cookie, bounty);
    expect(res.status).toBe(403);
  });
});

describe('WS-L.4.1g readiness + mode transition over HTTP', () => {
  it('reports readiness and rejects a non-steward mode transition (404)', async () => {
    const fixture = await freshKnomosisServices();
    let mode = 'simulated';
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: mode as never, name: 'Sim Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    fixture.knomosis.roomMode = {
      currentMode: async () => mode as never,
      setMode: async (_r, m) => {
        mode = m;
        return true;
      },
      setModeIf: async (_r, expected, m) => {
        if (mode !== expected) return false;
        mode = m;
        return true;
      },
    };
    const { cookie } = await seedUserWithSession(fixture.identity);
    const readiness = await req('GET', `/rooms/${ROOM}/governance/readiness`, cookie);
    expect(readiness.status).toBe(200);
    const readinessBody = (await readiness.json()) as { ready: boolean; unmet: unknown[] };
    expect(readinessBody.ready).toBe(false);
    expect(readinessBody.unmet.length).toBeGreaterThan(0);

    // A non-steward transition request is 404 (no steward oracle).
    const transition = await req('POST', `/rooms/${ROOM}/governance/mode`, cookie, {
      target_mode: 'testnet',
      reason: 'graduating',
    });
    expect(transition.status).toBe(404);
  });

  it('a steward can move ordinary → simulated (the safe direction, no readiness gate)', async () => {
    const fixture = await freshKnomosisServices();
    let mode = 'ordinary';
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: mode as never, name: 'Room' }),
      isMember: async () => true,
      isSteward: async () => true,
      contentVisibleToUser: async () => true,
    };
    fixture.knomosis.roomMode = {
      currentMode: async () => mode as never,
      setMode: async (_r, m) => {
        mode = m;
        return true;
      },
      setModeIf: async (_r, expected, m) => {
        if (mode !== expected) return false;
        mode = m;
        return true;
      },
    };
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    // The READINESS read serves ordinary rooms (W7): the ordinary→simulated
    // checklist is how a room enters the lifecycle — the dialog's lifecycle
    // tab must not land on a 404.
    const readiness = await req('GET', `/rooms/${ROOM}/governance/readiness`, cookie);
    expect(readiness.status).toBe(200);
    expect(((await readiness.json()) as { room_id: string }).room_id).toBe(ROOM);
    // The tab 404s for an ordinary room, but the mode transition to simulated
    // is the safe onboarding direction.
    const transition = await req('POST', `/rooms/${ROOM}/governance/mode`, cookie, {
      target_mode: 'simulated',
      reason: 'opting in',
    });
    expect(transition.status).toBe(200);
    const body = (await transition.json()) as { governance_mode: string };
    expect(body.governance_mode).toBe('simulated');
  });
});

describe('governance surface fail-closed gates', () => {
  it('503s the tab when the governance flag is off', async () => {
    const fixture = await freshKnomosisServices({ governanceEnabled: false });
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'simulated', name: 'Sim Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { cookie } = await seedUserWithSession(fixture.identity);
    expect((await req('GET', `/rooms/${ROOM}/governance/proposals`, cookie)).status).toBe(503);
  });

  it('409s treasury deposits outside simulated mode', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Testnet Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { cookie } = await seedUserWithSession(fixture.identity);
    await passQuiz(cookie);
    const res = await req('POST', `/rooms/${ROOM}/governance/treasury/deposits`, cookie, {
      asset: 'SIM-USDC',
      amount: '1',
      idempotency_key: crypto.randomUUID(),
    });
    expect(res.status).toBe(409);
  });

  it('a steward transition out of simulation is blocked when readiness is unmet (409)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'simulated', name: 'Sim Room' }),
      isMember: async () => true,
      isSteward: async () => true,
      contentVisibleToUser: async () => true,
    };
    fixture.knomosis.roomMode = {
      currentMode: async () => 'simulated',
      setMode: async () => true,
      setModeIf: async (_r, expected) => expected === 'simulated',
    };
    const { cookie } = await seedUserWithSession(fixture.identity, { steward: true });
    const res = await req('POST', `/rooms/${ROOM}/governance/mode`, cookie, {
      target_mode: 'testnet',
      reason: 'graduating',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string }; unmet: unknown[] };
    expect(body.error.code).toBe('readiness_unmet');
    expect(body.unmet.length).toBeGreaterThan(0);
  });
});

describe('WS-L review fix — simulated voting/execution require simulated mode', () => {
  it('409s a vote in a non-simulated (testnet) room (mode_invalid)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Testnet Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { cookie } = await seedUserWithSession(fixture.identity);
    const proposalId = '99999999-9999-4999-8999-999999999999';
    const res = await req(
      'POST',
      `/rooms/${ROOM}/governance/proposals/${proposalId}/vote`,
      cookie,
      {
        choice: 'approve',
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('mode_invalid');
  });

  it('409s an execute in a non-simulated (testnet) room (mode_invalid)', async () => {
    const fixture = await freshKnomosisServices();
    fixture.knomosis.rooms = {
      roomGovernance: async () => ({ mode: 'testnet', name: 'Testnet Room' }),
      isMember: async () => true,
      isSteward: async () => false,
      contentVisibleToUser: async () => true,
    };
    const { cookie } = await seedUserWithSession(fixture.identity);
    const proposalId = '99999999-9999-4999-8999-999999999999';
    const res = await req(
      'POST',
      `/rooms/${ROOM}/governance/proposals/${proposalId}/execute`,
      cookie,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('mode_invalid');
  });
});
