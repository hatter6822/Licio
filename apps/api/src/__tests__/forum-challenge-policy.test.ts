// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T challenge-policy route behavior (SPEC §15.4): the self-challenge
// refusal, the standing-derived concurrent-slot capacity (slot frees at the
// verdict), the post-withdrawal cooldown vs the 5-minute grace, the daily
// open budget, the KYC capacity boost, the once-per-target-per-version right,
// the settled threshold (three adjudicated upheld defenses), and the
// material-edit reset.  The pure math is covered in challenge-policy.test.ts;
// these tests drive the REAL create/withdraw/scheduler paths end to end.

import { randomUUID } from 'node:crypto';
import type { DebateJudgeVerdict } from '@licio/ai-governance';
import {
  type ChallengeStandingResponse,
  COMMONS_ROOM_ID,
  type ContributionPublic,
  challengeStandingResponseSchema,
  contributionPublicSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { maybeEnterDebate } from '../forum/debate.js';
import { buildDebateDeps, runDebateSchedulerTick } from '../forum/debate-scheduler.js';
import { createV1Routes } from '../routes/v1.js';
import type { SeededUser } from './event-test-helpers.js';
import {
  contributionBody,
  type ForumServicesFixture,
  freshForumServices,
  jsonRequest,
  seedThread,
  seedUserWithSession,
} from './forum-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const UPHELD: DebateJudgeVerdict = {
  model_version: 'test-judge',
  winner: 'incumbent',
  verdict: 'upheld',
  confidence: 0.9,
  probabilities: { incumbent: 0.9, challenger: 0.05, inconclusive: 0.05 },
  rationale: 'The incumbent is better sourced.',
};

let fixture: ForumServicesFixture;
let nowMs: number;
let author: SeededUser;
let threadId: string;

const rethrow = (err: unknown): never => {
  throw err;
};

beforeEach(async () => {
  nowMs = Date.parse('2026-06-11T12:00:00.000Z');
  fixture = freshForumServices({
    now: () => nowMs,
    forumConfig: { contributionsPerMinute: 100, contributionsPerHour: 5_000 },
  });
  author = await seedUserWithSession(fixture.identity);
  ({ threadId } = await seedThread(fixture));
});

async function post(body: Record<string, unknown>, cookie: string): Promise<Response> {
  return app().request(jsonRequest('/v1/contributions', 'POST', body, cookie));
}

