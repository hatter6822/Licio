// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U member ratification vote (the only production path to an active agent):
// the steward opens a vote on an eligible model; members cast yes/no ballots; the
// vote settles (scheduler) and activates the model ONLY on a quorum-meeting
// approving majority (fail-safe otherwise). Adopting a new model supersedes the
// prior one.
import { describe, expect, it } from 'vitest';
import { resolveGovernanceConfig } from '../governance/config.js';
import { runGovernanceTick } from '../governance/scheduler.js';
import { createGovernanceService } from '../governance/services.js';
import { createInMemoryGovernanceStores } from '../governance/stores.js';

function make(windowSeconds = 50) {
  let t = Date.parse('2026-06-19T00:00:00.000Z');
  let n = 0;
  const svc = createGovernanceService({
    stores: createInMemoryGovernanceStores(),
    config: resolveGovernanceConfig({
      electionTermSeconds: 1,
      electionWindowSeconds: windowSeconds,
    }),
    now: () => new Date(t),
    uuid: () => `id-${++n}`,
  });
  return {
    svc,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

const bundle = (over: Record<string, unknown> = {}) => ({
  bundleId: 'b',
  version: '1',
  name: 'n',
  moderationPrompt:
    'Route link-heavy, spammy, or otherwise suspicious contributions to human review; allow civil on-topic content.',
  promptTemplates: {},
  config: {},
  requestedCapabilities: ['moderate.flag'],
  ...over,
});

async function proposeEligible(
  svc: ReturnType<typeof make>['svc'],
  roomId: string,
  steward: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const p = await svc.proposeModel(roomId, steward, bundle(over), 'p', true);
  if (!p.ok) throw new Error('propose failed');
  await svc.evaluateModel(p.value.modelId);
  return p.value.modelId;
}

describe('GovernanceService ratification', () => {
  it('cancel: the steward closes an improper OPEN vote with NO outcome (the last line of defence)', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    const modelId = await proposeEligible(svc, 'r', 's');
    const open = await svc.openRatification('r', 's', modelId, null);
    if (!open.ok) throw new Error('open failed');
    const voteId = open.value.voteId;
    // Steward-only: a non-steward member cannot cancel.
    expect((await svc.cancelRatification('r', 'intruder', voteId)).ok).toBe(false);
    // A ballot lands while open; then the steward cancels…
    expect((await svc.castRatificationBallot('r', voteId, 'v1', 'approve', true)).ok).toBe(true);
    expect((await svc.cancelRatification('r', 's', voteId)).ok).toBe(true);
    // …ballots refuse from that instant, the settle sweep skips it, nothing adopts:
    expect((await svc.castRatificationBallot('r', voteId, 'v2', 'approve', true)).ok).toBe(false);
    expect((await svc.settleRatification(voteId)).ok).toBe(false); // not_open
    expect(await svc.getBinding('r')).toBeNull();
    // The cancel checked the VOTE, not the candidate: the model stays eligible
    // and a FRESH vote may open (the one-open-per-room slot is released).
    expect((await svc.cancelRatification('r', 's', voteId)).ok).toBe(false); // already closed
    expect((await svc.openRatification('r', 's', modelId, null)).ok).toBe(true);
  });

  it('the electorate is FROZEN on both sides — a post-open joiner cannot ratify', async () => {
    // This is the ONLY path to activating a room's in-room AI governance model,
    // and it kept the half-freeze that elections and WS-M proposals had already
    // closed: `eligibleCount` snapshotted at the open, eligibility checked LIVE
    // at ballot time.  `turnout` is `min(1, distinctVoters / eligibleCount)`, so
    // enough post-open joiners satisfy ANY `minTurnout` — a room's model adopted
    // without a single ballot from the electorate it was measured against.
    // A window wide enough that the refusal below can only be the freeze.
    const { svc, advance } = make(3_600);
    await svc.bootstrapSeat('r', 's');
    const modelId = await proposeEligible(svc, 'r', 's');
    // The measurement REPORTS the instant it measured at, and the vote records that
    // instant as its open — so the denominator and the ballot cutoff cannot describe
    // two different states.
    const asked: string[] = [];
    const open = await svc.openRatification('r', 's', modelId, null, async () => {
      const asOf = new Date().toISOString();
      asked.push(asOf);
      return { count: 5, asOf };
    });
    if (!open.ok) throw new Error('open failed');
    const voteId = open.value.voteId;
    expect(asked).toHaveLength(1);

    // A member who was there when it opened votes normally.
    const before = new Date(Date.parse(asked[0] as string) - 86_400_000).toISOString();
    expect((await svc.castRatificationBallot('r', voteId, 'v1', 'approve', true, before)).ok).toBe(
      true,
    );

    // One who joined a minute later is refused, with a code that says why.
    advance(60_000);
    const after = new Date(Date.parse(asked[0] as string) + 60_000).toISOString();
    const late = await svc.castRatificationBallot('r', voteId, 'late', 'approve', true, after);
    expect(late.ok).toBe(false);
    expect(!late.ok && late.code).toBe('joined_after_open');

    // An UNJUDGEABLE join instant (the steward-role arm carries no subscription
    // row) still votes — refusing there would lock out a legitimate steward to
    // close a narrower hole than it opens, the same call `castVote` makes.
    expect((await svc.castRatificationBallot('r', voteId, 'sw', 'approve', true, null)).ok).toBe(
      true,
    );
  });

  it('cancel: refused after the published close (no pocket veto during the settle latency window)', async () => {
    const { svc, advance } = make(50);
    await svc.bootstrapSeat('r', 's');
    const modelId = await proposeEligible(svc, 'r', 's');
    const open = await svc.openRatification('r', 's', modelId, null);
    if (!open.ok) throw new Error('open failed');
    // A member ballot lands, the window closes… a steward watching the tally
    // must NOT be able to cancel the concluded vote before the settle tick.
    expect(
      (await svc.castRatificationBallot('r', open.value.voteId, 'v1', 'approve', true)).ok,
    ).toBe(true);
    advance(51_000); // past closesAt (window = 50s), before any settle tick
    const lateCancel = await svc.cancelRatification('r', 's', open.value.voteId);
    expect(!lateCancel.ok && lateCancel.code).toBe('not_open');
    // The concluded vote still settles and activates normally.
    const settled = await svc.settleRatification(open.value.voteId);
    expect(settled.ok && settled.value.activated).toBe(true);
  });

  it('cancel: a foreign room vote id is a 404-class refusal, never cross-room cancellable', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    await svc.bootstrapSeat('r2', 's2');
    const modelId = await proposeEligible(svc, 'r', 's');
    const open = await svc.openRatification('r', 's', modelId, null);
    if (!open.ok) throw new Error('open failed');
    const foreign = await svc.cancelRatification('r2', 's2', open.value.voteId);
    expect(!foreign.ok && foreign.code).toBe('not_found');
  });

  it('opens a vote (steward only), gates ballots to members, and is idempotent', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    const modelId = await proposeEligible(svc, 'r', 's');

    expect((await svc.openRatification('r', 'intruder', modelId, null)).ok).toBe(false); // not_steward
    const open = await svc.openRatification('r', 's', modelId, null);
    expect(open.ok).toBe(true);
    const voteId = open.ok ? open.value.voteId : '';
    // Only one open vote per room.
    expect((await svc.openRatification('r', 's', modelId, null)).ok).toBe(false); // vote_open

    // A non-member ballot is refused; a member's is accepted; a repeat is idempotent.
    expect((await svc.castRatificationBallot('r', voteId, 'x', 'approve', false)).ok).toBe(false); // not_member
    expect((await svc.castRatificationBallot('r', voteId, 'v1', 'approve', true)).ok).toBe(true);
    expect((await svc.castRatificationBallot('r', voteId, 'v1', 'reject', true)).ok).toBe(false); // already_voted
  });

  it('reads the electorate ONLY after authorization passes (no unauth count)', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    const modelId = await proposeEligible(svc, 'r', 's');
    let counted = 0;
    const count = async () => {
      counted += 1;
      return { count: 5, asOf: new Date().toISOString() };
    };
    // A non-steward is rejected WITHOUT the (potentially expensive) electorate count.
    expect((await svc.openRatification('r', 'intruder', modelId, null, count)).ok).toBe(false);
    expect(counted).toBe(0);
    // The elected steward opening a valid vote reads it exactly once.
    expect((await svc.openRatification('r', 's', modelId, null, count)).ok).toBe(true);
    expect(counted).toBe(1);
  });

  it('settles an approving majority into an ACTIVE agent', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    const modelId = await proposeEligible(svc, 'r', 's');
    const open = await svc.openRatification('r', 's', modelId, null);
    const voteId = open.ok ? open.value.voteId : '';
    await svc.castRatificationBallot('r', voteId, 'v1', 'approve', true);
    await svc.castRatificationBallot('r', voteId, 'v2', 'approve', true);
    const settled = await svc.settleRatification(voteId);
    expect(settled.ok && settled.value.outcome).toBe('approved');
    expect(settled.ok && settled.value.activated).toBe(true);
    const binding = await svc.getBinding('r');
    expect(binding?.active).toBe(true);
    expect(binding?.modelId).toBe(modelId);
  });

  it('is FAIL-SAFE: a rejected/under-quorum vote does not activate', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    const modelId = await proposeEligible(svc, 'r', 's');
    const open = await svc.openRatification('r', 's', modelId, null);
    const voteId = open.ok ? open.value.voteId : '';
    await svc.castRatificationBallot('r', voteId, 'v1', 'reject', true);
    const settled = await svc.settleRatification(voteId);
    expect(settled.ok && settled.value.outcome).toBe('rejected');
    expect(settled.ok && settled.value.activated).toBe(false);
    expect(await svc.getBinding('r')).toBeNull();
    // The model stays eligible (re-votable), not approved.
    expect((await svc.getModel(modelId))?.status).toBe('eligible');
  });

  it('supersedes the prior model when a new one is ratified', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    const first = await proposeEligible(svc, 'r', 's');
    // Activate the first directly (the internal primitive).
    await svc.approveModel('r', first, null, null);
    expect((await svc.getModel(first))?.status).toBe('approved');
    // Ratify a second, distinct model.
    const second = await proposeEligible(svc, 'r', 's', { bundleId: 'b2', name: 'n2' });
    const open = await svc.openRatification('r', 's', second, null);
    const voteId = open.ok ? open.value.voteId : '';
    await svc.castRatificationBallot('r', voteId, 'v1', 'approve', true);
    await svc.settleRatification(voteId);
    expect((await svc.getModel(second))?.status).toBe('approved');
    expect((await svc.getModel(first))?.status).toBe('superseded'); // the prior is demoted
    expect((await svc.getBinding('r'))?.modelId).toBe(second);
  });

  it('rejects opening/settling/casting on missing or closed subjects', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    // Open on a non-existent model.
    expect((await svc.openRatification('r', 's', 'no-such-model', null)).ok).toBe(false); // not_found
    // Settle a non-existent vote.
    expect((await svc.settleRatification('no-such-vote')).ok).toBe(false); // not_found
    // Cast on a settled vote.
    const modelId = await proposeEligible(svc, 'r', 's');
    const open = await svc.openRatification('r', 's', modelId, null);
    const voteId = open.ok ? open.value.voteId : '';
    await svc.settleRatification(voteId);
    expect((await svc.castRatificationBallot('r', voteId, 'v1', 'approve', true)).ok).toBe(false); // not_open
    // Re-settling a settled vote is refused.
    expect((await svc.settleRatification(voteId)).ok).toBe(false); // not_open
  });

  it('the scheduler settles a vote whose window has closed', async () => {
    const { svc, advance, now } = make(50);
    await svc.bootstrapSeat('r', 's');
    const modelId = await proposeEligible(svc, 'r', 's');
    const open = await svc.openRatification('r', 's', modelId, null);
    const voteId = open.ok ? open.value.voteId : '';
    await svc.castRatificationBallot('r', voteId, 'v1', 'approve', true);
    // Before the window closes: the lifecycle is a no-op.
    expect(await svc.runRatificationLifecycle(now())).toEqual({
      settled: 0,
      activated: 0,
    });
    advance(51_000);
    const result = await svc.runRatificationLifecycle(now());
    expect(result).toEqual({ settled: 1, activated: 1 });
    expect((await svc.getBinding('r'))?.active).toBe(true);

    // The tick also routes through runGovernanceTick without error.
    await runGovernanceTick({
      service: svc,
      eligibleVoterCount: async () => 1,
      log: () => {},
      now,
    });
  });

  it('rejects a ratification ballot bound to another room (cross-room guard)', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('rA', 's');
    await svc.bootstrapSeat('rB', 's');
    const mB = await proposeEligible(svc, 'rB', 's');
    const openB = await svc.openRatification('rB', 's', mB, null);
    const voteB = openB.ok ? openB.value.voteId : '';
    // Casting room B's vote while claiming room A's membership is refused.
    const res = await svc.castRatificationBallot('rA', voteB, 'v1', 'approve', true);
    expect(!res.ok && res.code).toBe('not_found');
  });

  it('rejects a ratification ballot after the close time (before the tick)', async () => {
    const { svc, advance } = make(50);
    await svc.bootstrapSeat('r', 's');
    const m = await proposeEligible(svc, 'r', 's');
    const open = await svc.openRatification('r', 's', m, null);
    const voteId = open.ok ? open.value.voteId : '';
    advance(51_000); // past the window, before the scheduler settles it
    const res = await svc.castRatificationBallot('r', voteId, 'v1', 'approve', true);
    expect(!res.ok && res.code).toBe('not_open');
  });

  it("rejects opening a ratification bound to another room's law-pack", async () => {
    const { svc } = make();
    await svc.bootstrapSeat('rA', 's');
    await svc.bootstrapSeat('rB', 's');
    const lpB = await svc.proposeLawPack('rB', 's', {
      lawPackId: 'ignored',
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
    const lawPackId = lpB.ok ? lpB.value.lawPackId : '';
    const mA = await proposeEligible(svc, 'rA', 's');
    // Binding room B's law-pack to room A's ratification is refused.
    const res = await svc.openRatification('rA', 's', mA, lawPackId);
    expect(!res.ok && res.code).toBe('invalid_law_pack');
  });

  it('allows at most ONE open ratification per room — the atomic insert guard', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    const m1 = await proposeEligible(svc, 'r', 's');
    const m2 = await proposeEligible(svc, 'r', 's', { bundleId: 'b2', name: 'n2' });
    expect((await svc.openRatification('r', 's', m1, null)).ok).toBe(true);
    // A second open — even for a DIFFERENT model — collides on the one-open-
    // per-room guard (the insert returns null), so no second open vote is created.
    const second = await svc.openRatification('r', 's', m2, null);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.code).toBe('vote_open');
  });

  it('freezes the turnout electorate at open (M4) — the denominator is fixed for the vote', async () => {
    const { svc } = make();
    await svc.bootstrapSeat('r', 's');
    // A law-pack requiring 50% turnout, quorum 1.
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
        minTurnout: 0.5,
        termSeconds: 1,
      },
    });
    const lawPackId = lp.ok ? lp.value.lawPackId : '';

    // Frozen electorate of 2; one approving ballot ⇒ turnout 1/2 = 0.5 ✓ (adopted).
    const m1 = await proposeEligible(svc, 'r', 's');
    const open1 = await svc.openRatification('r', 's', m1, lawPackId, () =>
      Promise.resolve({ count: 2, asOf: new Date().toISOString() }),
    );
    const v1 = open1.ok ? open1.value.voteId : '';
    await svc.castRatificationBallot('r', v1, 'a', 'approve', true);
    expect((await svc.settleRatification(v1)).ok && (await svc.getBinding('r'))?.active).toBe(true);

    // A SECOND vote with a frozen electorate of 10; the same single ballot ⇒
    // turnout 1/10 = 0.1 < 0.5 ⇒ FAIL-SAFE, no matter what membership does later.
    const m2 = await proposeEligible(svc, 'r', 's', { bundleId: 'b2', name: 'n2' });
    const open2 = await svc.openRatification('r', 's', m2, lawPackId, () =>
      Promise.resolve({ count: 10, asOf: new Date().toISOString() }),
    );
    const v2 = open2.ok ? open2.value.voteId : '';
    await svc.castRatificationBallot('r', v2, 'a', 'approve', true);
    const s2 = await svc.settleRatification(v2);
    expect(s2.ok && s2.value.outcome).toBe('rejected');
    // The first model stays bound (the under-turnout second vote did not supersede).
    expect((await svc.getBinding('r'))?.modelId).toBe(m1);
  });
});
