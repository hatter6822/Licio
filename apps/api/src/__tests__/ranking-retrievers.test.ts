// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.1.1a retrieval READ SHAPE: one serve issues one recent-story scan, one
// seen-history scan, and one thread-shell batch — none of them growing with
// the number of retrievers or the number of candidates. The retrievers all run
// concurrently under a single `Promise.allSettled` over ONE `RetrieveContext`,
// which is what makes the per-serve memos on that context correct.

import { randomUUID } from 'node:crypto';
import { EVERGREEN_PROFILE } from '@licio/ranking';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestAttentionEvents } from '../events/ingest.js';
import { assembleCandidatePool, type ClassificationPorts } from '../ranking/orchestrator.js';
import {
  type CandidateDataPorts,
  ChronologicalCatchUpRetriever,
  createDefaultRetrievers,
  type RetrieveContext,
} from '../ranking/retrievers.js';
import { createCandidateDataPorts } from '../ranking/services.js';
import { attentionEvent, seedUserWithSession } from './event-test-helpers.js';
import { freshRankingServices, type RankingFixture, seedStory } from './ranking-helpers.js';

let fixture: RankingFixture;

const NO_CLASSIFICATION: ClassificationPorts = {
  seenSourceIds: async () => new Set(),
  isSyndicationCopy: async () => false,
};

function retrieveContext(partial: Partial<RetrieveContext> = {}): RetrieveContext {
  return {
    userId: null,
    surface: 'front_page',
    surfaceRoomId: null,
    nowMs: Date.now(),
    limit: 20,
    ...partial,
  };
}

function ports(): CandidateDataPorts {
  return createCandidateDataPorts(
    fixture.events,
    fixture.ingestion,
    fixture.forum,
    fixture.identity,
  );
}

async function markSeen(userId: string, storyId: string): Promise<void> {
  await ingestAttentionEvents(
    fixture.events,
    fixture.identity,
    userId,
    [attentionEvent(userId, { storyId, timestamp: new Date().toISOString() })],
    { maxPastMs: Number.MAX_SAFE_INTEGER, maxFutureMs: Number.MAX_SAFE_INTEGER },
  );
}

beforeEach(() => {
  fixture = freshRankingServices();
});

describe('per-serve retrieval memos', () => {
  it('assembles a pool with ONE recent-story scan and ONE seen-history scan', async () => {
    const { userId } = await seedUserWithSession(fixture.identity, { handle: 'reader1' });
    const seeded = [
      await seedStory(fixture.ingestion),
      await seedStory(fixture.ingestion),
      await seedStory(fixture.ingestion),
    ];
    // A non-empty seen set is what makes IndependentSourceAdditions scan at all
    // (it returns early on an empty history), so this exercises FOUR retrievers
    // that each used to issue their own `recentStories`.
    await markSeen(userId, seeded[0]?.storyId ?? '');

    const p = ports();
    const recentSpy = vi.spyOn(p, 'recentStories');
    const seenSpy = vi.spyOn(p, 'userSeenStories');
    const result = await assembleCandidatePool(
      createDefaultRetrievers(p),
      // The quota classification's own `seenSourceIds` read is a SEPARATE seam
      // (ClassificationPorts, not CandidateDataPorts) and is stubbed out here.
      NO_CLASSIFICATION,
      EVERGREEN_PROFILE,
      retrieveContext({ userId }),
      () => {},
      'anonymous',
    );

    expect(result.pool.length).toBeGreaterThan(0);
    expect(recentSpy).toHaveBeenCalledTimes(1);
    expect(seenSpy).toHaveBeenCalledTimes(1);
    // The one scan is sized for the WIDEST consumer; the narrower catch-up
    // retriever takes a prefix of it rather than re-querying.
    expect(recentSpy.mock.calls[0]?.[0]).toBe(80);
  });

  it('a second serve re-reads: the memos live on the request context, not the ports', async () => {
    // `createCandidateDataPorts` is constructed ONCE at boot, so a cache held
    // there would leak one user's seen history into the next request.
    const { userId } = await seedUserWithSession(fixture.identity, { handle: 'reader2' });
    await seedStory(fixture.ingestion);
    const p = ports();
    const recentSpy = vi.spyOn(p, 'recentStories');
    const registry = createDefaultRetrievers(p);
    for (const _serve of [0, 1]) {
      await assembleCandidatePool(
        registry,
        NO_CLASSIFICATION,
        EVERGREEN_PROFILE,
        retrieveContext({ userId }),
        () => {},
        'anonymous',
      );
    }
    expect(recentSpy).toHaveBeenCalledTimes(2);
  });
});

describe('ChronologicalCatchUpRetriever thread reads', () => {
  it('resolves every candidate room in ONE batch, not one read per candidate', async () => {
    const { userId } = await seedUserWithSession(fixture.identity, { handle: 'reader3' });
    // The ALREADY-SEEN story lives in a different room, so it sets that room's
    // catch-up mark and leaves the three Commons candidates eligible.
    const seeded = [
      await seedStory(fixture.ingestion, { roomId: randomUUID() }),
      await seedStory(fixture.ingestion),
      await seedStory(fixture.ingestion),
      await seedStory(fixture.ingestion),
    ];
    await markSeen(userId, seeded[0]?.storyId ?? '');

    const p = ports();
    const batchSpy = vi.spyOn(p, 'threadsByStoryIds');
    const candidates = await new ChronologicalCatchUpRetriever(p).retrieve(
      retrieveContext({ userId }),
    );

    // Three unseen stories still come back — the batch REPLACED the per-item
    // lookup, it did not drop the per-room mark it feeds.
    expect(candidates).toHaveLength(3);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const asked = new Set(batchSpy.mock.calls[0]?.[0] ?? []);
    for (const story of seeded) expect(asked.has(story.storyId)).toBe(true);
  });
});
