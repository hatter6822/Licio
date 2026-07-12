// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate arena service — the full lifecycle: a sourced correction opens a
// live arena, both sides adjust their underlying content + co-visible rebuttal
// statements while it is open, the material locks in by the EARLIER of the
// both-sides-idle expedite or the 23h/24h schedule, the governed adjudicator
// renders a verdict over the LOCKED material + opens the 24h override window,
// the steward fully overrules, and finalize tags the loser `incorrect`
// (visible, not hidden).  Withdrawal (challenger) and concession (incumbent)
// close the arena early while it is open.  Uses in-memory stores + a fake
// judge runner (the neural model is tested in @licio/ai-governance).
import { randomUUID } from 'node:crypto';
import {
  DEBATE_EDIT_WINDOW_MS,
  DEBATE_INACTIVITY_WINDOW_MS,
  DEBATE_LIVE_WINDOW_MS,
  DEBATE_OVERRIDE_WINDOW_MS,
} from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  concedeDebate,
  type DebateDeps,
  type DebateJudgeRunner,
  domainOf,
  finalizeDebate,
  judgeDebateArena,
  lockDebateArena,
  maybeEnterDebate,
  overrideDebateVerdict,
  postDebatePosition,
  readDebateArenaContent,
  runDebateLifecycle,
  toDebateArenaPublic,
  toDebateArenaSummary,
  touchDebateActivityForContribution,
  withdrawDebate,
} from '../forum/debate.js';
import { InMemoryDebateStore } from '../forum/debate-store.js';
import { InMemoryContributionStore } from '../forum/stores.js';

const INCUMBENT = randomUUID();
const CHALLENGER = randomUUID();
const STEWARD = randomUUID();
const ROOM = randomUUID();
const STORY = randomUUID();
const THREAD = randomUUID();

let clock: { ms: number };
let contributions: InMemoryContributionStore;
let debates: InMemoryDebateStore;
let deps: DebateDeps;
let corrected: DebateJudgeRunner;
let storyDisputes: Map<string, string>;
let broadcasts: string[];

const citation = { url: 'https://example.org/source' } as const;

async function seedComment(userId: string, body: string): Promise<string> {
  const id = randomUUID();
  await contributions.insert({
    contributionId: id,
    threadId: THREAD,
    userId,
    type: 'comment',
    body,
    citations: [],
    metadata: {},
    targetClaimId: null,
    parentContributionId: null,
    clientDraftId: `draft-${id}`,
    path: [],
    moderationState: 'published',
  });
  return id;
}

async function seedCorrection(targetContributionId: string): Promise<string> {
  const id = randomUUID();
  await contributions.insert({
    contributionId: id,
    threadId: THREAD,
    userId: CHALLENGER,
    type: 'correction',
    body: 'That figure is wrong; the official record says otherwise.',
    citations: [citation],
    metadata: { target_contribution_id: targetContributionId },
    targetClaimId: null,
    parentContributionId: null,
    clientDraftId: `draft-${id}`,
    path: [],
    moderationState: 'published',
  });
  return id;
}

function correctionInput(contributionId: string, targetContributionId: string) {
  return {
    contributionId,
    threadId: THREAD,
    storyId: STORY,
    roomId: ROOM,
    userId: CHALLENGER,
    body: 'That figure is wrong; the official record says otherwise.',
    citations: [citation],
    metadata: { target_contribution_id: targetContributionId },
  };
}

beforeEach(() => {
  clock = { ms: Date.parse('2026-07-05T00:00:00.000Z') };
  const now = () => clock.ms;
  contributions = new InMemoryContributionStore(now);
  debates = new InMemoryDebateStore(now);
  // A fake judge that always rules for the challenger with high confidence.
  corrected = async () => ({
    verdict: {
      model_version: '1.0.0',
      winner: 'challenger',
      verdict: 'corrected',
      confidence: 0.92,
      probabilities: { incumbent: 0.05, challenger: 0.92, inconclusive: 0.03 },
      rationale: 'The challenger prevailed with more independent sources.',
    },
    outputId: `out:${randomUUID()}`,
  });
  storyDisputes = new Map();
  broadcasts = [];
  deps = {
    debates,
    contributions,
    storyAuthor: async () => INCUMBENT,
    storyContent: async () => ({
      title: 'The challenged story',
      body: 'The story body under debate.',
      citations: [{ url: 'https://story.example/source' }],
      updatedAt: new Date(clock.ms).toISOString(),
    }),
    isSteward: async (roomId, userId) => roomId === ROOM && userId === STEWARD,
    setStoryDispute: async (storyId, status) => {
      storyDisputes.set(storyId, status);
    },
    runJudge: corrected,
    broadcast: (id) => {
      broadcasts.push(id);
    },
    now,
    log: () => {},
  };
});

/** Advance the clock past the arena's queue entry: the scheduled 24h resolve
 *  instant (well past the 1h idle expedite too — direct `judgeDebateArena`
 *  calls don't care, but lifecycle-driven tests do). */
function pastResolveDue(): void {
  clock.ms += DEBATE_LIVE_WINDOW_MS + 1000;
}

