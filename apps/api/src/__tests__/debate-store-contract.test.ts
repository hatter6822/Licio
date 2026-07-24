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
  /** A user DISTINCT from both parties (the challenge-policy opponent-dedup
   *  cases need a real non-null, non-self incumbent). */
  opponentUser: string;
  targetId: string;
  challengerId: string;
  challenger2Id: string;
  /** Mint one more correction-contribution id in this ctx's thread (the
   *  standing/settle cases need >2 terminal arenas per target). */
  newCorrection: () => Promise<string>;
  /** Mint a fresh user id: the USER-keyed standing aggregation must be
   *  isolated per case (the Drizzle leg shares one database, so a shared
   *  challenger id would pick up every prior case's arenas). */
  newUser: () => Promise<string>;
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

  it('pinnedStoryChallenger returns only the LIVE story challenger, never a settled one', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    // A settled INCONCLUSIVE story challenge (challenger A) is NOT pinnable.
    const settled = await store.open(
      makeArena(ctx, {
        targetType: 'story',
        targetContributionId: null,
        challengerContributionId: ctx.challengerId,
        state: 'resolved',
        verdict: 'inconclusive',
        resolvedAt: '2026-07-06T00:00:00.000Z',
      }),
    );
    expect(settled).not.toBeNull();
    expect(await store.pinnedStoryChallenger(ctx.storyId)).toBeNull();
    // A LIVE story challenge (challenger B) now pins — and ONLY it, so the
    // settled correction keeps its chronological place (the Codex edge case).
    const live = await store.open(
      makeArena(ctx, {
        targetType: 'story',
        targetContributionId: null,
        challengerContributionId: ctx.challenger2Id,
        state: 'open',
      }),
    );
    expect(live).not.toBeNull();
    expect(await store.pinnedStoryChallenger(ctx.storyId)).toBe(ctx.challenger2Id);
  });

  it('pinnedStoryChallenger returns a challenger that PREVAILED (resolved corrected)', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const won = await store.open(
      makeArena(ctx, {
        targetType: 'story',
        targetContributionId: null,
        challengerContributionId: ctx.challengerId,
        state: 'resolved',
        verdict: 'corrected',
        winner: 'challenger',
        decidedBy: 'ai',
        resolvedAt: '2026-07-06T00:00:00.000Z',
      }),
    );
    expect(won).not.toBeNull();
    expect(await store.pinnedStoryChallenger(ctx.storyId)).toBe(ctx.challengerId);
  });

  it('lists arenas by party and anonymizes the party out (DSAR §19.3)', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const party = ctx.challengerUser;
    if (party === null) return; // party ids are required for this contract
    const arena = await store.open(makeArena(ctx));
    expect(arena).not.toBeNull();

    // listByParty finds an arena the user is a party to.
    const listed = await store.listByParty(party, null, 10);
    expect(listed.map((r) => r.debateId)).toContain(arena?.debateId);

    // anonymizeParty detaches the party, NULLing the identity link while the
    // rebuttal text persists (§22.4) — exactly like contribution anonymize.
    const touched = await store.anonymizeParty(party);
    expect(touched).toBeGreaterThanOrEqual(1);
    expect(await store.listByParty(party, null, 10)).toHaveLength(0);
    const row = await store.getById(arena?.debateId ?? '');
    expect(row?.challengerUserId).toBeNull();
    expect(row?.positions.challenger.summary).toBe('wrong');
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

  it('backfills a MISSING snapshot on a claimed arena but never replaces one', async () => {
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
    // A legacy/crash claim: straight from `open`, no lock, no snapshot.
    await store.claimForVerdict(id);
    const filled = await store.backfillLockedContent(id, '2026-07-05T01:00:00.000Z', {
      target: side('the challenged text'),
      correction: side('the correction'),
    });
    expect(filled?.lockedContent?.target.body).toBe('the challenged text');
    expect(filled?.lockedAt).toBe('2026-07-05T01:00:00.000Z');
    // An existing snapshot is frozen for the judge — the backfill CAS refuses.
    expect(
      await store.backfillLockedContent(id, '2026-07-05T02:00:00.000Z', {
        target: side('overwrite attempt'),
        correction: side('x'),
      }),
    ).toBeNull();
    expect((await store.getById(id))?.lockedContent?.target.body).toBe('the challenged text');
  });

  it('closeForRemoval closes every arena atomically — or NONE when any left `open`', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    // Two live arenas: a comment-target one (this row as challenger) and a
    // story-target one (this row's author as incumbent).
    const a = await store.open(makeArena(ctx));
    const b = await store.open(
      makeArena(ctx, {
        targetType: 'story',
        targetContributionId: null,
        challengerContributionId: ctx.challenger2Id,
      }),
    );
    const aId = a?.debateId ?? '';
    const bId = b?.debateId ?? '';
    const patch = {
      verdict: 'corrected',
      winner: 'challenger',
      decidedBy: 'concession',
      rationale: 'The incumbent conceded the challenge.',
      verdictAt: '2026-07-05T01:00:00.000Z',
      resolvedAt: '2026-07-05T01:00:00.000Z',
    } as const;
    // One of the pair locks concurrently: the WHOLE close rolls back.
    await store.lock(bId, '2026-07-05T00:30:00.000Z', {
      target: { title: null, body: 'x', citations: [], updatedAt: null },
      correction: { title: null, body: 'y', citations: [], updatedAt: null },
    });
    expect(
      await store.closeForRemoval([
        { debateId: aId, kind: 'withdraw', closedAt: '2026-07-05T01:00:00.000Z' },
        { debateId: bId, kind: 'concede', patch },
      ]),
    ).toBeNull();
    expect((await store.getById(aId))?.state).toBe('open'); // untouched
    // With every arena OPEN (a fresh pair on a fresh graph), the set closes.
    const ctx2 = await freshCtx();
    const a2 = await store.open(makeArena(ctx2));
    const b2 = await store.open(
      makeArena(ctx2, {
        targetType: 'story',
        targetContributionId: null,
        challengerContributionId: ctx2.challenger2Id,
      }),
    );
    if (!a2 || !b2) throw new Error('fresh arenas not opened');
    const closed = await store.closeForRemoval([
      { debateId: a2.debateId, kind: 'withdraw', closedAt: '2026-07-05T02:00:00.000Z' },
      { debateId: b2.debateId, kind: 'concede', patch },
    ]);
    expect(closed?.map((row) => row.state)).toEqual(['withdrawn', 'resolved']);
    expect(closed?.[1]?.decidedBy).toBe('concession');
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
    // The batched §5.6 card-signal read counts COMMENT-target arenas ONLY: the
    // story-target arena rides the story's own dispute_status instead, so one
    // debate is never double-reported on a card. Unknown stories are absent.
    const arenaCounts = await store.countActiveCommentArenas([ctx.storyId, randomUUID()]);
    expect(arenaCounts.get(ctx.storyId)).toBe(1);
    expect(arenaCounts.size).toBe(1);
    expect(await store.countActiveCommentArenas([])).toEqual(new Map());
  });

  it('challengerHistory aggregates standing from arena rows (challenge policy)', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    // A FRESH challenger for every arena in this case: the aggregation is
    // user-keyed, and the Drizzle leg's database persists across cases.
    const challenger = await ctx.newUser();
    const resolvedWin = (over: Partial<DebateArenaRecord>): Partial<DebateArenaRecord> => ({
      challengerUserId: challenger,
      state: 'resolved',
      verdict: 'corrected',
      winner: 'challenger',
      decidedBy: 'ai',
      resolvedAt: '2026-07-05T06:00:00.000Z',
      ...over,
    });
    // Two adjudicated wins against the SAME opponent (one 'ai', one 'steward')
    // group into one bucket; a tombstoned-incumbent win lands in the shared
    // tombstone bucket; a concession win and a self-targeted win credit nothing.
    for (const over of [
      resolvedWin({ incumbentUserId: ctx.opponentUser }),
      resolvedWin({ incumbentUserId: ctx.opponentUser, decidedBy: 'steward' }),
      resolvedWin({ incumbentUserId: null }),
      resolvedWin({ incumbentUserId: ctx.opponentUser, decidedBy: 'concession' }),
      resolvedWin({ incumbentUserId: challenger }),
      // An adjudicated loss (the incumbent prevailed).
      resolvedWin({ incumbentUserId: ctx.opponentUser, verdict: 'upheld', winner: 'incumbent' }),
    ]) {
      const opened = await store.open(
        makeArena(ctx, { ...over, challengerContributionId: await ctx.newCorrection() }),
      );
      expect(opened).not.toBeNull();
    }
    // One LIVE (pre-verdict) arena holds a slot; a JUDGED one does not.
    const live = await store.open(makeArena(ctx, { challengerUserId: challenger }));
    expect(live).not.toBeNull();
    const judged = await store.open(
      makeArena(ctx, {
        challengerUserId: challenger,
        targetType: 'story',
        targetContributionId: null,
        challengerContributionId: await ctx.newCorrection(),
        state: 'judged',
        verdict: 'corrected',
        winner: 'challenger',
        decidedBy: 'ai',
      }),
    );
    expect(judged).not.toBeNull();
    // Two REAL withdrawal flows: one engaged (non-grace), one untouched (grace).
    const engagedTarget = await ctx.newCorrection();
    const engaged = await store.open(
      makeArena(ctx, {
        challengerUserId: challenger,
        targetContributionId: engagedTarget,
        challengerContributionId: await ctx.newCorrection(),
      }),
    );
    expect(engaged).not.toBeNull();
    const engagedBase = Date.parse(engaged?.createdAt ?? '');
    await store.touchActivity(
      engaged?.debateId ?? '',
      'incumbent',
      new Date(engagedBase + 30_000).toISOString(),
    );
    expect(
      await store.withdraw(engaged?.debateId ?? '', new Date(engagedBase + 600_000).toISOString()),
    ).not.toBeNull();
    const untouchedTarget = await ctx.newCorrection();
    const untouched = await store.open(
      makeArena(ctx, {
        challengerUserId: challenger,
        targetContributionId: untouchedTarget,
        challengerContributionId: await ctx.newCorrection(),
      }),
    );
    expect(untouched).not.toBeNull();
    const untouchedBase = Date.parse(untouched?.createdAt ?? '');
    expect(
      await store.withdraw(
        untouched?.debateId ?? '',
        new Date(untouchedBase + 60_000).toISOString(),
      ),
    ).not.toBeNull();

    const nowIso = new Date(Math.max(engagedBase, untouchedBase) + 3_600_000).toISOString();
    const history = await store.challengerHistory(challenger, {
      nowIso,
      opensWindowMs: 86_400_000,
      withdrawWindowMs: 30 * 86_400_000,
    });
    const buckets = new Map(history.winsByOpponent.map((row) => [row.opponentKey, row.wins]));
    expect(buckets.get(ctx.opponentUser)).toBe(2);
    expect(buckets.get('tombstoned')).toBe(1);
    expect(buckets.size).toBe(2);
    expect(history.adjudicatedLosses).toBe(1);
    expect(history.liveCount).toBe(1);
    expect(history.openTimesLast24h).toHaveLength(10);
    expect(history.withdrawals).toHaveLength(2);
    const engagement = history.withdrawals.map((row) => row.incumbentEngaged).sort();
    expect(engagement).toEqual([false, true]);
  });

  it('countUpheldDefenses counts adjudicated upheld outcomes after the anchor, never self-defenses', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const challenger = ctx.challengerUser;
    if (challenger === null) return;
    // The count keys on the LOCK instant (which version the verdict judged);
    // resolvedAt trails it by the override window here, as in the real flow.
    const upheld = (over: Partial<DebateArenaRecord>): Partial<DebateArenaRecord> => ({
      state: 'resolved',
      verdict: 'upheld',
      winner: 'incumbent',
      decidedBy: 'ai',
      incumbentUserId: ctx.opponentUser,
      lockedAt: '2026-07-05T06:00:00.000Z',
      resolvedAt: '2026-07-06T06:00:00.000Z',
      ...over,
    });
    for (const over of [
      upheld({}),
      upheld({ lockedAt: '2026-07-05T07:00:00.000Z' }),
      // Self-targeted (legacy) upheld arenas never count toward settling.
      upheld({ incumbentUserId: challenger }),
      // A successful correction is not a defense.
      upheld({ verdict: 'corrected', winner: 'challenger' }),
      // Locked before the anchor ⇒ a different content version was defended
      // (its resolvedAt lands after the anchor — exactly the post-verdict-edit
      // shape a resolve-keyed count would mis-attribute).
      upheld({ lockedAt: '2026-07-05T04:00:00.000Z' }),
      // A null-lockedAt legacy row proves nothing and never counts.
      upheld({ lockedAt: null }),
    ]) {
      const opened = await store.open(
        makeArena(ctx, { ...over, challengerContributionId: await ctx.newCorrection() }),
      );
      expect(opened).not.toBeNull();
    }
    const anchor = '2026-07-05T05:00:00.000Z';
    expect(await store.countUpheldDefensesForComment(ctx.targetId, anchor)).toBe(2);
    expect(
      await store.countUpheldDefensesForComment(ctx.targetId, '2026-07-05T06:30:00.000Z'),
    ).toBe(1);
    // The story variant keys on the story id.
    const storyDefense = await store.open(
      makeArena(ctx, {
        targetType: 'story',
        targetContributionId: null,
        challengerContributionId: await ctx.newCorrection(),
        ...upheld({}),
      }),
    );
    expect(storyDefense).not.toBeNull();
    expect(await store.countUpheldDefensesForStory(ctx.storyId, anchor)).toBe(1);
  });

  it('listChallengeOpens unions pre-verdict arenas with window-scoped opens', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const challenger = await ctx.newUser();
    // Terminal first: the one-live-per-target guard refuses ANY insert on a
    // target that already carries a live arena.
    const terminal = await store.open(
      makeArena(ctx, {
        challengerUserId: challenger,
        challengerContributionId: await ctx.newCorrection(),
        state: 'resolved',
        verdict: 'inconclusive',
        winner: 'none',
        decidedBy: 'ai',
        resolvedAt: '2026-07-05T06:00:00.000Z',
      }),
    );
    expect(terminal).not.toBeNull();
    const live = await store.open(makeArena(ctx, { challengerUserId: challenger }));
    expect(live).not.toBeNull();
    const bothCreated = [live?.createdAt ?? '', terminal?.createdAt ?? ''].sort();
    // A cutoff BEFORE both opens returns the union with honest flags.
    const before = new Date(Date.parse(bothCreated[0] ?? '') - 1000).toISOString();
    const all = await store.listChallengeOpens(challenger, before);
    expect(new Map(all.map((r) => [r.debateId, r.preVerdict]))).toEqual(
      new Map([
        [live?.debateId ?? '', true],
        [terminal?.debateId ?? '', false],
      ]),
    );
    // A cutoff AFTER both drops the terminal open but keeps the live slot —
    // a pre-verdict arena can outlast the opens window.
    const after = new Date(Date.parse(bothCreated[1] ?? '') + 1000).toISOString();
    const slots = await store.listChallengeOpens(challenger, after);
    expect(slots.map((r) => r.debateId)).toEqual([live?.debateId ?? '']);
  });

  it('latestConcludedChallengeAt skips grace withdrawals and other challengers', async () => {
    const store = makeStore();
    const ctx = await freshCtx();
    const challenger = ctx.challengerUser;
    if (challenger === null) return;
    const graceMs = 5 * 60_000;
    // A grace withdrawal (retracted in 1 minute, incumbent never engaged)
    // consumed nothing.
    const grace = await store.open(makeArena(ctx));
    expect(grace).not.toBeNull();
    const graceBase = Date.parse(grace?.createdAt ?? '');
    await store.withdraw(grace?.debateId ?? '', new Date(graceBase + 60_000).toISOString());
    expect(
      await store.latestConcludedChallengeAt({ contributionId: ctx.targetId }, challenger, graceMs),
    ).toBeNull();
    // A non-grace withdrawal (the incumbent engaged) consumes the once-per-
    // target right.
    const engaged = await store.open(
      makeArena(ctx, { challengerContributionId: ctx.challenger2Id }),
    );
    expect(engaged).not.toBeNull();
    const engagedBase = Date.parse(engaged?.createdAt ?? '');
    await store.touchActivity(
      engaged?.debateId ?? '',
      'incumbent',
      new Date(engagedBase + 30_000).toISOString(),
    );
    const withdrawnAt = new Date(engagedBase + 600_000).toISOString();
    await store.withdraw(engaged?.debateId ?? '', withdrawnAt);
    expect(
      await store.latestConcludedChallengeAt({ contributionId: ctx.targetId }, challenger, graceMs),
    ).toBe(withdrawnAt);
    // A later RESOLVED arena advances the latest instant; another challenger's
    // arena never surfaces for this one.
    const resolvedAt = new Date(engagedBase + 7_200_000).toISOString();
    const resolved = await store.open(
      makeArena(ctx, {
        challengerContributionId: await ctx.newCorrection(),
        state: 'resolved',
        verdict: 'inconclusive',
        winner: 'none',
        decidedBy: 'ai',
        resolvedAt,
      }),
    );
    expect(resolved).not.toBeNull();
    expect(
      await store.latestConcludedChallengeAt({ contributionId: ctx.targetId }, challenger, graceMs),
    ).toBe(resolvedAt);
    expect(
      await store.latestConcludedChallengeAt(
        { contributionId: ctx.targetId },
        ctx.opponentUser,
        graceMs,
      ),
    ).toBeNull();
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
      opponentUser: randomUUID(),
      targetId: randomUUID(),
      challengerId: randomUUID(),
      challenger2Id: randomUUID(),
      newCorrection: async () => randomUUID(),
      newUser: async () => randomUUID(),
    }),
  );
});

