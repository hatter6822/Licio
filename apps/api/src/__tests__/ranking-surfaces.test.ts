// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I surface acceptance: the room feed route (WS-G visibility gate + the
// room-scoped pool + REAL lens balancing), the topic surface (`?topic=`
// scoping + sensitivity-driven profile selection), the §23.3 wire fields
// (context_card, more_on_this_story), the GWEI gate semantics (recency
// window, k-anonymity suppression, TTL cache, the documented-owner
// override), the MFCI intake-path feature refresh, near-duplicate CHAIN
// clustering, replay backward-compatibility for pre-baseline_weights logs,
// and /v1/feed stability under the kill switch with real stories.

import { randomUUID } from 'node:crypto';
import {
  lshBandHashes,
  MINHASH_FAMILY_VERSION,
  MINHASH_NUM_HASHES,
  MINHASH_SHINGLE_K,
} from '@licio/invariants';
import { EVERGREEN_PROFILE, rankingDecisionLogSchema } from '@licio/ranking';
import {
  feedResponseSchema,
  LEGACY_DISTRIBUTION_REASON,
  topicIdForSlug,
  UNCLASSIFIED_TOPIC_ID,
} from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { signatureStory } from '../ingestion/dedup.js';
import { assembleFeatureVector, runFeatureBatch } from '../ranking/features.js';
import { engageKillSwitch } from '../ranking/killswitch.js';
import { replayDecision, serveFeed } from '../ranking/service.js';
import { registerRankingConsumers } from '../ranking/services.js';
import { createV1Routes } from '../routes/v1.js';
import { seedUserWithSession } from './event-test-helpers.js';
import {
  freshRankingServices,
  promoteInvariant,
  type RankingFixture,
  seedInvariantOutput,
  seedStory,
} from './ranking-helpers.js';

let fixture: RankingFixture;

beforeEach(() => {
  fixture = freshRankingServices();
});

function featureDeps() {
  return {
    events: fixture.events,
    ingestion: fixture.ingestion,
    invariants: fixture.invariants,
    forum: fixture.forum,
    featureStore: fixture.ranking.featureStore,
    log: fixture.ranking.log,
    now: fixture.ranking.now,
  };
}

async function insertRoom(visibility: 'public' | 'private'): Promise<string> {
  const roomId = randomUUID();
  await fixture.forum.rooms.insert({
    roomId,
    name: `Room ${roomId.slice(0, 8)}`,
    slug: `room-${roomId.slice(0, 8)}`,
    description: null,
    roomType: 'global_topic',
    visibility,
    joinModel: visibility === 'public' ? 'open' : 'request_approval',
    postingPolicy: 'all_members',
    createdBy: null,
    governanceMode: 'ordinary',
    charterSummary: null,
    typeMetadata: {},
    latestActivityAt: null,
  });
  return roomId;
}

async function subscribe(
  roomId: string,
  userId: string,
  status: 'active' | 'pending',
): Promise<void> {
  await fixture.forum.rooms.upsertSubscription({
    roomId,
    userId,
    status,
    requestId: randomUUID(),
    lensId: null,
    requestedAt: new Date().toISOString(),
    joinedAt: status === 'active' ? new Date().toISOString() : null,
  });
}

async function addLensContribution(threadId: string, lensId: string): Promise<void> {
  const result = await fixture.forum.contributions.insert({
    contributionId: randomUUID(),
    threadId,
    userId: randomUUID(),
    type: 'comment',
    body: 'A lens-tagged reading of the source material for this thread.',
    citations: [],
    metadata: { lens_id: lensId },
    targetClaimId: null,
    parentContributionId: null,
    clientDraftId: randomUUID(),
    path: [],
    moderationState: 'published',
  });
  if (!result.ok) throw new Error('lens contribution insert failed');
}