describe('WS-T debate arena lifecycle', () => {
  it('opens an arena from a correction, stamping the deadlines + activity clocks and marking the target under_debate', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const correctionId = await seedCorrection(targetId);
    const debateId = randomUUID();
    const arena = await maybeEnterDebate(deps, correctionInput(correctionId, targetId), debateId);
    expect(arena).not.toBeNull();
    expect(arena?.state).toBe('open');
    expect(arena?.incumbentUserId).toBe(INCUMBENT);
    expect(arena?.challengerUserId).toBe(CHALLENGER);
    // The correction ITSELF is the challenger's material (shown live as arena
    // content); both rebuttal statements start empty.
    expect(arena?.positions.challenger.summary).toBe('');
    expect(arena?.positions.incumbent.summary).toBe('');
    expect(arena?.editDeadlineAt).toBe(new Date(clock.ms + DEBATE_EDIT_WINDOW_MS).toISOString());
    expect(arena?.resolveDueAt).toBe(new Date(clock.ms + DEBATE_LIVE_WINDOW_MS).toISOString());
    expect(arena?.lockedAt).toBeNull();
    expect(arena?.lockedContent).toBeNull();
    // Both activity clocks start at open (the no-show fast path measures from here).
    expect(arena?.incumbentLastActiveAt).toBe(new Date(clock.ms).toISOString());
    expect(arena?.challengerLastActiveAt).toBe(new Date(clock.ms).toISOString());
    const target = await contributions.getById(targetId);
    expect(target?.disputeStatus).toBe('under_debate');
    // Second correction on the SAME target does not open a duplicate arena.
    const dup = await maybeEnterDebate(deps, correctionInput(randomUUID(), targetId), randomUUID());
    expect(dup).toBeNull();
  });

  it('lets both parties post rebuttals while open and rejects outsiders + post-deadline edits', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );

    clock.ms += 60_000; // a minute in: the rebuttal resets the activity clock
    const incumbentPost = await postDebatePosition(deps, debateId, INCUMBENT, {
      summary: 'The official transcript confirms 5-4.',
      citations: [{ url: 'https://court.gov/transcript' }],
    });
    expect(incumbentPost.ok).toBe(true);

    // A rebuttal post resets the side's activity clock (the expedite input).
    const posted = await debates.getById(debateId);
    expect(posted?.incumbentLastActiveAt).toBe(new Date(clock.ms).toISOString());

    // A non-party cannot post.
    const outsider = await postDebatePosition(deps, debateId, STEWARD, {
      summary: 'I think...',
      citations: [citation],
    });
    expect(outsider).toEqual({ ok: false, reason: 'not_a_party' });

    // After the 23h edit deadline, edits are rejected.
    clock.ms += DEBATE_EDIT_WINDOW_MS + 1000;
    const late = await postDebatePosition(deps, debateId, CHALLENGER, {
      summary: 'Last-minute edit.',
      citations: [citation],
    });
    expect(late).toEqual({ ok: false, reason: 'window_closed' });
  });

  it('judges after the window, opens a 24h override window, and tags incorrect on finalize', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );

    clock.ms += DEBATE_EDIT_WINDOW_MS + 1000;
    const judged = await judgeDebateArena(deps, debateId);
    expect(judged?.state).toBe('judged');
    expect(judged?.verdict).toBe('corrected');
    expect(judged?.winner).toBe('challenger');
    expect(judged?.decidedBy).toBe('ai');
    expect(judged?.confidence).toBeCloseTo(0.92);
    expect(judged?.aiOutputId).toMatch(/^out:/);
    expect(judged?.overrideDeadlineAt).toBe(
      new Date(clock.ms + DEBATE_OVERRIDE_WINDOW_MS).toISOString(),
    );

    // Finalize after the override window: the challenged comment is tagged incorrect.
    clock.ms += DEBATE_OVERRIDE_WINDOW_MS + 1000;
    const resolved = await finalizeDebate(deps, debateId);
    expect(resolved?.state).toBe('resolved');
    const target = await contributions.getById(targetId);
    expect(target?.disputeStatus).toBe('incorrect');
    // The comment is NOT hidden — it stays published (visible-but-sunk).
    expect(target?.moderationState).toBe('published');
  });

  it('lets the steward fully overrule the AI verdict within 24h (either direction)', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );
    clock.ms += DEBATE_EDIT_WINDOW_MS + 1000;
    await judgeDebateArena(deps, debateId); // AI: challenger wins (corrected)

    // A non-steward cannot override.
    const denied = await overrideDebateVerdict(deps, debateId, CHALLENGER, 'incumbent', 'because');
    expect(denied).toEqual({ ok: false, reason: 'not_steward' });

    // The steward flips it to uphold the incumbent.
    const overruled = await overrideDebateVerdict(
      deps,
      debateId,
      STEWARD,
      'incumbent',
      'The challenger misread the record.',
    );
    expect(overruled.ok).toBe(true);
    if (overruled.ok) {
      expect(overruled.arena.verdict).toBe('upheld');
      expect(overruled.arena.winner).toBe('incumbent');
      expect(overruled.arena.decidedBy).toBe('steward');
    }

    // Finalize now UPHOLDS: the target is tagged `validated` — challenged and
    // proven accurate (never `incorrect`).
    clock.ms += DEBATE_OVERRIDE_WINDOW_MS + 1000;
    await finalizeDebate(deps, debateId);
    const target = await contributions.getById(targetId);
    expect(target?.disputeStatus).toBe('validated');

    // The override window is closed now.
    const tooLate = await overrideDebateVerdict(deps, debateId, STEWARD, 'challenger', 'x');
    expect(tooLate.ok).toBe(false);
  });

  it('resolves fail-closed to inconclusive when the adjudicator is blocked', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );
    // The judge returns null (guard blocked / unavailable).
    deps.runJudge = async () => null;
    clock.ms += DEBATE_EDIT_WINDOW_MS + 1000;
    const judged = await judgeDebateArena(deps, debateId);
    expect(judged?.verdict).toBe('inconclusive');
    expect(judged?.winner).toBe('none');
    clock.ms += DEBATE_OVERRIDE_WINDOW_MS + 1000;
    await finalizeDebate(deps, debateId);
    const target = await contributions.getById(targetId);
    expect(target?.disputeStatus).toBe('none'); // nothing tagged
  });

  it('EXPEDITES a both-sides-idle arena: locked + judged one inactivity window after the last edit', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );

    // Before the inactivity window elapses: the tick does nothing.
    clock.ms += DEBATE_INACTIVITY_WINDOW_MS - 60_000;
    expect(await runDebateLifecycle(deps)).toEqual({
      locked: 0,
      expedited: 0,
      judged: 0,
      finalized: 0,
    });

    // One inactivity window after open (nobody edited — the no-show path):
    // the SAME tick locks the material, pulls the queue entry forward, and
    // judges — the debate resolves ~1h after the challenge, not 24h later.
    clock.ms += 61_000;
    expect(await runDebateLifecycle(deps)).toEqual({
      locked: 0,
      expedited: 1,
      judged: 1,
      finalized: 0,
    });
    const judged = await debates.getById(debateId);
    expect(judged?.state).toBe('judged');
    expect(judged?.lockedAt).toBe(new Date(clock.ms).toISOString());
    expect(judged?.resolveDueAt).toBe(new Date(clock.ms).toISOString()); // pulled forward
    expect(judged?.lockedContent?.target.body).toBe('The vote passed 5-4.');
    expect(judged?.lockedContent?.correction.body).toContain('wrong');

    // After a further 24h: the tick finalizes and the target is tagged incorrect.
    clock.ms += DEBATE_OVERRIDE_WINDOW_MS + 1000;
    expect(await runDebateLifecycle(deps)).toEqual({
      locked: 0,
      expedited: 0,
      judged: 0,
      finalized: 1,
    });
    expect((await debates.getById(debateId))?.state).toBe('resolved');
    expect((await contributions.getById(targetId))?.disputeStatus).toBe('incorrect');
  });

  it('an edit postpones the expedite; a continuously active arena locks on the 23h schedule and queues at 24h', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );

    // Keep the arena alive: some side edits at least once per inactivity
    // window until just past the 23h edit deadline.
    const step = DEBATE_INACTIVITY_WINDOW_MS - 60_000;
    let elapsed = 0;
    while (elapsed + step < DEBATE_EDIT_WINDOW_MS) {
      clock.ms += step;
      elapsed += step;
      const post = await postDebatePosition(deps, debateId, INCUMBENT, {
        summary: `Still standing by it (${elapsed}ms in).`,
        citations: [citation],
      });
      expect(post.ok).toBe(true);
      expect(await runDebateLifecycle(deps)).toEqual({
        locked: 0,
        expedited: 0,
        judged: 0,
        finalized: 0,
      });
    }

    // Past the 23h edit deadline: the tick LOCKS the material (the frozen
    // final countdown) but does not judge yet — the queue opens at hour 24.
    clock.ms += DEBATE_EDIT_WINDOW_MS - elapsed + 1000;
    expect(await runDebateLifecycle(deps)).toEqual({
      locked: 1,
      expedited: 0,
      judged: 0,
      finalized: 0,
    });
    const locked = await debates.getById(debateId);
    expect(locked?.state).toBe('locked');
    expect(locked?.lockedContent?.correction.body).toContain('wrong');
    // Locked-in: no further rebuttal edits.
    const late = await postDebatePosition(deps, debateId, INCUMBENT, {
      summary: 'Too late.',
      citations: [citation],
    });
    expect(late).toEqual({ ok: false, reason: 'window_closed' });

    // At hour 24 the debate enters the AI resolution queue and is judged.
    clock.ms += 60 * 60 * 1000;
    expect(await runDebateLifecycle(deps)).toEqual({
      locked: 0,
      expedited: 0,
      judged: 1,
      finalized: 0,
    });
    expect((await debates.getById(debateId))?.state).toBe('judged');
  });

  it('sinks an incorrect root to the bottom of the section, both orderings + paged', async () => {
    // Three roots at distinct times a < b < c.
    const a = await seedComment(INCUMBENT, 'first');
    clock.ms += 1000;
    const b = await seedComment(INCUMBENT, 'second');
    clock.ms += 1000;
    const c = await seedComment(INCUMBENT, 'third');
    await contributions.setDisputeStatus(b, 'incorrect');

    const ids = (rows: { contributionId: string }[]) => rows.map((r) => r.contributionId);
    const newest = await contributions.listRoots(THREAD, {
      states: ['published'],
      limit: 10,
      order: 'newest',
    });
    // non-incorrect newest-first (c, a), then the incorrect one (b) LAST.
    expect(ids(newest)).toEqual([c, a, b]);
    const oldest = await contributions.listRoots(THREAD, {
      states: ['published'],
      limit: 10,
      order: 'oldest',
    });
    expect(ids(oldest)).toEqual([a, c, b]);

    // Keyset pagination respects the sink: page 1 (limit 2) then page-2 by cursor.
    const page1 = await contributions.listRoots(THREAD, {
      states: ['published'],
      limit: 2,
      order: 'newest',
    });
    expect(ids(page1)).toEqual([c, a]);
    const cursorRow = page1[page1.length - 1];
    const page2 = await contributions.listRoots(THREAD, {
      states: ['published'],
      limit: 2,
      order: 'newest',
      after: {
        createdAt: cursorRow?.createdAt ?? '',
        id: cursorRow?.contributionId ?? '',
        disputeSink: cursorRow?.disputeStatus === 'incorrect' ? 1 : 0,
      },
    });
    expect(ids(page2)).toEqual([b]); // the incorrect root, after the clean ones
  });

  it('opens a story-target debate, marks the story under_debate, and tags it on corrected', async () => {
    const correctionId = randomUUID();
    await contributions.insert({
      contributionId: correctionId,
      threadId: THREAD,
      userId: CHALLENGER,
      type: 'correction',
      body: 'The headline is wrong.',
      citations: [citation],
      metadata: { target_story_id: STORY },
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: `draft-${correctionId}`,
      path: [],
      moderationState: 'published',
    });
    const debateId = randomUUID();
    const arena = await maybeEnterDebate(
      deps,
      {
        contributionId: correctionId,
        threadId: THREAD,
        storyId: STORY,
        roomId: ROOM,
        userId: CHALLENGER,
        body: 'The headline is wrong.',
        citations: [citation],
        metadata: { target_story_id: STORY },
      },
      debateId,
    );
    expect(arena?.targetType).toBe('story');
    expect(storyDisputes.get(STORY)).toBe('under_debate');

    clock.ms += DEBATE_EDIT_WINDOW_MS + 1000;
    await judgeDebateArena(deps, debateId); // fake judge → corrected
    clock.ms += DEBATE_OVERRIDE_WINDOW_MS + 1000;
    await finalizeDebate(deps, debateId);
    expect(storyDisputes.get(STORY)).toBe('incorrect');
  });

  it('tags an UPHELD target `validated` (challenged and proven accurate)', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );
    // The judge rules for the INCUMBENT — the challenge does not hold.
    deps.runJudge = async () => ({
      verdict: {
        model_version: '1.0.0',
        winner: 'incumbent',
        verdict: 'upheld',
        confidence: 0.9,
        probabilities: { incumbent: 0.9, challenger: 0.07, inconclusive: 0.03 },
        rationale: 'The incumbent account held up against the sources.',
      },
      outputId: `out:${randomUUID()}`,
    });
    clock.ms += DEBATE_EDIT_WINDOW_MS + 1000;
    const judged = await judgeDebateArena(deps, debateId);
    expect(judged?.verdict).toBe('upheld');
    clock.ms += DEBATE_OVERRIDE_WINDOW_MS + 1000;
    await finalizeDebate(deps, debateId);
    // Not `incorrect`, not cleared to `none` — proven accurate.
    expect((await contributions.getById(targetId))?.disputeStatus).toBe('validated');
  });

  it('does NOT tag a SELF-targeted upheld arena `validated` (no boost farming)', async () => {
    const targetId = await seedComment(INCUMBENT, 'My own claim.');
    const debateId = randomUUID();
    // The challenger IS the target's own author (self-challenge): the arena opens,
    // but an upheld outcome must clear to `none`, never `validated`, so a user
    // cannot stage a weak self-debate to farm the validation boost.
    await maybeEnterDebate(
      deps,
      { ...correctionInput(randomUUID(), targetId), userId: INCUMBENT },
      debateId,
    );
    deps.runJudge = async () => ({
      verdict: {
        model_version: '1.0.0',
        winner: 'incumbent',
        verdict: 'upheld',
        confidence: 0.9,
        probabilities: { incumbent: 0.9, challenger: 0.07, inconclusive: 0.03 },
        rationale: 'The account held up.',
      },
      outputId: `out:${randomUUID()}`,
    });
    clock.ms += DEBATE_EDIT_WINDOW_MS + 1000;
    expect((await judgeDebateArena(deps, debateId))?.verdict).toBe('upheld');
    clock.ms += DEBATE_OVERRIDE_WINDOW_MS + 1000;
    await finalizeDebate(deps, debateId);
    // Suppressed to `none` — a self-challenge earns no validation boost.
    expect((await contributions.getById(targetId))?.disputeStatus).toBe('none');
  });

  it('broadcasts a live frame on each position edit / verdict / resolution', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );
    broadcasts = [];
    // A position edit broadcasts (co-visibility).
    await postDebatePosition(deps, debateId, INCUMBENT, {
      summary: 'The transcript confirms it.',
      citations: [citation],
    });
    expect(broadcasts).toContain(debateId);
    // The verdict + the resolution broadcast too.
    broadcasts = [];
    clock.ms += DEBATE_EDIT_WINDOW_MS + 1000;
    await judgeDebateArena(deps, debateId);
    clock.ms += DEBATE_OVERRIDE_WINDOW_MS + 1000;
    await finalizeDebate(deps, debateId);
    expect(broadcasts.filter((id) => id === debateId).length).toBeGreaterThanOrEqual(2);
  });

  it('maps an under_debate comment to its active arena (active_debate_id source)', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );
    const map = await debates.activeDebateIdsForContributions([targetId, randomUUID()]);
    expect(map.get(targetId)).toBe(debateId);
  });

  it('projects a role-scoped public arena', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    const arena = await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );
    if (arena === null) throw new Error('arena not opened');
    const resolveAuthor = async (userId: string | null) =>
      userId === null ? null : { handle: `u-${userId.slice(0, 4)}`, displayName: 'User' };
    const content = await readDebateArenaContent(contributions, deps.storyContent, arena);
    const asChallenger = await toDebateArenaPublic(
      arena,
      CHALLENGER,
      resolveAuthor,
      false,
      content,
    );
    expect(asChallenger.viewer_role).toBe('challenger');
    expect(asChallenger.challenger.is_author).toBe(true);
    expect(asChallenger.incumbent.is_author).toBe(false);
    // The arena carries the REAL material under debate — LIVE while open.
    expect(asChallenger.target_content?.kind).toBe('comment');
    expect(asChallenger.target_content?.body).toBe('The vote passed 5-4.');
    expect(asChallenger.target_content?.locked).toBe(false);
    expect(asChallenger.correction_content?.kind).toBe('correction');
    expect(asChallenger.correction_content?.body).toContain('wrong');
    const asSteward = await toDebateArenaPublic(arena, STEWARD, resolveAuthor, true, content);
    expect(asSteward.viewer_role).toBe('steward');
    const asObserver = await toDebateArenaPublic(
      arena,
      randomUUID(),
      resolveAuthor,
      false,
      content,
    );
    expect(asObserver.viewer_role).toBe('observer');
  });

  it('drops a position write that races the judge tick (state-guarded update)', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );
    // The scheduler judges the arena (state → judged) BEFORE the racing write.
    clock.ms += DEBATE_EDIT_WINDOW_MS + 1000;
    await judgeDebateArena(deps, debateId);
    // A direct store write can no longer mutate the now-judged arena's positions.
    const stale = await debates.updatePosition(debateId, 'incumbent', {
      summary: 'A stale edit that raced the verdict.',
      citations: [citation],
      updatedAt: new Date(clock.ms).toISOString(),
    });
    expect(stale).toBeNull();
    const arena = await debates.getById(debateId);
    expect(arena?.positions.incumbent.summary).toBe(''); // never overwritten
  });
});

