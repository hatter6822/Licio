// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U GovernanceService: the full runtime vertical (seat → election → model
// admission → bounded moderation → kernel-backed treasury → floor freeze) over
// deterministic in-memory stores with an injected clock + uuid counter.
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveGovernanceConfig } from '../governance/config.js';
import type { ModerationProposer } from '../governance/moderation-proposer.js';
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

function makeService(cryptoEnabled = false, proposer?: ModerationProposer): Harness {
  let t = START;
  let n = 0;
  const stores = createInMemoryGovernanceStores();
  const svc = createGovernanceService({
    stores,
    config: resolveGovernanceConfig({ cryptoEnabled }),
    now: () => new Date(t),
    uuid: () => `id-${++n}`,
    // Omitted ⇒ createGovernanceService's deterministic default proposer.
    ...(proposer ? { moderationProposer: proposer } : {}),
  });
  return {
    svc,
    stores,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** A fake in-room model that proposes one FIXED action on every contribution —
 *  for exercising the admission gate's over/under-moderation rejection. */
function fixedProposer(action: string): ModerationProposer {
  return {
    kind: 'llm',
    async propose() {
      return {
        status: 'decided',
        proposal: { action: action as never, reason: 'x', outputId: null },
      };
    },
  };
}

const goodBundle = (over: Record<string, unknown> = {}) => ({
  bundleId: 'b',
  version: '1',
  name: 'Civility',
  moderationPrompt:
    'Route link-heavy, spammy, or otherwise suspicious contributions to human review; allow civil on-topic content.',
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
    expect((await h.svc.castVote('r1', eid, 'v1', 'cand', true)).ok).toBe(true);
    expect((await h.svc.castVote('r1', eid, 'v1', 'cand', true)).ok).toBe(false); // idempotent
    await h.svc.castVote('r1', eid, 'v2', 'cand', true);
    const settled = await h.svc.settleElection(eid, 3);
    expect(settled.ok && settled.value.winnerUserId).toBe('cand');
    expect((await h.svc.getSeat('r1'))?.holderUserId).toBe('cand');
    expect((await h.svc.getSeat('r1'))?.bootstrap).toBe(false);
  });

  it('never seats an election winner who is no longer a room member (fail-safe to incumbent)', async () => {
    await h.svc.bootstrapSeat('r1', 'creator');
    h.advance(YEAR_MS);
    const sched = await h.svc.scheduleElection('r1');
    const eid = sched.ok ? sched.value : '';
    // 'cand' wins the ballots but has since LEFT/been removed from the room.
    await h.svc.castVote('r1', eid, 'v1', 'cand', true);
    await h.svc.castVote('r1', eid, 'v2', 'cand', true);
    const isRoomMember = async (userId: string) => userId !== 'cand';
    const settled = await h.svc.settleElection(eid, 3, isRoomMember);
    // Fail-safe: the incumbent continues, the outsider is NOT seated.
    expect(settled.ok && settled.value.settled).toBe(false);
    expect(settled.ok && settled.value.winnerUserId).toBe('creator');
    expect((await h.svc.getSeat('r1'))?.holderUserId).toBe('creator');
  });

  it('vacates the seat when the winning INCUMBENT has left (never retains a departed holder)', async () => {
    await h.svc.bootstrapSeat('r1', 'creator');
    h.advance(YEAR_MS);
    const sched = await h.svc.scheduleElection('r1');
    const eid = sched.ok ? sched.value : '';
    // The incumbent 'creator' wins re-election but has since LEFT the room.
    await h.svc.castVote('r1', eid, 'v1', 'creator', true);
    await h.svc.castVote('r1', eid, 'v2', 'creator', true);
    const isRoomMember = async (userId: string) => userId !== 'creator';
    const settled = await h.svc.settleElection(eid, 3, isRoomMember);
    // The departed incumbent is NOT reseated — the seat is left vacant.
    expect(settled.ok && settled.value.settled).toBe(false);
    expect(settled.ok && settled.value.winnerUserId).toBeNull();
    const seat = await h.svc.getSeat('r1');
    expect(seat?.holderUserId).toBeNull();
    // The vacated seat's term is already elapsed, so the next scheduler tick opens a
    // replacement election immediately (not a full term with no steward).
    expect(seat?.termEnd).toBe(seat?.termStart);
  });

  it('rejects a ballot for a non-member candidate at the service (defense-in-depth)', async () => {
    await h.svc.bootstrapSeat('r1', 'creator');
    h.advance(YEAR_MS);
    const sched = await h.svc.scheduleElection('r1');
    const eid = sched.ok ? sched.value : '';
    // Voter is a member, but the candidate is not (candidateEligible=false).
    const denied = await h.svc.castVote('r1', eid, 'v1', 'outsider', true, false);
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.code).toBe('invalid_candidate');
  });

  it('validates the election BEFORE the candidate (no membership oracle for a bogus election)', async () => {
    // A non-member candidate on a NON-EXISTENT election returns not_found, not
    // invalid_candidate — so the endpoint cannot be used to probe room membership
    // when there is no valid election.
    const res = await h.svc.castVote('r1', 'no-such-election', 'v1', 'outsider', true, false);
    expect(!res.ok && res.code).toBe('not_found');
  });

  it('rejects a vote on a non-open election', async () => {
    expect((await h.svc.castVote('r1', 'missing', 'v', 'c', true)).ok).toBe(false);
  });

  it('rejects a ballot from a non-member (membership-gated at the service)', async () => {
    await h.svc.bootstrapSeat('r1', 'creator');
    h.advance(YEAR_MS);
    const sched = await h.svc.scheduleElection('r1');
    const eid = sched.ok ? sched.value : '';
    const denied = await h.svc.castVote('r1', eid, 'outsider', 'cand', false);
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.code).toBe('not_member');
  });

  it('settle reads the room law-pack election rules (quorum + term), not a constant', async () => {
    await h.svc.bootstrapSeat('r1', 'creator');
    // A bound law-pack whose election demands a quorum of 2 and a short 10s term.
    const lp = await h.svc.proposeLawPack('r1', 'creator', {
      lawPackId: 'x',
      version: '1',
      allowedProposalTypes: ['steward_election'],
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
        minQuorum: 2,
        minTurnout: 0,
        termSeconds: 10,
      },
    });
    if (!lp.ok) throw new Error('law-pack proposal failed');
    const proposed = await h.svc.proposeModel('r1', 'creator', goodBundle(), 'prompt', true);
    if (!proposed.ok) throw new Error('model proposal failed');
    await h.svc.evaluateModel(proposed.value.modelId);
    // Approve (bind the law-pack) so settle resolves rules from the binding.
    expect(
      (await h.svc.approveModel('r1', proposed.value.modelId, null, lp.value.lawPackId)).ok,
    ).toBe(true);

    // Open an election and cast a SINGLE ballot.
    h.advance(YEAR_MS);
    const sched = await h.svc.scheduleElection('r1');
    const eid = sched.ok ? sched.value : '';
    await h.svc.castVote('r1', eid, 'v1', 'challenger', true);

    // The bound law-pack requires a quorum of 2; one ballot fails it ⇒ fail-safe
    // (the default law-pack's quorum of 1 would have settled to 'challenger').
    const settled = await h.svc.settleElection(eid, 10);
    expect(settled.ok && settled.value.settled).toBe(false);
    const seat = await h.svc.getSeat('r1');
    expect(seat?.holderUserId).toBe('creator');
    // The next term honours the law-pack's short termSeconds (10s) — proof the
    // term length is law-pack-driven, never a hardcoded config constant.
    expect(Date.parse(seat?.termEnd ?? '') - Date.parse(seat?.termStart ?? '')).toBe(10_000);
  });

  it('settle divides by the electorate FROZEN at open, not a fresh read', async () => {
    // `tallyElection` fails an election when `distinctVoters / eligibleCount <
    // minTurnout`.  That denominator used to be a LIVE read taken at settle
    // (active subscribers ∪ stewards — a set any account can join at will), so
    // inflating membership after the last ballot pushed turnout under the bar
    // and failed an election that had met it; the fail-safe then hands the
    // incumbent a full new term.  The snapshot taken at OPEN is the electorate
    // the voters actually faced.
    await h.svc.bootstrapSeat('r1', 'creator');
    const lp = await h.svc.proposeLawPack('r1', 'creator', {
      lawPackId: 'turnout',
      version: '1',
      allowedProposalTypes: ['steward_election'],
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
        // Two of three must vote — met at open, missed if the denominator grows.
        minTurnout: 0.5,
        termSeconds: 10,
      },
    });
    if (!lp.ok) throw new Error('law-pack proposal failed');
    const proposed = await h.svc.proposeModel('r1', 'creator', goodBundle(), 'prompt', true);
    if (!proposed.ok) throw new Error('model proposal failed');
    await h.svc.evaluateModel(proposed.value.modelId);
    expect(
      (await h.svc.approveModel('r1', proposed.value.modelId, null, lp.value.lawPackId)).ok,
    ).toBe(true);

    h.advance(YEAR_MS);
    // THREE eligible voters at open — recorded on the row.
    const sched = await h.svc.scheduleElection('r1', {
      eligibleVoterCount: async () => 3,
    });
    const eid = sched.ok ? sched.value : '';
    await h.svc.castVote('r1', eid, 'v1', 'challenger', true);
    await h.svc.castVote('r1', eid, 'v2', 'challenger', true);

    // A THOUSAND by the time the scheduler ticks. 2/1000 is far under 0.5; the
    // frozen 2/3 is over it, so the challenger takes the seat.
    const settled = await h.svc.settleElection(eid, 1_000);
    expect(settled.ok && settled.value.settled).toBe(true);
    expect((await h.svc.getSeat('r1'))?.holderUserId).toBe('challenger');
  });

  it('rejects an election ballot bound to another room (cross-room guard)', async () => {
    await h.svc.bootstrapSeat('rA', 'cA');
    await h.svc.bootstrapSeat('rB', 'cB');
    h.advance(YEAR_MS);
    await h.svc.scheduleElection('rA');
    const b = await h.svc.scheduleElection('rB');
    const eidB = b.ok ? b.value : '';
    // Voting on room B's election while claiming room A's membership is refused.
    const res = await h.svc.castVote('rA', eidB, 'v1', 'cand', true);
    expect(!res.ok && res.code).toBe('not_found');
  });

  it('rejects an election ballot after the close time (before the scheduler tick)', async () => {
    await h.svc.bootstrapSeat('r1', 'creator');
    h.advance(YEAR_MS);
    const sched = await h.svc.scheduleElection('r1');
    const eid = sched.ok ? sched.value : '';
    h.advance(8 * 24 * 60 * 60 * 1000); // past the default 7-day voting window
    const res = await h.svc.castVote('r1', eid, 'v1', 'cand', true);
    expect(!res.ok && res.code).toBe('not_open');
  });
});