describe('room feed route (WS-I room surface; WS-G content visibility)', () => {
  it('a public room serves its OWN stories with a request_id and a room-surface log', async () => {
    const roomId = await insertRoom('public');
    const inRoom = await seedStory(fixture.ingestion, { roomId });
    const alsoInRoom = await seedStory(fixture.ingestion, { roomId });
    const outside = await seedStory(fixture.ingestion);
    const app = new Hono().route('/v1', createV1Routes());
    const response = await app.request(`/v1/rooms/${roomId}/feed`);
    expect(response.status).toBe(200);
    const body = feedResponseSchema.parse(await response.json());
    const servedIds = body.items.map((item) => item.story_id);
    expect(servedIds.sort()).toEqual([inRoom.storyId, alsoInRoom.storyId].sort());
    expect(servedIds).not.toContain(outside.storyId);
    expect(body.request_id).toBeDefined();
    const log = await fixture.ranking.decisionLogs.getByRequestId(body.request_id as string);
    expect(log?.surface).toBe('room');
  });

  it('restricted rooms read 404 for signed-out and PENDING users; active members serve', async () => {
    const roomId = await insertRoom('private');
    await seedStory(fixture.ingestion, { roomId });
    const pending = await seedUserWithSession(fixture.identity);
    const active = await seedUserWithSession(fixture.identity);
    await subscribe(roomId, pending.userId, 'pending');
    await subscribe(roomId, active.userId, 'active');
    const app = new Hono().route('/v1', createV1Routes());
    // Signed out: 404 (never 403 — no existence oracle beyond the directory).
    expect((await app.request(`/v1/rooms/${roomId}/feed`)).status).toBe(404);
    // A pending applicant knows the room exists but reads NO content.
    expect(
      (await app.request(`/v1/rooms/${roomId}/feed`, { headers: { cookie: pending.cookie } }))
        .status,
    ).toBe(404);
    // An active member serves the room feed.
    const served = await app.request(`/v1/rooms/${roomId}/feed`, {
      headers: { cookie: active.cookie },
    });
    expect(served.status).toBe(200);
    expect(feedResponseSchema.parse(await served.json()).items).toHaveLength(1);
    // An unknown room id is 404 too.
    expect((await app.request(`/v1/rooms/${randomUUID()}/feed`)).status).toBe(404);
  });

  it('room lens assignments derive from lens-tagged contributions, pin in the log, and replay', async () => {
    const roomId = await insertRoom('public');
    const s1 = await seedStory(fixture.ingestion, { roomId });
    const s2 = await seedStory(fixture.ingestion, { roomId });
    const s3 = await seedStory(fixture.ingestion, { roomId });
    // s1: lens-a dominates 2:1; s2: only lens-b; s3: EXACT tie broken
    // lexicographically (lens-a < lens-b) — deterministic and replayable.
    await addLensContribution(s1.threadId, 'lens-a');
    await addLensContribution(s1.threadId, 'lens-a');
    await addLensContribution(s1.threadId, 'lens-b');
    await addLensContribution(s2.threadId, 'lens-b');
    await addLensContribution(s3.threadId, 'lens-a');
    await addLensContribution(s3.threadId, 'lens-b');
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'room',
      surfaceRoomId: roomId,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(served.fallback).toBe(false);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    expect(log?.replay_inputs?.lens_by_item).toEqual({
      [s1.storyId]: 'lens-a',
      [s2.storyId]: 'lens-b',
      [s3.storyId]: 'lens-a',
    });
    // The pinned assignments make the room decision exactly replayable.
    const replay = await replayDecision(fixture.ranking, served.requestId);
    expect(replay.match).toBe(true);
  });

  it('private-room content NEVER leaks into public front-page/topic feeds, even for members (WS-Q §14.5.3)', async () => {
    // WS-Q strengthens containment: a `room_only` story in a private room is
    // off EVERY global surface — for signed-out, non-members, AND its own room
    // members. In-room content reaches a member only through the ROOM feed.
    const roomId = await insertRoom('private');
    const inRoom = await seedStory(fixture.ingestion, { roomId, visibility: 'room_only' });
    const publicStory = await seedStory(fixture.ingestion);
    const member = await seedUserWithSession(fixture.identity);
    await subscribe(roomId, member.userId, 'active');
    // Signed out: the room_only story is filtered BEFORE the pipeline — it
    // appears in neither the served items nor the logged candidate set.
    const anonymous = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(anonymous.items.map((i) => i.story_id)).toEqual([publicStory.storyId]);
    const anonymousLog = await fixture.ranking.decisionLogs.getByRequestId(anonymous.requestId);
    expect(anonymousLog?.candidate_ids).not.toContain(inRoom.storyId);
    // A signed-in NON-member reads the same public-only feed.
    const outsider = await seedUserWithSession(fixture.identity);
    const outsiderFeed = await serveFeed(fixture.ranking, {
      userId: outsider.userId,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(outsiderFeed.items.map((i) => i.story_id)).toEqual([publicStory.storyId]);
    // An ACTIVE member's FRONT PAGE is still public-only (containment is global).
    const memberFeed = await serveFeed(fixture.ranking, {
      userId: member.userId,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(memberFeed.items.map((i) => i.story_id)).toEqual([publicStory.storyId]);
    // The member DOES see the room_only story — but only on the ROOM feed.
    const roomFeed = await serveFeed(fixture.ranking, {
      userId: member.userId,
      surface: 'room',
      surfaceRoomId: roomId,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(roomFeed.items.map((i) => i.story_id)).toContain(inRoom.storyId);
  });
});

describe('topic feed surface (GET /v1/feed?topic=…)', () => {
  it('scopes the pool to the topic and logs surface "topic"', async () => {
    const water = await seedStory(fixture.ingestion, { topicIds: ['water-quality'] });
    const transit = await seedStory(fixture.ingestion, { topicIds: ['transit'] });
    const app = new Hono().route('/v1', createV1Routes());
    const response = await app.request('/v1/feed?topic=water-quality');
    expect(response.status).toBe(200);
    const body = feedResponseSchema.parse(await response.json());
    expect(body.items.map((item) => item.story_id)).toEqual([water.storyId]);
    expect(body.items.map((item) => item.story_id)).not.toContain(transit.storyId);
    const log = await fixture.ranking.decisionLogs.getByRequestId(body.request_id as string);
    expect(log?.surface).toBe('topic');
  });

  it('never surfaces the UNCLASSIFIED sentinel as a topic on a feed item (WS-I wire)', async () => {
    const unclassified = await seedStory(fixture.ingestion, {
      topicIds: [UNCLASSIFIED_TOPIC_ID],
    });
    const feed = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    const item = feed.items.find((i) => i.story_id === unclassified.storyId);
    expect(item).toBeDefined();
    // The sentinel is stripped from the wire, so the card shows no topic chip
    // and no per-topic repeats control for an unclassified story.
    expect(item?.topic_ids).toEqual([]);
  });

  it('resolves a `?topic=<slug>` to its catalog UUID so catalog-backed stories surface', async () => {
    // Real stories carry trusted catalog UUID topic ids; the public `?topic=`
    // form is the slug. The surface must resolve the slug to the UUID or it
    // would filter out every catalog-backed story.
    const climate = topicIdForSlug('climate-environment');
    const inTopic = await seedStory(fixture.ingestion, { topicIds: [climate] });
    const other = await seedStory(fixture.ingestion, { topicIds: [topicIdForSlug('health')] });
    const app = new Hono().route('/v1', createV1Routes());
    const response = await app.request('/v1/feed?topic=climate-environment');
    expect(response.status).toBe(200);
    const body = feedResponseSchema.parse(await response.json());
    expect(body.items.map((item) => item.story_id)).toContain(inTopic.storyId);
    expect(body.items.map((item) => item.story_id)).not.toContain(other.storyId);
  });

  it('a sensitive topic selects the conservative profile even for a breaking pool', async () => {
    // Brand-new (median age < 6h ⇒ 'breaking') stories on a WS-A sensitive
    // topic: breaking_news requires topic_sensitivity 'standard', so the
    // evergreen default must serve. A standard breaking topic contrast
    // selects breaking_news.
    await seedStory(fixture.ingestion, {
      topicIds: ['harassment'],
      publishedAt: new Date().toISOString(),
    });
    await seedStory(fixture.ingestion, {
      topicIds: ['cycling'],
      publishedAt: new Date().toISOString(),
    });
    const sensitive = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'topic',
      surfaceRoomId: null,
      surfaceTopicId: 'harassment',
      mode: undefined,
    });
    const sensitiveLog = await fixture.ranking.decisionLogs.getByRequestId(sensitive.requestId);
    expect(sensitiveLog?.profile_id).toBe('evergreen');
    const standard = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'topic',
      surfaceRoomId: null,
      surfaceTopicId: 'cycling',
      mode: undefined,
    });
    const standardLog = await fixture.ranking.decisionLogs.getByRequestId(standard.requestId);
    expect(standardLog?.profile_id).toBe('breaking_news');
  });
});

describe('wire fields (WS-I.2.4a expansions + WS-I.2.4c context cards)', () => {
  it('a stored SCOI row shapes nothing on the served wire (coupling removed)', async () => {
    const { storyId } = await seedStory(fixture.ingestion);
    await seedInvariantOutput(fixture.events, {
      invariantType: 'SCOI',
      targetId: storyId,
      scoreVector: { scoi: 0.45, context_state: 'split', lens_count: 3 },
    });
    await runFeatureBatch(featureDeps(), 50, 6);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(served.items.some((i) => i.story_id === storyId)).toBe(true);
    // The SCOI→ranking coupling was removed: no context-gate metric, no
    // constraint flag, no feature contribution.  The reader-facing divergence
    // surface is the story page's "Where interpretations differ" drawer
    // (GET /v1/stories/:id/interpretations), which reads the SCOI store
    // directly and is untouched by the ranking cut.
    expect(fixture.events.metrics.counter('ranking.context_gate.card')).toBe(0);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    const scored = log?.score_components[storyId];
    expect(scored?.constraint_flags ?? []).not.toContain('scoi_context_card');
    expect(scored?.score_components.context_coherence_gain ?? null).toBeNull();
  });

  it('cluster representatives carry more_on_this_story with the demoted sibling ids', async () => {
    // Three same-cluster stories (identical signature text); the evergreen
    // profile caps a MERI duplicate cluster at 2 per page — the OLDEST is
    // demoted into the representatives' "more on this story" expansion.
    const newest = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 1 * 3_600_000).toISOString(),
    });
    const middle = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    const demoted = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    });
    const sharedText =
      'identical syndicated body text repeated verbatim across three near duplicate stories';
    for (const story of [newest, middle, demoted]) {
      await signatureStory(fixture.ingestion.signatures, story.storyId, sharedText, 'submitted');
    }
    await runFeatureBatch(featureDeps(), 50, 6);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    const servedIds = served.items.map((item) => item.story_id);
    expect(servedIds).toContain(newest.storyId);
    expect(servedIds).toContain(middle.storyId);
    expect(servedIds).not.toContain(demoted.storyId);
    const representative = served.items.find((item) => item.story_id === newest.storyId);
    expect(representative?.more_on_this_story).toEqual([demoted.storyId]);
    expect(
      representative?.context_chips.some((chip) => chip.label === '+1 more on this story'),
    ).toBe(true);
  });
});

