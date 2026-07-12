// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T — the `DebateStore` contract, run against BOTH adapters: the in-memory
// adapter (always) verifies the semantics locally, and the gated Drizzle adapter
// (DATABASE_URL) runs the SAME assertions against live Postgres + the real
// migration chain (0056/0078/0079).  Unlike the CID-opaque LCAP store,
// `debate_arenas` has FK edges, so the Drizzle leg seeds a fresh
// story→thread→contribution graph per arena (via `freshCtx`); the in-memory leg
// uses arbitrary ids.
import { randomUUID } from 'node:crypto';
import { createDbClient, debateArenas, migrationsFolder } from '@licio/db';
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DebateArenaRecord,
  type DebateLockedContent,
  type DebateStore,
  InMemoryDebateStore,
} from '../forum/debate-store.js';
import { DrizzleDebateStore } from '../forum/drizzle-debate-store.js';
import { DrizzleContributionStore, DrizzleRoomStore } from '../forum/drizzle-forum-stores.js';
import { DrizzleStoryStore } from '../ingestion/drizzle-ingestion-stores.js';

const DB_URL = process.env['DATABASE_URL'];
const citation = { url: 'https://example.org/source' };

interface Ctx {
  storyId: string;
  threadId: string;
  incumbentUser: string | null;
  challengerUser: string | null;
  targetId: string;
  challengerId: string;
  challenger2Id: string;
}

function makeArena(
  ctx: Ctx,
  over: Partial<DebateArenaRecord> = {},
): Omit<DebateArenaRecord, 'createdAt' | 'updatedAt'> {
  return {
    debateId: randomUUID(),
    storyId: ctx.storyId,
    threadId: ctx.threadId,
    roomId: null,
    targetType: 'comment',
    targetContributionId: ctx.targetId,
    challengerContributionId: ctx.challengerId,
    incumbentUserId: ctx.incumbentUser,
    challengerUserId: ctx.challengerUser,
    state: 'open',
    positions: {
      incumbent: { summary: '', citations: [], updatedAt: null },
      challenger: {
        summary: 'wrong',
        citations: [citation],
        updatedAt: '2026-07-05T00:00:00.000Z',
      },
    },
    editDeadlineAt: '2026-07-05T23:00:00.000Z',
    resolveDueAt: '2026-07-06T00:00:00.000Z',
    lockedAt: null,
    lockedContent: null,
    incumbentLastActiveAt: '2026-07-05T00:00:00.000Z',
    challengerLastActiveAt: '2026-07-05T00:00:00.000Z',
    verdict: null,
    winner: null,
    decidedBy: null,
    rationale: null,
    confidence: null,
    aiOutputId: null,
    verdictAt: null,
    overrideDeadlineAt: null,
    overriddenByUserId: null,
    overrideReason: null,
    resolvedAt: null,
    ...over,
  };
}