describe('WS-T story-level active-debate discovery (listActiveForStory + summary)', () => {
  const resolveAuthor = async (userId: string | null) =>
    userId === null
      ? null
      : { handle: `u-${userId.slice(0, 4)}`, displayName: `User ${userId.slice(0, 4)}` };

  it('lists a story’s active arenas and projects a compact, display-only summary', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );

    const active = await debates.listActiveForStory(STORY, 50);
    expect(active.map((a) => a.debateId)).toContain(debateId);

    const arena = active[0];
    if (!arena) throw new Error('no active arena');
    const target = await contributions.getById(targetId);
    const summary = await toDebateArenaSummary(arena, resolveAuthor, target?.body ?? null);
    expect(summary.debate_id).toBe(debateId);
    expect(summary.target_type).toBe('comment');
    expect(summary.target_contribution_id).toBe(targetId);
    expect(summary.state).toBe('open');
    expect(summary.incumbent_display_name).toBe(`User ${INCUMBENT.slice(0, 4)}`);
    expect(summary.challenger_display_name).toBe(`User ${CHALLENGER.slice(0, 4)}`);
    expect(summary.target_excerpt).toBe('The vote passed 5-4.');
    // Display-only: no vote/tally/score field anywhere on the summary.
    expect(summary).not.toHaveProperty('votes');
  });

  it('excludes a resolved arena from the discovery list', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );
    // Judge + finalize → resolved.
    clock.ms += DEBATE_EDIT_WINDOW_MS + 1000;
    await judgeDebateArena(deps, debateId);
    clock.ms += DEBATE_OVERRIDE_WINDOW_MS + 1000;
    await finalizeDebate(deps, debateId);
    expect((await debates.listActiveForStory(STORY, 50)).map((a) => a.debateId)).not.toContain(
      debateId,
    );
  });
});

