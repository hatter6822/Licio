// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.2 distribution-side enforcement: a blocked/muted author's stories are
// hidden FROM THE VIEWER in the ranking feed (the per-viewer complement to the
// global safety filter), wired through the forum relationship-reader seam.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBlock, createMute, createRelationshipReader } from '../moderation/relations.js';
import {
  createInMemoryModerationServices,
  type ModerationServices,
} from '../moderation/services.js';
import { serveFeed } from '../ranking/service.js';
import { freshRankingServices, type RankingFixture, seedStory } from './ranking-helpers.js';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';

let fixture: RankingFixture;
let mod: ModerationServices;

beforeEach(() => {
  fixture = freshRankingServices();
  mod = createInMemoryModerationServices();
  fixture.ranking.forum.relationshipReader = createRelationshipReader(mod);
});
afterEach(async () => {
  await fixture.ranking.flushBackground();
});

const frontPage = (userId: string | null) =>
  serveFeed(fixture.ranking, {
    userId,
    surface: 'front_page',
    surfaceRoomId: null,
    surfaceTopicId: null,
    mode: undefined,
  });

describe('WS-J.1.2 feed viewing filter', () => {
  it('excludes a blocked author story from the viewer, but not for others', async () => {
    const mine = await seedStory(fixture.ingestion, { submittedBy: A });
    const theirs = await seedStory(fixture.ingestion, { submittedBy: B });
    await createBlock(mod, A, B);

    const served = await frontPage(A);
    const ids = served.items.map((i) => i.story_id);
    expect(ids).toContain(mine.storyId);
    expect(ids).not.toContain(theirs.storyId);

    // A signed-out viewer sees both (the filter is per-viewer).
    const anon = (await frontPage(null)).items.map((i) => i.story_id);
    expect(anon).toContain(mine.storyId);
    expect(anon).toContain(theirs.storyId);
  });

  it('a mute hides the muted author story from the muter only', async () => {
    const theirs = await seedStory(fixture.ingestion, { submittedBy: B });
    await createMute(mod, A, B, undefined);
    expect((await frontPage(A)).items.map((i) => i.story_id)).not.toContain(theirs.storyId);
    expect((await frontPage(B)).items.map((i) => i.story_id)).toContain(theirs.storyId);
  });
});