describe('near-duplicate CHAIN clustering (WS-I.2.1a bounded BFS)', () => {
  /** Store a hand-crafted 128-component signature (exact estimate control). */
  async function storeSignature(storyId: string, components: Uint32Array): Promise<void> {
    await fixture.ingestion.signatures.upsert(
      {
        storyId,
        minhash: components,
        shingleK: MINHASH_SHINGLE_K,
        numHashes: MINHASH_NUM_HASHES,
        familyVersion: MINHASH_FAMILY_VERSION,
        textSource: 'submitted',
      },
      lshBandHashes(components),
    );
  }

  it('A↔B↔C chains share ONE cluster key even when A and C are not mutual hits', async () => {
    const a = await seedStory(fixture.ingestion);
    const b = await seedStory(fixture.ingestion);
    const c = await seedStory(fixture.ingestion);
    // Exact estimate construction over the 128 signature components:
    //   A agrees with B on components [0, 96)  ⇒ estimate(A,B) = 0.75 ≥ 0.7
    //   B agrees with C on components [32, 128) ⇒ estimate(B,C) = 0.75 ≥ 0.7
    //   A agrees with C only on [32, 96)        ⇒ estimate(A,C) = 0.50 < 0.7
    const sigA = new Uint32Array(128);
    const sigB = new Uint32Array(128);
    const sigC = new Uint32Array(128);
    for (let i = 0; i < 128; i += 1) {
      sigA[i] = 1_000 + i;
      sigB[i] = i < 96 ? 1_000 + i : 2_000 + i;
      sigC[i] = i >= 32 ? (sigB[i] as number) : 3_000 + i;
    }
    await storeSignature(a.storyId, sigA);
    await storeSignature(b.storyId, sigB);
    await storeSignature(c.storyId, sigC);
    const expected = [a.storyId, b.storyId, c.storyId].sort()[0];
    // EVERY chain member maps to the same minimum-id key: min-over-direct-
    // hits would have split A's component ({A,B}) from C's ({B,C}).
    for (const storyId of [a.storyId, b.storyId, c.storyId]) {
      const vector = await assembleFeatureVector(featureDeps(), storyId);
      expect(vector?.duplicate_cluster_id).toBe(expected);
    }
    // A unique fourth story stays cluster-free.
    const unique = await seedStory(fixture.ingestion);
    const sigU = new Uint32Array(128);
    for (let i = 0; i < 128; i += 1) sigU[i] = 9_000 + i;
    await storeSignature(unique.storyId, sigU);
    const vector = await assembleFeatureVector(featureDeps(), unique.storyId);
    expect(vector?.duplicate_cluster_id).toBeUndefined();
  });
});

