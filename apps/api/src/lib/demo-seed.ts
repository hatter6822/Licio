// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Development demo seed (NEVER runs in production): creates the demo forum
// content through the REAL WS-G/WS-F stores — rooms, lenses, stories with
// their thread shells (the same fixed ids the DEMO_FEED fixtures reference),
// typed contributions across the structured sections, and a community
// synthesis — so the PWA renders real end-to-end data the moment the dev
// server boots, through exactly the production read paths.

import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
} from '@licio/shared';
import type { ForumServices } from '../forum/services.js';
import type { IdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import { DEMO_IDS } from './demo-data.js';

const SEED_USER = {
  userId: '5f5e0000-0000-4000-8000-000000000001',
  handle: 'licio-demo',
  displayName: 'Licio Demo',
} as const;

const C = (n: number): string => `5f5e4000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LENS_LOCAL = '5f5e5000-0000-4000-8000-000000000001';

/** Idempotent: re-running against existing data is a no-op. */
export async function seedForumDemoData(
  forum: ForumServices,
  ingestion: IngestionServices,
  identityStore: IdentityServices['store'],
): Promise<void> {
  if (await forum.rooms.getById(DEMO_IDS.ROOM_1)) return; // already seeded

  // The demo author (a real user row so author handles resolve).
  if (!(await identityStore.getUser(SEED_USER.userId))) {
    await identityStore.createUser({
      userId: SEED_USER.userId,
      handle: SEED_USER.handle,
      displayName: SEED_USER.displayName,
      email: null,
      accountState: 'active',
      locale: 'en',
      ageBand: 'adult',
      privacySettings: defaultPrivacySettings(),
      personalizationSettings: defaultPersonalizationSettings(),
      reputationSummary: emptyReputationSummary(),
      roles: ['user'],
    });
  }

  await forum.rooms.insert({
    roomId: DEMO_IDS.ROOM_1,
    name: 'Public Health',
    slug: 'public-health',
    description: 'Evidence-led discussion of public-health reporting.',
    roomType: 'global_topic',
    visibility: 'public',
    createdBy: SEED_USER.userId,
    governanceMode: 'ordinary',
    charterSummary: 'Platform-wide rules apply. Cite primary sources where possible.',
    typeMetadata: { initial_topics: ['public-health'] },
    latestActivityAt: null,
  });
  await forum.rooms.insert({
    roomId: DEMO_IDS.ROOM_2,
    name: 'Riverside',
    slug: 'riverside',
    description: 'Local news and civic decisions for the Riverside district.',
    roomType: 'local_geographic',
    visibility: 'public',
    createdBy: SEED_USER.userId,
    governanceMode: 'ordinary',
    charterSummary: null,
    typeMetadata: { geographic_scope: 'Riverside district' },
    latestActivityAt: null,
  });
  await forum.lenses.insert({
    lensId: LENS_LOCAL,
    roomId: DEMO_IDS.ROOM_2,
    name: 'Riverside residents',
    lensType: 'local_resident',
    description: 'How the story reads for people living in the district.',
  });

  const stories = [
    {
      storyId: DEMO_IDS.STORY_1,
      threadId: DEMO_IDS.THREAD_1,
      roomId: DEMO_IDS.ROOM_1,
      title: 'Regional water board publishes the full testing dataset',
      body: 'The board released raw and processed results alongside the sampling methodology.',
    },
    {
      storyId: DEMO_IDS.STORY_2,
      threadId: DEMO_IDS.THREAD_2,
      roomId: DEMO_IDS.ROOM_2,
      title: 'Two neighbourhoods read the same zoning proposal very differently',
      body: 'The proposal text is identical, but two rooms summarise its effects differently.',
    },
    {
      storyId: DEMO_IDS.STORY_3,
      threadId: DEMO_IDS.THREAD_3,
      roomId: null,
      title: 'Claim about the new transit timetable is missing a key caveat',
      body: 'The timetable claim omits a service-frequency caveat.',
    },
  ];
  for (const story of stories) {
    const created = await ingestion.stories.createWithThread(
      {
        storyId: story.storyId,
        canonicalUrl: null,
        title: story.title,
        titleHash: `demo-${story.storyId}`,
        submittedBy: SEED_USER.userId,
        sourceId: null,
        language: 'en',
        topicIds: ['5f5e6000-0000-4000-8000-000000000001'],
        locationScope: null,
        sensitivityLabels: [],
        lifecycleState: 'gathering_attention',
        submissionType: 'original_brief',
        submissionMetadata: { submission_type: 'original_brief', body: story.body },
        excerpt: story.body,
        publisher: null,
        author: null,
        publishedAt: null,
        mediaType: null,
        extractionState: 'not_applicable',
        hiddenState: null,
      },
      story.threadId,
    );
    if (created.ok && story.roomId !== null) {
      await ingestion.stories.updateThread(story.threadId, { roomId: story.roomId });
      await forum.rooms.touchActivity(story.roomId, created.thread.createdAt);
    }
  }

  // Typed contributions across the structured sections of thread 1.
  const author = SEED_USER.userId;
  await forum.contributions.insert({
    contributionId: C(1),
    threadId: DEMO_IDS.THREAD_1,
    userId: author,
    type: 'question',
    body: 'Was the sampling window representative of seasonal variation?',
    citations: [],
    metadata: {},
    targetClaimId: null,
    parentContributionId: null,
    clientDraftId: 'demo-1',
    path: [],
    moderationState: 'published',
  });
  await forum.contributions.insert({
    contributionId: C(2),
    threadId: DEMO_IDS.THREAD_1,
    userId: author,
    type: 'answer',
    body: 'The methodology appendix covers May through October — both wet and dry seasons.',
    citations: [{ url: 'https://example.org/methodology' }],
    metadata: {},
    targetClaimId: null,
    parentContributionId: C(1),
    clientDraftId: 'demo-2',
    path: [C(1)],
    moderationState: 'published',
  });
  await forum.contributions.insert({
    contributionId: C(3),
    threadId: DEMO_IDS.THREAD_1,
    userId: author,
    type: 'explanation',
    body: 'Nitrate figures are reported in mg/L; the legal limit is 50 mg/L in this region.',
    citations: [],
    metadata: { assumptions: 'Current regional regulation.' },
    targetClaimId: null,
    parentContributionId: null,
    clientDraftId: 'demo-3',
    path: [],
    moderationState: 'published',
  });
  await forum.contributions.insert({
    contributionId: C(4),
    threadId: DEMO_IDS.THREAD_2,
    userId: author,
    type: 'local_context',
    body: 'The intersection floods every spring, which the proposal map does not show.',
    citations: [],
    metadata: { scope: 'Riverside resident', lens_id: LENS_LOCAL },
    targetClaimId: null,
    parentContributionId: null,
    clientDraftId: 'demo-4',
    path: [],
    moderationState: 'published',
  });

  const summary = await forum.summaries.insert({
    summaryId: '5f5e7000-0000-4000-8000-000000000001',
    threadId: DEMO_IDS.THREAD_1,
    layer: 'community_synthesis',
    body: 'Readers corroborated the official dataset against an independent lab report.',
    citedBranchIds: [C(1)],
    citedEvidenceIds: [],
    unresolvedUncertainty: 'Whether the sampling window was representative.',
    minorityViewsNote: null,
    authoredBy: author,
    approvedBy: null,
  });
  await ingestion.stories.updateThread(DEMO_IDS.THREAD_1, { currentSummaryId: summary.summaryId });
}
