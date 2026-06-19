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

  it('rejects approving a model that belongs to a different room', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('rA', 's');
    await svc.bootstrapSeat('rB', 's');
    const p = await svc.proposeModel('rA', 's', bundle(), 'p');
    const id = p.ok ? p.value.modelId : '';
    await svc.evaluateModel(id);
    expect((await svc.approveModel('rB', id, null, null)).ok).toBe(false); // roomId mismatch
  });

  it('keeps a flag decision unchanged when flag itself is not granted (no over-downgrade)', async () => {
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
    expect(dec.ok && dec.value?.action).toBe('flag_for_review');
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
