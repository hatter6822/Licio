// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Development demo seed (NEVER runs in production): creates the demo forum
// content through the REAL WS-G/WS-F stores — rooms, lenses, stories with
// their thread shells (the same fixed ids the DEMO_FEED fixtures reference),
// typed contributions across the structured sections, and a community
// synthesis — so the PWA renders real end-to-end data the moment the dev
// server boots, through exactly the production read paths.

import {
  type ContributionType,
  DEFAULT_ROOM_NOTIFICATION_PREFERENCES,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
  type LocationScope,
  type SubmissionMetadata,
} from '@licio/shared';
import type { ForumServices } from '../forum/services.js';
import type { IdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import { DEMO_IDS } from './demo-data.js';

export const SEED_USER = {
  userId: '5f5e0000-0000-4000-8000-000000000001',
  handle: 'licio-demo',
  displayName: 'Licio Demo',
} as const;

const C = (n: number): string => `5f5e4000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LENS_LOCAL = '5f5e5000-0000-4000-8000-000000000001';

// Stable id factories per entity family (the existing demo ids are the low
// indices: SEED_USER = U(1), ROOM_1..3 = R(1..3), STORY_1..3 = S(1..3),
// THREAD_1..3 = T(1..3), LENS_LOCAL = LENS(1)). New demo content uses higher
// indices so the originals — which fixtures and tests pin — never move.
const U = (n: number): string => `5f5e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const R = (n: number): string => `5f5e3000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const S = (n: number): string => `5f5e1000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = (n: number): string => `5f5e2000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LENS = (n: number): string => `5f5e5000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUM = (n: number): string => `5f5e7000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUB = (n: number): string => `5f5e8000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOPIC = (n: number): string => `5f5e6000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/** Idempotent: re-running against existing data is a no-op. */
export async function seedForumDemoData(
  forum: ForumServices,
  ingestion: IngestionServices,
  identityStore: IdentityServices['store'],
): Promise<void> {
  if (await forum.rooms.getById(DEMO_IDS.ROOM_1)) return; // already seeded

  // The demo author (a real user row so author handles resolve). Backdated ~90
  // days so it is a normal aged account that clears the submission account-age
  // gate (WS-F prechecks) — the demo/E2E user can submit content immediately.
  if (!(await identityStore.getUser(SEED_USER.userId))) {
    const ninetyDaysAgo = forum.now() - 90 * 24 * 60 * 60 * 1000;
    await identityStore.createUser(
      {
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
      },
      ninetyDaysAgo,
    );
  }

  await forum.rooms.insert({
    roomId: DEMO_IDS.ROOM_1,
    name: 'Public Health',
    slug: 'public-health',
    description: 'Evidence-led discussion of public-health reporting.',
    roomType: 'global_topic',
    visibility: 'public',
    joinModel: 'open',
    postingPolicy: 'all_members',
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
    joinModel: 'open',
    postingPolicy: 'all_members',
    createdBy: SEED_USER.userId,
    governanceMode: 'ordinary',
    charterSummary: null,
    typeMetadata: { geographic_scope: 'Riverside district' },
    latestActivityAt: null,
  });
  // WS-Q.1.6 — a PRIVATE demo room (request-to-join) whose content is forced
  // `room_only`, exercising the read-bar / containment paths end-to-end.
  await forum.rooms.insert({
    roomId: DEMO_IDS.ROOM_3,
    name: 'Transit Working Group',
    slug: 'transit-working-group',
    description: 'A members-only space coordinating local transit analysis.',
    roomType: 'professional_domain',
    visibility: 'private',
    joinModel: 'request_approval',
    postingPolicy: 'all_members',
    createdBy: SEED_USER.userId,
    governanceMode: 'ordinary',
    charterSummary: null,
    typeMetadata: { domain_descriptor: 'Urban transit planning' },
    latestActivityAt: null,
  });
  // The demo author is an ACTIVE member + steward of the private room (so the
  // room_only content is readable through the production read paths).
  await forum.rooms.addSteward({
    roomId: DEMO_IDS.ROOM_3,
    userId: SEED_USER.userId,
    role: 'community_steward',
    assignedAt: new Date(forum.now()).toISOString(),
  });
  await forum.rooms.upsertSubscription({
    roomId: DEMO_IDS.ROOM_3,
    userId: SEED_USER.userId,
    status: 'active',
    requestId: '5f5e8000-0000-4000-8000-000000000001',
    notificationPreferences: { ...DEFAULT_ROOM_NOTIFICATION_PREFERENCES },
    requestedAt: new Date(forum.now()).toISOString(),
    joinedAt: new Date(forum.now()).toISOString(),
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
      visibility: 'public' as const,
      title: 'Regional water board publishes the full testing dataset',
      body: 'The board released raw and processed results alongside the sampling methodology.',
    },
    {
      storyId: DEMO_IDS.STORY_2,
      threadId: DEMO_IDS.THREAD_2,
      roomId: DEMO_IDS.ROOM_2,
      visibility: 'public' as const,
      title: 'Two neighbourhoods read the same zoning proposal very differently',
      body: 'The proposal text is identical, but two rooms summarise its effects differently.',
    },
    {
      // WS-Q.1.6 — STORY_3 lives in the PRIVATE room and is forced room_only.
      storyId: DEMO_IDS.STORY_3,
      threadId: DEMO_IDS.THREAD_3,
      roomId: DEMO_IDS.ROOM_3,
      visibility: 'room_only' as const,
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
        // WS-Q — every demo story has a home room + visibility; the thread's
        // room is stamped from the story inside createWithThread.
        roomId: story.roomId,
        visibility: story.visibility,
        mediaUploadRef: null,
        canonicalPublicStoryId: null,
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
    if (created.ok) {
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

  // -------------------------------------------------------------------------
  // Richer demo corpus (for local development + bug discovery): several more
  // authors, rooms (public/private/expert-gated), stories of varied submission
  // types + visibility tiers, and threads with several nested, multi-author
  // comments. Created through the SAME production stores/read paths as above, so
  // every surface (feeds, room shells, threads, ranking, visibility containment)
  // renders real end-to-end data. Idempotency is the top-of-function guard.
  // -------------------------------------------------------------------------
  const backdated = forum.now() - NINETY_DAYS_MS;
  const nowIso = new Date(forum.now()).toISOString();
  const demo = SEED_USER.userId;
  const [maya, theo, lena, raj, samd, nadia] = [U(2), U(3), U(4), U(5), U(6), U(7)] as const;

  // Additional demo authors (real user rows so handles resolve everywhere).
  const EXTRA_AUTHORS: ReadonlyArray<{
    userId: string;
    handle: string;
    displayName: string;
    steward?: boolean;
  }> = [
    { userId: maya, handle: 'maya-rivers', displayName: 'Maya Okonkwo' },
    { userId: theo, handle: 'theo-desk', displayName: 'Theo Vance' },
    { userId: lena, handle: 'lena-ward', displayName: 'Lena Park' },
    { userId: raj, handle: 'raj-policy', displayName: 'Raj Mehta' },
    { userId: samd, handle: 'sam-data', displayName: 'Sam Ellison' },
    { userId: nadia, handle: 'nadia-steward', displayName: 'Nadia Rahman', steward: true },
  ];
  for (const a of EXTRA_AUTHORS) {
    if (await identityStore.getUser(a.userId)) continue;
    await identityStore.createUser(
      {
        userId: a.userId,
        handle: a.handle,
        displayName: a.displayName,
        email: null,
        accountState: 'active',
        locale: 'en',
        ageBand: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
        reputationSummary: emptyReputationSummary(),
        roles: a.steward ? ['user', 'steward'] : ['user'],
      },
      backdated,
    );
  }

  // More rooms: two public topic rooms, an expert-gated public room (posting
  // restricted to experts/stewards — exercises the can't-post composer state), a
  // public local room, and two MORE private rooms (request-to-join + invite).
  // Coherence rule: a public room's join model is always `open`.
  type RoomSpec = {
    roomId: string;
    name: string;
    slug: string;
    description: string;
    roomType: 'global_topic' | 'local_geographic' | 'professional_domain';
    visibility: 'public' | 'private';
    joinModel: 'open' | 'request_approval' | 'invite';
    postingPolicy: 'all_members' | 'experts_and_stewards';
    charterSummary: string | null;
    typeMetadata: Record<string, unknown>;
  };
  const EXTRA_ROOMS: readonly RoomSpec[] = [
    {
      roomId: R(4),
      name: 'Climate & Energy',
      slug: 'climate-and-energy',
      description: 'Evidence-led discussion of climate policy, grids, and energy data.',
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      charterSummary: 'Cite primary data. Separate measurement from interpretation.',
      typeMetadata: { initial_topics: ['climate', 'energy'] },
    },
    {
      roomId: R(5),
      name: 'Elections & Governance',
      slug: 'elections-and-governance',
      description: 'How elections are run, counted, and governed — process over horse-race.',
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      charterSummary: null,
      typeMetadata: { initial_topics: ['elections', 'governance'] },
    },
    {
      roomId: R(6),
      name: 'Open Science',
      slug: 'open-science',
      description: 'Methods, replication, and data quality. Top-level posts from verified experts.',
      roomType: 'professional_domain',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'experts_and_stewards',
      charterSummary: 'Anyone may read and discuss; top-level submissions are expert-reviewed.',
      typeMetadata: { domain_descriptor: 'Open research methods' },
    },
    {
      roomId: R(7),
      name: 'Harbor District',
      slug: 'harbor-district',
      description: 'Local news and civic decisions for the Harbor District.',
      roomType: 'local_geographic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      charterSummary: null,
      typeMetadata: { geographic_scope: 'Harbor District' },
    },
    {
      roomId: R(8),
      name: 'Newsroom Desk',
      slug: 'newsroom-desk',
      description: 'A members-only desk coordinating investigative reporting.',
      roomType: 'professional_domain',
      visibility: 'private',
      joinModel: 'request_approval',
      postingPolicy: 'all_members',
      charterSummary: 'Private from the public, not from moderation. Not encrypted.',
      typeMetadata: { domain_descriptor: 'Investigative journalism' },
    },
    {
      roomId: R(9),
      name: 'Budget Review',
      slug: 'budget-review',
      description: 'Invite-only working group reviewing the quarterly budget.',
      roomType: 'global_topic',
      visibility: 'private',
      joinModel: 'invite',
      postingPolicy: 'all_members',
      charterSummary: null,
      typeMetadata: { initial_topics: ['budget'] },
    },
  ];
  for (const room of EXTRA_ROOMS) {
    await forum.rooms.insert({
      roomId: room.roomId,
      name: room.name,
      slug: room.slug,
      description: room.description,
      roomType: room.roomType,
      visibility: room.visibility,
      joinModel: room.joinModel,
      postingPolicy: room.postingPolicy,
      createdBy: room.roomId === R(8) ? theo : demo,
      governanceMode: 'ordinary',
      charterSummary: room.charterSummary,
      typeMetadata: room.typeMetadata,
      latestActivityAt: null,
    });
  }

  // The logged-in demo user must be a MEMBER of the private rooms to read their
  // room_only content through the production read bar. Steward of the Newsroom;
  // plain member of Budget Review. Nadia stewards the expert-gated Open Science
  // room so its top-level posts have a legitimate author.
  const joinPrivate = async (
    roomId: string,
    requestId: string,
    steward: boolean,
  ): Promise<void> => {
    if (steward) {
      await forum.rooms.addSteward({
        roomId,
        userId: demo,
        role: 'community_steward',
        assignedAt: nowIso,
      });
    }
    await forum.rooms.upsertSubscription({
      roomId,
      userId: demo,
      status: 'active',
      requestId,
      notificationPreferences: { ...DEFAULT_ROOM_NOTIFICATION_PREFERENCES },
      requestedAt: nowIso,
      joinedAt: nowIso,
    });
  };
  await joinPrivate(R(8), SUB(2), true);
  await joinPrivate(R(9), SUB(3), false);
  await forum.rooms.addSteward({
    roomId: R(6),
    userId: nadia,
    role: 'community_steward',
    assignedAt: nowIso,
  });

  await forum.lenses.insert({
    lensId: LENS(2),
    roomId: R(4),
    name: 'Skeptical read',
    lensType: 'skeptical',
    description: 'How the story reads to someone demanding stronger evidence.',
  });
  await forum.lenses.insert({
    lensId: LENS(3),
    roomId: R(5),
    name: 'Policy lens',
    lensType: 'policy',
    description: 'What the story implies for governance and rule-making.',
  });

  // --- Stories (varied submission types + visibility tiers) -----------------
  const seedStory = async (spec: {
    n: number;
    roomId: string;
    visibility: 'public' | 'room_only';
    author: string;
    title: string;
    submissionType: SubmissionMetadata['submission_type'];
    submissionMetadata: SubmissionMetadata;
    excerpt: string;
    topicIds: string[];
    canonicalUrl?: string;
    locationScope?: LocationScope;
  }): Promise<void> => {
    const created = await ingestion.stories.createWithThread(
      {
        storyId: S(spec.n),
        canonicalUrl: spec.canonicalUrl ?? null,
        title: spec.title,
        titleHash: `demo-${S(spec.n)}`,
        submittedBy: spec.author,
        sourceId: null,
        roomId: spec.roomId,
        visibility: spec.visibility,
        mediaUploadRef: null,
        canonicalPublicStoryId: null,
        language: 'en',
        topicIds: spec.topicIds,
        locationScope: spec.locationScope ?? null,
        sensitivityLabels: [],
        lifecycleState: 'gathering_attention',
        submissionType: spec.submissionType,
        submissionMetadata: spec.submissionMetadata,
        excerpt: spec.excerpt,
        publisher: null,
        author: null,
        publishedAt: null,
        mediaType: null,
        extractionState: 'not_applicable',
        hiddenState: null,
      },
      T(spec.n),
    );
    if (created.ok) await forum.rooms.touchActivity(spec.roomId, created.thread.createdAt);
  };

  const topics = {
    water: TOPIC(2),
    climate: TOPIC(3),
    elections: TOPIC(4),
    science: TOPIC(5),
    local: TOPIC(6),
  };
  const link = (url: string, reason: string): SubmissionMetadata => ({
    submission_type: 'link',
    url,
    reason,
  });
  const brief = (body: string): SubmissionMetadata => ({ submission_type: 'original_brief', body });
  const question = (q: string, context: string): SubmissionMetadata => ({
    submission_type: 'question',
    question: q,
    context,
  });
  const localUpdate = (location_scope: LocationScope, disclosure: string): SubmissionMetadata => ({
    submission_type: 'local_update',
    location_scope,
    source_or_experience_disclosure: disclosure,
  });

  await seedStory({
    n: 4,
    roomId: DEMO_IDS.ROOM_1,
    visibility: 'public',
    author: theo,
    title: 'Hospital readmission data released for the first quarter',
    submissionType: 'link',
    submissionMetadata: link(
      'https://example.org/health/readmissions-q1',
      'The full dataset, with the methodology appendix.',
    ),
    canonicalUrl: 'https://example.org/health/readmissions-q1',
    excerpt: 'Quarterly readmission rates by facility, with the sampling methodology attached.',
    topicIds: [topics.water],
  });
  await seedStory({
    n: 5,
    roomId: DEMO_IDS.ROOM_1,
    visibility: 'public',
    author: maya,
    title: 'What the new air-quality sensors actually measure',
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'The network reports PM2.5 and NO2 hourly. It does NOT measure ozone — a common misreading.',
    ),
    excerpt: 'A short explainer separating what the sensors measure from what they do not.',
    topicIds: [topics.science],
  });
  await seedStory({
    n: 6,
    roomId: DEMO_IDS.ROOM_1,
    visibility: 'room_only',
    author: demo,
    title: 'Members: how should we read the lead-testing footnotes?',
    submissionType: 'question',
    submissionMetadata: question(
      'The footnotes change the denominator. How should the room interpret the headline figure?',
      'Asking members before this goes to a wider audience.',
    ),
    excerpt: 'An in-room question (room_only in a public room — carries the in-room chip).',
    topicIds: [topics.water],
  });
  await seedStory({
    n: 7,
    roomId: DEMO_IDS.ROOM_2,
    visibility: 'public',
    author: lena,
    title: 'Riverside bridge closure extended through spring',
    submissionType: 'local_update',
    submissionMetadata: localUpdate(
      { type: 'city', value: 'Riverside' },
      'First-hand: I attended the public works briefing on Tuesday.',
    ),
    locationScope: { type: 'city', value: 'Riverside' },
    excerpt: 'The detour adds roughly ten minutes; transit reroutes start Monday.',
    topicIds: [topics.local],
  });
  await seedStory({
    n: 8,
    roomId: DEMO_IDS.ROOM_2,
    visibility: 'public',
    author: raj,
    title: 'City posts the full zoning amendment text',
    submissionType: 'link',
    submissionMetadata: link(
      'https://example.org/riverside/zoning-amendment',
      'The complete amendment, not the press summary.',
    ),
    canonicalUrl: 'https://example.org/riverside/zoning-amendment',
    excerpt: 'The amendment rezones two parcels near the river; comment period closes in 30 days.',
    topicIds: [topics.local],
  });
  await seedStory({
    n: 9,
    roomId: R(4),
    visibility: 'public',
    author: samd,
    title: 'Grid demand peaked twice this week — here is the data',
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'Two evening peaks, both below last summer. The full series is linked in the thread.',
    ),
    excerpt: 'A data brief on this week’s grid demand, with caveats on weather normalization.',
    topicIds: [topics.climate],
  });
  await seedStory({
    n: 10,
    roomId: R(4),
    visibility: 'public',
    author: theo,
    title: 'Is the new tariff actually lowering emissions?',
    submissionType: 'question',
    submissionMetadata: question(
      'Early numbers look mixed. What evidence would settle whether the tariff is working?',
      'Looking for measurable, falsifiable indicators.',
    ),
    excerpt: 'An open question inviting evidence on the tariff’s emissions effect.',
    topicIds: [topics.climate],
  });
  await seedStory({
    n: 11,
    roomId: R(5),
    visibility: 'public',
    author: raj,
    title: 'Elections board publishes precinct-level turnout',
    submissionType: 'link',
    submissionMetadata: link(
      'https://example.org/elections/precinct-turnout',
      'Machine-readable precinct turnout, with a data dictionary.',
    ),
    canonicalUrl: 'https://example.org/elections/precinct-turnout',
    excerpt: 'Turnout by precinct in a downloadable format, plus the field definitions.',
    topicIds: [topics.elections],
  });
  await seedStory({
    n: 12,
    roomId: R(5),
    visibility: 'public',
    author: nadia,
    title: 'How ranked-choice tabulation works, step by step',
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'A worked example through three rounds, showing exactly when a candidate is eliminated.',
    ),
    excerpt: 'A neutral, worked explainer of ranked-choice counting.',
    topicIds: [topics.elections],
  });
  await seedStory({
    n: 13,
    roomId: R(6),
    visibility: 'public',
    author: nadia,
    title: 'Replication study confirms the soil-carbon estimate',
    submissionType: 'link',
    submissionMetadata: link(
      'https://example.org/science/soil-carbon-replication',
      'Independent replication, pre-registered, with open data.',
    ),
    canonicalUrl: 'https://example.org/science/soil-carbon-replication',
    excerpt: 'An expert-room post: the replication lands within the original confidence interval.',
    topicIds: [topics.science],
  });
  await seedStory({
    n: 14,
    roomId: R(7),
    visibility: 'public',
    author: lena,
    title: 'Harbor cleanup schedule for the quarter',
    submissionType: 'local_update',
    submissionMetadata: localUpdate(
      { type: 'city', value: 'Harbor District' },
      'Source: the district sanitation office calendar.',
    ),
    locationScope: { type: 'city', value: 'Harbor District' },
    excerpt: 'Which piers are cleaned when, and how to report a missed collection.',
    topicIds: [topics.local],
  });
  await seedStory({
    n: 15,
    roomId: R(8),
    visibility: 'room_only',
    author: theo,
    title: 'Draft: timeline for the water-board investigation',
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'A working timeline of records requests and responses. Members only while we verify.',
    ),
    excerpt: 'An in-progress investigation timeline, contained to the Newsroom Desk.',
    topicIds: [topics.water],
  });
  await seedStory({
    n: 16,
    roomId: R(8),
    visibility: 'room_only',
    author: nadia,
    title: 'Which records requests are still outstanding?',
    submissionType: 'question',
    submissionMetadata: question(
      'Tracking what we have asked for and what is overdue.',
      'Members-only coordination question.',
    ),
    excerpt: 'A coordination question inside the private Newsroom Desk.',
    topicIds: [topics.water],
  });
  await seedStory({
    n: 17,
    roomId: R(9),
    visibility: 'room_only',
    author: raj,
    title: 'Internal: the line-item budget workbook',
    submissionType: 'link',
    submissionMetadata: link(
      'https://example.org/budget/q2-workbook',
      'The full workbook for the members reviewing it.',
    ),
    canonicalUrl: 'https://example.org/budget/q2-workbook',
    excerpt: 'An invite-only resource for the Budget Review group.',
    topicIds: [topics.elections],
  });
  await seedStory({
    n: 18,
    roomId: R(9),
    visibility: 'room_only',
    author: demo,
    title: 'Members: summary of the Q2 variance',
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'Where actuals diverged from plan, and the two line items driving most of it.',
    ),
    excerpt: 'A members-only variance summary in the Budget Review group.',
    topicIds: [topics.elections],
  });

  // --- Threads with several nested, multi-author comments --------------------
  const at = <X>(arr: readonly X[], i: number): X => {
    const v = arr[i];
    if (v === undefined) throw new Error(`demo-seed: missing index ${i}`);
    return v;
  };
  type Cite = { url: string; title?: string };
  type CSpec = {
    type: ContributionType;
    author: string;
    body: string;
    parent?: number;
    citations?: Cite[];
    metadata?: Record<string, unknown>;
    /** Indices (within this thread's specs) of branches a synthesis includes. */
    includeIdx?: number[];
  };
  /** Insert a thread's contributions, computing ids + materialized paths. */
  const tree = async (threadId: string, startN: number, specs: readonly CSpec[]): Promise<void> => {
    const ids = specs.map((_, i) => C(startN + i));
    const paths: string[][] = [];
    for (let i = 0; i < specs.length; i += 1) {
      const p = at(specs, i).parent;
      paths[i] = p !== undefined ? [...at(paths, p), at(ids, p)] : [];
    }
    for (let i = 0; i < specs.length; i += 1) {
      const s = at(specs, i);
      const parentId = s.parent !== undefined ? at(ids, s.parent) : null;
      const metadata: Record<string, unknown> = { ...(s.metadata ?? {}) };
      if (s.includeIdx) metadata['included_branch_ids'] = s.includeIdx.map((j) => at(ids, j));
      await forum.contributions.insert({
        contributionId: at(ids, i),
        threadId,
        userId: s.author,
        type: s.type,
        body: s.body,
        citations: s.citations ?? [],
        metadata,
        targetClaimId: null,
        parentContributionId: parentId,
        clientDraftId: `seed-${at(ids, i)}`,
        path: at(paths, i),
        moderationState: 'published',
      });
    }
  };

  // Hospital-readmission link (public): a question answered with a cited answer,
  // an evidence card, a clarifying sub-question, and a meta note.
  await tree(T(4), 100, [
    {
      type: 'question',
      author: maya,
      body: 'Are readmissions risk-adjusted, or are these raw counts per facility?',
    },
    {
      type: 'answer',
      author: theo,
      parent: 0,
      body: 'Risk-adjusted — the appendix describes the model and the covariates used.',
      citations: [
        {
          url: 'https://example.org/health/readmissions-q1#appendix',
          title: 'Methodology appendix',
        },
      ],
    },
    {
      type: 'evidence',
      author: samd,
      parent: 1,
      body: 'The adjustment model matches the national specification (linked).',
      citations: [
        { url: 'https://example.org/standards/readmission-model', title: 'National model spec' },
      ],
      metadata: { evidence_type: 'report' },
    },
    {
      type: 'question',
      author: lena,
      parent: 1,
      body: 'Does the adjustment account for seasonal admission surges?',
    },
    {
      type: 'explanation',
      author: maya,
      parent: 3,
      body: 'Partly: it includes a winter indicator but not a facility-level surge term.',
      metadata: { assumptions: 'Reading the appendix at face value.' },
    },
    {
      type: 'meta_discussion',
      author: nadia,
      body: 'Keeping this thread to measurement; policy debate belongs in a separate branch.',
    },
  ]);

  // Bridge closure (public local): direct experience + local context + a counterexample.
  await tree(T(7), 120, [
    {
      type: 'direct_experience',
      author: lena,
      body: 'I drove the detour this morning; the added time was closer to fifteen minutes at peak.',
      metadata: { privacy_acknowledged: true, scope: 'Riverside resident', location: 'Riverside' },
    },
    {
      type: 'local_context',
      author: raj,
      parent: 0,
      body: 'The detour overlaps the school-run corridor, which the briefing did not mention.',
      metadata: { scope: 'Riverside resident', location: 'Riverside' },
    },
    {
      type: 'counterexample',
      author: theo,
      parent: 0,
      body: 'The northbound detour was clear at 9am — congestion may be direction-specific.',
      metadata: { relevance_explanation: 'Shows the delay is not uniform across directions.' },
    },
    {
      type: 'answer',
      author: lena,
      parent: 2,
      body: 'Agreed — southbound is the slow leg; northbound is fine outside the school window.',
    },
  ]);

  // Grid-demand brief (public climate): evidence, a correction with citations, a synthesis.
  await tree(T(9), 140, [
    {
      type: 'question',
      author: theo,
      body: 'Is this normalized for the warm spell, or are these absolute peaks?',
    },
    {
      type: 'answer',
      author: samd,
      parent: 0,
      body: 'Absolute. Weather-normalized, the second peak is roughly flat year-on-year.',
      citations: [{ url: 'https://example.org/grid/normalized-series' }],
    },
    {
      type: 'correction',
      author: maya,
      parent: 1,
      body: 'The first peak was Tuesday, not Monday — the labels in the chart are off by a day.',
      citations: [{ url: 'https://example.org/grid/raw-readings', title: 'Raw interval readings' }],
      metadata: { target_text_excerpt: 'Monday evening peak' },
    },
    {
      type: 'evidence',
      author: raj,
      parent: 1,
      body: 'Independent ISO data agrees with the normalized read.',
      citations: [{ url: 'https://example.org/iso/demand' }],
      metadata: { evidence_type: 'dataset' },
    },
    {
      type: 'synthesis',
      author: nadia,
      body: 'Net: two absolute peaks, flat once normalized, with a one-day labeling fix.',
      includeIdx: [1, 3],
      metadata: { uncertainty_note: 'Normalization method is sensitive to the chosen baseline.' },
    },
  ]);

  // Tariff question (public climate): a couple of cited answers.
  await tree(T(10), 160, [
    {
      type: 'answer',
      author: samd,
      body: 'Emissions intensity is the cleaner indicator than total emissions here.',
      citations: [{ url: 'https://example.org/climate/intensity-vs-total' }],
    },
    {
      type: 'counterexample',
      author: theo,
      parent: 0,
      body: 'A neighboring market saw intensity fall WITHOUT a tariff — confounding the read.',
      metadata: { relevance_explanation: 'Suggests other factors may drive the change.' },
    },
  ]);

  // Elections turnout (public): a question + answer + evidence.
  await tree(T(11), 180, [
    {
      type: 'question',
      author: lena,
      body: 'Is turnout reported as a share of registered voters or of eligible population?',
    },
    {
      type: 'answer',
      author: raj,
      parent: 0,
      body: 'Registered voters — the data dictionary defines the denominator explicitly.',
      citations: [{ url: 'https://example.org/elections/precinct-turnout#dictionary' }],
    },
    {
      type: 'evidence',
      author: samd,
      parent: 1,
      body: 'Cross-checked three precincts against the certified totals; they match.',
      citations: [{ url: 'https://example.org/elections/certified-totals' }],
      metadata: { evidence_type: 'primary_source' },
    },
  ]);

  // Newsroom Desk (PRIVATE, room_only): a coordination thread the demo member can read.
  await tree(T(15), 200, [
    {
      type: 'question',
      author: nadia,
      body: 'Do we have the second FOIA response in hand, or only the acknowledgment?',
    },
    {
      type: 'answer',
      author: theo,
      parent: 0,
      body: 'Only the acknowledgment so far; the response is due next week.',
    },
    {
      type: 'local_context',
      author: demo,
      parent: 1,
      body: 'The clerk’s office is short-staffed this month, which may slow the response.',
      metadata: { scope: 'Newsroom coordination' },
    },
  ]);

  // Lighter threads on the remaining new stories so every story has discussion.
  await tree(T(5), 220, [
    {
      type: 'question',
      author: theo,
      body: 'Do the sensors report ozone at all, or is that a separate network?',
    },
    {
      type: 'answer',
      author: maya,
      parent: 0,
      body: 'Separate network entirely — these units have no ozone channel.',
    },
  ]);
  await tree(T(8), 230, [
    {
      type: 'evidence',
      author: lena,
      body: 'The two rezoned parcels border the floodplain (map linked).',
      citations: [{ url: 'https://example.org/riverside/floodplain-map' }],
      metadata: { evidence_type: 'primary_source' },
    },
  ]);
  await tree(T(12), 240, [
    {
      type: 'question',
      author: lena,
      body: 'What happens to a ballot whose later choices are all eliminated?',
    },
    {
      type: 'answer',
      author: nadia,
      parent: 0,
      body: 'It becomes "exhausted" and is set aside in subsequent rounds.',
    },
  ]);
  await tree(T(13), 250, [
    {
      type: 'evidence',
      author: samd,
      body: 'Pre-registration and analysis plan are both posted.',
      citations: [{ url: 'https://example.org/science/soil-carbon-replication#prereg' }],
      metadata: { evidence_type: 'expert_reference' },
    },
  ]);
  await tree(T(16), 260, [
    {
      type: 'answer',
      author: theo,
      body: 'Two requests are overdue; I will escalate both this week.',
    },
  ]);

  // A couple of community syntheses on the richer new threads.
  const briefSummary = await forum.summaries.insert({
    summaryId: SUM(2),
    threadId: T(9),
    layer: 'community_synthesis',
    body: 'Two absolute demand peaks this week; flat once weather-normalized. A one-day chart-labeling error was corrected.',
    citedBranchIds: [C(141), C(143)],
    citedEvidenceIds: [],
    unresolvedUncertainty: 'How sensitive the normalization is to the baseline period.',
    minorityViewsNote: null,
    authoredBy: nadia,
    approvedBy: null,
  });
  await ingestion.stories.updateThread(T(9), { currentSummaryId: briefSummary.summaryId });

  const turnoutSummary = await forum.summaries.insert({
    summaryId: SUM(3),
    threadId: T(11),
    layer: 'community_synthesis',
    body: 'Turnout is reported as a share of registered voters; a spot-check against certified totals matched.',
    citedBranchIds: [C(181)],
    citedEvidenceIds: [],
    unresolvedUncertainty: null,
    minorityViewsNote: null,
    authoredBy: raj,
    approvedBy: null,
  });
  await ingestion.stories.updateThread(T(11), { currentSummaryId: turnoutSummary.summaryId });
}