describe('WS-T domainOf — registrable-domain extraction (anti-gaming)', () => {
  it('collapses sibling subdomains to ONE registrable domain', () => {
    expect(domainOf('https://a.example.com/path')).toBe('example.com');
    expect(domainOf('https://b.example.com')).toBe('example.com');
    expect(domainOf('https://example.com')).toBe('example.com');
    expect(domainOf('https://www.example.com')).toBe('example.com');
    expect(domainOf('https://deep.nested.example.com')).toBe('example.com');
  });

  it('honours common two-label public suffixes (eTLD+1)', () => {
    expect(domainOf('https://sub.example.co.uk')).toBe('example.co.uk');
    expect(domainOf('https://example.co.uk')).toBe('example.co.uk');
    expect(domainOf('https://news.bbc.co.uk/x')).toBe('bbc.co.uk');
    expect(domainOf('https://a.b.example.com.au')).toBe('example.com.au');
  });

  it('returns null for a non-http(s) or opaque URL', () => {
    expect(domainOf('doi:10.1000/xyz')).toBeNull();
    expect(domainOf('mailto:x@y.com')).toBeNull();
    expect(domainOf('not a url')).toBeNull();
  });
});

describe('WS-T sourced roots — filter + count include sourced comments', () => {
  async function seedTyped(
    type: 'comment' | 'correction',
    citations: { url: string }[],
  ): Promise<string> {
    const id = randomUUID();
    await contributions.insert({
      contributionId: id,
      threadId: THREAD,
      userId: INCUMBENT,
      type,
      body: `${type} body`,
      citations,
      metadata: type === 'correction' ? { target_story_id: STORY } : {},
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: `draft-${id}`,
      path: [],
      moderationState: 'published',
    });
    return id;
  }

  it('the "Sources" view is exactly the comments carrying ≥1 citation', async () => {
    await seedTyped('comment', []); // plain comment — NOT sourced
    const sourcedComment = await seedTyped('comment', [citation]); // sourced comment
    const alsoSourced = await seedTyped('comment', [citation]); // second sourced comment
    await seedTyped('correction', [citation]); // correction — its own tab, NOT here

    const sourced = await contributions.listRoots(THREAD, {
      sourced: true,
      states: ['published'],
      limit: 10,
      order: 'oldest',
    });
    expect(new Set(sourced.map((r) => r.contributionId))).toEqual(
      new Set([sourcedComment, alsoSourced]),
    );
    expect(await contributions.countSourced(THREAD, ['published'])).toBe(2);
  });
});