describe('GWEI deployment-gate semantics (WS-I.2.3c; SPEC §9.5)', () => {
  it('rows OUTSIDE the recency window never feed the gate', async () => {
    await fixture.events.configStore.set('ranking.scalars', { gwei_gate_window_hours: 1 });
    await fixture.ranking.reloadConfig();
    await seedInvariantOutput(fixture.events, {
      invariantType: 'GWEI',
      targetId: randomUUID(),
      targetType: 'cohort',
      scoreVector: { gw2: 0.9 },
      createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), // 2h old
    });
    expect(await fixture.ranking.latestGweiDisparity()).toBeNull();
    // A row INSIDE the window engages (null results are never cached).
    await seedInvariantOutput(fixture.events, {
      invariantType: 'GWEI',
      targetId: randomUUID(),
      targetType: 'cohort',
      scoreVector: { gw2: 0.4 },
      createdAt: new Date().toISOString(),
    });
    expect(await fixture.ranking.latestGweiDisparity()).toBe(0.4);
  });

  it('k-anonymity-suppressed rows are SKIPPED (withheld ≠ zero ≠ infinite)', async () => {
    await seedInvariantOutput(fixture.events, {
      invariantType: 'GWEI',
      targetId: randomUUID(),
      targetType: 'cohort',
      scoreVector: { gw2: 0.9 },
      reasonCodes: ['SUPPRESSED_K_ANONYMITY'],
    });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'GWEI',
      targetId: randomUUID(),
      targetType: 'cohort',
      scoreVector: { gw2: 0.2 },
    });
    expect(await fixture.ranking.latestGweiDisparity()).toBe(0.2);
  });

  it('non-null reads are TTL-cached; reloadConfig clears the cache', async () => {
    await seedInvariantOutput(fixture.events, {
      invariantType: 'GWEI',
      targetId: randomUUID(),
      targetType: 'cohort',
      scoreVector: { gw2: 0.1 },
    });
    expect(await fixture.ranking.latestGweiDisparity()).toBe(0.1);
    // A higher row lands; within the TTL the cached value still serves
    // (the serving path pays one query per minute, not one per request).
    await seedInvariantOutput(fixture.events, {
      invariantType: 'GWEI',
      targetId: randomUUID(),
      targetType: 'cohort',
      scoreVector: { gw2: 0.8 },
    });
    expect(await fixture.ranking.latestGweiDisparity()).toBe(0.1);
    await fixture.ranking.reloadConfig(); // config changes invalidate the gate input
    expect(await fixture.ranking.latestGweiDisparity()).toBe(0.8);
  });

  it('the documented-owner override keeps ranked serving, LOUDLY, until it expires', async () => {
    await seedStory(fixture.ingestion);
    await promoteInvariant(fixture.invariants, 'GWEI');
    await seedInvariantOutput(fixture.events, {
      invariantType: 'GWEI',
      targetId: randomUUID(),
      targetType: 'cohort',
      scoreVector: { gw2: 0.9 }, // far above the 0.35 evergreen threshold
    });
    // Tripped gate, no override: chronological fallback.
    const blocked = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(blocked.fallback).toBe(true);
    expect(
      (await fixture.ranking.decisionLogs.getByRequestId(blocked.requestId))?.fallback_reason,
    ).toBe('gwei_gate');
    // A LIVE documented-owner override keeps ranked serving and counts it.
    await fixture.events.configStore.set('ranking.gwei_override', {
      until: new Date(Date.now() + 3_600_000).toISOString(),
      owner: 'fairness-owner@licio',
      reason: 'known cohort artifact under investigation (ticket FAIR-12)',
    });
    await fixture.ranking.reloadConfig();
    const overridden = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(overridden.fallback).toBe(false);
    expect(
      fixture.events.metrics.snapshot().counters['ranking.gwei_gate.overridden'],
    ).toBeGreaterThanOrEqual(1);
    // An EXPIRED override stops overriding (fail closed to the fallback).
    await fixture.events.configStore.set('ranking.gwei_override', {
      until: new Date(Date.now() - 1_000).toISOString(),
      owner: 'fairness-owner@licio',
      reason: 'expired',
    });
    await fixture.ranking.reloadConfig();
    const reblocked = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(reblocked.fallback).toBe(true);
  });
});

