// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I §5.6 "Well-Sourced" gating is INDEPENDENCE-AWARE: the feed promotes a
// story to "Well-Sourced" only on ≥2 DISTINCT, VERIFIED, independent evidence
// units — never on repeated (same MERI independence group) or unverified cards.
// The descriptive "N evidence cards" chip keeps the RAW total, so a reader sees
// "2 evidence cards" without the story being mislabelled well-sourced. This is
// the regression guard for the PR-review finding that the gate double-counted
// non-independent / unverified evidence.

import { randomUUID } from 'node:crypto';
import type { VerificationState } from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import { runFeatureBatch } from '../ranking/features.js';
import { serveFeed } from '../ranking/service.js';
import {
  freshRankingServices,
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
    featureStore: fixture.ranking.featureStore,
    log: fixture.ranking.log,
    now: fixture.ranking.now,
  };
}

/** Attach one claim + N evidence cards (each with its verification/independence). */
async function seedEvidence(
  storyId: string,
  cards: ReadonlyArray<{ verification: VerificationState; group: string | null }>,
): Promise<void> {
  const claim = await fixture.ingestion.claims.insert({
    claimId: randomUUID(),
    storyId,
    canonicalText: 'A factual claim under discussion.',
    normalizedTextHash: `h-${randomUUID()}`,
    claimStatus: 'candidate',
    firstSeenStoryId: storyId,
    independenceGroupId: null,
    createdBy: null,
    extractionSource: 'steward',
    extractionConfidence: null,
    modelVersion: null,
  });
  for (const card of cards) {
    await fixture.ingestion.evidence.insert({
      evidenceId: randomUUID(),
      claimId: claim.claimId,
      sourceId: null,
      contributionId: null,
      submittedBy: null,
      evidenceType: 'primary_source',
      relationshipType: 'supports',
      citationUrlOrRef: `https://example.org/${randomUUID()}`,
      relevanceNote: 'Supporting material.',
      verificationState: card.verification,
      independenceGroupId: card.group,
      storyId,
    });
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

describe('WS-I — §5.6 well-sourced gating is independence-aware', () => {
  it('promotes only the genuinely independent, verified story to "Well-Sourced"', async () => {
    // All three stories share the SAME MERI exposure (independent_source ≥ 1),
    // so the differentiator is PURELY the thread-level evidence independence.
    const independent = await seedStory(fixture.ingestion, { title: 'Independent verified' });
    const unverified = await seedStory(fixture.ingestion, { title: 'Two unverified cards' });
    const redundant = await seedStory(fixture.ingestion, { title: 'Two cards, one group' });

    // 2 distinct verified independent units → well-sourced.
    await seedEvidence(independent.storyId, [
      { verification: 'verified', group: 'grp-a' },
      { verification: 'verified', group: 'grp-b' },
    ]);
    // 2 cards, but UNVERIFIED → 0 independent verified units → NOT well-sourced.
    await seedEvidence(unverified.storyId, [
      { verification: 'unverified', group: 'grp-c' },
      { verification: 'unverified', group: 'grp-d' },
    ]);
    // 2 VERIFIED cards sharing ONE independence group → 1 unit → NOT well-sourced.
    await seedEvidence(redundant.storyId, [
      { verification: 'verified', group: 'grp-shared' },
      { verification: 'verified', group: 'grp-shared' },
    ]);

    // One feed-level MERI output makes ALL THREE independent_source on exposure.
    await seedInvariantOutput(fixture.events, {
      invariantType: 'MERI',
      targetId: GLOBAL_FEED_TARGET_ID,
      scoreVector: {
        marginal_gains: {
          [independent.storyId]: 1,
          [unverified.storyId]: 1,
          [redundant.storyId]: 1,
        },
      },
    });
    await runFeatureBatch(featureDeps(), 50, 6);

    const items = await fullFrontPage();
    const byId = new Map(items.map((i) => [i.story_id, i]));
    const a = byId.get(independent.storyId);
    const b = byId.get(unverified.storyId);
    const c = byId.get(redundant.storyId);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();

    // Only the genuinely independent + verified story earns the label. MERI
    // source-independence is a SEPARATE gate feeding this label — and it still
    // works even though the MERI exposure label is no longer a user-facing field.
    expect(a?.rating_label).toBe('well-sourced');
    expect(b?.rating_label).not.toBe('well-sourced');
    expect(c?.rating_label).not.toBe('well-sourced');

    // The MERI exposure label was removed as a user-facing surface — the feed
    // item carries no such field anymore.
    expect(a).not.toHaveProperty('exposure_label');
  });

  it('keeps the descriptive "N evidence cards" chip on the RAW total', async () => {
    // A story with two unverified cards is not well-sourced, yet the reader must
    // still see that two cards exist — the chip counts raw, the label counts
    // independent-verified.
    const story = await seedStory(fixture.ingestion, { title: 'Raw chip vs label' });
    await seedEvidence(story.storyId, [
      { verification: 'unverified', group: null },
      { verification: 'unverified', group: null },
    ]);
    await runFeatureBatch(featureDeps(), 50, 6);

    const item = (await fullFrontPage()).find((i) => i.story_id === story.storyId);
    expect(item?.rating_label).not.toBe('well-sourced');
    const chip = item?.context_chips.find((ch) => ch.id === 'evidence');
    expect(chip?.label).toBe('2 evidence cards');
  });

  it('counts an un-grouped (null) verified card as its own independent unit', async () => {
    // Two verified cards, both with a null independence group, are two distinct
    // un-clustered units → well-sourced (null is "not known redundant", so each
    // counts once).
    const story = await seedStory(fixture.ingestion, { title: 'Two null-group verified' });
    await seedEvidence(story.storyId, [
      { verification: 'verified', group: null },
      { verification: 'verified', group: null },
    ]);
    await seedInvariantOutput(fixture.events, {
      invariantType: 'MERI',
      targetId: GLOBAL_FEED_TARGET_ID,
      scoreVector: { marginal_gains: { [story.storyId]: 1 } },
    });
    await runFeatureBatch(featureDeps(), 50, 6);

    const item = (await fullFrontPage()).find((i) => i.story_id === story.storyId);
    expect(item?.rating_label).toBe('well-sourced');
  });
});
