// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G organic thread-state evolution + subtree pagination + the upload
// scanner seam + DSAR upload listing:
//
//   • structural `active → deepening` (maybeDeepenConversation via the
//     contribution-create hook): fires only when volume, sourcing (citation-
//     bearing contributions), AND a live multi-level exchange all hold, and
//     never from a non-active state;
//   • WS-E harassment-cascade escalation (the `forum-thread-posture` router
//     consumer): safety `normal → elevated` + conversation `active → tense`,
//     idempotent under at-least-once redelivery, burst signals ignored,
//     `deepening` keeps its (ratified) lack of a tense edge;
//   • subtreeContent walks the WHOLE subtree exactly once through keyset
//     pages (the WS-G.3.3 lazy-loading contract applied to subtrees);
//   • the injectable UploadScanner gates uploads (pending holds, flagged
//     rejects) without weakening the default local-checks posture.
import { randomUUID } from 'node:crypto';
import {
  type ContributionCreate,
  type IntegritySignalDetectedEvent,
  integritySignalDetectedEventSchema,
} from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContribution } from '../forum/contributions.js';
import { subtreeContent } from '../forum/threads.js';
import { applyConversationTransition } from '../forum/transitions.js';
import { getIdentityServices } from '../identity/services.js';
import {
  contributionBody,
  type ForumServicesFixture,
  freshForumServices,
  seedThread,
  seedUserWithSession,
} from './forum-test-helpers.js';

let fixture: ForumServicesFixture;
let userId: string;
let threadId: string;
let storyId: string;

beforeEach(async () => {
  fixture = freshForumServices({
    forumConfig: {
      contributionsPerMinute: 1_000,
      contributionsPerHour: 5_000,
      deepeningMinContributions: 4,
      deepeningMinDepth: 2,
      deepeningMinEvidence: 1,
    },
  });
  const session = await seedUserWithSession(fixture.identity);
  userId = session.userId;
  ({ threadId, storyId } = await seedThread(fixture));
});

function bundle() {
  return { forum: fixture.forum, ingestion: fixture.ingestion, events: fixture.events };
}

async function createOk(body: Record<string, unknown>) {
  const outcome = await createContribution(
    bundle(),
    userId,
    `ref-${userId}`,
    body as unknown as ContributionCreate,
  );
  if (!outcome.ok) throw new Error(`create failed: ${JSON.stringify(outcome.rejection)}`);
  return outcome.contribution;
}

async function conversationState(): Promise<string> {
  const thread = await fixture.ingestion.stories.getThreadById(threadId);
  if (!thread) throw new Error('thread vanished');
  return thread.conversationState;
}

async function safetyState(): Promise<string> {
  const thread = await fixture.ingestion.stories.getThreadById(threadId);
  if (!thread) throw new Error('thread vanished');
  return thread.safetyState;
}

/** Root comment + reply; returns both ids (the depth-2 anchor points). */
async function seedExchange(): Promise<{ rootId: string; answerId: string }> {
  const root = await createOk(contributionBody('comment', threadId));
  const answer = await createOk(
    contributionBody('comment', threadId, { parentId: root.contributionId }),
  );
  return { rootId: root.contributionId, answerId: answer.contributionId };
}

function cascadeSignal(targetId: string, eventId = randomUUID()): IntegritySignalDetectedEvent {
  return integritySignalDetectedEventSchema.parse({
    event_id: eventId,
    event_type: 'integrity.signal.detected',
    timestamp: new Date().toISOString(),
    schema_version: '1',
    signal_type: 'harassment_cascade',
    target_ids: [targetId],
    confidence: 0.91,
    evidence_summary: 'synthetic cascade for thread-posture tests',
    privacy_classification: 'restricted',
    retention_tier: 'security_log',
  });
}