describe('MFCI intake-path feature refresh (WS-I.2.1d real-time freshness)', () => {
  it('integrity.signal.detected refreshes features for its targets (<5s path)', async () => {
    registerRankingConsumers(fixture.ranking);
    const { storyId } = await seedStory(fixture.ingestion);
    // The MFCI INTAKE path writes the risk state directly — no
    // invariant.run.completed is emitted on the sub-minute freeze path.
    await fixture.invariants.mfciRiskStates.set({
      targetId: storyId,
      state: 'high',
      score: 3.4,
      reason: 'intake',
      updatedAt: new Date().toISOString(),
    });
    expect(await fixture.ranking.featureStore.getLatest(storyId)).toBeNull();
    await fixture.events.router.publish({
      event_id: randomUUID(),
      event_type: 'integrity.signal.detected',
      timestamp: new Date().toISOString(),
      schema_version: '1',
      signal_type: 'coordinated_burst',
      target_ids: [storyId],
      confidence: 0.9,
      evidence_summary: 'synchronized burst confirmed by the intake detector',
      privacy_classification: 'restricted',
      retention_tier: 'security_log',
    } as never);
    const stored = await fixture.ranking.featureStore.getLatest(storyId);
    expect(stored?.mfci_risk_state).toBe('high');
    expect(stored?.coordination_penalty).toBe(0.5);
  });

  it('EVERY target refreshes — events near the 100-id schema cap leave no stale tail', async () => {
    registerRankingConsumers(fixture.ranking);
    const storyIds: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const { storyId } = await seedStory(fixture.ingestion);
      storyIds.push(storyId);
      await fixture.invariants.mfciRiskStates.set({
        targetId: storyId,
        state: 'elevated',
        score: 1.1,
        reason: 'intake',
        updatedAt: new Date().toISOString(),
      });
    }
    await fixture.events.router.publish({
      event_id: randomUUID(),
      event_type: 'integrity.signal.detected',
      timestamp: new Date().toISOString(),
      schema_version: '1',
      signal_type: 'brigading',
      target_ids: storyIds,
      confidence: 0.8,
      evidence_summary: 'coordinated activity across thirty stories',
      privacy_classification: 'restricted',
      retention_tier: 'security_log',
    } as never);
    // The 26th-and-beyond targets refresh too (a 25-item cap left them
    // ranking on stale risk inputs until the hourly batch).
    for (const storyId of [storyIds[0], storyIds[25], storyIds[29]] as string[]) {
      const stored = await fixture.ranking.featureStore.getLatest(storyId);
      expect(stored?.mfci_risk_state).toBe('elevated');
    }
  });
});

