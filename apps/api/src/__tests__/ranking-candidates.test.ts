// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.1 candidate generation: the eight retrievers (WS-I.1.1a), diversity
// quotas (WS-I.1.1b), and the orchestrator (WS-I.1.1d) — merge/dedup,
// failure isolation, budget, quota enforcement with graceful degradation,
// and the schema-validated stage boundary.

import { randomUUID } from 'node:crypto';
import type { Candidate, RankingProfileConfig } from '@licio/ranking';
import { EVERGREEN_PROFILE } from '@licio/ranking';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingestAttentionEvents } from '../events/ingest.js';
import { assembleCandidatePool, type ClassificationPorts } from '../ranking/orchestrator.js';
import { applyQuotas } from '../ranking/quotas.js';
import {
  type CandidateRetriever,
  ChronologicalCatchUpRetriever,
  CrossCommunityBridgesRetriever,
  createDefaultRetrievers,
  EmergingDiscussionsRetriever,
  ExpertExplanationsRetriever,
  GlobalCandidatesRetriever,
  IndependentSourceAdditionsRetriever,
  LocalNewsRetriever,
  localeRegion,
  type RetrieveContext,
  RetrieverRegistry,
  SubscribedRoomsRetriever,
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

function ports() {
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

describe('WS-I.1.1a retrievers', () => {
  it('every candidate carries source_type + retrieval origin metadata', async () => {
    await seedStory(fixture.ingestion);
    const retriever = new ChronologicalCatchUpRetriever(ports());
    const candidates = await retriever.retrieve(retrieveContext());
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.source_type).toBe('chronological_catch_up');
    expect(candidates[0]?.retrieval_origins).toEqual(['chronological_catch_up_v1']);
  });

  it('hidden and archived stories are never retrieved', async () => {
    await seedStory(fixture.ingestion, { hiddenState: 'takedown' });
    await seedStory(fixture.ingestion, { lifecycleState: 'archived' });
    const { storyId } = await seedStory(fixture.ingestion);
    const candidates = await new ChronologicalCatchUpRetriever(ports()).retrieve(retrieveContext());
    expect(candidates.map((c) => c.item_id)).toEqual([storyId]);
  });

  it('subscribed-rooms retrieves only the user’s ACTIVE room subscriptions', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const roomId = randomUUID();
    await fixture.forum.rooms.insert({
      roomId,
      name: 'Water systems',
      slug: 'water-systems',
      description: null,
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      createdBy: null,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });
    await fixture.forum.rooms.upsertSubscription({
      roomId,
      userId,
      status: 'active',
      requestId: randomUUID(),
      lensId: null,
      requestedAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
    });
    const inRoom = await seedStory(fixture.ingestion, { roomId });
    await seedStory(fixture.ingestion); // not in any room
    const candidates = await new SubscribedRoomsRetriever(ports()).retrieve(
      retrieveContext({ userId }),
    );
    expect(candidates.map((c) => c.item_id)).toEqual([inRoom.storyId]);
    expect(candidates[0]?.room_id).toBe(roomId);
    // Signed-out users have no subscribed rooms.
    expect(await new SubscribedRoomsRetriever(ports()).retrieve(retrieveContext())).toEqual([]);
  });

  it('local news matches the user’s OWN configured locale region only', async () => {
    expect(localeRegion('en-GB')).toBe('GB');
    expect(localeRegion('en')).toBeNull();
    expect(localeRegion(null)).toBeNull();
    const { userId } = await seedUserWithSession(fixture.identity);
    await fixture.identity.store.updateUser(userId, { locale: 'en-GB' });
    const local = await seedStory(fixture.ingestion, {
      locationScope: { type: 'country', value: 'GB' },
    });
    await seedStory(fixture.ingestion, { locationScope: { type: 'country', value: 'US' } });
    await seedStory(fixture.ingestion, { locationScope: null });
    const candidates = await new LocalNewsRetriever(ports()).retrieve(retrieveContext({ userId }));
    expect(candidates.map((c) => c.item_id)).toEqual([local.storyId]);
    expect(candidates[0]?.source_type).toBe('local_news');
  });

  it('global candidates use the PWAtt threshold, never raw engagement counts', async () => {
    const above = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 100 * 3_600_000).toISOString(),
    });
    const below = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 100 * 3_600_000).toISOString(),
    });
    await fixture.events.invariantStore.upsert({
      invariantType: 'PWAtt_v1',
      targetType: 'story',
      targetId: above.storyId,
      timeWindow: { start: '2026-06-10T00:00:00.000Z', end: '2026-06-10T01:00:00.000Z' },
      version: 'v1',
      scoreVector: { active_attention: 0.4, participation: 0.4 },
      explanationSummary: null,
      confidence: 1,
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: false,
      createdAt: new Date().toISOString(),
    });
    await fixture.events.invariantStore.upsert({
      invariantType: 'PWAtt_v1',
      targetType: 'story',
      targetId: below.storyId,
      timeWindow: { start: '2026-06-10T00:00:00.000Z', end: '2026-06-10T01:00:00.000Z' },
      version: 'v1',
      scoreVector: { active_attention: 0.0, participation: 0.0 },
      explanationSummary: null,
      confidence: 1,
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: false,
      createdAt: new Date().toISOString(),
    });
    const candidates = await new GlobalCandidatesRetriever(ports()).retrieve(retrieveContext());
    expect(candidates.map((c) => c.item_id)).toEqual([above.storyId]);
  });

  it('retrieval treats a SHADOW/degraded PWAtt row as ABSENT (§30.5 gate binds retrieval)', async () => {
    // An OLD story (low freshness ⇒ no cold-start) with a STRONG PWAtt row that
    // is shadow_mode:true. The retrieval leg must apply the same bounded-input
    // gate as the feature join, so the shadow row does NOT admit the candidate.
    const oldTs = new Date(Date.now() - 100 * 3_600_000).toISOString();
    const shadowStory = await seedStory(fixture.ingestion, { publishedAt: oldTs });
    const strong = {
      invariantType: 'PWAtt_v1' as const,
      targetType: 'story' as const,
      targetId: shadowStory.storyId,
      timeWindow: { start: '2026-06-10T00:00:00.000Z', end: '2026-06-10T01:00:00.000Z' },
      version: 'v1',
      scoreVector: { active_attention: 0.9, participation: 0.9 },
      explanationSummary: null,
      confidence: 1,
      coverage: 1,
      reasonCodes: [] as string[],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: true, // pre-lift / kill-switch posture
      createdAt: new Date().toISOString(),
    };
    await fixture.events.invariantStore.upsert(strong);
    expect(
      (await new GlobalCandidatesRetriever(ports()).retrieve(retrieveContext())).map(
        (c) => c.item_id,
      ),
    ).not.toContain(shadowStory.storyId);

    // A DEGRADED (TIMEOUT) post-lift row is likewise ABSENT.
    await fixture.events.invariantStore.upsert({
      ...strong,
      shadowMode: false,
      reasonCodes: ['TIMEOUT'],
    });
    expect(
      (await new GlobalCandidatesRetriever(ports()).retrieve(retrieveContext())).map(
        (c) => c.item_id,
      ),
    ).not.toContain(shadowStory.storyId);

    // The SAME strong row post-lift and non-degraded DOES admit it.
    await fixture.events.invariantStore.upsert({ ...strong, shadowMode: false, reasonCodes: [] });
    expect(
      (await new GlobalCandidatesRetriever(ports()).retrieve(retrieveContext())).map(
        (c) => c.item_id,
      ),
    ).toContain(shadowStory.storyId);
  });

  it('global cold start: brand-new uncovered stories are eligible at a LOWER score', async () => {
    const fresh = await seedStory(fixture.ingestion, {
      publishedAt: new Date().toISOString(),
    });
    const candidates = await new GlobalCandidatesRetriever(ports()).retrieve(retrieveContext());
    expect(candidates.map((c) => c.item_id)).toEqual([fresh.storyId]);
    expect(candidates[0]?.retrieval_score).toBeLessThanOrEqual(0.5);
  });

  it('emerging discussions require CONSTRUCTIVE velocity, not raw volume', async () => {
    const constructive = await seedStory(fixture.ingestion);
    const noisy = await seedStory(fixture.ingestion);
    const windowBase = {
      windowStart: new Date(Date.now() - 3_600_000).toISOString(),
      windowSize: '24h' as const,
      uniqueActiveUsers: 5,
      sourceOpens: 3,
      contextOpens: 1,
      returnVisits: 2,
      antiSignalCounts: {},
      computedAt: new Date().toISOString(),
    };
    await fixture.events.windowStore.upsert({
      ...windowBase,
      itemId: constructive.storyId,
      contributionCounts: { correction: 1, bridge_comment: 1 },
      eventCount: 10,
    });
    await fixture.events.windowStore.upsert({
      ...windowBase,
      itemId: noisy.storyId,
      contributionCounts: { low_info_reply: 40 },
      eventCount: 100,
    });
    const candidates = await new EmergingDiscussionsRetriever(ports()).retrieve(retrieveContext());
    expect(candidates.map((c) => c.item_id)).toEqual([constructive.storyId]);
  });

  it('independent additions surface previously-seen stories that gained sourced comments', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    const seen = await seedStory(fixture.ingestion);
    await markSeen(userId, seen.storyId);
    // A published SOURCED comment (comment-centric sourcing) lands AFTER the
    // user saw the story.
    await fixture.forum.contributions.insert({
      contributionId: randomUUID(),
      threadId: seen.threadId,
      userId,
      type: 'comment',
      body: 'The primary dataset is public.',
      citations: [{ url: 'https://example.org/data' }],
      metadata: {},
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: `seed-${seen.storyId}`,
      path: [],
      moderationState: 'published',
    });
    await fixture.ingestion.stories.update(seen.storyId, {
      lastMaterialUpdateAt: new Date(Date.now() + 1000).toISOString(),
    });
    const candidates = await new IndependentSourceAdditionsRetriever(ports()).retrieve(
      retrieveContext({ userId }),
    );
    expect(candidates.map((c) => c.item_id)).toEqual([seen.storyId]);
  });

  it('cross-community bridges require SCOI divergence and carry context metadata', async () => {
    const split = await seedStory(fixture.ingestion);
    await seedStory(fixture.ingestion);
    await fixture.events.invariantStore.upsert({
      invariantType: 'SCOI',
      targetType: 'story',
      targetId: split.storyId,
      timeWindow: { start: '2026-06-10T00:00:00.000Z', end: '2026-06-10T01:00:00.000Z' },
      version: '1.0.0',
      scoreVector: { scoi: 0.6, context_state: 'split', lens_count: 3 },
      explanationSummary: null,
      confidence: 1,
      coverage: 1,
      reasonCodes: [],
      fallbackUsed: false,
      versionMetadata: null,
      shadowMode: true,
      createdAt: new Date().toISOString(),
    });
    const candidates = await new CrossCommunityBridgesRetriever(ports()).retrieve(
      retrieveContext(),
    );
    expect(candidates.map((c) => c.item_id)).toEqual([split.storyId]);
    expect(candidates[0]?.bridge_context).toEqual({
      scoi: 0.6,
      context_state: 'split',
      lens_count: 3,
    });
  });

  it('expert explanations surface stories from PUBLIC experts_and_stewards rooms only', async () => {
    // The retriever's single remaining leg (the human-summary leg was removed
    // with the §24.3 thread-summary feature): stories in public rooms whose
    // posting policy is `experts_and_stewards` — the WS-Q successor to legacy
    // expert_led rooms. Ordinary-room stories never enter through this source.
    const expertRoomId = randomUUID();
    await fixture.forum.rooms.insert({
      roomId: expertRoomId,
      name: 'Expert desk',
      slug: 'expert-desk',
      description: null,
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'experts_and_stewards',
      createdBy: null,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });
    const expertStory = await seedStory(fixture.ingestion, { roomId: expertRoomId });
    await seedStory(fixture.ingestion); // Commons (all_members) — not expert-led
    const candidates = await new ExpertExplanationsRetriever(ports()).retrieve(retrieveContext());
    expect(candidates.map((c) => c.item_id)).toEqual([expertStory.storyId]);
    expect(candidates[0]?.source_type).toBe('expert_explanation');
    expect(candidates[0]?.retrieval_origins).toEqual(['expert_explanations_v1']);
  });

  it('chronological catch-up skips seen stories and respects the per-room mark', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    // WS-Q — every story has a home room; seed the two in DISTINCT public rooms
    // so the per-room last-seen mark of the seen story does not also filter the
    // unseen one (and so the global public predicate passes for both).
    const insertPublicRoom = async (): Promise<string> => {
      const roomId = randomUUID();
      await fixture.forum.rooms.insert({
        roomId,
        name: `Room ${roomId.slice(0, 8)}`,
        slug: `room-${roomId.slice(0, 8)}`,
        description: null,
        roomType: 'global_topic',
        visibility: 'public',
        joinModel: 'open',
        postingPolicy: 'all_members',
        createdBy: null,
        governanceMode: 'ordinary',
        charterSummary: null,
        typeMetadata: {},
        latestActivityAt: null,
      });
      return roomId;
    };
    const seen = await seedStory(fixture.ingestion, { roomId: await insertPublicRoom() });
    const unseen = await seedStory(fixture.ingestion, { roomId: await insertPublicRoom() });
    await markSeen(userId, seen.storyId);
    const candidates = await new ChronologicalCatchUpRetriever(ports()).retrieve(
      retrieveContext({ userId }),
    );
    expect(candidates.map((c) => c.item_id)).toEqual([unseen.storyId]);
  });
});