function contract(makeStore: () => DebateStore, freshCtx: () => Promise<Ctx>): void {
  it('opens + reads an arena and enforces one non-resolved arena per target', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const arena = await store.open(makeArena(ctx));
    expect(arena).not.toBeNull();
    const fetched = await store.getById(arena?.debateId ?? '');
    expect(fetched?.targetContributionId).toBe(ctx.targetId);
    expect(fetched?.positions.challenger.summary).toBe('wrong');
    // A second (different challenger) arena on the SAME target is refused.
    const dup = await store.open(makeArena(ctx, { challengerContributionId: ctx.challenger2Id }));
    expect(dup).toBeNull();
    expect((await store.getActiveForComment(ctx.targetId))?.debateId).toBe(arena?.debateId);
  });

  it('recordVerdict is STATE-CONDITIONAL: a stale second verdict never clobbers the first or an override', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const arena = await store.open(makeArena(ctx));
    const id = arena?.debateId ?? '';
    const first = await store.recordVerdict(id, {
      verdict: 'corrected',
      winner: 'challenger',
      decidedBy: 'ai',
      rationale: 'more independent sources',
      confidence: 0.9,
      aiOutputId: 'out-1',
      verdictAt: '2026-07-05T12:00:00.000Z',
      overrideDeadlineAt: '2026-07-06T12:00:00.000Z',
      state: 'judged',
    });
    expect(first?.state).toBe('judged');
    // A steward overrules (state stays `judged`).
    await store.recordOverride(id, {
      verdict: 'upheld',
      winner: 'incumbent',
      overriddenByUserId: ctx.incumbentUser ?? 'steward',
      overrideReason: 'primary source vindicates the original',
    });
    // A STALE concurrent judge (a lease-overrun tick on another instance)
    // tries to write again: the CAS refuses — null, nothing changes.
    const stale = await store.recordVerdict(id, {
      verdict: 'inconclusive',
      winner: 'none',
      decidedBy: 'ai',
      rationale: 'stale overwrite attempt',
      confidence: null,
      aiOutputId: null,
      verdictAt: '2026-07-05T12:05:00.000Z',
      overrideDeadlineAt: '2026-07-06T12:05:00.000Z',
      state: 'judged',
    });
    expect(stale).toBeNull();
    const after = await store.getById(id);
    expect(after?.verdict).toBe('upheld'); // the override survives
    expect(after?.winner).toBe('incumbent');
    expect(after?.rationale).not.toBe('stale overwrite attempt');
  });

  it('claimForVerdict atomically freezes the position snapshot the judge scores', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const arena = await store.open(makeArena(ctx));
    const id = arena?.debateId ?? '';
    // The claim flips open → awaiting_verdict and returns the frozen snapshot.
    const claimed = await store.claimForVerdict(id);
    expect(claimed?.state).toBe('awaiting_verdict');
    // A position write AFTER the claim is refused at the store level (the
    // TOCTOU loser gets an explicit rejection, never a silently ignored write).
    const late = await store.updatePosition(id, 'incumbent', {
      summary: 'a last-second rebuttal that must not be silently ignored',
      citations: [citation],
      updatedAt: '2026-07-05T11:59:59.000Z',
    });
    expect(late).toBeNull();
    expect((await store.getById(id))?.positions.incumbent.summary).not.toContain('last-second');
    // Re-claiming succeeds (crash recovery for a judge that never returned) …
    expect((await store.claimForVerdict(id))?.state).toBe('awaiting_verdict');
    // … and the awaiting arena stays LISTED as due for resolution (never stranded).
    const due = await store.listPastResolveDeadline('2027-01-01T00:00:00.000Z', 10);
    expect(due.some((row) => row.debateId === id)).toBe(true);
    // A judged arena refuses the claim.
    await store.recordVerdict(id, {
      verdict: 'corrected',
      winner: 'challenger',
      decidedBy: 'ai',
      rationale: 'sources',
      confidence: 0.8,
      aiOutputId: null,
      verdictAt: '2026-07-05T12:00:00.000Z',
      overrideDeadlineAt: '2026-07-06T12:00:00.000Z',
      state: 'judged',
    });
    expect(await store.claimForVerdict(id)).toBeNull();
  });

  it('updates one side without clobbering the other (co-visible concurrency)', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const arena = await store.open(makeArena(ctx));
    const id = arena?.debateId ?? '';
    await store.updatePosition(id, 'incumbent', {
      summary: 'the transcript confirms it',
      citations: [citation],
      updatedAt: '2026-07-05T01:00:00.000Z',
    });
    const after = await store.getById(id);
    expect(after?.positions.incumbent.summary).toBe('the transcript confirms it');
    // The challenger's original draft is UNTOUCHED.
    expect(after?.positions.challenger.summary).toBe('wrong');
    expect(after?.positions.challenger.citations).toHaveLength(1);
  });

  it('records a verdict, a steward override, and resolution', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const arena = await store.open(makeArena(ctx));
    const id = arena?.debateId ?? '';
    await store.recordVerdict(id, {
      verdict: 'corrected',
      winner: 'challenger',
      decidedBy: 'ai',
      rationale: 'more independent sources',
      confidence: 0.9,
      aiOutputId: 'out:x',
      verdictAt: '2026-07-05T12:00:00.000Z',
      overrideDeadlineAt: '2026-07-06T12:00:00.000Z',
      state: 'judged',
    });
    const judged = await store.getById(id);
    expect(judged?.state).toBe('judged');
    expect(judged?.verdict).toBe('corrected');
    expect(judged?.confidence).toBeCloseTo(0.9);
    await store.recordOverride(id, {
      verdict: 'upheld',
      winner: 'incumbent',
      overriddenByUserId: ctx.incumbentUser ?? randomUUID(),
      overrideReason: 'the record was misread',
    });
    const overruled = await store.getById(id);
    expect(overruled?.winner).toBe('incumbent');
    expect(overruled?.decidedBy).toBe('steward');
    await store.setState(id, 'resolved', '2026-07-07T00:00:00.000Z');
    expect((await store.getById(id))?.state).toBe('resolved');
    // A resolved arena is no longer the active one for the target.
    expect(await store.getActiveForComment(ctx.targetId)).toBeNull();
  });

  it('sweeps arenas due for lock, resolution, and finalize', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    // An OPEN arena whose 23h edit window already closed → due for LOCK.
    const open = await store.open(
      makeArena(ctx, {
        editDeadlineAt: '2026-07-05T00:00:00.000Z',
        resolveDueAt: '2026-07-05T01:00:00.000Z',
      }),
    );
    const dueLock = await store.listDueForLock('2026-07-05T00:30:00.000Z', 10);
    expect(dueLock.map((a) => a.debateId)).toContain(open?.debateId);
    // Past its resolve-due instant it is due for the AI resolution queue
    // (still `open` — the lock-sweep catch-up path is listed too).
    const dueResolve = await store.listPastResolveDeadline('2026-07-05T06:00:00.000Z', 10);
    expect(dueResolve.map((a) => a.debateId)).toContain(open?.debateId);
    // A JUDGED arena whose 24h override window already closed.
    await store.recordVerdict(open?.debateId ?? '', {
      verdict: 'inconclusive',
      winner: 'none',
      decidedBy: 'ai',
      rationale: null,
      confidence: null,
      aiOutputId: null,
      verdictAt: '2026-07-05T00:00:00.000Z',
      overrideDeadlineAt: '2026-07-05T01:00:00.000Z',
      state: 'judged',
    });
    // A judged arena is no longer due for lock/resolution.
    expect(
      (await store.listDueForLock('2027-01-01T00:00:00.000Z', 10)).map((a) => a.debateId),
    ).not.toContain(open?.debateId);
    expect(
      (await store.listPastResolveDeadline('2027-01-01T00:00:00.000Z', 10)).map((a) => a.debateId),
    ).not.toContain(open?.debateId);
    const pastOverride = await store.listPastOverrideDeadline('2026-07-06T00:00:00.000Z', 10);
    expect(pastOverride.map((a) => a.debateId)).toContain(open?.debateId);
  });

  it('locks in the content snapshot (state CAS; the expedite pulls resolveDueAt forward)', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const arena = await store.open(makeArena(ctx));
    const id = arena?.debateId ?? '';
    const snapshot: DebateLockedContent = {
      target: {
        title: null,
        body: 'the challenged text',
        citations: [],
        updatedAt: '2026-07-05T00:30:00.000Z',
      },
      correction: {
        title: null,
        body: 'the correction text',
        citations: [citation],
        updatedAt: '2026-07-05T00:00:00.000Z',
      },
    };
    // The expedited lock pulls the queue entry forward to the lock instant.
    const locked = await store.lock(
      id,
      '2026-07-05T01:00:00.000Z',
      snapshot,
      '2026-07-05T01:00:00.000Z',
    );
    expect(locked?.state).toBe('locked');
    expect(locked?.lockedAt).toBe('2026-07-05T01:00:00.000Z');
    expect(locked?.resolveDueAt).toBe('2026-07-05T01:00:00.000Z');
    expect(locked?.lockedContent?.target.body).toBe('the challenged text');
    expect(locked?.lockedContent?.correction.citations).toHaveLength(1);
    // A second lock is refused (CAS: only `open` locks) — and so are position
    // writes, withdrawal, and concession from this instant.
    expect(await store.lock(id, '2026-07-05T02:00:00.000Z', snapshot)).toBeNull();
    expect(await store.withdraw(id, '2026-07-05T02:00:00.000Z')).toBeNull();
    expect(
      await store.concede(id, {
        verdict: 'corrected',
        winner: 'challenger',
        decidedBy: 'concession',
        rationale: 'conceded',
        verdictAt: '2026-07-05T02:00:00.000Z',
        resolvedAt: '2026-07-05T02:00:00.000Z',
      }),
    ).toBeNull();
    // A locked arena claims for verdict (locked → awaiting_verdict).
    expect((await store.claimForVerdict(id))?.state).toBe('awaiting_verdict');
  });

  it('refreshLockedContent replaces a still-locked snapshot and refuses once claimed', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const arena = await store.open(makeArena(ctx));
    const id = arena?.debateId ?? '';
    const side = (body: string): DebateLockedContent['target'] => ({
      title: null,
      body,
      citations: [],
      updatedAt: null,
    });
    await store.lock(id, '2026-07-05T01:00:00.000Z', {
      target: side('pre-race body'),
      correction: side('the correction'),
    });
    // The edit-race reconcile: while still `locked`, the snapshot is replaceable.
    const refreshed = await store.refreshLockedContent(id, {
      target: side('post-edit body'),
      correction: side('the correction'),
    });
    expect(refreshed?.lockedContent?.target.body).toBe('post-edit body');
    // Once the queue claims the arena, the snapshot is frozen for the judge.
    await store.claimForVerdict(id);
    expect(
      await store.refreshLockedContent(id, {
        target: side('too late'),
        correction: side('the correction'),
      }),
    ).toBeNull();
    expect((await store.getById(id))?.lockedContent?.target.body).toBe('post-edit body');
  });

  it('withdraws an OPEN arena (terminal, frees the per-target slot)', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const arena = await store.open(makeArena(ctx));
    const id = arena?.debateId ?? '';
    const withdrawn = await store.withdraw(id, '2026-07-05T01:00:00.000Z');
    expect(withdrawn?.state).toBe('withdrawn');
    expect(withdrawn?.resolvedAt).toBe('2026-07-05T01:00:00.000Z');
    expect(withdrawn?.verdict).toBeNull();
    // Terminal: not active, not sweepable, and the target slot is FREE again.
    expect(await store.getActiveForComment(ctx.targetId)).toBeNull();
    expect(
      (await store.listPastResolveDeadline('2027-01-01T00:00:00.000Z', 10)).map((a) => a.debateId),
    ).not.toContain(id);
    const fresh = await store.open(makeArena(ctx, { challengerContributionId: ctx.challenger2Id }));
    expect(fresh).not.toBeNull();
  });

  it('concedes an OPEN arena (resolved with the concession outcome)', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const arena = await store.open(makeArena(ctx));
    const id = arena?.debateId ?? '';
    const conceded = await store.concede(id, {
      verdict: 'corrected',
      winner: 'challenger',
      decidedBy: 'concession',
      rationale: 'The incumbent conceded the challenge.',
      verdictAt: '2026-07-05T01:00:00.000Z',
      resolvedAt: '2026-07-05T01:00:00.000Z',
    });
    expect(conceded?.state).toBe('resolved');
    expect(conceded?.verdict).toBe('corrected');
    expect(conceded?.winner).toBe('challenger');
    expect(conceded?.decidedBy).toBe('concession');
    // Terminal: a verdict can no longer land.
    expect(await store.claimForVerdict(id)).toBeNull();
  });

  it('tracks side activity: position writes + touches feed the idle sweep', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const arena = await store.open(makeArena(ctx));
    const id = arena?.debateId ?? '';
    // Both clocks start at open → the arena is idle-listed one window later.
    const idleAtOpen = await store.listIdleSince('2026-07-05T01:00:00.000Z', 10);
    expect(idleAtOpen.map((a) => a.debateId)).toContain(id);
    // A rebuttal write resets the WRITER's clock and un-lists the arena.
    await store.updatePosition(id, 'incumbent', {
      summary: 'the transcript confirms it',
      citations: [citation],
      updatedAt: '2026-07-05T02:00:00.000Z',
    });
    expect(
      (await store.listIdleSince('2026-07-05T01:30:00.000Z', 10)).map((a) => a.debateId),
    ).not.toContain(id);
    // An underlying-content touch resets the other side's clock too.
    const touched = await store.touchActivity(id, 'challenger', '2026-07-05T03:00:00.000Z');
    expect(touched?.challengerLastActiveAt).toBe('2026-07-05T03:00:00.000Z');
    // Idle again one window after the LATEST side activity.
    expect(
      (await store.listIdleSince('2026-07-05T03:00:00.000Z', 10)).map((a) => a.debateId),
    ).toContain(id);
    // Only OPEN arenas idle-list; a locked arena never re-lists.
    await store.lock(
      id,
      '2026-07-05T04:00:00.000Z',
      {
        target: { title: null, body: 'x', citations: [], updatedAt: null },
        correction: { title: null, body: 'y', citations: [], updatedAt: null },
      },
      '2026-07-05T04:00:00.000Z',
    );
    expect(
      (await store.listIdleSince('2027-01-01T00:00:00.000Z', 10)).map((a) => a.debateId),
    ).not.toContain(id);
    // touchActivity on a non-open arena is a no-op (null).
    expect(await store.touchActivity(id, 'incumbent', '2026-07-05T05:00:00.000Z')).toBeNull();
  });

  it('finds the live arena by its CORRECTION contribution and shifts deadlines (the dev seam)', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const arena = await store.open(makeArena(ctx));
    const id = arena?.debateId ?? '';
    expect((await store.getActiveForCorrection(ctx.challengerId))?.debateId).toBe(id);
    expect(await store.getActiveForCorrection(randomUUID())).toBeNull();
    const shifted = await store.shiftDeadlines(id, {
      editDeadlineAt: '2026-07-05T00:10:00.000Z',
      resolveDueAt: '2026-07-05T00:20:00.000Z',
    });
    expect(shifted?.editDeadlineAt).toBe('2026-07-05T00:10:00.000Z');
    expect(shifted?.resolveDueAt).toBe('2026-07-05T00:20:00.000Z');
  });

  it('handles story-target arenas + active counts + the contribution→debate map', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const storyArena = await store.open(
      makeArena(ctx, { targetType: 'story', targetContributionId: null }),
    );
    expect((await store.getActiveForStory(ctx.storyId))?.debateId).toBe(storyArena?.debateId);
    expect(await store.countActiveForStory(ctx.storyId)).toBeGreaterThanOrEqual(1);
    // A comment arena on a different target maps its target → the debate id.
    const commentArena = await store.open(makeArena(ctx));
    const map = await store.activeDebateIdsForContributions([ctx.targetId, randomUUID()]);
    expect(map.get(ctx.targetId)).toBe(commentArena?.debateId);
    // The story-level discovery list surfaces BOTH the story- and comment-target
    // active arenas (the resolved/none ones are excluded by state).
    const active = await store.listActiveForStory(ctx.storyId, 10);
    const activeIds = active.map((a) => a.debateId);
    expect(activeIds).toContain(storyArena?.debateId);
    expect(activeIds).toContain(commentArena?.debateId);
    expect(active.every((a) => a.state !== 'resolved')).toBe(true);
    // …and a different story sees none of them.
    expect(await store.listActiveForStory(randomUUID(), 10)).toHaveLength(0);
  });
}