describe('window-policy override (the dev-simulator / test seam)', () => {
  const SHORT = {
    editWindowMs: 1_000,
    lockWindowMs: 500,
    inactivityWindowMs: 10_000,
    overrideWindowMs: 2_000,
  };

  it('stamps the injected windows; absent ⇒ the §15.4 spec constants', async () => {
    // Injected windows drive every deadline.
    const target = await seedComment(INCUMBENT, 'The figure is 42.');
    const correction = await seedCorrection(target);
    const shortened: DebateDeps = { ...deps, windows: { windows: SHORT } };
    const arena = await maybeEnterDebate(
      shortened,
      correctionInput(correction, target),
      randomUUID(),
    );
    expect(arena).not.toBeNull();
    expect(Date.parse(arena?.editDeadlineAt ?? '')).toBe(clock.ms + 1_000);
    expect(Date.parse(arena?.resolveDueAt ?? '')).toBe(clock.ms + 1_500);
    clock.ms += 1_500;
    const judged = await judgeDebateArena(shortened, arena?.debateId ?? '');
    expect(Date.parse(judged?.overrideDeadlineAt ?? '')).toBe(clock.ms + 2_000);
    // And the full lifecycle resolves on the shortened cadence.
    clock.ms += 2_000;
    const { finalized } = await runDebateLifecycle(shortened);
    expect(finalized).toBe(1);

    // Without the override, a fresh arena carries the SPEC deadlines.
    const target2 = await seedComment(INCUMBENT, 'A second figure is 7.');
    const correction2 = await seedCorrection(target2);
    const arena2 = await maybeEnterDebate(
      deps,
      correctionInput(correction2, target2),
      randomUUID(),
    );
    expect(Date.parse(arena2?.editDeadlineAt ?? '')).toBe(clock.ms + DEBATE_EDIT_WINDOW_MS);
    expect(Date.parse(arena2?.resolveDueAt ?? '')).toBe(clock.ms + DEBATE_LIVE_WINDOW_MS);
    clock.ms += DEBATE_LIVE_WINDOW_MS;
    const judged2 = await judgeDebateArena(deps, arena2?.debateId ?? '');
    expect(Date.parse(judged2?.overrideDeadlineAt ?? '')).toBe(
      clock.ms + DEBATE_OVERRIDE_WINDOW_MS,
    );
  });

  it('SCOPES the override via appliesToUser: only a both-parties-match arena shortens', async () => {
    // The simulator scopes its shortened windows to both-synthetic arenas; a
    // debate a real user is party to keeps the spec windows.
    const simUsers = new Set<string>([CHALLENGER]);
    const scoped: DebateDeps = {
      ...deps,
      windows: { windows: SHORT, appliesToUser: (uid) => uid !== null && simUsers.has(uid) },
    };
    // The incumbent is NOT in the sim roster ⇒ spec windows.
    const target = await seedComment(INCUMBENT, 'Real-user content.');
    const arena = await maybeEnterDebate(
      scoped,
      correctionInput(await seedCorrection(target), target),
      randomUUID(),
    );
    expect(Date.parse(arena?.editDeadlineAt ?? '')).toBe(clock.ms + DEBATE_EDIT_WINDOW_MS);

    // Both parties in the roster ⇒ the shortened windows apply.
    simUsers.add(INCUMBENT);
    const target2 = await seedComment(INCUMBENT, 'Synthetic content.');
    const arena2 = await maybeEnterDebate(
      scoped,
      correctionInput(await seedCorrection(target2), target2),
      randomUUID(),
    );
    expect(Date.parse(arena2?.editDeadlineAt ?? '')).toBe(clock.ms + 1_000);
  });
});