describe('WS-I.1.1b quotas', () => {
  const quotas = EVERGREEN_PROFILE.quotas;

  function candidate(n: number, score: number): Candidate {
    return {
      item_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      item_type: 'story',
      source_type: 'global',
      room_id: null,
      visibility: 'public',
      topic_ids: ['t'],
      source_id: `00000000-0000-4000-8000-${String(9000 + n).padStart(12, '0')}`,
      freshness_timestamp: new Date().toISOString(),
      retrieval_score: score,
      retrieval_origins: ['global_pwatt_v1'],
      bridge_context: null,
    };
  }

  it('reserves quota slots for under-represented classes', () => {
    // 20 candidates; the last 5 are "fresh"; budget 10 with 15% fresh floor.
    const pool = Array.from({ length: 20 }, (_, i) => candidate(i + 1, 1 - i * 0.01));
    const fresh = new Set(pool.slice(15).map((c) => c.item_id));
    const result = applyQuotas(
      pool,
      (c) => ({ fresh: fresh.has(c.item_id), independent: true, local: false }),
      quotas,
      10,
      { localQuotaApplies: false },
    );
    expect(result.pool).toHaveLength(10);
    const achievedFresh = result.pool.filter((c) => fresh.has(c.item_id)).length;
    expect(achievedFresh).toBeGreaterThanOrEqual(Math.floor((quotas.fresh_min_pct / 100) * 10));
    const outcome = result.outcomes.find((o) => o.quota_type === 'fresh');
    expect(outcome?.shortfall).toBe(false);
  });

  it('degrades gracefully and reports the shortfall when the class is empty', () => {
    const pool = Array.from({ length: 10 }, (_, i) => candidate(i + 1, 1 - i * 0.01));
    const result = applyQuotas(
      pool,
      () => ({ fresh: false, independent: true, local: false }),
      quotas,
      10,
      { localQuotaApplies: true },
    );
    expect(result.pool).toHaveLength(10);
    expect(result.outcomes.find((o) => o.quota_type === 'fresh')?.shortfall).toBe(true);
    expect(result.outcomes.find((o) => o.quota_type === 'local')?.shortfall).toBe(true);
  });

  it('the local quota applies only when a local signal exists', () => {
    const pool = Array.from({ length: 5 }, (_, i) => candidate(i + 1, 1 - i * 0.01));
    const result = applyQuotas(
      pool,
      () => ({ fresh: true, independent: true, local: false }),
      quotas,
      5,
      { localQuotaApplies: false },
    );
    const local = result.outcomes.find((o) => o.quota_type === 'local');
    // The target is always REPORTED; `applicable: false` records that it
    // did not bind (no local signal) — distinct from a real shortfall.
    expect(local?.target_pct).toBe(quotas.local_min_pct);
    expect(local?.applicable).toBe(false);
    expect(local?.shortfall).toBe(false);
  });

  it('JOINT protection: filling one class never evicts another class below its reserve', () => {
    // Budget 10 ⇒ reserves: fresh ceil(1.5)=2, independent ceil(2)=2.
    // Top-10 contains EXACTLY the fresh reserve (c9, c10 — the two lowest-
    // ranked selected items) and zero independent members; the independent
    // fill must evict the lowest-ranked EVICTABLE items (c8, c7), never the
    // fresh members whose eviction would re-create a fresh shortfall.
    const pool = Array.from({ length: 12 }, (_, i) => candidate(i + 1, 1 - i * 0.01));
    const id = (n: number) => pool[n - 1]?.item_id as string;
    const freshIds = new Set([id(9), id(10)]);
    const independentIds = new Set([id(11), id(12)]);
    const result = applyQuotas(
      pool,
      (c) => ({
        fresh: freshIds.has(c.item_id),
        independent: independentIds.has(c.item_id),
        local: false,
      }),
      quotas,
      10,
      { localQuotaApplies: false },
    );
    const selected = new Set(result.pool.map((c) => c.item_id));
    // The fresh reserve survived the independent fill…
    expect(selected.has(id(9))).toBe(true);
    expect(selected.has(id(10))).toBe(true);
    // …the independent members were swapped in…
    expect(selected.has(id(11))).toBe(true);
    expect(selected.has(id(12))).toBe(true);
    // …at the cost of the lowest-ranked unprotected items.
    expect(selected.has(id(7))).toBe(false);
    expect(selected.has(id(8))).toBe(false);
    expect(result.outcomes.find((o) => o.quota_type === 'fresh')?.shortfall).toBe(false);
    expect(result.outcomes.find((o) => o.quota_type === 'independent')?.shortfall).toBe(false);
  });
});