describe('seen-aware pagination (the ?cursor= page chain)', () => {
  /** Shrink the page so a dozen stories paginate (loader floor is 5). */
  async function fivePerPage(): Promise<void> {
    await fixture.events.configStore.set('ranking.profiles', {
      profiles: [{ ...EVERGREEN_PROFILE, page_size: 5 }],
    });
    await fixture.ranking.reloadConfig();
  }

  function feedRequest(cursor: string | null) {
    return {
      userId: null,
      surface: 'front_page' as const,
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
      cursor,
    };
  }

  it('pages cover the pool exactly once; the chain pins parents and replays', async () => {
    await fivePerPage();
    const ids = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const { storyId } = await seedStory(fixture.ingestion, {
        publishedAt: new Date(Date.now() - i * 3_600_000).toISOString(),
      });
      ids.add(storyId);
    }
    const pages: Awaited<ReturnType<typeof serveFeed>>[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const served = await serveFeed(fixture.ranking, feedRequest(cursor));
      pages.push(served);
      if (served.nextCursor === null) break;
      cursor = served.nextCursor;
    }
    // 12 items at 5 per page ⇒ 3 pages (5 + 5 + 2), then the feed honestly
    // reports exhaustion.
    expect(pages.map((p) => p.items.length)).toEqual([5, 5, 2]);
    expect(pages[0]?.nextCursor).toBe(pages[0]?.requestId);
    expect(pages[2]?.nextCursor).toBeNull();
    const collected = pages.flatMap((p) => p.items.map((i) => i.story_id));
    expect(new Set(collected).size).toBe(12); // complete, no duplicates
    expect(new Set(collected)).toEqual(ids);
    // Audit lineage: each page's decision log links its parent…
    const log2 = await fixture.ranking.decisionLogs.getByRequestId(pages[1]?.requestId as string);
    const log3 = await fixture.ranking.decisionLogs.getByRequestId(pages[2]?.requestId as string);
    expect(log2?.parent_request_id).toBe(pages[0]?.requestId);
    expect(log3?.parent_request_id).toBe(pages[1]?.requestId);
    expect(
      (await fixture.ranking.decisionLogs.getByRequestId(pages[0]?.requestId as string))
        ?.parent_request_id,
    ).toBeNull();
    // …and every page is its OWN exactly-replayable decision.
    const replay = await replayDecision(fixture.ranking, pages[1]?.requestId as string);
    expect(replay.problems).toEqual([]);
    expect(replay.match).toBe(true);
  });

  it('unknown or expired cursors serve the FIRST page, never an error', async () => {
    const { storyId } = await seedStory(fixture.ingestion);
    // A cursor whose chain head was swept (or never existed) resolves to an
    // empty exclusion set — clients recover with a fresh first page.
    const served = await serveFeed(fixture.ranking, feedRequest(randomUUID()));
    expect(served.items.map((i) => i.story_id)).toEqual([storyId]);
    expect(
      (await fixture.ranking.decisionLogs.getByRequestId(served.requestId))?.parent_request_id,
    ).toBeNull();
    // Garbage (non-uuid) cursors through the ROUTE behave the same way.
    const app = new Hono().route('/v1', createV1Routes());
    const response = await app.request('/v1/feed?cursor=not-a-request-id');
    expect(response.status).toBe(200);
    expect(feedResponseSchema.parse(await response.json()).items).toHaveLength(1);
  });

  it('the chronological fallback paginates too (deep scroll under the kill switch)', async () => {
    await fivePerPage();
    const ordered: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const { storyId } = await seedStory(fixture.ingestion, {
        publishedAt: new Date(Date.now() - i * 3_600_000).toISOString(),
      });
      ordered.push(storyId); // newest first by construction
    }
    await engageKillSwitch(
      fixture.events,
      {
        global: true,
        surfaces: [],
        profileIds: [],
        owner: 'oncall',
        triggerCondition: 'pagination drill',
        rollbackPath: 'release',
        reviewDate: new Date().toISOString(),
      },
      new Date().toISOString(),
    );
    const page1 = await serveFeed(fixture.ranking, feedRequest(null));
    expect(page1.fallback).toBe(true);
    expect(page1.items.map((i) => i.story_id)).toEqual(ordered.slice(0, 5));
    expect(page1.nextCursor).toBe(page1.requestId);
    const page2 = await serveFeed(fixture.ranking, feedRequest(page1.nextCursor));
    expect(page2.fallback).toBe(true);
    expect(page2.items.map((i) => i.story_id)).toEqual(ordered.slice(5));
    expect(page2.nextCursor).toBeNull();
  });

  it('a failed decision-log write never advertises a next page (no silent restarts)', async () => {
    // The cursor IS the chain link: when the log insert fails (a counted
    // auditability incident), a cursor pointing at it would resolve to no
    // exclusions and re-serve page one — so the page reports exhaustion
    // instead, and the client simply re-requests later.
    await fivePerPage();
    for (let i = 0; i < 7; i += 1) {
      await seedStory(fixture.ingestion);
    }
    const failing = {
      ...fixture.ranking,
      decisionLogs: {
        ...fixture.ranking.decisionLogs,
        insert: async () => {
          throw new Error('log store outage');
        },
      },
    };
    const served = await serveFeed(failing as typeof fixture.ranking, feedRequest(null));
    expect(served.items).toHaveLength(5); // serving never fails…
    expect(served.nextCursor).toBeNull(); // …but no unresolvable cursor ships
    expect(
      fixture.events.metrics.snapshot().counters['ranking.decision_log.write_failed'],
    ).toBeGreaterThanOrEqual(1);
  });

  it('the room route honors ?cursor= end to end', async () => {
    await fivePerPage();
    const roomId = await insertRoom('public');
    const inRoom = new Set<string>();
    for (let i = 0; i < 7; i += 1) {
      inRoom.add((await seedStory(fixture.ingestion, { roomId })).storyId);
    }
    const app = new Hono().route('/v1', createV1Routes());
    const first = feedResponseSchema.parse(
      await (await app.request(`/v1/rooms/${roomId}/feed`)).json(),
    );
    expect(first.items).toHaveLength(5);
    expect(first.nextCursor).not.toBeNull();
    const second = feedResponseSchema.parse(
      await (await app.request(`/v1/rooms/${roomId}/feed?cursor=${first.nextCursor}`)).json(),
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const union = [...first.items, ...second.items].map((i) => i.story_id);
    expect(new Set(union).size).toBe(7);
    expect(new Set(union)).toEqual(inRoom);
  });
});