describe.skipIf(!DB_URL)('DrizzleDebateStore (contract, live Postgres)', () => {
  let db: ReturnType<typeof createDbClient>;
  let stories: DrizzleStoryStore;
  let contributions: DrizzleContributionStore;
  let rooms: DrizzleRoomStore;
  let user: string;
  let opponent: string;
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
      .values([
        {
          handle: `wst_${randomUUID().slice(0, 8)}`,
          displayName: 'WS-T debate',
          email: null,
          ageBandIfKnown: 'adult',
          privacySettings: defaultPrivacySettings(),
          personalizationSettings: defaultPersonalizationSettings(),
        },
        {
          handle: `wsto_${randomUUID().slice(0, 8)}`,
          displayName: 'WS-T opponent',
          email: null,
          ageBandIfKnown: 'adult',
          privacySettings: defaultPrivacySettings(),
          personalizationSettings: defaultPersonalizationSettings(),
        },
      ])
      .returning();
    user = (inserted[0] as { userId: string }).userId;
    opponent = (inserted[1] as { userId: string }).userId;
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
      opponentUser: opponent,
      targetId: await seedContribution(threadId),
      challengerId: await seedContribution(threadId),
      challenger2Id: await seedContribution(threadId),
      newCorrection: () => seedContribution(threadId),
      newUser: async () => {
        const { users } = await import('@licio/db');
        const rows = await db
          .insert(users)
          .values({
            handle: `wstu_${randomUUID().slice(0, 8)}`,
            displayName: 'WS-T standing',
            email: null,
            ageBandIfKnown: 'adult',
            privacySettings: defaultPrivacySettings(),
            personalizationSettings: defaultPersonalizationSettings(),
          })
          .returning();
        return (rows[0] as { userId: string }).userId;
      },
    };
  };

  contract(() => new DrizzleDebateStore(db), freshCtx);
});