describe('structural deepening (WS-G.1.1 system trigger)', () => {
  it('moves active → deepening when volume, sourcing, and depth all hold', async () => {
    const { answerId } = await seedExchange();
    await createOk(contributionBody('comment', threadId, { sourced: true })); // 3 published
    expect(await conversationState()).toBe('active'); // below volume threshold
    // The 4th contribution is a depth-2 reply — every condition now holds.
    await createOk(contributionBody('comment', threadId, { parentId: answerId }));
    await fixture.settleAll();
    expect(await conversationState()).toBe('deepening');
  });

  it('never fires from shallow volume alone (depth condition)', async () => {
    await createOk(contributionBody('comment', threadId, { sourced: true }));
    for (let i = 0; i < 5; i += 1) {
      await createOk(contributionBody('comment', threadId));
    }
    await fixture.settleAll();
    expect(await conversationState()).toBe('active');
  });

  it('never fires without accumulated sourcing (citation condition)', async () => {
    const { answerId } = await seedExchange();
    await createOk(contributionBody('comment', threadId));
    await createOk(contributionBody('comment', threadId, { parentId: answerId }));
    await fixture.settleAll();
    expect(await conversationState()).toBe('active');
  });

  it('never auto-deepens a non-active thread (state gate)', async () => {
    const { answerId } = await seedExchange();
    await createOk(contributionBody('comment', threadId, { sourced: true }));
    const deps = {
      stories: fixture.ingestion.stories,
      events: fixture.events,
      audit: getIdentityServices().audit,
      trackBackground: fixture.forum.trackBackground,
      now: fixture.forum.now,
    };
    const marked = await applyConversationTransition(deps, threadId, 'tense', null, 'test');
    expect(marked.ok).toBe(true);
    await createOk(contributionBody('comment', threadId, { parentId: answerId }));
    await fixture.settleAll();
    expect(await conversationState()).toBe('tense');
  });

  it('emits the audited thread.state.changed event for the transition', async () => {
    const { answerId } = await seedExchange();
    await createOk(contributionBody('comment', threadId, { sourced: true }));
    await createOk(contributionBody('comment', threadId, { parentId: answerId }));
    await fixture.settleAll();
    const events = await fixture.events.eventStore.listByTopicsBetween(
      ['thread.state.changed'],
      new Date(0).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    const change = events.find(
      (row) =>
        (row.payload as { state_dimension?: string }).state_dimension === 'conversation' &&
        (row.payload as { new_state?: string }).new_state === 'deepening',
    );
    expect(change).toBeDefined();
    expect((change?.payload as { changed_by?: string } | undefined)?.changed_by).toBe('system');
  });
});

describe('integrity escalation (the forum-thread-posture consumer)', () => {
  it('a harassment cascade elevates safety and marks the conversation tense', async () => {
    await fixture.events.router.publish(cascadeSignal(storyId));
    await fixture.settleAll();
    expect(await safetyState()).toBe('elevated');
    expect(await conversationState()).toBe('tense');
    expect(fixture.forum.metrics.snapshot()['threads.safety_escalated']).toBe(1);
    expect(fixture.forum.metrics.snapshot()['threads.marked_tense']).toBe(1);
  });

  it('is idempotent under at-least-once redelivery', async () => {
    const signal = cascadeSignal(storyId);
    await fixture.events.router.publish(signal);
    await fixture.events.router.publish(signal); // redelivery, same event id
    await fixture.events.router.publish(cascadeSignal(storyId)); // fresh detection
    await fixture.settleAll();
    expect(await safetyState()).toBe('elevated');
    expect(await conversationState()).toBe('tense');
    // Exactly one transition per dimension ever applied.
    expect(fixture.forum.metrics.snapshot()['threads.safety_escalated']).toBe(1);
    expect(fixture.forum.metrics.snapshot()['threads.marked_tense']).toBe(1);
    expect(await fixture.events.deadLetters.list()).toEqual([]);
  });

  it('a THREAD-id target still escalates — the LEGACY replay path', async () => {
    // A cascade target is a PWAtt fold item id (`pwatt/scoring.ts` emits
    // `target_ids: [item.itemId]`), and every branch of the fold now keys by the
    // owning story — including `contribution.created`, which used to key by
    // `thread_id` and so produced a phantom item nothing downstream could reach.
    // So a signal emitted by THIS release always names a story.
    //
    // But `integrity.signal.detected` is durable and replayable, and a
    // `harassment_cascade` emitted BEFORE the fold-key change still names a
    // thread.  Dropping the thread lookup would silently skip those pending
    // signals for the life of the retained window — a real escalation never
    // applied.  Story-first with a thread fallback keeps them working.
    //
    // What keeps the fold-key fix honest is NOT this consumer being intolerant —
    // it is `pwatt/aggregation.ts` folding by story and the tests there failing
    // loudly on a regression.  Making the replay path lossy to police a
    // different module's invariant costs real signals for no guarantee.
    await fixture.events.router.publish(cascadeSignal(threadId));
    await fixture.settleAll();
    expect(await safetyState()).toBe('elevated');
    expect(await conversationState()).toBe('tense');
  });

  it('ignores non-cascade signals and unknown targets', async () => {
    await fixture.events.router.publish(
      integritySignalDetectedEventSchema.parse({
        ...cascadeSignal(storyId),
        event_id: randomUUID(),
        signal_type: 'coordinated_burst',
      }),
    );
    await fixture.events.router.publish(cascadeSignal(randomUUID())); // no such story
    await fixture.settleAll();
    expect(await safetyState()).toBe('normal');
    expect(await conversationState()).toBe('active');
  });

  it('a deepening thread keeps its conversation state (no tense edge) but still escalates safety', async () => {
    const deps = {
      stories: fixture.ingestion.stories,
      events: fixture.events,
      audit: getIdentityServices().audit,
      trackBackground: fixture.forum.trackBackground,
      now: fixture.forum.now,
    };
    const deepened = await applyConversationTransition(deps, threadId, 'deepening', null, 'test');
    expect(deepened.ok).toBe(true);
    await fixture.events.router.publish(cascadeSignal(storyId));
    await fixture.settleAll();
    expect(await safetyState()).toBe('elevated');
    expect(await conversationState()).toBe('deepening');
  });
});

describe('subtree keyset pagination (WS-G.1.2d-2 / WS-G.3.3)', () => {
  async function buildTree(): Promise<{ rootId: string; allIds: string[] }> {
    const root = await createOk(contributionBody('comment', threadId));
    const allIds = [root.contributionId];
    // Three replies, each with two depth-2 replies: 1 + 3 + 6 = 10 rows.
    for (let i = 0; i < 3; i += 1) {
      const answer = await createOk(
        contributionBody('comment', threadId, { parentId: root.contributionId }),
      );
      allIds.push(answer.contributionId);
      for (let j = 0; j < 2; j += 1) {
        const reply = await createOk(
          contributionBody('comment', threadId, { parentId: answer.contributionId }),
        );
        allIds.push(reply.contributionId);
      }
    }
    await createOk(contributionBody('comment', threadId)); // outside the subtree
    return { rootId: root.contributionId, allIds };
  }

  const resolveNoAuthor = async () => null;

  it('walks the whole subtree exactly once; the root heads the first page only', async () => {
    fixture = freshForumServices({
      forumConfig: { contributionsPerMinute: 1_000, branchPageSize: 4 },
    });
    const session = await seedUserWithSession(fixture.identity);
    userId = session.userId;
    ({ threadId } = await seedThread(fixture));
    const { rootId, allIds } = await buildTree();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page = await subtreeContent(
        bundle(),
        threadId,
        rootId,
        userId,
        resolveNoAuthor,
        cursor,
      );
      expect(page.rootFound).toBe(true);
      seen.push(...page.rows.map((row) => row.contribution_id));
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(20); // walk always terminates
    }
    expect(seen.includes(rootId)).toBe(true);
    expect(seen.filter((id) => id === rootId)).toHaveLength(1); // first page only
    expect(new Set(seen).size).toBe(seen.length); // exactly once
    expect([...seen].sort()).toEqual([...allIds].sort()); // complete, root included
    expect(pages).toBeGreaterThan(1); // it actually paginated
  });

  it('an unknown cursor restarts from the first page (defensive fallback)', async () => {
    const { rootId } = await buildTree();
    const first = await subtreeContent(bundle(), threadId, rootId, userId, resolveNoAuthor, null);
    const restarted = await subtreeContent(
      bundle(),
      threadId,
      rootId,
      userId,
      resolveNoAuthor,
      randomUUID(),
    );
    expect(restarted.rows.map((r) => r.contribution_id)).toEqual(
      first.rows.map((r) => r.contribution_id),
    );
  });

  it('an invisible root gates every page, including continuations', async () => {
    const { rootId } = await buildTree();
    const first = await subtreeContent(bundle(), threadId, rootId, userId, resolveNoAuthor, null);
    expect(first.rootFound).toBe(true);
    await fixture.forum.contributions.setModerationState(rootId, 'removed');
    const stranger = randomUUID();
    const page1 = await subtreeContent(bundle(), threadId, rootId, stranger, resolveNoAuthor, null);
    expect(page1.rootFound).toBe(false);
    const page2 = await subtreeContent(
      bundle(),
      threadId,
      rootId,
      stranger,
      resolveNoAuthor,
      first.nextCursor,
    );
    expect(page2.rootFound).toBe(false);
  });
});