describe('GovernanceService — Stage 2 model admission', () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeService();
    await h.svc.bootstrapSeat('r', 'steward');
  });

  it('lets any MEMBER propose (candidacy is a member power; the steward validates), and content-addresses the bundle', async () => {
    // A non-member is refused; a plain member — not just the steward — proposes
    // (a distinct bundle: the same one would collide on the room-digest guard).
    expect((await h.svc.proposeModel('r', 'outsider', goodBundle(), 'p', false)).ok).toBe(false);
    expect(
      (await h.svc.proposeModel('r', 'member-1', { ...goodBundle(), bundleId: 'b2' }, 'p', true))
        .ok,
    ).toBe(true);
    const p = await h.svc.proposeModel('r', 'steward', goodBundle(), 'You moderate r.', true);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('content-addresses a bundle independent of key order (canonical digest)', async () => {
    const ordered = await h.svc.proposeModel('r', 'steward', goodBundle(), 'p', true);
    // The SAME bundle with reordered top-level keys, proposed in another room.
    await h.svc.bootstrapSeat('r2', 'steward');
    const reordered = await h.svc.proposeModel(
      'r2',
      'steward',
      {
        requestedCapabilities: ['moderate.remove', 'moderate.flag'],
        config: {},
        promptTemplates: {},
        moderationPrompt:
          'Route link-heavy, spammy, or otherwise suspicious contributions to human review; allow civil on-topic content.',
        name: 'Civility',
        version: '1',
        bundleId: 'b',
      },
      'p',
      true,
    );
    expect(ordered.ok && reordered.ok).toBe(true);
    if (ordered.ok && reordered.ok) {
      // JSON.stringify would differ on key order; the canonical digest does not.
      expect(reordered.value.artifactDigest).toBe(ordered.value.artifactDigest);
    }
  });

  it('admits a well-behaved model and rejects over/under-moderation (a proposer property)', async () => {
    // Admission is now a property of the in-room MODEL (the proposer), not the
    // bundle text: a model is sampled over the platform floor-safety eval set and
    // must land in-band on every fixture (WS-U.2.2a / ADR-9). The bundle only
    // carries the community's moderationPrompt.

    // Well-behaved (the deterministic default proposer) ⇒ eligible.
    const good = await h.svc.proposeModel('r', 'steward', goodBundle(), 'p', true);
    const goodId = good.ok ? good.value.modelId : '';
    expect((await h.svc.evaluateModel(goodId)).ok).toBe(true);
    expect((await h.stores.models.get(goodId))?.status).toBe('eligible');

    // Over-moderation: a model that REMOVES even the benign fixture ⇒ rejected.
    const over = makeService(false, fixedProposer('remove'));
    await over.svc.bootstrapSeat('r', 'steward');
    const nuke = await over.svc.proposeModel('r', 'steward', goodBundle(), 'p', true);
    const nukeId = nuke.ok ? nuke.value.modelId : '';
    await over.svc.evaluateModel(nukeId);
    expect((await over.stores.models.get(nukeId))?.status).toBe('rejected');

    // Under-moderation: a model that ALLOWS even clearly-violating spam ⇒ rejected.
    const under = makeService(false, fixedProposer('allow'));
    await under.svc.bootstrapSeat('r', 'steward');
    const empty = await under.svc.proposeModel('r', 'steward', goodBundle(), 'p', true);
    const emptyId = empty.ok ? empty.value.modelId : '';
    await under.svc.evaluateModel(emptyId);
    expect((await under.stores.models.get(emptyId))?.status).toBe('rejected');
  });
});