describe('lifecycle fan-out — per-arena failure isolation', () => {
  it('one failing adjudication is logged and the rest of the batch still judges', async () => {
    // Three due arenas on distinct targets.
    const arenas: string[] = [];
    for (const body of ['One is 1.', 'Two is 2.', 'Three is 3.']) {
      const target = await seedComment(INCUMBENT, body);
      const correction = await seedCorrection(target);
      const arena = await maybeEnterDebate(deps, correctionInput(correction, target), randomUUID());
      if (arena) arenas.push(arena.debateId);
    }
    expect(arenas).toHaveLength(3);
    const poisoned = arenas[1];
    const logged: string[] = [];
    const flaky: DebateDeps = {
      ...deps,
      runJudge: async (ctx, input) => {
        if (ctx.debateId === poisoned) throw new Error('adjudicator store fault');
        return corrected(ctx, input);
      },
      log: (event) => {
        logged.push(event);
      },
    };
    pastResolveDue();
    const { judged } = await runDebateLifecycle(flaky);
    expect(judged).toBe(2); // the poisoned arena is isolated, not batch-fatal
    expect(logged).toContain('forum.debate_judge_failed');
    // The poisoned arena is untouched and judges on a later pass.
    const { judged: retried } = await runDebateLifecycle(deps);
    expect(retried).toBe(1);
  });
});