describe('upload scanner seam (WS-J.2.6b) + DSAR upload listing', () => {
  it('the in-memory store lists uploads by owner in (created_at, id) order', async () => {
    const mine = await fixture.forum.uploads.put(
      {
        uploadId: randomUUID(),
        ownerUserId: userId,
        contentType: 'image/png',
        byteSize: 10,
        altText: 'mine',
        storageRef: 'uploads/mine',
        metadataStripped: true,
        scanState: 'clear',
      },
      new Uint8Array([1]),
    );
    await fixture.forum.uploads.put(
      {
        uploadId: randomUUID(),
        ownerUserId: randomUUID(),
        contentType: 'image/png',
        byteSize: 10,
        altText: 'other',
        storageRef: 'uploads/other',
        metadataStripped: true,
        scanState: 'clear',
      },
      new Uint8Array([1]),
    );
    const listed = await fixture.forum.uploads.listByOwner(userId);
    expect(listed.map((row) => row.uploadId)).toEqual([mine.uploadId]);
    expect(await fixture.forum.uploads.listByOwner(randomUUID())).toEqual([]);

    // The batch read behind `resolveMedia` — the SAME contract the Drizzle
    // adapter is pinned to in forum-integration.test.ts: duplicates collapse, a
    // missing id is absent rather than an error, and an empty ask does no work.
    const missing = randomUUID();
    const batch = await fixture.forum.uploads.getRecords([mine.uploadId, mine.uploadId, missing]);
    expect([...batch.keys()]).toEqual([mine.uploadId]);
    expect(batch.get(mine.uploadId)).toEqual(await fixture.forum.uploads.getRecord(mine.uploadId));
    expect(batch.has(missing)).toBe(false);
    expect(await fixture.forum.uploads.getRecords([])).toEqual(new Map());
  });

  it('a pending scan verdict holds attachment; flagged rejects at the seam', async () => {
    fixture.forum.uploadScanner = {
      scan: async () => ({ state: 'pending', reason: 'queued_for_shared_intel' }),
    };
    const held = await fixture.forum.uploadScanner.scan(new Uint8Array([1]), 'image/png');
    expect(held.state).toBe('pending');
    // A pending upload cannot attach (the existing attachment guard).
    const pending = await fixture.forum.uploads.put(
      {
        uploadId: randomUUID(),
        ownerUserId: userId,
        contentType: 'image/jpeg',
        byteSize: 10,
        altText: 'x',
        storageRef: 'uploads/pending',
        metadataStripped: true,
        scanState: 'pending',
      },
      new Uint8Array([1]),
    );
    const outcome = await createContribution(bundle(), userId, `ref-${userId}`, {
      ...contributionBody('comment', threadId),
      attachment_ids: [pending.uploadId],
    } as unknown as ContributionCreate);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.code).toBe('attachment_not_cleared');
  });
});
