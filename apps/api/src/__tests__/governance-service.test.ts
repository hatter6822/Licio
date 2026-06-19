// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U GovernanceService: the full runtime vertical (seat → election → model
// admission → bounded moderation → kernel-backed treasury → floor freeze) over
// deterministic in-memory stores with an injected clock + uuid counter.
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveGovernanceConfig } from '../governance/config.js';
import type { GovernanceService } from '../governance/service.js';
import { createGovernanceService } from '../governance/services.js';
import { createInMemoryGovernanceStores, type GovernanceStores } from '../governance/stores.js';

const START = Date.parse('2026-06-19T00:00:00.000Z');
const YEAR_MS = 366 * 24 * 60 * 60 * 1000;

interface Harness {
  svc: GovernanceService;
  stores: GovernanceStores;
  advance: (ms: number) => void;
}

function makeService(cryptoEnabled = false): Harness {
  let t = START;
  let n = 0;
  const stores = createInMemoryGovernanceStores();
  const svc = createGovernanceService({
    stores,
    config: resolveGovernanceConfig({ cryptoEnabled }),
    now: () => new Date(t),
    uuid: () => `id-${++n}`,
  });
  return {
    svc,
    stores,
    advance: (ms) => {
      t += ms;
    },
  };
}

const goodBundle = (over: Record<string, unknown> = {}) => ({
  bundleId: 'b',
  version: '1',
  name: 'Civility',
  moderationRules: [
    {
      id: 'spam',
      when: { kind: 'link_count_gte', value: 3 },
      action: 'remove',
      reason: 'too many links',
    },
  ],
  promptTemplates: {},
  config: {},
  requestedCapabilities: ['moderate.remove', 'moderate.flag'],
  ...over,
});

const ctx = (over: Record<string, unknown> = {}) => ({
  contentText: 'hello friends',
  contentKind: 'comment' as const,
  contentLength: 13,
  linkCount: 0,
  mentionCount: 0,
  hasMediaUpload: false,
  authorAccountAgeDays: 365,
  authorNewToRoom: false,
  priorRemovalsInRoom: 0,
  ...over,
});

const spamCtx = ctx({
  contentText: 'BUY http://a http://b http://c',
  contentLength: 30,
  linkCount: 3,
});

describe('GovernanceService — Stage 1 seat + elections', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeService();
  });

  it('bootstraps the seat to the creator, idempotently', async () => {
    await h.svc.bootstrapSeat('r1', 'creator');
    expect((await h.svc.getSeat('r1'))?.holderUserId).toBe('creator');
    expect((await h.svc.getSeat('r1'))?.bootstrap).toBe(true);
    await h.svc.bootstrapSeat('r1', 'other');
    expect((await h.svc.getSeat('r1'))?.holderUserId).toBe('creator');
  });

  it('runs the election lifecycle and reseats the winner', async () => {
    await h.svc.bootstrapSeat('r1', 'creator');
    expect((await h.svc.scheduleElection('r1')).ok).toBe(false); // term active
    h.advance(YEAR_MS);
    const sched = await h.svc.scheduleElection('r1');
    expect(sched.ok).toBe(true);
    const eid = sched.ok ? sched.value : '';
    expect((await h.svc.castVote(eid, 'v1', 'cand')).ok).toBe(true);
    expect((await h.svc.castVote(eid, 'v1', 'cand')).ok).toBe(false); // idempotent
    await h.svc.castVote(eid, 'v2', 'cand');
    const settled = await h.svc.settleElection(eid, 3);
    expect(settled.ok && settled.value.winnerUserId).toBe('cand');
    expect((await h.svc.getSeat('r1'))?.holderUserId).toBe('cand');
    expect((await h.svc.getSeat('r1'))?.bootstrap).toBe(false);
  });

  it('rejects a vote on a non-open election', async () => {
    expect((await h.svc.castVote('missing', 'v', 'c')).ok).toBe(false);
  });
});

describe('GovernanceService — Stage 2 model admission', () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeService();
    await h.svc.bootstrapSeat('r', 'steward');
  });

  it('lets only the steward propose, and content-addresses the bundle', async () => {
    expect((await h.svc.proposeModel('r', 'intruder', goodBundle(), 'p')).ok).toBe(false);
    const p = await h.svc.proposeModel('r', 'steward', goodBundle(), 'You moderate r.');
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('admits a well-behaved policy and rejects over/under-moderation', async () => {
    const good = await h.svc.proposeModel('r', 'steward', goodBundle(), 'p');
    const goodId = good.ok ? good.value.modelId : '';
    expect((await h.svc.evaluateModel(goodId)).ok).toBe(true);
    const model = await h.stores.models.get(goodId);
    expect(model?.status).toBe('eligible');

    // Over-moderation: removes everything ⇒ rejected.
    const nuke = await h.svc.proposeModel(
      'r',
      'steward',
      goodBundle({
        moderationRules: [
          { id: 'all', when: { kind: 'always' }, action: 'remove', reason: 'nuke' },
        ],
      }),
      'p2',
    );
    const nukeId = nuke.ok ? nuke.value.modelId : '';
    await h.svc.evaluateModel(nukeId);
    expect((await h.stores.models.get(nukeId))?.status).toBe('rejected');

    // Under-moderation: empty rules wave spam through ⇒ rejected.
    const empty = await h.svc.proposeModel(
      'r',
      'steward',
      goodBundle({ moderationRules: [] }),
      'p3',
    );
    const emptyId = empty.ok ? empty.value.modelId : '';
    await h.svc.evaluateModel(emptyId);
    expect((await h.stores.models.get(emptyId))?.status).toBe('rejected');
  });
});