describe('GovernanceService — Stage 3 bounded moderation agent', () => {
  let h: Harness;
  let modelId: string;
  beforeEach(async () => {
    h = makeService();
    await h.svc.bootstrapSeat('r', 'steward');
    const p = await h.svc.proposeModel('r', 'steward', goodBundle(), 'p', true);
    modelId = p.ok ? p.value.modelId : '';
    await h.svc.evaluateModel(modelId);
  });

  it('moderates within the law-pack and logs the action; benign is untouched', async () => {
    expect((await h.svc.approveModel('r', modelId, null, null)).ok).toBe(true);
    const dec = await h.svc.moderate('r', spamCtx, 'contrib-1');
    // The escalate-to-human-review ceiling caps the model at flag_for_review even
    // though the room granted moderate.remove — a human confirms before removal.
    expect(dec.ok && dec.value?.action).toBe('flag_for_review');
    expect((await h.stores.agentActions.listByRoom('r', 10)).length).toBe(1);
    const benign = await h.svc.moderate('r', ctx(), 'contrib-2');
    expect(benign.ok && benign.value?.action).toBe('allow');
    expect((await h.stores.agentActions.listByRoom('r', 10)).length).toBe(1); // allow not logged
  });

  it('downgrades an action the capability descriptor does not grant', async () => {
    // A room granting only moderate.WARN ⇒ a flag proposal is clamped down to warn
    // (below the ceiling, so this exercises the capability clamp, not the ceiling).
    const p = await h.svc.proposeModel(
      'r',
      'steward',
      goodBundle({ requestedCapabilities: ['moderate.warn'] }),
      'p2',
      true,
    );
    const id = p.ok ? p.value.modelId : '';
    await h.svc.evaluateModel(id);
    await h.svc.approveModel('r', id, null, null);
    const dec = await h.svc.moderate('r', spamCtx, 'c');
    expect(dec.ok && dec.value?.action).toBe('warn');
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

  it('reads the crypto flag LIVE — a runtime disable stops execution (WS-L review fix)', async () => {
    let live = true;
    const svc = createGovernanceService({
      stores: createInMemoryGovernanceStores(),
      // Boot config says ENABLED, but the live getter is the source of truth.
      config: resolveGovernanceConfig({ cryptoEnabled: true }),
      cryptoFlag: () => live,
      now: () => new Date(START),
      uuid: () => crypto.randomUUID(),
    });
    await svc.bootstrapSeat('r', 's');
    // An operator disables the shared crypto flag at runtime.
    live = false;
    const tr = await svc.executeTreasuryAction('r', {
      category: 'transparency_report',
      amount: 0,
      asset: null,
      coiDeclared: false,
      proposedAt: '2026-06-19T00:00:00.000Z',
    });
    expect(tr.ok).toBe(false);
    if (!tr.ok) expect(tr.code).toBe('crypto_disabled');
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
      true,
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
