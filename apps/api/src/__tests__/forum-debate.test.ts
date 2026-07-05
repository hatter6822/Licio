// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate arena service — the full lifecycle: a sourced correction opens an
// arena, both sides post co-visible positions within the 12h window, the
// governed adjudicator renders a verdict + opens the 24h override window, the
// steward fully overrules, and finalize tags the loser `incorrect` (visible, not
// hidden).  Uses in-memory stores + a fake judge runner (the neural model is
// tested in @licio/ai-governance).
import { randomUUID } from 'node:crypto';
import { DEBATE_EDIT_WINDOW_MS, DEBATE_OVERRIDE_WINDOW_MS } from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type DebateDeps,
  type DebateJudgeRunner,
  finalizeDebate,
  judgeDebateArena,
  maybeEnterDebate,
  overrideDebateVerdict,
  postDebatePosition,
  runDebateLifecycle,
  toDebateArenaPublic,
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

describe('WS-T debate arena lifecycle', () => {
  it('opens an arena from a correction, seeding the challenger + marking the target under_debate', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const correctionId = await seedCorrection(targetId);
    const debateId = randomUUID();
    const arena = await maybeEnterDebate(deps, correctionInput(correctionId, targetId), debateId);
    expect(arena).not.toBeNull();
    expect(arena?.state).toBe('open');
    expect(arena?.incumbentUserId).toBe(INCUMBENT);
    expect(arena?.challengerUserId).toBe(CHALLENGER);
    expect(arena?.positions.challenger.summary).toContain('wrong');
    expect(arena?.positions.challenger.citations).toHaveLength(1);
    expect(arena?.positions.incumbent.summary).toBe('');
    expect(arena?.editDeadlineAt).toBe(new Date(clock.ms + DEBATE_EDIT_WINDOW_MS).toISOString());
    const target = await contributions.getById(targetId);
    expect(target?.disputeStatus).toBe('under_debate');
    // Second correction on the SAME target does not open a duplicate arena.
    const dup = await maybeEnterDebate(deps, correctionInput(randomUUID(), targetId), randomUUID());
    expect(dup).toBeNull();
  });

  it('lets both parties post within the 12h window and rejects outsiders + late edits', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );

    const incumbentPost = await postDebatePosition(deps, debateId, INCUMBENT, {
      summary: 'The official transcript confirms 5-4.',
      citations: [{ url: 'https://court.gov/transcript' }],
    });
    expect(incumbentPost.ok).toBe(true);

    // A non-party cannot post.
    const outsider = await postDebatePosition(deps, debateId, STEWARD, {
      summary: 'I think...',
      citations: [citation],
    });
    expect(outsider).toEqual({ ok: false, reason: 'not_a_party' });

    // After the 12h window, edits are rejected.
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

    // Finalize now UPHOLDS: the target is not tagged incorrect.
    clock.ms += DEBATE_OVERRIDE_WINDOW_MS + 1000;
    await finalizeDebate(deps, debateId);
    const target = await contributions.getById(targetId);
    expect(target?.disputeStatus).toBe('none');

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

  it('drives judge + finalize from the scheduler tick at each deadline', async () => {
    const targetId = await seedComment(INCUMBENT, 'The vote passed 5-4.');
    const debateId = randomUUID();
    await maybeEnterDebate(
      deps,
      correctionInput(await seedCorrection(targetId), targetId),
      debateId,
    );

    // Before the edit deadline: the tick does nothing.
    expect(await runDebateLifecycle(deps)).toEqual({ judged: 0, finalized: 0 });

    // After 12h: the tick judges (but does not yet finalize).
    clock.ms += DEBATE_EDIT_WINDOW_MS + 1000;
    expect(await runDebateLifecycle(deps)).toEqual({ judged: 1, finalized: 0 });
    expect((await debates.getById(debateId))?.state).toBe('judged');

    // After a further 24h: the tick finalizes and the target is tagged incorrect.
    clock.ms += DEBATE_OVERRIDE_WINDOW_MS + 1000;
    expect(await runDebateLifecycle(deps)).toEqual({ judged: 0, finalized: 1 });
    expect((await debates.getById(debateId))?.state).toBe('resolved');
    expect((await contributions.getById(targetId))?.disputeStatus).toBe('incorrect');
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
    const asChallenger = await toDebateArenaPublic(arena, CHALLENGER, resolveAuthor, false);
    expect(asChallenger.viewer_role).toBe('challenger');
    expect(asChallenger.challenger.is_author).toBe(true);
    expect(asChallenger.incumbent.is_author).toBe(false);
    const asSteward = await toDebateArenaPublic(arena, STEWARD, resolveAuthor, true);
    expect(asSteward.viewer_role).toBe('steward');
    const asObserver = await toDebateArenaPublic(arena, randomUUID(), resolveAuthor, false);
    expect(asObserver.viewer_role).toBe('observer');
  });
});
