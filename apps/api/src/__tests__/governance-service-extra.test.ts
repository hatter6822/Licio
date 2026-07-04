// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U GovernanceService residual branch coverage (edge guards).
import { describe, expect, it } from 'vitest';
import { resolveGovernanceConfig } from '../governance/config.js';
import {
  createGovernanceService,
  getGovernanceService,
  resetGovernanceService,
  setGovernanceService,
} from '../governance/services.js';
import { createInMemoryGovernanceStores } from '../governance/stores.js';

function make(cryptoEnabled = false) {
  let t = Date.parse('2026-06-19T00:00:00.000Z');
  let n = 0;
  return {
    svc: createGovernanceService({
      stores: createInMemoryGovernanceStores(),
      config: resolveGovernanceConfig({
        cryptoEnabled,
        electionTermSeconds: 1,
        electionWindowSeconds: 100,
      }),
      now: () => new Date(t),
      uuid: () => `id-${++n}`,
    }),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const bundle = (over: Record<string, unknown> = {}) => ({
  bundleId: 'b',
  version: '1',
  name: 'n',
  moderationRules: [
    { id: 'spam', when: { kind: 'link_count_gte', value: 3 }, action: 'remove', reason: 'links' },
  ],
  promptTemplates: {},
  config: {},
  requestedCapabilities: ['moderate.remove', 'moderate.flag'],
  ...over,
});

const spamCtx = {
  contentText: 'BUY http://a http://b http://c',
  contentKind: 'comment' as const,
  contentLength: 30,
  linkCount: 3,
  mentionCount: 0,
  hasMediaUpload: false,
  authorAccountAgeDays: 1,
  authorNewToRoom: true,
  priorRemovalsInRoom: 0,
};

describe('GovernanceService residual branches', () => {
  it('rejects scheduling a second election while one is open', async () => {
    const { svc, advance } = make();
    await svc.bootstrapSeat('r', 'c');
    advance(5000);
    expect((await svc.scheduleElection('r')).ok).toBe(true);
    expect((await svc.scheduleElection('r')).ok).toBe(false); // election_open
  });

  it('enforces one OPEN election per room at the store (atomic guard, L4)', async () => {
    const stores = createInMemoryGovernanceStores();
    const base = {
      roomId: 'r',
      status: 'open' as const,
      opensAt: 't',
      closesAt: 't',
      weightModel: 'one_civic_account_one_vote',
      winnerUserId: null,
      tally: null,
      mode: 'simulated' as const,
      createdAt: 't',
      settledAt: null,
    };
    expect(await stores.elections.insert({ ...base, electionId: 'e1' })).not.toBeNull();
    // A second OPEN election for the same room collides (the atomic one-open guard).
    expect(await stores.elections.insert({ ...base, electionId: 'e2' })).toBeNull();
    // Settling the first frees the room to open a new one.
    await stores.elections.patch('e1', { status: 'settled' });
    expect(await stores.elections.insert({ ...base, electionId: 'e3' })).not.toBeNull();
  });

  it('rejects approving a model that belongs to a different room', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('rA', 's');
    await svc.bootstrapSeat('rB', 's');
    const p = await svc.proposeModel('rA', 's', bundle(), 'p');
    const id = p.ok ? p.value.modelId : '';
    await svc.evaluateModel(id);
    expect((await svc.approveModel('rB', id, null, null)).ok).toBe(false); // roomId mismatch
  });

  it('never hides content when the deciding capability was not granted (deny-by-default)', async () => {
    // A model that decides flag_for_review but was granted NO content-affecting
    // capability must NOT hide content: flag_for_review maps to under_review, and
    // the community granted the agent no capability to hide, so the effective
    // action is `allow` (no effect, no agent action logged). This is the WS-U
    // capability sandbox — the agent can never exceed community-voted bounds.
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    const p = await svc.proposeModel(
      'r',
      's',
      bundle({
        moderationRules: [
          {
            id: 'flag',
            when: { kind: 'link_count_gte', value: 3 },
            action: 'flag_for_review',
            reason: 'x',
          },
        ],
        requestedCapabilities: [],
      }),
      'p',
    );
    const id = p.ok ? p.value.modelId : '';
    await svc.evaluateModel(id);
    await svc.approveModel('r', id, null, null);
    const dec = await svc.moderate('r', spamCtx, 'c');
    expect(dec.ok && dec.value?.action).toBe('allow');
    // No content-affecting action ⇒ nothing appended to the agent action log.
    expect(await svc.recentAgentActions('r', 10)).toHaveLength(0);
  });

  it('falls back to the strongest GRANTED action and never escalates a visible one', async () => {
    // Decides `remove` but is granted only moderate.flag ⇒ falls back to
    // flag_for_review (the strongest granted action no more severe than remove) —
    // routes to the human floor rather than removing, and never escalates.
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    const p = await svc.proposeModel(
      'r',
      's',
      bundle({
        moderationRules: [
          {
            id: 'remove',
            when: { kind: 'link_count_gte', value: 3 },
            action: 'remove',
            reason: 'x',
          },
        ],
        requestedCapabilities: ['moderate.flag'],
      }),
      'p',
    );
    const id = p.ok ? p.value.modelId : '';
    await svc.evaluateModel(id);
    await svc.approveModel('r', id, null, null);
    const dec = await svc.moderate('r', spamCtx, 'c');
    expect(dec.ok && dec.value?.action).toBe('flag_for_review');
  });

  it('keeps a floor-frozen agent paused across a member re-ratification (durable floor)', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    // Adopt an initial model → active agent that removes the spam contribution.
    const p1 = await svc.proposeModel('r', 's', bundle(), 'p');
    const m1 = p1.ok ? p1.value.modelId : '';
    await svc.evaluateModel(m1);
    await svc.approveModel('r', m1, null, null);
    const first = await svc.moderate('r', spamCtx, 'c');
    expect(first.ok && first.value?.action).toBe('remove');
    expect((await svc.getBinding('r'))?.active).toBe(true);

    // The platform floor freezes the agent (durable) — it stops moderating.
    expect((await svc.freezeAgent('r')).ok).toBe(true);
    let binding = await svc.getBinding('r');
    expect(binding?.active).toBe(false);
    expect(binding?.floorFrozen).toBe(true);
    const paused = await svc.moderate('r', spamCtx, 'c2');
    expect(paused.ok && paused.value).toBeNull();

    // A member ratification adopts a DIFFERENT model — but must NOT re-activate the
    // floor-frozen agent (the legal floor is non-overridable by a community vote).
    const p2 = await svc.proposeModel('r', 's', bundle({ name: 'n2' }), 'p2');
    const m2 = p2.ok ? p2.value.modelId : '';
    await svc.evaluateModel(m2);
    const adopt = await svc.approveModel('r', m2, 'vote-1', null);
    expect(adopt.ok && adopt.value.active).toBe(false); // adopted but NOT activated
    binding = await svc.getBinding('r');
    expect(binding?.active).toBe(false);
    expect(binding?.floorFrozen).toBe(true);
    expect(binding?.modelId).toBe(m2); // the new model IS bound…
    const stillPaused = await svc.moderate('r', spamCtx, 'c3');
    expect(stillPaused.ok && stillPaused.value).toBeNull(); // …but the agent is still paused.

    // Only a WS-J-gated unfreeze restores the agent (and clears the durable flag).
    expect((await svc.reactivateAgent('r')).ok).toBe(true);
    binding = await svc.getBinding('r');
    expect(binding?.active).toBe(true);
    expect(binding?.floorFrozen).toBe(false);
    const restored = await svc.moderate('r', spamCtx, 'c4');
    expect(restored.ok && restored.value?.action).toBe('remove');

    // Both floor interventions are recorded in the append-only agent audit log.
    const actions = await svc.recentAgentActions('r', 50);
    const types = actions.map((a) => a.actionType);
    expect(types).toContain('governance.freeze');
    expect(types).toContain('governance.unfreeze');
  });

  it('rejects a malformed treasury action category (crypto on, gateway granted)', async () => {
    const { svc } = make(true);
    await svc.bootstrapSeat('r', 's');
    const lp = await svc.proposeLawPack('r', 's', {
      lawPackId: 'x',
      version: '1',
      allowedProposalTypes: ['t'],
      permittedCapabilities: ['gateway.submit_signed_action', 'treasury.report'],
      treasury: {
        caps: [
          { category: 'transparency_report', perActionMax: 0, perWindowMax: 0, windowSeconds: 60 },
        ],
        minIntervalSeconds: 0,
        timelockSeconds: 0,
        materialThreshold: 1,
        requireCoiFor: [],
        investment: null,
      },
      election: {
        weightModel: 'one_civic_account_one_vote',
        minQuorum: 1,
        minTurnout: 0,
        termSeconds: 1,
      },
    });
    const lawPackId = lp.ok ? lp.value.lawPackId : '';
    const p = await svc.proposeModel(
      'r',
      's',
      bundle({
        requestedCapabilities: ['gateway.submit_signed_action', 'treasury.report'],
      }),
      'p',
    );
    const id = p.ok ? p.value.modelId : '';
    await svc.evaluateModel(id);
    await svc.approveModel('r', id, null, lawPackId);
    const bad = await svc.executeTreasuryAction('r', {
      category: 'not_a_real_category',
      amount: 1,
      asset: null,
      coiDeclared: false,
      proposedAt: '2026-06-19T00:00:00.000Z',
    });
    expect(bad.ok).toBe(false); // invalid_action
  });

  it('refuses a treasury category the room did not grant, even with a configured cap', async () => {
    // The room grants only treasury.report; a `grant`-category action is refused
    // (no_capability) even though a grant cap is configured — the per-category
    // capability is enforced, not just whether a cap row exists.
    const { svc } = make(true);
    await svc.bootstrapSeat('r', 's');
    const lp = await svc.proposeLawPack('r', 's', {
      lawPackId: 'x',
      version: '1',
      allowedProposalTypes: ['t'],
      permittedCapabilities: ['gateway.submit_signed_action', 'treasury.report'],
      treasury: {
        caps: [
          {
            category: 'transparency_report',
            perActionMax: 10,
            perWindowMax: 10,
            windowSeconds: 60,
          },
          // A grant cap IS configured — but treasury.grant is NOT permitted.
          { category: 'grant', perActionMax: 1000, perWindowMax: 1000, windowSeconds: 60 },
        ],
        minIntervalSeconds: 0,
        timelockSeconds: 0,
        materialThreshold: 100_000,
        requireCoiFor: [],
        investment: null,
      },
      election: {
        weightModel: 'one_civic_account_one_vote',
        minQuorum: 1,
        minTurnout: 0,
        termSeconds: 1,
      },
    });
    const lawPackId = lp.ok ? lp.value.lawPackId : '';
    const p = await svc.proposeModel(
      'r',
      's',
      bundle({ requestedCapabilities: ['gateway.submit_signed_action', 'treasury.report'] }),
      'p',
    );
    const id = p.ok ? p.value.modelId : '';
    await svc.evaluateModel(id);
    await svc.approveModel('r', id, null, lawPackId);

    const grant = await svc.executeTreasuryAction('r', {
      category: 'grant',
      amount: 500,
      asset: null,
      coiDeclared: false,
      proposedAt: '2026-06-19T00:00:00.000Z',
    });
    expect(grant.ok).toBe(false);
    expect(grant.ok === false && grant.code).toBe('no_capability');

    // The granted category (transparency_report) is accepted by the kernel.
    const report = await svc.executeTreasuryAction('r', {
      category: 'transparency_report',
      amount: 1,
      asset: null,
      coiDeclared: false,
      proposedAt: '2026-06-19T00:00:00.000Z',
    });
    expect(report.ok).toBe(true);
  });

  it('threads a target allocation through an investment rebalance and enforces the bands', async () => {
    const { svc } = make(true);
    await svc.bootstrapSeat('r', 's');
    const lp = await svc.proposeLawPack('r', 's', {
      lawPackId: 'x',
      version: '1',
      allowedProposalTypes: ['t'],
      permittedCapabilities: ['gateway.submit_signed_action', 'treasury.invest'],
      treasury: {
        caps: [
          {
            category: 'investment_rebalance',
            perActionMax: 1000,
            perWindowMax: 1000,
            windowSeconds: 60,
          },
        ],
        minIntervalSeconds: 0,
        timelockSeconds: 0,
        materialThreshold: 100_000,
        requireCoiFor: [],
        investment: {
          allocationBands: [
            { asset: 'STABLE', minFraction: 0.5, maxFraction: 1 },
            { asset: 'ETH', minFraction: 0, maxFraction: 0.5 },
          ],
          rebalanceMinIntervalSeconds: 1,
        },
      },
      election: {
        weightModel: 'one_civic_account_one_vote',
        minQuorum: 1,
        minTurnout: 0,
        termSeconds: 1,
      },
    });
    const lawPackId = lp.ok ? lp.value.lawPackId : '';
    const p = await svc.proposeModel(
      'r',
      's',
      bundle({ requestedCapabilities: ['gateway.submit_signed_action', 'treasury.invest'] }),
      'p',
    );
    const id = p.ok ? p.value.modelId : '';
    await svc.evaluateModel(id);
    await svc.approveModel('r', id, null, lawPackId);

    // A rebalance with NO allocation (a room that voted an investment policy) is
    // rejected fail-closed rather than silently waved through. (Run first: it is
    // rejected, so it records no accepted history and cannot trip the interval
    // check for the compliant rebalance below.)
    const noAlloc = await svc.executeTreasuryAction('r', {
      category: 'investment_rebalance',
      amount: 0,
      asset: null,
      coiDeclared: false,
      proposedAt: '2026-06-19T00:00:00.000Z',
    });
    expect(noAlloc.ok && noAlloc.value.accepted).toBe(false);
    expect(noAlloc.ok && !noAlloc.value.accepted && noAlloc.value.code).toBe(
      'investment_band_required',
    );

    // A rebalance WITH a compliant target allocation is accepted by the kernel.
    const okRebal = await svc.executeTreasuryAction('r', {
      category: 'investment_rebalance',
      amount: 0,
      asset: null,
      coiDeclared: false,
      proposedAt: '2026-06-19T00:00:00.000Z',
      targetAllocation: [
        { asset: 'STABLE', fraction: 0.6 },
        { asset: 'ETH', fraction: 0.4 },
      ],
    });
    expect(okRebal.ok && okRebal.value.accepted).toBe(true);
  });

  it('binds a custom law-pack that restricts the agent below the model request', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    // A community law-pack permitting ONLY moderate.flag.
    const lp = await svc.proposeLawPack('r', 's', {
      lawPackId: 'x',
      version: '1',
      allowedProposalTypes: ['model_prompt_approval'],
      permittedCapabilities: ['moderate.flag'],
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
    });
    const lawPackId = lp.ok ? lp.value.lawPackId : '';
    // A model REQUESTING flag + remove.
    const p = await svc.proposeModel(
      'r',
      's',
      bundle({
        moderationRules: [
          {
            id: 'flag',
            when: { kind: 'link_count_gte', value: 3 },
            action: 'flag_for_review',
            reason: 'x',
          },
        ],
        requestedCapabilities: ['moderate.flag', 'moderate.remove'],
      }),
      'p',
    );
    const id = p.ok ? p.value.modelId : '';
    await svc.evaluateModel(id);
    const approved = await svc.approveModel('r', id, null, lawPackId);
    if (!approved.ok) throw new Error('approve failed');
    // requested ∩ permitted = [flag]; the law-pack drops moderate.remove.
    expect(approved.value.descriptor.granted).toContain('moderate.flag');
    expect(approved.value.descriptor.granted).not.toContain('moderate.remove');
  });
});

