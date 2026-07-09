// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U Stage 4 lawmaking facilitation on the service: the agent summarises a
// proposal, schedules its vote window, and attests a PLATFORM-COMPUTED outcome —
// each ONLY when the community granted the matching lawmaking capability (else a
// typed refusal, never a silent facilitation). Every facilitation is logged with
// the provenance triple. The agent has no tally capability (ADR-8).
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveGovernanceConfig } from '../governance/config.js';
import type { GovernanceService } from '../governance/service.js';
import { createGovernanceService } from '../governance/services.js';
import { createInMemoryGovernanceStores, type GovernanceStores } from '../governance/stores.js';

const ROOM = 'room-law';
const STEWARD = 'steward-law';

interface Harness {
  svc: GovernanceService;
  stores: GovernanceStores;
}

function makeService(): Harness {
  let n = 0;
  const stores = createInMemoryGovernanceStores();
  const svc = createGovernanceService({
    stores,
    config: resolveGovernanceConfig({ electionWindowSeconds: 7 * 24 * 60 * 60 }),
    now: () => new Date('2026-06-20T00:00:00.000Z'),
    uuid: () => `id-${++n}`,
  });
  return { svc, stores };
}

/** A bundle clearing the admission gate, requesting the given capabilities. */
function bundle(capabilities: string[]) {
  return {
    bundleId: 'law',
    version: '1',
    name: 'Lawmaking-capable',
    moderationPrompt:
      'Route link-heavy, spammy, or otherwise suspicious contributions to human review; allow civil on-topic content.',
    promptTemplates: {},
    config: {},
    requestedCapabilities: capabilities,
  };
}

/** A law-pack permitting the given capabilities (so derivation can grant them). */
function lawPack(capabilities: string[]) {
  return {
    lawPackId: 'lp',
    version: '1',
    allowedProposalTypes: ['model_prompt_approval'],
    permittedCapabilities: capabilities,
    treasury: {
      caps: [],
      minIntervalSeconds: 0,
      timelockSeconds: 0,
      materialThreshold: 0,
      requireCoiFor: [],
      investment: null,
    },
    election: {
      weightModel: 'one_civic_account_one_vote',
      perAccountCap: 1,
      minQuorum: 1,
      minTurnout: 0,
      termSeconds: 1,
    },
  };
}

/** Bootstrap → propose (requesting caps) → evaluate → approve (binding lawPack). */
async function activate(h: Harness, capabilities: string[]): Promise<void> {
  await h.svc.bootstrapSeat(ROOM, STEWARD);
  const lp = await h.svc.proposeLawPack(ROOM, STEWARD, lawPack(capabilities));
  if (!lp.ok) throw new Error('law-pack');
  const proposed = await h.svc.proposeModel(ROOM, STEWARD, bundle(capabilities), 'prompt');
  if (!proposed.ok) throw new Error('propose');
  await h.svc.evaluateModel(proposed.value.modelId);
  const approved = await h.svc.approveModel(ROOM, proposed.value.modelId, null, lp.value.lawPackId);
  if (!approved.ok) throw new Error('approve');
}

let h: Harness;
beforeEach(() => {
  h = makeService();
});

describe('GovernanceService — Stage 4 lawmaking facilitation', () => {
  it('summarises a proposal when granted lawmaking.summarize, and logs the action', async () => {
    await activate(h, ['moderate.flag', 'lawmaking.summarize']);
    const res = await h.svc.facilitateSummary(ROOM, {
      proposalId: 'prop-1',
      title: 'Adopt a weekly digest',
      body: 'An opt-in weekly digest of the room.',
      options: ['Yes', 'No'],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.proposalId).toBe('prop-1');
      expect(res.value.optionCount).toBe(2);
      expect(res.value.summary).toContain('Adopt a weekly digest');
    }
    const actions = await h.svc.recentAgentActions(ROOM, 10);
    expect(actions[0]?.actionType).toBe('lawmaking.summarize');
    expect(actions[0]?.subjectRef).toBe('prop-1');
  });

  it('refuses summary when the capability was not granted (no silent facilitation)', async () => {
    await activate(h, ['moderate.flag']); // no lawmaking capability
    const res = await h.svc.facilitateSummary(ROOM, {
      proposalId: 'prop-2',
      title: 'x',
      body: 'y',
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe('no_capability');
    expect(await h.svc.recentAgentActions(ROOM, 10)).toHaveLength(0);
  });

  it('refuses facilitation when no active agent governs the room', async () => {
    await h.svc.bootstrapSeat(ROOM, STEWARD); // seat only, no approved model
    const res = await h.svc.facilitateSummary(ROOM, { proposalId: 'p', title: 't', body: 'b' });
    expect(!res.ok && res.code).toBe('no_agent');
  });

  it('rejects an invalid proposal even when granted', async () => {
    await activate(h, ['moderate.flag', 'lawmaking.summarize']);
    const res = await h.svc.facilitateSummary(ROOM, { title: 'missing id' });
    expect(!res.ok && res.code).toBe('invalid_proposal');
  });

  it('schedules a deterministic vote window when granted lawmaking.schedule', async () => {
    await activate(h, ['moderate.flag', 'lawmaking.schedule']);
    const res = await h.svc.facilitateSchedule(ROOM, 'prop-3');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.opensAt).toBe('2026-06-20T00:00:00.000Z');
      expect(res.value.closesAt).toBe('2026-06-27T00:00:00.000Z'); // +7 days
    }
    expect((await h.svc.recentAgentActions(ROOM, 10))[0]?.actionType).toBe('lawmaking.schedule');
  });

  it('attests a PLATFORM-COMPUTED outcome when granted lawmaking.attest (never computes it)', async () => {
    await activate(h, ['moderate.flag', 'lawmaking.attest']);
    const res = await h.svc.facilitateAttest(ROOM, 'prop-4', {
      settled: true,
      adopted: true,
      inFavor: 7,
      against: 2,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.outcome).toBe('adopted');
      expect(res.value.statement).toContain('in favour 7, against 2');
    }
    expect((await h.svc.recentAgentActions(ROOM, 10))[0]?.actionType).toBe('lawmaking.attest');
  });

  it('refuses schedule/attest when only summarize was granted (per-capability gating)', async () => {
    await activate(h, ['moderate.flag', 'lawmaking.summarize']);
    expect(!(await h.svc.facilitateSchedule(ROOM, 'p')).ok).toBe(true);
    expect(
      !(
        await h.svc.facilitateAttest(ROOM, 'p', {
          settled: false,
          adopted: false,
          inFavor: 0,
          against: 0,
        })
      ).ok,
    ).toBe(true);
  });
});
