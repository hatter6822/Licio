// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I comment-centric sourcing: with the EvidenceCard entity removed, a
// story's sourcing signal is the SOURCED COMMENTS on its thread — published
// `comment` contributions carrying ≥1 citation. This proves the successor
// behaviors end-to-end: the descriptive "N sourced comments" context chip
// counts exactly the published sourced comments; the §5.4 wE input
// `source_evidence_completeness` saturates as n/(n+3); and the §5.6
// rating-label cascade has NO well-sourced branch — sourced-comment volume
// never changes the label (a deepening story stays "Deepening"; a story under
// safety review reads "Under Review").

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
  it('the "sources" chip counts PUBLISHED sourced comments — and only them', async () => {
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
    // Pluralised on the published sourced count alone.
    expect(byId.get(sourced.storyId)?.context_chips.find((c) => c.id === 'sources')?.label).toBe(
      '3 sourced comments',
    );
    expect(byId.get(single.storyId)?.context_chips.find((c) => c.id === 'sources')?.label).toBe(
      '1 sourced comment',
    );
    // A story with no sourced comments carries no chip at all.
    expect(byId.get(bare.storyId)?.context_chips.some((c) => c.id === 'sources')).toBe(false);
    // The removed evidence-card chip id never reappears.
    for (const item of items) {
      expect(item.context_chips.some((c) => c.id === 'evidence')).toBe(false);
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

  it('the rating label has NO well-sourced branch — sourcing never changes it', async () => {
    // A deepening story stays "Deepening" whether it carries zero or many
    // sourced comments (formerly the ≥2-independent-verified gate would have
    // promoted it to the removed "Well-Sourced" label).
    const quiet = await seedStory(fixture.ingestion, {
      title: 'Deepening, unsourced',
      lifecycleState: 'deepening',
    });
    const rich = await seedStory(fixture.ingestion, {
      title: 'Deepening, richly sourced',
      lifecycleState: 'deepening',
    });
    await seedSourcedComments(rich.threadId, 5);

    // A story under live safety review reads "Under Review" even with the
    // same sourced-comment record — the review posture outranks everything.
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
    expect(byId.get(quiet.storyId)?.rating_label).toBe('deepening');
    expect(byId.get(rich.storyId)?.rating_label).toBe('deepening');
    expect(byId.get(reviewed.storyId)?.rating_label).toBe('under-review');
    // The removed label never reaches the wire.
    for (const item of items) {
      expect(item.rating_label).not.toBe('well-sourced');
    }
  });
});