describe('serving survives audit-write outages (WS-I.2.5a availability)', () => {
  it('an event-store failure on the §21.3 batch never fails the feed', async () => {
    const { storyId } = await seedStory(fixture.ingestion);
    const originalInsertMany = fixture.events.eventStore.insertMany.bind(fixture.events.eventStore);
    fixture.events.eventStore.insertMany = async () => {
      throw new Error('event store outage');
    };
    try {
      const served = await serveFeed(fixture.ranking, {
        userId: null,
        surface: 'front_page',
        surfaceRoomId: null,
        surfaceTopicId: null,
        mode: undefined,
      });
      // The user still gets the ranked feed; the decision log landed; the
      // missing events are a counted incident.
      expect(served.fallback).toBe(false);
      expect(served.items.map((i) => i.story_id)).toEqual([storyId]);
      expect(await fixture.ranking.decisionLogs.getByRequestId(served.requestId)).not.toBeNull();
      expect(
        fixture.events.metrics.snapshot().counters['ranking.decision_event.write_failed'],
      ).toBeGreaterThanOrEqual(1);
    } finally {
      fixture.events.eventStore.insertMany = originalInsertMany;
    }
  });
});

describe('replay backward-compatibility (pre-baseline_weights decision logs)', () => {
  it('a log whose snapshot predates baseline_weights/lens_by_item still replays exactly', async () => {
    // An EVERGREEN-class pool (median age ≥ 72h): pre-upgrade logs were
    // served with the then-hard-coded baseline weights, which are exactly
    // the evergreen profile's — the breaking profile's timeliness-weighted
    // baseline only EXISTS after the upgrade, so it is not a legacy shape.
    const a = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 100 * 3_600_000).toISOString(),
    });
    await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 200 * 3_600_000).toISOString(),
    });
    await seedInvariantOutput(fixture.events, {
      invariantType: 'PWAtt_v1',
      targetId: a.storyId,
      scoreVector: { active_attention: 0.8, participation: 0.7 },
      shadowMode: false,
    });
    await runFeatureBatch(featureDeps(), 50, 6);
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
    });
    expect(served.fallback).toBe(false);
    const log = await fixture.ranking.decisionLogs.getByRequestId(served.requestId);
    if (log === null || log.replay_inputs === null) throw new Error('no ranked log');
    // Strip the fields a PRE-UPGRADE log could not have carried. The schema
    // defaults must reconstruct the exact arithmetic the decision was served
    // with (evergreen's baseline_weights ARE the historical hard-coded
    // weights; front-page requests carried no lens dimension).
    const { baseline_weights: _weights, ...legacyProfile } = log.replay_inputs.profile_snapshot;
    const { lens_by_item: _lens, ...legacyInputs } = log.replay_inputs;
    const legacyRaw = {
      ...log,
      request_id: randomUUID(),
      replay_inputs: { ...legacyInputs, profile_snapshot: legacyProfile },
    };
    // Parsing the legacy shape through the CURRENT schema applies defaults…
    const legacy = rankingDecisionLogSchema.parse(legacyRaw);
    expect(legacy.replay_inputs?.profile_snapshot.baseline_weights).toEqual({
      freshness: 50,
      reliability: 30,
      relevance: 20,
    });
    expect(legacy.replay_inputs?.lens_by_item).toBeNull();
    // …and the replay still matches byte for byte.
    await fixture.ranking.decisionLogs.insert(legacy);
    const replay = await replayDecision(fixture.ranking, legacy.request_id);
    expect(replay.problems).toEqual([]);
    expect(replay.match).toBe(true);
  });
});