describe('GovernanceService floor freeze/restore', () => {
  it('reactivateAgent restores a frozen binding and no-ops a room without one', async () => {
    const { svc } = make();
    // No binding ⇒ nothing to reactivate.
    const empty = await svc.reactivateAgent('empty');
    expect(empty.ok && empty.value.reactivated).toBe(false);
    // Approve a model ⇒ active binding; freeze ⇒ inactive; reactivate ⇒ restored.
    await svc.bootstrapSeat('r', 's');
    const p = await svc.proposeModel('r', 's', bundle(), 'p');
    const id = p.ok ? p.value.modelId : '';
    await svc.evaluateModel(id);
    await svc.approveModel('r', id, null, null);
    await svc.freezeAgent('r');
    expect((await svc.getBinding('r'))?.active).toBe(false);
    const restored = await svc.reactivateAgent('r');
    expect(restored.ok && restored.value.reactivated).toBe(true);
    expect((await svc.getBinding('r'))?.active).toBe(true);
  });
});

describe('GovernanceService singleton binding', () => {
  it('setGovernanceService binds the process singleton (the boot wiring point)', () => {
    resetGovernanceService();
    const svc = createGovernanceService({ stores: createInMemoryGovernanceStores() });
    setGovernanceService(svc);
    expect(getGovernanceService()).toBe(svc);
    // After reset, the next get lazily builds a fresh (different) instance.
    resetGovernanceService();
    expect(getGovernanceService()).not.toBe(svc);
    resetGovernanceService();
  });
});