describe('InMemoryDebateStore (contract)', () => {
  contract(
    () => new InMemoryDebateStore(() => Date.parse('2026-07-05T00:00:00.000Z')),
    async () => ({
      storyId: randomUUID(),
      threadId: randomUUID(),
      incumbentUser: randomUUID(),
      challengerUser: randomUUID(),
      targetId: randomUUID(),
      challengerId: randomUUID(),
      challenger2Id: randomUUID(),
    }),
  );
});

describe.skipIf(!DB_URL)('DrizzleDebateStore (contract, live Postgres)', () => {
  let db: ReturnType<typeof createDbClient>;
  let stories: DrizzleStoryStore;
  let contributions: DrizzleContributionStore;
  let rooms: DrizzleRoomStore;
  let user: string;
  let roomId: string;

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    stories = new DrizzleStoryStore(db);
    contributions = new DrizzleContributionStore(db);
    rooms = new DrizzleRoomStore(db);
    const { users } = await import('@licio/db');
    const inserted = await db
      .insert(users)
      .values({
        handle: `wst_${randomUUID().slice(0, 8)}`,
        displayName: 'WS-T debate',
        email: null,
        ageBandIfKnown: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
      })
      .returning();
    user = (inserted[0] as { userId: string }).userId;
    const suffix = randomUUID().slice(0, 8);
    const room = await rooms.insert({
      roomId: randomUUID(),
      name: `WS-T Debate Room ${suffix}`,
      slug: `wst-debate-room-${suffix}`,
      description: null,
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      storageMode: 'server',
      createdBy: user,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
      frozen: false,
      migratedToRoomId: null,
    });
    if (!room.ok) throw new Error('room seed failed');
    roomId = room.room.roomId;
  });

  afterAll(async () => {
    await db.delete(debateArenas);
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  /** Seed a fresh story→thread + two contributions so each arena's FKs resolve. */
  async function seedContribution(threadId: string): Promise<string> {
    const id = randomUUID();
    const outcome = await contributions.insert({
      contributionId: id,
      threadId,
      userId: user,
      type: 'comment',
      body: 'seed',
      citations: [],
      metadata: {},
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: `draft-${randomUUID()}`,
      path: [],
      moderationState: 'published',
    });
    if (!outcome.ok) throw new Error('contribution seed failed');
    return id;
  }

  const freshCtx = async (): Promise<Ctx> => {
    const storyId = randomUUID();
    const threadId = randomUUID();
    const created = await stories.createWithThread(
      {
        storyId,
        canonicalUrl: null,
        title: `WS-T debate story ${storyId.slice(0, 8)}`,
        titleHash: randomUUID().replaceAll('-', ''),
        submittedBy: user,
        sourceId: null,
        roomId,
        visibility: 'public',
        mediaUploadRef: null,
        canonicalPublicStoryId: null,
        language: 'en',
        topicIds: [randomUUID()],
        locationScope: null,
        sensitivityLabels: ['none'],
        lifecycleState: 'gathering_attention',
        submissionType: 'original_brief',
        submissionMetadata: { submission_type: 'original_brief', body: 'seed' },
        excerpt: 'seed',
        publisher: null,
        author: null,
        publishedAt: null,
        mediaType: null,
        extractionState: 'not_applicable',
        hiddenState: null,
      },
      threadId,
    );
    if (!created.ok) throw new Error('story seed failed');
    return {
      storyId,
      threadId,
      incumbentUser: user,
      challengerUser: user,
      targetId: await seedContribution(threadId),
      challengerId: await seedContribution(threadId),
      challenger2Id: await seedContribution(threadId),
    };
  };

  contract(() => new DrizzleDebateStore(db), freshCtx);
});