describe('/v1/feed stability under the kill switch (real stories)', () => {
  it('the wire contract holds: schema-valid items in time order', async () => {
    const older = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 7_200_000).toISOString(),
    });
    const newer = await seedStory(fixture.ingestion, {
      publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const app = new Hono().route('/v1', createV1Routes());
    const ranked = feedResponseSchema.parse(await (await app.request('/v1/feed')).json());
    expect(ranked.items).toHaveLength(2);
    await engageKillSwitch(
      fixture.events,
      {
        global: true,
        surfaces: [],
        profileIds: [],
        owner: 'oncall',
        triggerCondition: 'surface-stability drill',
        rollbackPath: 'release via admin',
        reviewDate: new Date().toISOString(),
      },
      new Date().toISOString(),
    );
    const response = await app.request('/v1/feed');
    expect(response.status).toBe(200);
    const body = feedResponseSchema.parse(await response.json());
    // Same real stories, chronological order, the honest paused reason —
    // and the response still validates the FULL §23.3 item schema.
    expect(body.items.map((item) => item.story_id)).toEqual([newer.storyId, older.storyId]);
    for (const item of body.items) {
      expect(item.distribution_reason).toBe(LEGACY_DISTRIBUTION_REASON);
    }
    expect(body.request_id).toBeDefined();
    const log = await fixture.ranking.decisionLogs.getByRequestId(body.request_id as string);
    expect(log?.fallback).toBe(true);
    expect(log?.fallback_reason).toBe('kill_switch');
  });
});

describe('WS-H public story drawers honor the room read bar (WS-Q.3.2)', () => {
  it('interpretations + lenses 404 for non-members of a private room', async () => {
    const roomId = await insertRoom('private');
    const { storyId } = await seedStory(fixture.ingestion, { roomId, visibility: 'room_only' });
    const member = await seedUserWithSession(fixture.identity);
    const outsider = await seedUserWithSession(fixture.identity);
    await subscribe(roomId, member.userId, 'active');
    const app = new Hono().route('/v1', createV1Routes());

    // The story-detail drawers + the SCOI lens read all gate on the SAME item
    // read bar (no existence oracle): 404 to outsiders, 200 to active members.
    for (const drawer of ['interpretations', 'lenses'] as const) {
      const path = `/v1/stories/${storyId}/${drawer}`;
      // Signed out → 404 (no existence oracle).
      expect((await app.request(path)).status).toBe(404);
      // A non-member with a valid session → 404.
      expect((await app.request(path, { headers: { cookie: outsider.cookie } })).status).toBe(404);
      // An active member reads it (200; the body may be empty pre-computation).
      expect((await app.request(path, { headers: { cookie: member.cookie } })).status).toBe(200);
    }
  });

  it('the drawers 404 (fail-closed) when the story’s room cannot be resolved', async () => {
    // A story stamped with a non-existent room id ⇒ storyReadableTo finds no
    // room ⇒ unreadable (the fail-closed branch), so the drawers 404.
    const { storyId } = await seedStory(fixture.ingestion, {
      roomId: randomUUID(),
      visibility: 'room_only',
    });
    const app = new Hono().route('/v1', createV1Routes());
    expect((await app.request(`/v1/stories/${storyId}/interpretations`)).status).toBe(404);
  });
});