describe('lease-bounded judging (judgeDeadlineMs)', () => {
  it('skips the remaining due arenas once the deadline passes; they stay open for the next tick', async () => {
    for (const body of ['A is 1.', 'B is 2.'] as const) {
      const target = await seedComment(INCUMBENT, body);
      const correction = await seedCorrection(target);
      await maybeEnterDebate(deps, correctionInput(correction, target), randomUUID());
    }
    pastResolveDue();
    // Deadline already elapsed ⇒ nothing judged, nothing lost.
    const bounded = await runDebateLifecycle(deps, 100, 4, clock.ms - 1);
    expect(bounded.judged).toBe(0);
    // The next (unbounded) pass judges both.
    const next = await runDebateLifecycle(deps);
    expect(next.judged).toBe(2);
  });
});

describe('claim-before-judge (the last-second-position TOCTOU)', () => {
  it('a position submitted DURING a slow adjudication is rejected, never silently ignored', async () => {
    const target = await seedComment(INCUMBENT, 'The figure is 42.');
    const correction = await seedCorrection(target);
    const arena = await maybeEnterDebate(deps, correctionInput(correction, target), randomUUID());
    const id = arena?.debateId ?? '';
    clock.ms += DEBATE_EDIT_WINDOW_MS + 1;

    let judgedSummary = '';
    let judgedContext: { debateId: string; roomId: string | null } | null = null;
    let midJudgeAttempt: Awaited<ReturnType<typeof postDebatePosition>> | null = null;
    const racingDeps: DebateDeps = {
      ...deps,
      runJudge: async (ctx, input) => {
        judgedSummary = input.incumbent.summary;
        judgedContext = ctx;
        // The incumbent tries to post WHILE the (slow) judge is computing —
        // the claim already froze the arena, so the write is refused loudly.
        midJudgeAttempt = await postDebatePosition(deps, ctx.debateId, INCUMBENT, {
          summary: 'a mid-adjudication rebuttal',
          citations: [citation],
        });
        return corrected(ctx, input);
      },
    };
    const judged = await judgeDebateArena(racingDeps, id);
    expect(judged?.state).toBe('judged');
    expect(midJudgeAttempt).toEqual({ ok: false, reason: 'window_closed' });
    // The verdict was computed on the claimed snapshot — which the racer never
    // mutated (empty incumbent rebuttal, exactly what the judge saw).
    expect(judgedSummary).toBe('');
    // The judge runner receives the ROOM context (WS-U debate.judge routing).
    expect(judgedContext).toEqual({ debateId: id, roomId: ROOM });
    expect((await debates.getById(id))?.positions.incumbent.summary).toBe('');
  });

  it('a claim whose judge crashed is re-listed and judged on a later pass (never stranded)', async () => {
    const target = await seedComment(INCUMBENT, 'The figure is 7.');
    const correction = await seedCorrection(target);
    const arena = await maybeEnterDebate(deps, correctionInput(correction, target), randomUUID());
    const id = arena?.debateId ?? '';
    pastResolveDue();
    const crashing: DebateDeps = {
      ...deps,
      runJudge: async () => {
        throw new Error('adjudicator crashed mid-flight');
      },
    };
    await expect(judgeDebateArena(crashing, id)).rejects.toThrow('mid-flight');
    expect((await debates.getById(id))?.state).toBe('awaiting_verdict');
    // The stranded claim is still listed as due and judges on the next pass.
    const { judged } = await runDebateLifecycle(deps);
    expect(judged).toBe(1);
    expect((await debates.getById(id))?.state).toBe('judged');
  });
});