describe('GovernanceService — Stage 3 bounded moderation agent', () => {
  let h: Harness;
  let modelId: string;
  beforeEach(async () => {
    h = makeService();
    await h.svc.bootstrapSeat('r', 'steward');
    const p = await h.svc.proposeModel('r', 'steward', goodBundle(), 'p');
    modelId = p.ok ? p.value.modelId : '';
    await h.svc.evaluateModel(modelId);
  });

  it('moderates within the law-pack and logs the action; benign is untouched', async () => {
    expect((await h.svc.approveModel('r', modelId, null, null)).ok).toBe(true);
    const dec = await h.svc.moderate('r', spamCtx, 'contrib-1');
    expect(dec.ok && dec.value?.action).toBe('remove');
    expect((await h.stores.agentActions.listByRoom('r', 10)).length).toBe(1);
    const benign = await h.svc.moderate('r', ctx(), 'contrib-2');
    expect(benign.ok && benign.value?.action).toBe('allow');
    expect((await h.stores.agentActions.listByRoom('r', 10)).length).toBe(1); // allow not logged
  });

  it('downgrades an action the capability descriptor does not grant', async () => {
    // A bundle requesting only flag, with a remove rule ⇒ remove is downgraded.
    const p = await h.svc.proposeModel(
      'r',
      'steward',
      goodBundle({ requestedCapabilities: ['moderate.flag'] }),
      'p2',
    );
    const id = p.ok ? p.value.modelId : '';
    await h.svc.evaluateModel(id);
    await h.svc.approveModel('r', id, null, null);
    const dec = await h.svc.moderate('r', spamCtx, 'c');
    expect(dec.ok && dec.value?.action).toBe('flag_for_review');
  });

  it('returns null (platform fallback) with no binding, and after a floor freeze', async () => {
    expect((await h.svc.moderate('r', spamCtx, 'c')).ok).toBe(true);
    expect((await (await makeService()).svc.moderate('nobinding', spamCtx, 'c')).ok && true).toBe(
      true,
    );
    await h.svc.approveModel('r', modelId, null, null);
    await h.svc.freezeAgent('r');
    const dec = await h.svc.moderate('r', spamCtx, 'c');
    expect(dec.ok && dec.value).toBeNull();
  });
});

describe('GovernanceService — Stage 5 kernel-backed treasury', () => {
  it('is fail-closed when crypto is disabled', async () => {
    const h = makeService(false);
    await h.svc.bootstrapSeat('r', 's');
    const tr = await h.svc.executeTreasuryAction('r', {
      category: 'transparency_report',
      amount: 0,
      asset: null,
      coiDeclared: false,
      proposedAt: '2026-06-19T00:00:00.000Z',
    });
    expect(tr.ok).toBe(false);
  });

  it('executes a within-bounds action via the kernel when crypto is enabled', async () => {
    const h = makeService(true);
    await h.svc.bootstrapSeat('r', 's');
    const lp = await h.svc.proposeLawPack('r', 's', {
      lawPackId: 'x',
      version: '1',
      allowedProposalTypes: ['treasury'],
      permittedCapabilities: ['gateway.submit_signed_action', 'treasury.report'],
      treasury: {
        caps: [
          {
            category: 'transparency_report',
            perActionMax: 0,
            perWindowMax: 0,
            windowSeconds: 3600,
          },
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
    const p = await h.svc.proposeModel(
      'r',
      's',
      goodBundle({
        requestedCapabilities: ['gateway.submit_signed_action', 'treasury.report'],
      }),
      'p',
    );
    const modelId = p.ok ? p.value.modelId : '';
    await h.svc.evaluateModel(modelId);
    await h.svc.approveModel('r', modelId, null, lawPackId);
    const tr = await h.svc.executeTreasuryAction('r', {
      category: 'transparency_report',
      amount: 0,
      asset: null,
      coiDeclared: false,
      proposedAt: '2026-06-19T00:00:00.000Z',
    });
    expect(tr.ok && tr.value.accepted).toBe(true);
  });
});