async function postOk(body: Record<string, unknown>, cookie: string): Promise<ContributionPublic> {
  const res = await post(body, cookie);
  expect(res.status).toBe(201);
  const json = (await res.json()) as { contribution: unknown };
  return contributionPublicSchema.parse(json.contribution);
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** A published comment by the author (a challengeable target). */
async function seedTarget(): Promise<string> {
  const comment = await postOk(contributionBody('comment', threadId), author.cookie);
  return comment.contribution_id;
}

function challengeBody(targetId: string): Record<string, unknown> {
  return contributionBody('correction', threadId, { targetId });
}

/** Drive a live arena to `resolved` through the REAL scheduler: the
 *  both-sides-idle expedite locks + judges it, then the 24h override window
 *  elapses and finalize applies the outcome. */
async function resolveArena(debateId: string): Promise<void> {
  nowMs += HOUR_MS + 1000; // both sides idle ⇒ expedite + judge on one tick
  await runDebateSchedulerTick(rethrow);
  expect((await fixture.forum.debates.getById(debateId))?.state).toBe('judged');
  nowMs += 24 * HOUR_MS + 1000; // the steward-override window closes
  await runDebateSchedulerTick(rethrow);
  expect((await fixture.forum.debates.getById(debateId))?.state).toBe('resolved');
}

describe('WS-T challenge policy — self-challenge refusal', () => {
  it('refuses challenging your own comment and your own story', async () => {
    const targetId = await seedTarget();
    const own = await post(challengeBody(targetId), author.cookie);
    expect(own.status).toBe(422);
    expect(await errorCode(own)).toBe('cannot_challenge_own_content');

    // A story submitted BY the author is equally self-unchallengeable.
    const owned = await seedThread(fixture, { submittedBy: author.userId });
    const ownStory = await post(
      contributionBody('correction', owned.threadId, { storyId: owned.storyId }),
      author.cookie,
    );
    expect(ownStory.status).toBe(422);
    expect(await errorCode(ownStory)).toBe('cannot_challenge_own_content');
  });
});

describe('WS-T challenge policy — capacity and velocity', () => {
  it('caps a new account at ONE live challenge; the slot frees at the verdict', async () => {
    const challenger = await seedUserWithSession(fixture.identity);
    const first = await postOk(challengeBody(await seedTarget()), challenger.cookie);
    const debateId = first.metadata.debate_arena_id ?? '';
    // The second concurrent challenge (a different target) is refused.
    const secondTarget = await seedTarget();
    const refused = await post(challengeBody(secondTarget), challenger.cookie);
    expect(refused.status).toBe(422);
    expect(await errorCode(refused)).toBe('challenge_capacity_reached');
    // The verdict frees the slot — BEFORE the arena finalizes (judged, not
    // resolved, is the boundary; the 24h override window holds no slot).
    nowMs += HOUR_MS + 1000;
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('judged');
    const afterVerdict = await post(challengeBody(secondTarget), challenger.cookie);
    expect(afterVerdict.status).toBe(201);
  });

  it('enforces the daily open budget with Retry-After', async () => {
    const daily = freshForumServices({
      now: () => nowMs,
      forumConfig: {
        contributionsPerMinute: 100,
        challengeOpensPerDay: 1,
        // Capacity is not under test here.
        challengeBaseCapacity: 10,
      },
    });
    const dailyAuthor = await seedUserWithSession(daily.identity);
    const challenger = await seedUserWithSession(daily.identity);
    const seeded = await seedThread(daily);
    const mkTarget = async () =>
      (await postOk(contributionBody('comment', seeded.threadId), dailyAuthor.cookie))
        .contribution_id;
    await postOk(
      contributionBody('correction', seeded.threadId, { targetId: await mkTarget() }),
      challenger.cookie,
    );
    const refused = await post(
      contributionBody('correction', seeded.threadId, { targetId: await mkTarget() }),
      challenger.cookie,
    );
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe('challenge_daily_limit');
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
    // The trailing 24h window ages the open out.
    nowMs += DAY_MS + 1000;
    const later = await post(
      contributionBody('correction', seeded.threadId, { targetId: await mkTarget() }),
      challenger.cookie,
    );
    expect(later.status).toBe(201);
  });

  it('the KYC boost raises capacity without gating the floor', async () => {
    // A null seam (the fixture default) means no boost — the floor of 1.
    const challenger = await seedUserWithSession(fixture.identity);
    await postOk(challengeBody(await seedTarget()), challenger.cookie);
    const refused = await post(challengeBody(await seedTarget()), challenger.cookie);
    expect(await errorCode(refused)).toBe('challenge_capacity_reached');
    // KYC-verified: base 1 + bonus 2 ⇒ three concurrent slots.
    fixture.forum.kycReader = async () => true;
    expect((await post(challengeBody(await seedTarget()), challenger.cookie)).status).toBe(201);
    expect((await post(challengeBody(await seedTarget()), challenger.cookie)).status).toBe(201);
    const fourth = await post(challengeBody(await seedTarget()), challenger.cookie);
    expect(fourth.status).toBe(422);
    expect(await errorCode(fourth)).toBe('challenge_capacity_reached');
    // A THROWING reader fails closed to the floor, never an error.
    fixture.forum.kycReader = async () => {
      throw new Error('compliance outage');
    };
    const during = await post(challengeBody(await seedTarget()), challenger.cookie);
    expect(await errorCode(during)).toBe('challenge_capacity_reached');
  });

  it('adjudicated challenger wins raise capacity (tier at three distinct wins)', async () => {
    const challenger = await seedUserWithSession(fixture.identity);
    fixture.forum.debateJudge = async () => ({
      verdict: {
        ...UPHELD,
        winner: 'challenger',
        verdict: 'corrected',
        probabilities: { incumbent: 0.05, challenger: 0.9, inconclusive: 0.05 },
      },
      outputId: 'out-win',
    });
    // Three adjudicated wins against three DISTINCT authors.
    for (let i = 0; i < 3; i += 1) {
      const opponent = await seedUserWithSession(fixture.identity);
      const target = (await postOk(contributionBody('comment', threadId), opponent.cookie))
        .contribution_id;
      const filed = await postOk(challengeBody(target), challenger.cookie);
      await resolveArena(filed.metadata.debate_arena_id ?? '');
    }
    // Tier 1 earned: TWO concurrent challenges now fit.
    expect((await post(challengeBody(await seedTarget()), challenger.cookie)).status).toBe(201);
    expect((await post(challengeBody(await seedTarget()), challenger.cookie)).status).toBe(201);
    const third = await post(challengeBody(await seedTarget()), challenger.cookie);
    expect(await errorCode(third)).toBe('challenge_capacity_reached');
  });
});

describe('WS-T challenge policy — the post-open quota recheck (TOCTOU)', () => {
  it('self-voids a raced overflow open as a grace withdrawal', async () => {
    const challenger = await seedUserWithSession(fixture.identity);
    // One live arena occupies the (floor) capacity of 1.
    await postOk(challengeBody(await seedTarget()), challenger.cookie);
    // Simulate the RACED request that already passed the account gates before
    // the first arena existed: its correction row is inserted directly and
    // the arena open runs with the same resolved quota the gate computed.
    const target2 = await seedTarget();
    const racedCorrectionId = randomUUID();
    const inserted = await fixture.forum.contributions.insert({
      contributionId: racedCorrectionId,
      threadId,
      userId: challenger.userId,
      type: 'correction',
      body: 'Raced challenge.',
      citations: [{ url: 'https://example.org/raced' }],
      metadata: { target_contribution_id: target2 },
      targetClaimId: null,
      parentContributionId: target2,
      clientDraftId: `draft-${racedCorrectionId}`,
      path: [target2],
      moderationState: 'published',
    });
    expect(inserted.ok).toBe(true);
    // Strictly newer than the first arena: under the frozen test clock both
    // opens would otherwise share a createdAt and the oldest-survives order
    // would fall to the random debate-id tie-break.
    nowMs += 1000;
    const racedArenaId = randomUUID();
    const opened = await maybeEnterDebate(
      buildDebateDeps(fixture.forum, fixture.ingestion),
      {
        contributionId: racedCorrectionId,
        threadId,
        storyId: (await fixture.ingestion.stories.getThreadById(threadId))?.storyId ?? '',
        roomId: (await fixture.ingestion.stories.getThreadById(threadId))?.roomId ?? null,
        userId: challenger.userId,
        body: 'Raced challenge.',
        citations: [{ url: 'https://example.org/raced' }],
        metadata: { target_contribution_id: target2 },
      },
      racedArenaId,
      {
        capacity: 1,
        opensPerDay: 5,
        opensCutoffIso: new Date(nowMs - DAY_MS).toISOString(),
        graceMs: 5 * 60_000,
      },
    );
    // The overflow open self-voided: no arena handed out, the row is a
    // terminal withdrawal, and the target was never tagged.
    expect(opened).toBeNull();
    expect((await fixture.forum.debates.getById(racedArenaId))?.state).toBe('withdrawn');
    expect((await fixture.forum.contributions.getById(target2))?.disputeStatus).toBe('none');
    // GRACE by construction: the racer is not cooled down and keeps the
    // once-per-target right on that target.
    const history = await fixture.forum.debates.challengerHistory(challenger.userId, {
      nowIso: new Date(nowMs).toISOString(),
      opensWindowMs: DAY_MS,
      withdrawWindowMs: 30 * DAY_MS,
      graceMs: 5 * 60_000,
    });
    expect(history.liveCount).toBe(1);
    expect(
      await fixture.forum.debates.latestConcludedChallengeAt(
        { contributionId: target2 },
        challenger.userId,
        5 * 60_000,
      ),
    ).toBeNull();
  });
});

describe('WS-T challenge policy — withdrawal pricing', () => {
  it('a non-grace withdrawal starts a cooldown (429 + Retry-After)', async () => {
    const challenger = await seedUserWithSession(fixture.identity);
    const filed = await postOk(challengeBody(await seedTarget()), challenger.cookie);
    const debateId = filed.metadata.debate_arena_id ?? '';
    // The incumbent engages (a rebuttal): the grace window no longer applies.
    const rebuttal = await app().request(
      jsonRequest(
        `/v1/debates/${debateId}/position`,
        'POST',
        {
          summary: 'The figure is from the certified record.',
          citations: [{ url: 'https://example.gov/rec' }],
        },
        author.cookie,
      ),
    );
    expect(rebuttal.status).toBe(200);
    nowMs += 10 * 60_000; // past the 5-minute grace window
    const withdrawn = await app().request(
      jsonRequest(`/v1/debates/${debateId}/withdraw`, 'POST', {}, challenger.cookie),
    );
    expect(withdrawn.status).toBe(200);
    const refused = await post(challengeBody(await seedTarget()), challenger.cookie);
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe('challenge_cooldown');
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
    // The first-withdrawal rung (2h) expires.
    nowMs += 2 * HOUR_MS + 1000;
    expect((await post(challengeBody(await seedTarget()), challenger.cookie)).status).toBe(201);
  });

  it('a grace withdrawal (5 minutes, incumbent never engaged) costs nothing and consumes nothing', async () => {
    const challenger = await seedUserWithSession(fixture.identity);
    const targetId = await seedTarget();
    const filed = await postOk(challengeBody(targetId), challenger.cookie);
    nowMs += 2 * 60_000; // inside the grace window, incumbent silent
    const withdrawn = await app().request(
      jsonRequest(
        `/v1/debates/${filed.metadata.debate_arena_id ?? ''}/withdraw`,
        'POST',
        {},
        challenger.cookie,
      ),
    );
    expect(withdrawn.status).toBe(200);
    // No cooldown — and the once-per-target right was NOT consumed: the SAME
    // account may re-file against the SAME target immediately.
    const refiled = await post(challengeBody(targetId), challenger.cookie);
    expect(refiled.status).toBe(201);
  });
});

describe('WS-T challenge policy — the post-open target-state recheck', () => {
  it('a prior arena finalizing between the guards and the open never bypasses once-per-target', async () => {
    const challenger = await seedUserWithSession(fixture.identity);
    const targetId = await seedTarget();
    const filed = await postOk(challengeBody(targetId), challenger.cookie);
    const debateId = filed.metadata.debate_arena_id ?? '';
    nowMs += HOUR_MS + 1000;
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('judged');
    nowMs += 24 * HOUR_MS + 1000;
    // The vulnerable interleave: finalize's STATUS write lands before the
    // second create's guards read (simulated by the direct store poke — the
    // arena itself is still `judged`, so `latestConcludedChallengeAt` sees
    // nothing concluded), and the RESOLVE lands before the arena open (the
    // classify hook runs the finalize tick), so the one-live-per-target
    // constraint no longer blocks either.  Only the post-open target-state
    // recheck stands between this and a second arena on the same version.
    await fixture.forum.contributions.setDisputeStatus(targetId, 'none', null);
    const safety = fixture.forum.safety;
    const realClassify = safety.classify.bind(safety);
    safety.classify = async (...args: Parameters<typeof realClassify>) => {
      safety.classify = realClassify;
      await runDebateSchedulerTick(rethrow);
      expect((await fixture.forum.debates.getById(debateId))?.state).toBe('resolved');
      return realClassify(...args);
    };
    const refiled = await post(challengeBody(targetId), challenger.cookie);
    expect(refiled.status).toBe(201);
    const body = (await refiled.json()) as {
      contribution: { contribution_id: string; metadata: { debate_arena_id?: string } };
    };
    // The correction posted but its arena self-voided: no arena id handed
    // out, the raced arena is a terminal (grace) withdrawal, and the target
    // was never re-tagged.
    expect(body.contribution.metadata.debate_arena_id).toBeUndefined();
    expect(await fixture.forum.debates.getActiveForComment(targetId)).toBeNull();
    expect((await fixture.forum.contributions.getById(targetId))?.disputeStatus).toBe('none');
    // The once-per-target right stays consumed for this version.
    expect(
      await fixture.forum.debates.latestConcludedChallengeAt(
        { contributionId: targetId },
        challenger.userId,
        5 * 60_000,
      ),
    ).not.toBeNull();
  });
});

describe('WS-T challenge policy — grace and the daily budget', () => {
  it('a grace withdrawal burns no daily budget (immediate re-file allowed)', async () => {
    const tight = freshForumServices({
      now: () => nowMs,
      forumConfig: {
        contributionsPerMinute: 100,
        challengeOpensPerDay: 1,
        challengeBaseCapacity: 10,
      },
    });
    const tightAuthor = await seedUserWithSession(tight.identity);
    const challenger = await seedUserWithSession(tight.identity);
    const seeded = await seedThread(tight);
    const target = (await postOk(contributionBody('comment', seeded.threadId), tightAuthor.cookie))
      .contribution_id;
    const filed = await postOk(
      contributionBody('correction', seeded.threadId, { targetId: target }),
      challenger.cookie,
    );
    nowMs += 2 * 60_000; // inside the grace window, incumbent silent
    const withdrawn = await app().request(
      jsonRequest(
        `/v1/debates/${filed.metadata.debate_arena_id ?? ''}/withdraw`,
        'POST',
        {},
        challenger.cookie,
      ),
    );
    expect(withdrawn.status).toBe(200);
    // opensPerDay is 1 and the grace-withdrawn open is budget-EXEMPT: the
    // immediate re-file (same target — once-per-target also unconsumed)
    // succeeds instead of a 24h challenge_daily_limit.
    const refiled = await post(
      contributionBody('correction', seeded.threadId, { targetId: target }),
      challenger.cookie,
    );
    expect(refiled.status).toBe(201);
  });
});

describe('WS-T challenge policy — once per target per version', () => {
  it('a concluded challenge consumes the right until the target materially changes', async () => {
    const challenger = await seedUserWithSession(fixture.identity);
    const targetId = await seedTarget();
    const filed = await postOk(challengeBody(targetId), challenger.cookie);
    // The default fixture judge is fail-closed null ⇒ inconclusive; the
    // target clears back to `none` and stays re-challengeable — but NOT by
    // the same account against the same version.
    await resolveArena(filed.metadata.debate_arena_id ?? '');
    const again = await post(challengeBody(targetId), challenger.cookie);
    expect(again.status).toBe(422);
    expect(await errorCode(again)).toBe('target_already_challenged');
    // A DIFFERENT account still can.
    const other = await seedUserWithSession(fixture.identity);
    expect((await post(challengeBody(targetId), other.cookie)).status).toBe(201);
    // A material edit by the author re-opens the first account's right.
    nowMs += 60_000;
    const otherArena = await fixture.forum.debates.getActiveForComment(targetId);
    // Close the live arena first (one live per target) via the author's
    // concession, then edit.
    const conceded = await app().request(
      jsonRequest(`/v1/debates/${otherArena?.debateId ?? ''}/concede`, 'POST', {}, author.cookie),
    );
    expect(conceded.status).toBe(200);
    // A conceded target is `incorrect` — terminally unchallengeable — so use
    // a FRESH target to prove the edit-reset instead.
    const freshTarget = await seedTarget();
    const filed2 = await postOk(challengeBody(freshTarget), challenger.cookie);
    await resolveArena(filed2.metadata.debate_arena_id ?? '');
    expect(await errorCode(await post(challengeBody(freshTarget), challenger.cookie))).toBe(
      'target_already_challenged',
    );
    nowMs += 60_000;
    const edit = await app().request(
      jsonRequest(
        `/v1/contributions/${freshTarget}`,
        'PATCH',
        { contribution_id: freshTarget, body: 'A genuinely revised claim.' },
        author.cookie,
      ),
    );
    expect(edit.status).toBe(200);
    expect((await post(challengeBody(freshTarget), challenger.cookie)).status).toBe(201);
  });
});

describe('WS-T challenge policy — standing endpoint + unsettle', () => {
  async function standing(cookie: string, query = ''): Promise<ChallengeStandingResponse> {
    const res = await app().request(
      new Request(`http://local/v1/challenge-standing${query}`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    return challengeStandingResponseSchema.parse(await res.json());
  }

  /** Settle a target: three distinct challengers, all adjudicated `upheld`. */
  async function settleTarget(targetId: string): Promise<void> {
    fixture.forum.debateJudge = async () => ({ verdict: UPHELD, outputId: 'out-upheld' });
    for (let i = 0; i < 3; i += 1) {
      const challenger = await seedUserWithSession(fixture.identity);
      const filed = await postOk(challengeBody(targetId), challenger.cookie);
      await resolveArena(filed.metadata.debate_arena_id ?? '');
    }
    expect((await fixture.forum.contributions.getById(targetId))?.settledAt).not.toBeNull();
  }

  it('serves the caller their own quota, cooldown, and target probe', async () => {
    const challenger = await seedUserWithSession(fixture.identity);
    const fresh = await standing(challenger.cookie);
    expect(fresh.standing.capacity).toBe(1);
    expect(fresh.standing.available).toBe(1);
    expect(fresh.standing.can_open_now).toBe(true);
    expect(fresh.standing.blocked_by).toBeNull();
    expect(fresh.standing.policy.settle_threshold).toBe(3);
    expect(fresh.standing.target).toBeNull();

    const targetId = await seedTarget();
    // The probe mirrors the create guard: the AUTHOR sees own_content.
    const own = await standing(author.cookie, `?target_contribution_id=${targetId}`);
    expect(own.standing.target).toEqual({ challengeable: false, reason: 'own_content' });
    const probed = await standing(challenger.cookie, `?target_contribution_id=${targetId}`);
    expect(probed.standing.target).toEqual({ challengeable: true, reason: null });

    // A live challenge occupies the slot…
    const filed = await postOk(challengeBody(targetId), challenger.cookie);
    const occupied = await standing(challenger.cookie);
    expect(occupied.standing.live_count).toBe(1);
    expect(occupied.standing.available).toBe(0);
    expect(occupied.standing.blocked_by).toBe('capacity');
    // …and a non-grace withdrawal surfaces the cooldown.
    const rebuttal = await app().request(
      jsonRequest(
        `/v1/debates/${filed.metadata.debate_arena_id ?? ''}/position`,
        'POST',
        { summary: 'Engaging the challenge.', citations: [{ url: 'https://example.gov/r' }] },
        author.cookie,
      ),
    );
    expect(rebuttal.status).toBe(200);
    nowMs += 10 * 60_000;
    await app().request(
      jsonRequest(
        `/v1/debates/${filed.metadata.debate_arena_id ?? ''}/withdraw`,
        'POST',
        {},
        challenger.cookie,
      ),
    );
    const cooling = await standing(challenger.cookie);
    expect(cooling.standing.blocked_by).toBe('cooldown');
    expect(cooling.standing.cooldown_until).not.toBeNull();
  });

  it('unsettle is steward/admin-gated, reopens the lane, and re-settles on the next upheld defense', async () => {
    const targetId = await seedTarget();
    await settleTarget(targetId);
    const fourth = await seedUserWithSession(fixture.identity);
    // The settled probe answers before anyone burns a create.
    const probed = await standing(fourth.cookie, `?target_contribution_id=${targetId}`);
    expect(probed.standing.target).toEqual({ challengeable: false, reason: 'settled' });
    // A plain verified member may not unsettle.
    const refused = await app().request(
      jsonRequest(`/v1/contributions/${targetId}/unsettle`, 'POST', {}, fourth.cookie),
    );
    expect(refused.status).toBe(403);
    // A ROOM STEWARD may.
    const steward = await seedUserWithSession(fixture.identity);
    await fixture.forum.rooms.addSteward({
      roomId: COMMONS_ROOM_ID,
      userId: steward.userId,
      role: 'community_steward',
      assignedAt: new Date(nowMs).toISOString(),
    });
    const unsettled = await app().request(
      jsonRequest(`/v1/contributions/${targetId}/unsettle`, 'POST', {}, steward.cookie),
    );
    expect(unsettled.status).toBe(200);
    expect(((await unsettled.json()) as { unsettled: boolean }).unsettled).toBe(true);
    // The settled mark alone cleared — the adjudicated `validated` badge stands.
    const row = await fixture.forum.contributions.getById(targetId);
    expect(row?.settledAt).toBeNull();
    expect(row?.disputeStatus).toBe('validated');
    // A second unsettle is a 409 (nothing settled).
    const again = await app().request(
      jsonRequest(`/v1/contributions/${targetId}/unsettle`, 'POST', {}, steward.cookie),
    );
    expect(again.status).toBe(409);
    // The lane is open — and the NEXT upheld defense re-settles immediately
    // (the door stays open only until the record re-confirms the content).
    const refiled = await postOk(challengeBody(targetId), fourth.cookie);
    await resolveArena(refiled.metadata.debate_arena_id ?? '');
    const resettled = await fixture.forum.contributions.getById(targetId);
    expect(resettled?.disputeStatus).toBe('validated');
    expect(resettled?.settledAt).not.toBeNull();
  });

  it('three upheld defenses settle a STORY too (persisted mark, unsettle, re-settle)', async () => {
    fixture.forum.debateJudge = async () => ({ verdict: UPHELD, outputId: 'out-upheld' });
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    const storyChallenge = () => contributionBody('correction', threadId, { storyId });
    for (let i = 0; i < 3; i += 1) {
      const challenger = await seedUserWithSession(fixture.identity);
      const filed = await postOk(storyChallenge(), challenger.cookie);
      await resolveArena(filed.metadata.debate_arena_id ?? '');
      const story = await fixture.ingestion.stories.getById(storyId);
      expect(story?.disputeStatus).toBe('validated');
      // The settled mark PERSISTS through the story dispute setter (it was
      // silently dropped before the setter forwarded the third argument).
      expect(story?.settledAt == null).toBe(i < 2);
    }
    const fourth = await seedUserWithSession(fixture.identity);
    const refused = await post(storyChallenge(), fourth.cookie);
    expect(refused.status).toBe(422);
    expect(await errorCode(refused)).toBe('target_settled');
    // The story unsettle route clears the mark; the next upheld re-settles.
    const steward = await seedUserWithSession(fixture.identity);
    await fixture.forum.rooms.addSteward({
      roomId: COMMONS_ROOM_ID,
      userId: steward.userId,
      role: 'community_steward',
      assignedAt: new Date(nowMs).toISOString(),
    });
    const unsettled = await app().request(
      jsonRequest(`/v1/stories/${storyId}/unsettle`, 'POST', {}, steward.cookie),
    );
    expect(unsettled.status).toBe(200);
    expect((await fixture.ingestion.stories.getById(storyId))?.settledAt).toBeNull();
    const refiled = await postOk(storyChallenge(), fourth.cookie);
    await resolveArena(refiled.metadata.debate_arena_id ?? '');
    expect((await fixture.ingestion.stories.getById(storyId))?.settledAt).not.toBeNull();
  });

  it('a verdict FINALIZING during a material edit never certifies the new text', async () => {
    fixture.forum.debateJudge = async () => ({ verdict: UPHELD, outputId: 'out-upheld' });
    const targetId = await seedTarget();
    const challenger = await seedUserWithSession(fixture.identity);
    const filed = await postOk(challengeBody(targetId), challenger.cookie);
    const debateId = filed.metadata.debate_arena_id ?? '';
    nowMs += HOUR_MS + 1000;
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('judged');
    // The finalize lands INSIDE the edit's slow safety pass: at the edit's
    // initial read the target is still `under_debate`, so a pre-read-gated
    // reset would be skipped and the fresh `validated` would certify text the
    // verdict never judged.
    const safety = fixture.forum.safety;
    const realClassify = safety.classify.bind(safety);
    safety.classify = async (...args: Parameters<typeof realClassify>) => {
      safety.classify = realClassify;
      nowMs += 24 * HOUR_MS + 1000;
      await runDebateSchedulerTick(rethrow);
      expect((await fixture.forum.debates.getById(debateId))?.state).toBe('resolved');
      expect((await fixture.forum.contributions.getById(targetId))?.disputeStatus).toBe(
        'validated',
      );
      return realClassify(...args);
    };
    const edit = await app().request(
      jsonRequest(
        `/v1/contributions/${targetId}`,
        'PATCH',
        { contribution_id: targetId, body: 'Edited while the verdict finalized.' },
        author.cookie,
      ),
    );
    expect(edit.status).toBe(200);
    const row = await fixture.forum.contributions.getById(targetId);
    expect(row?.disputeStatus).toBe('none');
    expect(row?.settledAt).toBeNull();
    expect(row?.body).toBe('Edited while the verdict finalized.');
  });

  it('an edit landing between finalize’s anchor read and its write is never certified', async () => {
    fixture.forum.debateJudge = async () => ({ verdict: UPHELD, outputId: 'out-upheld' });
    const targetId = await seedTarget();
    const challenger = await seedUserWithSession(fixture.identity);
    const filed = await postOk(challengeBody(targetId), challenger.cookie);
    const debateId = filed.metadata.debate_arena_id ?? '';
    nowMs += HOUR_MS + 1000;
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('judged');
    // The material edit lands AFTER finalize read the target/anchor but
    // BEFORE its status write: the edit's own conditional reset no-ops (the
    // row still reads `under_debate`), so only the finalize-side CAS on the
    // edit lineage can stop the stale `validated` — the settle-count hook
    // sits exactly between the two.
    const debates = fixture.forum.debates;
    const realCount = debates.countUpheldDefensesForComment.bind(debates);
    let raced = false;
    debates.countUpheldDefensesForComment = async (
      ...args: Parameters<typeof realCount>
    ): Promise<number> => {
      if (!raced) {
        raced = true;
        const edit = await app().request(
          jsonRequest(
            `/v1/contributions/${targetId}`,
            'PATCH',
            { contribution_id: targetId, body: 'Edited inside the finalize window.' },
            author.cookie,
          ),
        );
        expect(edit.status).toBe(200);
        expect((await fixture.forum.contributions.getById(targetId))?.disputeStatus).toBe(
          'under_debate',
        );
      }
      return realCount(...args);
    };
    nowMs += 24 * HOUR_MS + 1000;
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('resolved');
    const row = await fixture.forum.contributions.getById(targetId);
    expect(row?.disputeStatus).toBe('none');
    expect(row?.settledAt).toBeNull();
    expect(row?.body).toBe('Edited inside the finalize window.');
  });

  it('an override landing mid-finalize resolves with ITS effects, never the stale verdict’s', async () => {
    fixture.forum.debateJudge = async () => ({ verdict: UPHELD, outputId: 'out-upheld' });
    const targetId = await seedTarget();
    const challenger = await seedUserWithSession(fixture.identity);
    const filed = await postOk(challengeBody(targetId), challenger.cookie);
    const debateId = filed.metadata.debate_arena_id ?? '';
    nowMs += HOUR_MS + 1000;
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('judged');
    // The steward's overrule lands while finalize is mid-effects for the AI's
    // `upheld` (the certify hook sits inside that window): the resolve CAS on
    // the row's updatedAt token must miss and the loop re-apply for the FINAL
    // `corrected` verdict.
    const steward = await seedUserWithSession(fixture.identity);
    const contributions = fixture.forum.contributions;
    const realCertify = contributions.certifyValidatedIfUnedited.bind(contributions);
    let raced = false;
    contributions.certifyValidatedIfUnedited = async (...args: Parameters<typeof realCertify>) => {
      const result = await realCertify(...args);
      if (!raced) {
        raced = true;
        const overridden = await fixture.forum.debates.recordOverride(debateId, {
          verdict: 'corrected',
          winner: 'challenger',
          overriddenByUserId: steward.userId,
          overrideReason: 'New primary source contradicts the incumbent.',
        });
        expect(overridden?.verdict).toBe('corrected');
      }
      return result;
    };
    nowMs += 24 * HOUR_MS + 1000;
    await runDebateSchedulerTick(rethrow);
    const arena = await fixture.forum.debates.getById(debateId);
    expect(arena?.state).toBe('resolved');
    expect(arena?.verdict).toBe('corrected');
    // The applied effects match the FINAL verdict: the target is incorrect
    // (never left `validated` by the stale upheld pass), and the challenger's
    // winning correction carries no `incorrect` tag.
    const target = await fixture.forum.contributions.getById(targetId);
    expect(target?.disputeStatus).toBe('incorrect');
    expect(target?.settledAt).toBeNull();
    expect((await fixture.forum.contributions.getById(filed.contribution_id))?.disputeStatus).toBe(
      'none',
    );
  });

  it('a verdict on a SUPERSEDED version resolves none — never validated, never settled', async () => {
    fixture.forum.debateJudge = async () => ({ verdict: UPHELD, outputId: 'out-upheld' });
    const targetId = await seedTarget();
    const challenger = await seedUserWithSession(fixture.identity);
    const filed = await postOk(challengeBody(targetId), challenger.cookie);
    const debateId = filed.metadata.debate_arena_id ?? '';
    // Judge the arena (both-sides-idle expedite), then materially edit the
    // target INSIDE the override window — allowed (only locked/awaiting
    // freeze edits), and it advances the version anchor past the snapshot.
    nowMs += HOUR_MS + 1000;
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('judged');
    nowMs += 60_000;
    const edit = await app().request(
      jsonRequest(
        `/v1/contributions/${targetId}`,
        'PATCH',
        { contribution_id: targetId, body: 'Rewritten after the verdict.' },
        author.cookie,
      ),
    );
    expect(edit.status).toBe(200);
    nowMs += 24 * HOUR_MS + 1000;
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('resolved');
    // The verdict certified text that is no longer served: nothing is claimed
    // about the current version, and no settle progress accrues from it.
    const row = await fixture.forum.contributions.getById(targetId);
    expect(row?.disputeStatus).toBe('none');
    expect(row?.settledAt).toBeNull();
    // The challenger's loss stands — their correction was judged against the
    // material as it was locked.
    expect((await fixture.forum.contributions.getById(filed.contribution_id))?.disputeStatus).toBe(
      'incorrect',
    );
    // And the once-per-target right re-opened with the version (the judged
    // snapshot predates the edit anchor).
    expect((await post(challengeBody(targetId), challenger.cookie)).status).toBe(201);
  });

  it('an edit racing a fresh challenge never stomps under_debate', async () => {
    // A validated (unsettled) target: one adjudicated upheld defense.
    fixture.forum.debateJudge = async () => ({ verdict: UPHELD, outputId: 'out-upheld' });
    const targetId = await seedTarget();
    const first = await seedUserWithSession(fixture.identity);
    const filed = await postOk(challengeBody(targetId), first.cookie);
    await resolveArena(filed.metadata.debate_arena_id ?? '');
    expect((await fixture.forum.contributions.getById(targetId))?.disputeStatus).toBe('validated');
    // The author's material edit interleaves with a SECOND challenger's create:
    // the challenge lands (and tags `under_debate`) between the edit's write
    // and the edit path's dispute reset — the reset must not stomp it.
    const second = await seedUserWithSession(fixture.identity);
    const store = fixture.forum.contributions;
    const realApplyEdit = store.applyEdit.bind(store);
    let raced = false;
    store.applyEdit = async (...args: Parameters<typeof realApplyEdit>) => {
      const row = await realApplyEdit(...args);
      if (!raced) {
        raced = true;
        const challenge = await post(challengeBody(targetId), second.cookie);
        expect(challenge.status).toBe(201);
        expect((await store.getById(targetId))?.disputeStatus).toBe('under_debate');
      }
      return row;
    };
    nowMs += 60_000;
    const edit = await app().request(
      jsonRequest(
        `/v1/contributions/${targetId}`,
        'PATCH',
        { contribution_id: targetId, body: 'Edited while a challenge raced in.' },
        author.cookie,
      ),
    );
    expect(edit.status).toBe(200);
    const row = await fixture.forum.contributions.getById(targetId);
    expect(row?.disputeStatus).toBe('under_debate');
    expect(row?.body).toBe('Edited while a challenge raced in.');
    expect(await fixture.forum.debates.getActiveForComment(targetId)).not.toBeNull();
  });

  it('unsettle never re-certifies a materially edited row (settled mark only)', async () => {
    const targetId = await seedTarget();
    await settleTarget(targetId);
    const steward = await seedUserWithSession(fixture.identity);
    await fixture.forum.rooms.addSteward({
      roomId: COMMONS_ROOM_ID,
      userId: steward.userId,
      role: 'community_steward',
      assignedAt: new Date(nowMs).toISOString(),
    });
    // The author materially edits: the version reset clears validated+settled.
    nowMs += 60_000;
    const edit = await app().request(
      jsonRequest(
        `/v1/contributions/${targetId}`,
        'PATCH',
        { contribution_id: targetId, body: 'Edited between settle and unsettle.' },
        author.cookie,
      ),
    );
    expect(edit.status).toBe(200);
    // The unsettle finds nothing settled (409) — and even the worst-case late
    // write is harmless: the unsettle path touches ONLY the settled mark, so
    // the edit's reset can never be overwritten with a stale `validated`.
    const refused = await app().request(
      jsonRequest(`/v1/contributions/${targetId}/unsettle`, 'POST', {}, steward.cookie),
    );
    expect(refused.status).toBe(409);
    await fixture.forum.contributions.clearSettled(targetId);
    const row = await fixture.forum.contributions.getById(targetId);
    expect(row?.disputeStatus).toBe('none');
    expect(row?.settledAt).toBeNull();
  });
});

describe('WS-T challenge policy — the settled threshold', () => {
  it('three adjudicated upheld defenses settle the target; a material edit un-settles', async () => {
    fixture.forum.debateJudge = async () => ({ verdict: UPHELD, outputId: 'out-upheld' });
    const targetId = await seedTarget();
    for (let i = 0; i < 3; i += 1) {
      const challenger = await seedUserWithSession(fixture.identity);
      const filed = await postOk(challengeBody(targetId), challenger.cookie);
      await resolveArena(filed.metadata.debate_arena_id ?? '');
      const stored = await fixture.forum.contributions.getById(targetId);
      expect(stored?.disputeStatus).toBe('validated');
      expect(stored?.settledAt === null).toBe(i < 2);
    }
    // Settled: the next challenge is refused for EVERY account.
    const fourth = await seedUserWithSession(fixture.identity);
    const refused = await post(challengeBody(targetId), fourth.cookie);
    expect(refused.status).toBe(422);
    expect(await errorCode(refused)).toBe('target_settled');
    // A material edit clears the badge AND the settled mark: the defended
    // text is no longer the served text.
    nowMs += 60_000;
    const edit = await app().request(
      jsonRequest(
        `/v1/contributions/${targetId}`,
        'PATCH',
        { contribution_id: targetId, body: 'Materially revised after settling.' },
        author.cookie,
      ),
    );
    expect(edit.status).toBe(200);
    const cleared = await fixture.forum.contributions.getById(targetId);
    expect(cleared?.disputeStatus).toBe('none');
    expect(cleared?.settledAt).toBeNull();
    expect((await post(challengeBody(targetId), fourth.cookie)).status).toBe(201);
  });
});