describe('WS-T lock — the material under debate is snapshotted and judged', () => {
  it('locks the CURRENT content (post-edit) and the judge scores the locked material', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const correctionId = await seedCorrection(targetId);
    const debateId = randomUUID();
    await maybeEnterDebate(deps, correctionInput(correctionId, targetId), debateId);

    // The incumbent fixes their comment while the arena is open — the arena
    // shows (and later locks) the LIVE content.
    await contributions.applyEdit(
      targetId,
      { body: 'Corrected during the debate: the vote passed 6-3.' },
      INCUMBENT,
      randomUUID(),
    );

    let judgedIncumbentContent = '';
    const capturing: DebateDeps = {
      ...deps,
      runJudge: async (ctx, input) => {
        judgedIncumbentContent = input.incumbent.content;
        return corrected(ctx, input);
      },
    };
    const locked = await lockDebateArena(capturing, debateId, 'scheduled');
    expect(locked?.state).toBe('locked');
    expect(locked?.lockedContent?.target.body).toContain('6-3');
    // A post-lock underlying edit can no longer change what the judge sees.
    await judgeDebateArena(capturing, debateId);
    expect(judgedIncumbentContent).toContain('6-3');
  });

  it('judging an OPEN arena past its due instant locks first (lock-sweep catch-up)', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );
    pastResolveDue();
    const judged = await judgeDebateArena(deps, debateId);
    expect(judged?.state).toBe('judged');
    expect(judged?.lockedAt).not.toBeNull();
    expect(judged?.lockedContent?.target.body).toBe('The vote passed 5-4.');
  });

  it('an underlying-content edit resets the editor side activity clock (touch + broadcast)', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const correctionId = await seedCorrection(targetId);
    const debateId = randomUUID();
    await maybeEnterDebate(deps, correctionInput(correctionId, targetId), debateId);
    clock.ms += 30 * 60 * 1000; // 30 minutes in
    broadcasts = [];
    // The target-comment author edited (the contribution hook calls this).
    await touchDebateActivityForContribution(deps, targetId);
    let arena = await debates.getById(debateId);
    expect(arena?.incumbentLastActiveAt).toBe(new Date(clock.ms).toISOString());
    expect(broadcasts).toContain(debateId);
    // The correction author edited: the CHALLENGER clock resets.
    clock.ms += 60_000;
    await touchDebateActivityForContribution(deps, correctionId);
    arena = await debates.getById(debateId);
    expect(arena?.challengerLastActiveAt).toBe(new Date(clock.ms).toISOString());
    // A contribution with no live arena is a no-op.
    await touchDebateActivityForContribution(deps, randomUUID());
  });

  it('projects the locked snapshot (not the live row) once locked', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );
    await lockDebateArena(deps, debateId, 'scheduled');
    const arena = await debates.getById(debateId);
    if (arena === null) throw new Error('arena missing');
    const content = await readDebateArenaContent(contributions, deps.storyContent, arena);
    expect(content.target?.locked).toBe(true);
    expect(content.target?.body).toBe('The vote passed 5-4.');
    expect(content.correction?.locked).toBe(true);
  });
});

describe('WS-T withdraw / concede — party-driven early closes', () => {
  it('the challenger withdraws while open: state withdrawn, tag cleared, target re-challengeable', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );

    // Only the challenger may withdraw.
    const denied = await withdrawDebate(deps, debateId, INCUMBENT);
    expect(denied).toEqual({ ok: false, reason: 'not_challenger' });

    const withdrawn = await withdrawDebate(deps, debateId, CHALLENGER);
    expect(withdrawn.ok).toBe(true);
    if (withdrawn.ok) {
      expect(withdrawn.arena.state).toBe('withdrawn');
      expect(withdrawn.arena.verdict).toBeNull();
      expect(withdrawn.arena.resolvedAt).toBe(new Date(clock.ms).toISOString());
    }
    // The target's Challenged tag clears — and the slot frees for a NEW arena.
    expect((await contributions.getById(targetId))?.disputeStatus).toBe('none');
    const fresh = await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      randomUUID(),
    );
    expect(fresh).not.toBeNull();
  });

  it('the incumbent concedes while open: resolved corrected-by-concession, target tagged incorrect', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );

    const denied = await concedeDebate(deps, debateId, CHALLENGER);
    expect(denied).toEqual({ ok: false, reason: 'not_incumbent' });

    const conceded = await concedeDebate(deps, debateId, INCUMBENT);
    expect(conceded.ok).toBe(true);
    if (conceded.ok) {
      expect(conceded.arena.state).toBe('resolved');
      expect(conceded.arena.verdict).toBe('corrected');
      expect(conceded.arena.winner).toBe('challenger');
      expect(conceded.arena.decidedBy).toBe('concession');
    }
    expect((await contributions.getById(targetId))?.disputeStatus).toBe('incorrect');
    // No verdict to judge/finalize later — the lifecycle no-ops.
    pastResolveDue();
    const pass = await runDebateLifecycle(deps);
    expect(pass.judged).toBe(0);
  });

  it('a story-target concession tags the STORY incorrect', async () => {
    const correctionId = randomUUID();
    await contributions.insert({
      contributionId: correctionId,
      threadId: THREAD,
      userId: CHALLENGER,
      type: 'correction',
      body: 'The headline is wrong.',
      citations: [citation],
      metadata: { target_story_id: STORY },
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: `draft-${correctionId}`,
      path: [],
      moderationState: 'published',
    });
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      {
        contributionId: correctionId,
        threadId: THREAD,
        storyId: STORY,
        roomId: ROOM,
        userId: CHALLENGER,
        body: 'The headline is wrong.',
        citations: [citation],
        metadata: { target_story_id: STORY },
      },
      debateId,
    );
    const conceded = await concedeDebate(deps, debateId, INCUMBENT);
    expect(conceded.ok).toBe(true);
    expect(storyDisputes.get(STORY)).toBe('incorrect');
  });

  it('withdraw and concede are refused once the material is locked in', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );
    await lockDebateArena(deps, debateId, 'expedited');
    expect(await withdrawDebate(deps, debateId, CHALLENGER)).toEqual({
      ok: false,
      reason: 'window_closed',
    });
    expect(await concedeDebate(deps, debateId, INCUMBENT)).toEqual({
      ok: false,
      reason: 'window_closed',
    });
  });
});
