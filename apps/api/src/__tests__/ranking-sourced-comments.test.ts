// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I comment-centric sourcing: with the EvidenceCard entity removed, a
// story's sourcing signal is the SOURCED COMMENTS on its thread — published
// `comment` contributions carrying ≥1 citation. This proves the successor
// behaviors end-to-end: the §5.6 card signal `sources_count` counts exactly
// the published sourced comments; the §5.4 wE input
// `source_evidence_completeness` saturates as n/(n+3); and sourced-comment
// volume never changes the safety posture (a story under safety review reads
// `under-review` whatever its sourcing record).

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { assembleFeatureVector, runFeatureBatch } from '../ranking/features.js';
import { serveFeed } from '../ranking/service.js';
import { freshRankingServices, type RankingFixture, seedStory } from './ranking-helpers.js';

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

/** Insert one contribution directly (bypassing the POST guard chain so a
 *  non-`published` state can be staged too). */
async function insertContribution(
  threadId: string,
  opts: {
    type?: 'comment' | 'correction';
    cited?: boolean;
    state?: 'published' | 'under_review';
  } = {},
): Promise<void> {
  const id = randomUUID();
  await fixture.forum.contributions.insert({
    contributionId: id,
    threadId,
    userId: randomUUID(),
    type: opts.type ?? 'comment',
    body: 'The primary dataset backing this story is public.',
    citations: opts.cited === false ? [] : [{ url: `https://example.org/${id}` }],
    metadata: {},
    targetClaimId: null,
    parentContributionId: null,
    clientDraftId: `seed-${id}`,
    path: [],
    moderationState: opts.state ?? 'published',
  });
}

/** Attach N published sourced comments (the §5.6 "sourced" predicate rows). */
async function seedSourcedComments(threadId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await insertContribution(threadId);
  }
}

/** Page the front page to exhaustion (anonymous reader). */
async function fullFrontPage() {
  const items: Awaited<ReturnType<typeof serveFeed>>['items'] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const served = await serveFeed(fixture.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: undefined,
      cursor,
    });
    items.push(...served.items);
    if (served.nextCursor === null) break;
    cursor = served.nextCursor;
  }
  return items;
}

describe('WS-I — comment-centric sourcing (the EvidenceCard successor)', () => {
  it('sources_count counts PUBLISHED sourced comments — and only them', async () => {
    const sourced = await seedStory(fixture.ingestion, { title: 'Three sourced comments' });
    const single = await seedStory(fixture.ingestion, { title: 'One sourced comment' });
    const bare = await seedStory(fixture.ingestion, { title: 'No sourced comments' });

    await seedSourcedComments(sourced.threadId, 3);
    // None of these satisfy the sourced predicate (`comment` + ≥1 citation,
    // published): an under-review sourced comment, a citation-less comment,
    // and a cited CORRECTION (a challenge, not a sourced comment).
    await insertContribution(sourced.threadId, { state: 'under_review' });
    await insertContribution(sourced.threadId, { cited: false });
    await insertContribution(sourced.threadId, { type: 'correction' });

    await seedSourcedComments(single.threadId, 1);
    await runFeatureBatch(featureDeps(), 50, 6);

    const items = await fullFrontPage();
    const byId = new Map(items.map((i) => [i.story_id, i]));
    // The card signal counts the published sourced comments alone.
    expect(byId.get(sourced.storyId)?.sources_count).toBe(3);
    expect(byId.get(single.storyId)?.sources_count).toBe(1);
    expect(byId.get(bare.storyId)?.sources_count).toBe(0);
    // Neither the removed evidence-card chip nor the superseded wordy
    // sources chip reappears (sources ride the first-class field now).
    for (const item of items) {
      expect(item.context_chips.some((c) => c.id === 'evidence')).toBe(false);
      expect(item.context_chips.some((c) => c.id === 'sources')).toBe(false);
    }
  });

  it('source_evidence_completeness saturates as sourced/(sourced+3)', async () => {
    const none = await seedStory(fixture.ingestion, { title: 'Zero sourced' });
    const three = await seedStory(fixture.ingestion, { title: 'Three sourced' });
    const nine = await seedStory(fixture.ingestion, { title: 'Nine sourced' });
    await seedSourcedComments(three.threadId, 3);
    await seedSourcedComments(nine.threadId, 9);

    const vNone = await assembleFeatureVector(featureDeps(), none.storyId);
    const vThree = await assembleFeatureVector(featureDeps(), three.storyId);
    const vNine = await assembleFeatureVector(featureDeps(), nine.storyId);
    expect(vNone?.source_evidence_completeness).toBe(0);
    expect(vThree?.source_evidence_completeness).toBe(0.5); // 3 / (3 + 3)
    expect(vNine?.source_evidence_completeness).toBe(0.75); // 9 / (9 + 3)
  });

  it('sourcing volume never changes the safety posture', async () => {
    // Sourcing is a descriptive count, not a quality verdict: a richly sourced
    // story and an unsourced one both read `ok`, and a story under live safety
    // review reads `under-review` even with a rich sourced-comment record —
    // the review posture is independent of sourcing by construction.
    const quiet = await seedStory(fixture.ingestion, {
      title: 'Deepening, unsourced',
      lifecycleState: 'deepening',
    });
    const rich = await seedStory(fixture.ingestion, {
      title: 'Deepening, richly sourced',
      lifecycleState: 'deepening',
    });
    await seedSourcedComments(rich.threadId, 5);

    const reviewed = await seedStory(fixture.ingestion, {
      title: 'Under review, sourced',
      lifecycleState: 'deepening',
    });
    await seedSourcedComments(reviewed.threadId, 5);
    await fixture.invariants.mfciRiskStates.set({
      targetId: reviewed.storyId,
      state: 'high',
      score: 6,
      reason: 'score',
      updatedAt: new Date().toISOString(),
    });

    await runFeatureBatch(featureDeps(), 50, 6);
    const items = await fullFrontPage();
    const byId = new Map(items.map((i) => [i.story_id, i]));
    expect(byId.get(quiet.storyId)?.safety_state).toBe('ok');
    expect(byId.get(rich.storyId)?.safety_state).toBe('ok');
    expect(byId.get(rich.storyId)?.sources_count).toBe(5);
    expect(byId.get(reviewed.storyId)?.safety_state).toBe('under-review');
    expect(byId.get(reviewed.storyId)?.sources_count).toBe(5);
  });
});