describe('WS-I.1.1d orchestrator', () => {
  it('merges retrievers, dedupes by item id, and validates the boundary', async () => {
    const { userId } = await seedUserWithSession(fixture.identity);
    await seedStory(fixture.ingestion, { publishedAt: new Date().toISOString() });
    const logs: Array<{ event: string; meta: Record<string, unknown> }> = [];
    const result = await assembleCandidatePool(
      fixture.ranking.retrievers,
      NO_CLASSIFICATION,
      EVERGREEN_PROFILE,
      {
        userId,
        surface: 'front_page',
        surfaceRoomId: null,
        nowMs: Date.now(),
        limit: 20,
      },
      (event, meta) => logs.push({ event, meta }),
      'bucket:aa',
    );
    expect(result.pool.length).toBe(1);
    // The same story reached the pool through ≥ 2 retrievers, merged.
    expect(result.pool[0]?.retrieval_origins.length).toBeGreaterThanOrEqual(2);
    const assembled = logs.find((l) => l.event === 'candidate.pool.assembled');
    expect(assembled?.meta['user_privacy_bucket']).toBe('bucket:aa');
    expect(assembled?.meta['total_candidates']).toBe(1);
    expect(logs.filter((l) => l.event === 'candidate.quota.evaluated')).toHaveLength(3);
  });

  it('a throwing retriever is skipped with a gap log; the pool still returns', async () => {
    await seedStory(fixture.ingestion, { publishedAt: new Date().toISOString() });
    const registry = new RetrieverRegistry();
    const failing: CandidateRetriever = {
      origin: 'broken_v1',
      sourceType: 'global',
      retrieve: async () => {
        throw new Error('store outage');
      },
    };
    registry.register(failing);
    registry.register(new ChronologicalCatchUpRetriever(ports()));
    const logs: string[] = [];
    const result = await assembleCandidatePool(
      registry,
      NO_CLASSIFICATION,
      EVERGREEN_PROFILE,
      { userId: null, surface: 'front_page', surfaceRoomId: null, nowMs: Date.now(), limit: 20 },
      (event) => logs.push(event),
      'anonymous',
    );
    expect(result.pool.length).toBe(1);
    expect(result.skippedRetrievers).toEqual(['broken_v1']);
    expect(logs).toContain('candidate.retrieval.gap');
  });

  it('caps the pool at the configured budget', async () => {
    for (let i = 0; i < 12; i += 1) {
      await seedStory(fixture.ingestion, { publishedAt: new Date().toISOString() });
    }
    const budgeted: RankingProfileConfig = { ...EVERGREEN_PROFILE, candidate_budget: 10 };
    const result = await assembleCandidatePool(
      fixture.ranking.retrievers,
      NO_CLASSIFICATION,
      budgeted,
      { userId: null, surface: 'front_page', surfaceRoomId: null, nowMs: Date.now(), limit: 50 },
      () => {},
      'anonymous',
    );
    expect(result.pool.length).toBeLessThanOrEqual(10);
  });

  it('the registry holds the eight organic origins + the room scoper, and rejects duplicates', () => {
    const origins = createDefaultRetrievers(ports()).origins();
    expect(origins.sort()).toEqual(
      [
        'subscribed_rooms_v1',
        'local_news_v1',
        'global_pwatt_v1',
        'emerging_discussions_v1',
        'independent_additions_v1',
        'cross_community_bridges_v1',
        'expert_explanations_v1',
        'chronological_catch_up_v1',
        // Room-surface scoping (inert outside room feeds; not an organic
        // front-page source — those remain exactly the SPEC §13.2 eight).
        'room_surface_v1',
      ].sort(),
    );
    const registry = new RetrieverRegistry();
    registry.register(new ChronologicalCatchUpRetriever(ports()));
    expect(() => registry.register(new ChronologicalCatchUpRetriever(ports()))).toThrow();
  });
});
