// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Development demo seed (NEVER runs in production): creates the demo forum
// content through the REAL WS-G/WS-F stores — rooms, lenses, stories with
// their thread shells (the same fixed ids the DEMO_FEED fixtures reference),
// and threaded multi-author comments (with cited corrections) — so the PWA
// renders real end-to-end data the moment the dev server boots, through
// exactly the production read paths.

import { randomUUID } from 'node:crypto';
import {
  lshBandHashes,
  MINHASH_FAMILY_VERSION,
  MINHASH_NUM_HASHES,
  MINHASH_SHINGLE_K,
  minhashSignature,
} from '@licio/invariants';
import {
  attentionAggregateEventSchema,
  type ContributionMetadata,
  type ContributionType,
  DEBATE_EDIT_WINDOW_MS,
  DEBATE_LIVE_WINDOW_MS,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  type LocationScope,
  type StewardRoleId,
  type StoryLifecycleState,
  type SubmissionMetadata,
  topicIdForSlug,
} from '@licio/shared';
import { complianceServicesConfigured, getComplianceServices } from '../compliance/services.js';
import { attentionPurgeAfterIso } from '../events/privacy-gate.js';
import type { EventPipelineServices } from '../events/services.js';
import type { NewStoredEvent } from '../events/stores.js';
import type { ForumServices } from '../forum/services.js';
import type { GovernanceService } from '../governance/service.js';
import { AlwaysGrantJobLeaseStore, type JobLeaseStore } from '../identity/job-lease.js';
import type { Role } from '../identity/rbac.js';
import type { IdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import { runBatchTier } from '../invariants/scheduler.js';
import type { InvariantPlatformServices } from '../invariants/services.js';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import { applyEvidenceDecision } from '../moderation/evidence.js';
import { submitReport } from '../moderation/reports.js';
import type { ModerationServices } from '../moderation/services.js';
import { windowStartMs } from '../pwatt/aggregation.js';
import { runPwattWindow } from '../pwatt/scoring.js';
import { DEMO_IDS } from './demo-data.js';

export const SEED_USER = {
  userId: '5f5e0000-0000-4000-8000-000000000001',
  handle: 'licio_demo',
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
const SUB = (n: number): string => `5f5e8000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CLAIM = (n: number): string => `5f5e9000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DEBATE = (n: number): string => `5f5ee000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The named DEVELOPMENT test accounts (NEVER seeded in production — the seed is
 * guarded by NODE_ENV in index.ts). Each is a real, login-able account: Licio is
 * passwordless, so a tester signs in with the email below and reads the
 * one-time code from the `pnpm dev` API log (`auth.mail.dev_code`). The roles
 * give each account a distinct slice of the product to exercise. Credentials and
 * the sign-in walkthrough live in DEVELOPMENT.md.
 *
 * `expert` holds the platform `expert` role (least-privilege, WS-D RBAC): it
 * may post top-level in expert-gated (`experts_and_stewards`) rooms but has no
 * moderation/governance/admin powers — so it can post in Open Science without
 * being a steward of it.
 */
export const DEV_ACCOUNTS: ReadonlyArray<{
  userId: string;
  handle: string;
  displayName: string;
  email: string;
  roles: readonly Role[];
  /** WS-J doctrine steward roles (the console queues each unlocks). */
  stewardRoles?: readonly StewardRoleId[];
  purpose: string;
}> = [
  {
    userId: U(20),
    handle: 'licio_admin',
    displayName: 'Ada Admin',
    email: 'admin@licio.test',
    roles: ['user', 'admin'],
    purpose: 'Platform administrator — full RBAC, every steward/admin surface.',
  },
  {
    userId: U(21),
    handle: 'licio_steward',
    displayName: 'Sam Steward',
    email: 'steward@licio.test',
    roles: ['user', 'steward'],
    // The three WS-J doctrine roles needed to exercise every console tab in dev:
    // report queue (safety), appeals, and the integrity incident queue.
    stewardRoles: ['ROLE_SAFETY', 'ROLE_APPEALS', 'ROLE_INTEGRITY'],
    purpose: 'Platform steward — moderation queues, appeals, integrity, audit reads.',
  },
  {
    userId: U(22),
    handle: 'licio_expert',
    displayName: 'Dr. Erin Expert',
    email: 'expert@licio.test',
    roles: ['user', 'expert'],
    purpose: 'Domain expert — the platform `expert` role: may post in expert-gated rooms.',
  },
  {
    userId: U(23),
    handle: 'licio_compliance',
    displayName: 'Cora Compliance',
    email: 'compliance@licio.test',
    // Both WS-N roles on one dev account so the whole compliance console —
    // cases, fraud queue, declaration verification — AND the counsel-only
    // surfaces (SAR drafting, disclosure publishing) are exercisable in dev.
    // In production these are separate people (isCounsel ∌ compliance.review).
    roles: ['user', 'compliance', 'counsel'],
    purpose:
      'Financial-compliance reviewer + counsel — the WS-N console and SAR/disclosure surfaces.',
  },
] as const;

/** Idempotent: re-running against existing data is a no-op. */
export async function seedForumDemoData(
  forum: ForumServices,
  ingestion: IngestionServices,
  identityStore: IdentityServices['store'],
): Promise<void> {
  if (await forum.rooms.getById(DEMO_IDS.ROOM_1)) return; // already seeded

  // Every demo account is backdated ~90 days so it is a normal aged account that
  // clears the submission account-age gate (WS-F prechecks) — content can be
  // submitted immediately.
  const backdated = forum.now() - NINETY_DAYS_MS;

  // The demo author (a real user row so author handles resolve).
  if (!(await identityStore.getUser(SEED_USER.userId))) {
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
        roles: ['user'],
      },
      backdated,
    );
  }

  // The named DEVELOPMENT test accounts (admin / steward / expert). Each is a
  // real, login-able passwordless account with a verified email so the
  // email-OTP sign-in (code surfaced to the dev API log) works immediately and
  // verified-only surfaces are reachable. See DEVELOPMENT.md.
  for (const account of DEV_ACCOUNTS) {
    if (await identityStore.getUser(account.userId)) continue;
    await identityStore.createUser(
      {
        userId: account.userId,
        handle: account.handle,
        displayName: account.displayName,
        email: account.email,
        accountState: 'active',
        locale: 'en',
        ageBand: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
        roles: [...account.roles],
        ...(account.stewardRoles ? { stewardRoles: [...account.stewardRoles] } : {}),
      },
      backdated,
    );
    await identityStore.setAuth(account.userId, {
      emailVerified: true,
      emailVerifiedAt: new Date(backdated).toISOString(),
    });
  }

  // Bot-prevention layer 3 (dev UX): every named dev account + the demo author
  // carries a reviewer-verified KYC standing so room-governance participation
  // (elections, ratifications, proposals) is exercisable on a `pnpm dev` box —
  // the same REAL store + guard production uses, seeded rather than bypassed.
  // Fail-soft when a suite seeds forum data without the WS-N container.
  if (complianceServicesConfigured()) {
    const kyc = getComplianceServices().kyc;
    const backdatedIso = new Date(backdated).toISOString();
    for (const userId of [SEED_USER.userId, ...DEV_ACCOUNTS.map((a) => a.userId)]) {
      if ((await kyc.get(userId)) !== null) continue;
      await kyc.upsert({
        userId,
        status: 'verified',
        evidenceRef: 'dev-seed',
        verifiedAt: backdatedIso,
        verifiedBy: null,
        createdAt: backdatedIso,
        updatedAt: backdatedIso,
      });
    }
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
    storageMode: 'server',
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
    storageMode: 'server',
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
    storageMode: 'server',
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
    lensId: null,
    requestId: '5f5e8000-0000-4000-8000-000000000001',
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
      // Deepening conversation stage with sourced comments (drives sources_count).
      lifecycle: 'deepening' as StoryLifecycleState,
      title: 'Regional water board publishes the full testing dataset',
      body: 'The board released raw and processed results alongside the sampling methodology.',
    },
    {
      storyId: DEMO_IDS.STORY_2,
      threadId: DEMO_IDS.THREAD_2,
      roomId: DEMO_IDS.ROOM_2,
      visibility: 'public' as const,
      // Two communities reconciling divergent readings (bridging stage).
      lifecycle: 'bridging' as StoryLifecycleState,
      title: 'Two neighbourhoods read the same zoning proposal very differently',
      body: 'The proposal text is identical, but two rooms summarise its effects differently.',
    },
    {
      // WS-Q.1.6 — STORY_3 lives in the PRIVATE room and is forced room_only.
      storyId: DEMO_IDS.STORY_3,
      threadId: DEMO_IDS.THREAD_3,
      roomId: DEMO_IDS.ROOM_3,
      visibility: 'room_only' as const,
      // A clarifying question awaiting evidence (context_needed stage).
      lifecycle: 'context_needed' as StoryLifecycleState,
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
        // Seed content is authoritative/pre-validated → trusted catalog topic
        // directly (proposed == trusted, as if the validator confirmed it).
        topicIds: [topicIdForSlug('climate-environment')],
        proposedTopicIds: [topicIdForSlug('climate-environment')],
        locationScope: null,
        sensitivityLabels: [],
        lifecycleState: story.lifecycle,
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

  // Comments on threads 1 and 2: a cited Q&A exchange, a measurement note, and
  // a lens-tagged local observation.
  const author = SEED_USER.userId;
  await forum.contributions.insert({
    contributionId: C(1),
    threadId: DEMO_IDS.THREAD_1,
    userId: author,
    type: 'comment',
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
    type: 'comment',
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
    type: 'comment',
    body: 'Nitrate figures are reported in mg/L; the legal limit is 50 mg/L in this region.',
    citations: [],
    metadata: {},
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
    type: 'comment',
    body: 'The intersection floods every spring, which the proposal map does not show.',
    citations: [],
    metadata: { lens_id: LENS_LOCAL },
    targetClaimId: null,
    parentContributionId: null,
    clientDraftId: 'demo-4',
    path: [],
    moderationState: 'published',
  });

  // -------------------------------------------------------------------------
  // Richer demo corpus (for local development + bug discovery): several more
  // authors, rooms (public/private/expert-gated), stories of varied submission
  // types + visibility tiers, and threads with several nested, multi-author
  // comments. Created through the SAME production stores/read paths as above, so
  // every surface (feeds, room shells, threads, ranking, visibility containment)
  // renders real end-to-end data. Idempotency is the top-of-function guard.
  // -------------------------------------------------------------------------
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
    { userId: maya, handle: 'maya_rivers', displayName: 'Maya Okonkwo' },
    { userId: theo, handle: 'theo_desk', displayName: 'Theo Vance' },
    { userId: lena, handle: 'lena_ward', displayName: 'Lena Park' },
    { userId: raj, handle: 'raj_policy', displayName: 'Raj Mehta' },
    { userId: samd, handle: 'sam_data', displayName: 'Sam Ellison' },
    { userId: nadia, handle: 'nadia_steward', displayName: 'Nadia Rahman', steward: true },
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
      storageMode: 'server',
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
      lensId: null,
      requestId,
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
  // The DEVELOPMENT "expert" account posts in the expert-gated Open Science room
  // (R6) through the platform `expert` ROLE — no room-steward grant needed.

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

  // --- Stories (varied submission types + visibility tiers + lifecycle) -----
  // Varying the lifecycle state keeps the corpus honest across conversation
  // stages (retrieval eligibility, the archival sweep). The reader-facing card
  // signals are seeded separately: sourced comments drive sources_count, the
  // WS-T dispute showcase below drives the corrections tally + badges, and the
  // live safety signals (thread safety → under-review) are layered on in
  // seedShadowSignals below.
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
    lifecycle?: StoryLifecycleState;
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
        proposedTopicIds: spec.topicIds,
        locationScope: spec.locationScope ?? null,
        sensitivityLabels: [],
        lifecycleState: spec.lifecycle ?? 'gathering_attention',
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

  // Canonical catalog topics (SPEC §14.1): the seed content is authoritative /
  // pre-validated, so its trusted `topicIds` are set directly to real catalog
  // ids (no random per-story topics — that is exactly what made the demo feed
  // trip the PHI narrow-loop detector on meaningless buckets).
  const topics = {
    water: topicIdForSlug('climate-environment'),
    climate: topicIdForSlug('climate-environment'),
    elections: topicIdForSlug('elections-democracy'),
    science: topicIdForSlug('science-research'),
    local: topicIdForSlug('local-community'),
  };
  const link = (url: string, reason: string): SubmissionMetadata => ({
    submission_type: 'link',
    url,
    reason,
  });
  const brief = (body: string): SubmissionMetadata => ({ submission_type: 'original_brief', body });

  await seedStory({
    n: 4,
    lifecycle: 'deepening',
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
    lifecycle: 'stable',
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
    lifecycle: 'context_needed',
    roomId: DEMO_IDS.ROOM_1,
    visibility: 'room_only',
    author: demo,
    title: 'Members: how should we read the lead-testing footnotes?',
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'The footnotes change the denominator. How should the room interpret the headline figure? Asking members before this goes to a wider audience.',
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
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'The closure now runs through spring. First-hand: I attended the public works briefing on Tuesday.',
    ),
    locationScope: { type: 'city', value: 'Riverside' },
    excerpt: 'The detour adds roughly ten minutes; transit reroutes start Monday.',
    topicIds: [topics.local],
  });
  await seedStory({
    n: 8,
    lifecycle: 'deepening',
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
    lifecycle: 'stable',
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
    lifecycle: 'context_needed',
    roomId: R(4),
    visibility: 'public',
    author: theo,
    title: 'Is the new tariff actually lowering emissions?',
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'Early numbers look mixed. What evidence would settle whether the tariff is working? Looking for measurable, falsifiable indicators.',
    ),
    excerpt: 'An open question inviting evidence on the tariff’s emissions effect.',
    topicIds: [topics.climate],
  });
  await seedStory({
    n: 11,
    lifecycle: 'stable',
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
    lifecycle: 'deepening',
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
    lifecycle: 'deepening',
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
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'The pier-by-pier cleanup rotation for the quarter. Source: the district sanitation office calendar.',
    ),
    locationScope: { type: 'city', value: 'Harbor District' },
    excerpt: 'Which piers are cleaned when, and how to report a missed collection.',
    topicIds: [topics.local],
  });
  await seedStory({
    n: 15,
    lifecycle: 'deepening',
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
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'Tracking what we have asked for and what is overdue. Members-only coordination.',
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
    lifecycle: 'deepening',
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

  // --- Stories authored by the DEVELOPMENT test accounts ---------------------
  // These cover the rating-label / lifecycle states the corpus above does not,
  // and give the admin/steward/expert accounts authored content to test with.
  const [admin, steward, expert] = [U(20), U(21), U(22)] as const;
  // S19 — flagged for coordination review (its thread is placed under_review
  // below) ⇒ "Under Review". Authored by the steward who would triage it.
  await seedStory({
    n: 19,
    lifecycle: 'deepening',
    roomId: DEMO_IDS.ROOM_1,
    visibility: 'public',
    author: steward,
    title: 'Sudden burst of near-identical posts about the clinic-closure rumour',
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'A cluster of accounts posted the same unsourced claim within minutes. Flagged for a coordination check before it spreads.',
    ),
    excerpt:
      'Descriptive only: a coordination signal is being reviewed — not a verdict on the content.',
    topicIds: [topics.water],
  });
  // S20 — an older, resolved explainer (archived; excluded from retrieval).
  await seedStory({
    n: 20,
    lifecycle: 'archived',
    roomId: R(5),
    visibility: 'public',
    author: admin,
    title: 'How we counted the recall petition signatures (final write-up)',
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'The verification method, the rejection reasons, and the certified total. Closed with a high-quality synthesis.',
    ),
    excerpt: 'A previously ambiguous process, now resolved with a cited synthesis.',
    topicIds: [topics.elections],
  });
  // S21 — brand-new submission (submitted stage; all-zero card signals).
  await seedStory({
    n: 21,
    lifecycle: 'submitted',
    roomId: R(4),
    visibility: 'public',
    author: admin,
    title: 'New filing: utility requests a winter rate adjustment',
    submissionType: 'link',
    submissionMetadata: link(
      'https://example.org/energy/winter-rate-filing',
      'The full filing as submitted to the regulator.',
    ),
    canonicalUrl: 'https://example.org/energy/winter-rate-filing',
    excerpt: 'Just submitted; reading is beginning. No interpretation has formed yet.',
    topicIds: [topics.climate],
  });
  // S22 — an expert-room post with independent sourced comments (cited
  // comments seeded below + a MERI independence signal in seedShadowSignals).
  await seedStory({
    n: 22,
    lifecycle: 'deepening',
    roomId: R(6),
    visibility: 'public',
    author: expert,
    title: 'Three independent labs report the same aquifer drawdown',
    submissionType: 'link',
    submissionMetadata: link(
      'https://example.org/science/aquifer-drawdown-multilab',
      'Three independent measurement series, each with open data.',
    ),
    canonicalUrl: 'https://example.org/science/aquifer-drawdown-multilab',
    excerpt: 'Independent primary sources converge on the same drawdown estimate.',
    topicIds: [topics.science],
  });
  // S23 — an expert's open question (submitted stage).
  await seedStory({
    n: 23,
    roomId: R(4),
    visibility: 'public',
    author: expert,
    title: 'What measurement would distinguish weather noise from a real demand shift?',
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'Looking for a falsifiable indicator the room could agree on in advance — a methodology question, posted before the next data release.',
    ),
    excerpt: 'An open methodological question inviting evidence.',
    topicIds: [topics.climate],
  });
  // S24 — a steward's local service-change brief (deepening stage).
  await seedStory({
    n: 24,
    lifecycle: 'deepening',
    roomId: R(7),
    visibility: 'public',
    author: steward,
    title: 'Harbor ferry adds a second morning sailing',
    submissionType: 'original_brief',
    submissionMetadata: brief(
      'A second morning sailing starts this month. Source: the port authority service bulletin.',
    ),
    locationScope: { type: 'city', value: 'Harbor District' },
    excerpt: 'Schedule change with the bulletin attached; the room is adding context.',
    topicIds: [topics.local],
  });
  // S25 — a NEAR-DUPLICATE repost of the winter-rate filing (S21): same content,
  // a different URL. Its MinHash signature collides with S21's (seeded below), so
  // the REAL MERI batch groups them and labels the second copy `duplicate_context`
  // — ten reposts never count as ten independent exposures (SPEC §7.1).
  await seedStory({
    n: 25,
    lifecycle: 'submitted',
    roomId: R(4),
    visibility: 'public',
    author: maya,
    // Same title + excerpt as S21 (so the MinHash signatures collide), different
    // URL — a verbatim repost. The MERI batch groups them; the ranking pipeline
    // folds the duplicate into "more on this story".
    title: 'New filing: utility requests a winter rate adjustment',
    submissionType: 'link',
    submissionMetadata: link(
      'https://example.org/energy/winter-rate-filing-repost',
      'The same filing as submitted to the regulator, reposted.',
    ),
    canonicalUrl: 'https://example.org/energy/winter-rate-filing-repost',
    excerpt: 'Just submitted; reading is beginning. No interpretation has formed yet.',
    topicIds: [topics.climate],
  });

  // S26 — a NATIVE IMAGE post, so the media-rendering surface (StoryMedia, the
  // gated /v1/uploads serving path) has real content. The bytes are a tiny valid
  // PNG, already metadata-stripped + scan-clear (the upload pipeline's output).
  const imageUploadId = '5f5ec000-0000-4000-8000-000000000001';
  const pngBytes = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  // The upload row + bytes live on the LONG-LIVED uploads store, NOT the seed
  // transaction: the bytes must survive commit (the dev fallback holds them in
  // memory per store instance), and the row must be visible to the in-transaction
  // image story that FK-references it (uploads commit before the story insert; the
  // soft `ownerStoryId` back-link has no FK). The existence guard keeps a retry —
  // after a rolled-back content transaction — from re-inserting the same upload.
  if ((await forum.uploads.getRecord(imageUploadId)) === null) {
    await forum.uploads.put(
      {
        uploadId: imageUploadId,
        ownerUserId: lena,
        contentType: 'image/png',
        byteSize: pngBytes.byteLength,
        altText: 'A chart of harbor water-clarity readings rising over the quarter.',
        storageRef: `demo/${imageUploadId}.png`,
        metadataStripped: true,
        scanState: 'clear',
      },
      pngBytes,
    );
  }
  const imageStory = await ingestion.stories.createWithThread(
    {
      storyId: S(26),
      canonicalUrl: null,
      title: 'Harbor water-clarity readings, charted for the quarter',
      titleHash: `demo-${S(26)}`,
      submittedBy: lena,
      sourceId: null,
      roomId: R(7),
      visibility: 'public',
      mediaUploadRef: imageUploadId,
      canonicalPublicStoryId: null,
      language: 'en',
      topicIds: [topics.local],
      proposedTopicIds: [topics.local],
      locationScope: { type: 'city', value: 'Harbor District' },
      sensitivityLabels: [],
      lifecycleState: 'gathering_attention',
      submissionType: 'image_post',
      submissionMetadata: {
        submission_type: 'image_post',
        upload_id: imageUploadId,
        alt_text: 'A chart of harbor water-clarity readings rising over the quarter.',
      },
      excerpt: 'A native image post: the quarter’s water-clarity readings as a chart.',
      publisher: null,
      author: null,
      publishedAt: null,
      mediaType: 'image',
      extractionState: 'not_applicable',
      hiddenState: null,
    },
    T(26),
  );
  if (imageStory.ok) {
    await forum.uploads.setOwnerStory(imageUploadId, S(26));
    await forum.rooms.touchActivity(R(7), imageStory.thread.createdAt);
  }

  // Moderation review queue (WS-J seam): a couple of PENDING items so the
  // steward/admin review surface is non-empty for testing. Ratified WS-A reason
  // codes; descriptive, never pre-judged.
  await ingestion.reviewQueue.insert({
    kind: 'contribution_safety_hold',
    storyId: S(19),
    context: {
      thread_id: T(19),
      reason_code: 'MOD_SPAM_002',
      urgency: 'elevated',
      note: 'A burst of near-identical posts flagged for a coordination check.',
    },
    status: 'pending',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    notBefore: null,
  });
  await ingestion.reviewQueue.insert({
    kind: 'contribution_safety_hold',
    storyId: S(8),
    context: {
      thread_id: T(8),
      reason_code: 'MOD_MISINFO_002',
      urgency: 'normal',
      note: 'A reader asked whether the rezoning map omits the floodplain boundary.',
    },
    status: 'pending',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    notBefore: null,
  });

  // Thread safety states (descriptive postures, never sanctions): S19 is under
  // coordination review (⇒ "Under Review"); S7 carries an elevated signal
  // (⇒ a "caution" badge while keeping its lifecycle label).
  await ingestion.stories.updateThread(T(19), { safetyState: 'under_review' });
  await ingestion.stories.updateThread(T(7), { safetyState: 'elevated' });

  // A second lens on the Climate room so the tariff story (S10) has TWO lenses
  // whose readings diverge — the SCOI "Where interpretations differ" showcase
  // (the divergent energy itself is the seeded SCOI output in seedShadowSignals).
  await forum.lenses.insert({
    lensId: LENS(4),
    roomId: R(4),
    name: 'Industry lens',
    lensType: 'policy',
    description: 'How the story reads for the firms the tariff regulates.',
  });

  // Claims give MERI's claim-extraction input real demo coverage (the real
  // batch computes each story's exposure over these independence groups).
  // Sourcing itself is comment-centric: the cited comments seeded below are
  // what the sourced-comment surfaces (chips, "Sources" view, wE) count.
  const seedClaim = async (storyId: string, claimN: number, claimText: string): Promise<void> => {
    await ingestion.claims.insert({
      claimId: CLAIM(claimN),
      storyId,
      canonicalText: claimText,
      normalizedTextHash: `demo-claim-${claimN}`,
      claimStatus: 'candidate',
      firstSeenStoryId: storyId,
      // A real claim independence group so MERI's claim-extraction input is
      // present for these stories (the real batch computes their exposure).
      // A DETERMINISTIC UUID (the claim model types group ids as UUIDs — the
      // real dedup path mints randomUUID(); a bare string here is
      // model-invalid seed data).
      independenceGroupId: `5f5e9100-0000-4000-8000-${String(claimN).padStart(12, '0')}`,
      createdBy: null,
      extractionSource: 'steward',
      extractionConfidence: null,
      modelVersion: null,
    });
  };
  await seedClaim(DEMO_IDS.STORY_1, 1, 'Nitrate levels are within the regional legal limit.');
  await seedClaim(S(13), 2, 'The soil-carbon estimate replicates within its confidence interval.');
  await seedClaim(S(22), 3, 'Three independent labs report the same aquifer drawdown.');

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
    metadata?: ContributionMetadata;
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
      await forum.contributions.insert({
        contributionId: at(ids, i),
        threadId,
        userId: s.author,
        type: s.type,
        body: s.body,
        citations: s.citations ?? [],
        metadata: s.metadata ?? {},
        targetClaimId: null,
        parentContributionId: parentId,
        clientDraftId: `seed-${at(ids, i)}`,
        path: at(paths, i),
        moderationState: 'published',
      });
    }
  };

  // Hospital-readmission link (public): a question answered with a cited reply,
  // a sourced comment, a clarifying sub-question, and a housekeeping note.
  await tree(T(4), 100, [
    {
      type: 'comment',
      author: maya,
      body: 'Are readmissions risk-adjusted, or are these raw counts per facility?',
    },
    {
      type: 'comment',
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
      type: 'comment',
      author: samd,
      parent: 1,
      body: 'The adjustment model matches the national specification (linked).',
      citations: [
        { url: 'https://example.org/standards/readmission-model', title: 'National model spec' },
      ],
    },
    {
      type: 'comment',
      author: lena,
      parent: 1,
      body: 'Does the adjustment account for seasonal admission surges?',
    },
    {
      type: 'comment',
      author: maya,
      parent: 3,
      body: 'Partly: reading the appendix at face value, it includes a winter indicator but not a facility-level surge term.',
    },
    {
      type: 'comment',
      author: nadia,
      body: 'Keeping this thread to measurement; policy debate belongs in a separate branch.',
    },
  ]);

  // Bridge closure (public local): first-hand residents' reports + a
  // direction-specific counterpoint.
  await tree(T(7), 120, [
    {
      type: 'comment',
      author: lena,
      body: 'I drove the detour this morning; the added time was closer to fifteen minutes at peak.',
    },
    {
      type: 'comment',
      author: raj,
      parent: 0,
      body: 'The detour overlaps the school-run corridor, which the briefing did not mention.',
    },
    {
      type: 'comment',
      author: theo,
      parent: 0,
      body: 'The northbound detour was clear at 9am — congestion may be direction-specific.',
    },
    {
      type: 'comment',
      author: lena,
      parent: 2,
      body: 'Agreed — southbound is the slow leg; northbound is fine outside the school window.',
    },
  ]);

  // Grid-demand brief (public climate): a sourced reply, a correction with
  // citations, and a summing-up comment.
  await tree(T(9), 140, [
    {
      type: 'comment',
      author: theo,
      body: 'Is this normalized for the warm spell, or are these absolute peaks?',
    },
    {
      type: 'comment',
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
      // Formally targets the STORY (the brief's own chart) — the WS-T dispute
      // showcase below opens the live arena this correction is arguing in.
      metadata: {
        target_text_excerpt: 'Monday evening peak',
        target_story_id: S(9),
        debate_arena_id: DEBATE(1),
      },
    },
    {
      type: 'comment',
      author: raj,
      parent: 1,
      body: 'Independent ISO data agrees with the normalized read.',
      citations: [{ url: 'https://example.org/iso/demand' }],
    },
    {
      type: 'comment',
      author: nadia,
      body: 'Net: two absolute peaks, flat once normalized, with a one-day labeling fix — though the normalization is sensitive to the chosen baseline.',
    },
  ]);

  // Tariff story (public climate): a couple of cited replies, PLUS two
  // lens-tagged comments that genuinely diverge (skeptical vs industry) — the
  // raw material for the SCOI "Where interpretations differ" drawer on S10.
  await tree(T(10), 160, [
    {
      type: 'comment',
      author: samd,
      body: 'Emissions intensity is the cleaner indicator than total emissions here.',
      citations: [{ url: 'https://example.org/climate/intensity-vs-total' }],
    },
    {
      type: 'comment',
      author: theo,
      parent: 0,
      body: 'A neighboring market saw intensity fall WITHOUT a tariff — confounding the read; other factors may drive the change.',
    },
    {
      type: 'comment',
      author: maya,
      body: 'Skeptical read: the early drop is within normal year-to-year noise; the tariff has not been shown to do anything yet.',
      metadata: { lens_id: LENS(2) },
    },
    {
      type: 'comment',
      author: raj,
      body: 'Industry read: the tariff is already raising input costs and forcing real operational changes on the ground.',
      metadata: { lens_id: LENS(4) },
    },
  ]);

  // Elections turnout (public): a Q&A exchange + a sourced comment.
  await tree(T(11), 180, [
    {
      type: 'comment',
      author: lena,
      body: 'Is turnout reported as a share of registered voters or of eligible population?',
    },
    {
      type: 'comment',
      author: raj,
      parent: 0,
      body: 'Registered voters — the data dictionary defines the denominator explicitly.',
      citations: [{ url: 'https://example.org/elections/precinct-turnout#dictionary' }],
    },
    {
      type: 'comment',
      author: samd,
      parent: 1,
      body: 'Cross-checked three precincts against the certified totals; they match.',
      citations: [{ url: 'https://example.org/elections/certified-totals' }],
    },
  ]);

  // Newsroom Desk (PRIVATE, room_only): a coordination thread the demo member can read.
  await tree(T(15), 200, [
    {
      type: 'comment',
      author: nadia,
      body: 'Do we have the second FOIA response in hand, or only the acknowledgment?',
    },
    {
      type: 'comment',
      author: theo,
      parent: 0,
      body: 'Only the acknowledgment so far; the response is due next week.',
    },
    {
      type: 'comment',
      author: demo,
      parent: 1,
      body: 'The clerk’s office is short-staffed this month, which may slow the response.',
    },
  ]);

  // Lighter threads on the remaining new stories so every story has discussion.
  await tree(T(5), 220, [
    {
      type: 'comment',
      author: theo,
      body: 'Do the sensors report ozone at all, or is that a separate network?',
    },
    {
      type: 'comment',
      author: maya,
      parent: 0,
      body: 'Separate network entirely — these units have no ozone channel.',
    },
  ]);
  await tree(T(8), 230, [
    {
      type: 'comment',
      author: lena,
      body: 'The two rezoned parcels border the floodplain (map linked).',
      citations: [{ url: 'https://example.org/riverside/floodplain-map' }],
    },
  ]);
  await tree(T(12), 240, [
    {
      type: 'comment',
      author: lena,
      body: 'What happens to a ballot whose later choices are all eliminated?',
    },
    {
      type: 'comment',
      author: nadia,
      parent: 0,
      body: 'It becomes "exhausted" and is set aside in subsequent rounds.',
    },
  ]);
  await tree(T(13), 250, [
    {
      type: 'comment',
      author: samd,
      body: 'Pre-registration and analysis plan are both posted.',
      citations: [{ url: 'https://example.org/science/soil-carbon-replication#prereg' }],
    },
  ]);
  await tree(T(16), 260, [
    {
      type: 'comment',
      author: theo,
      body: 'Two requests are overdue; I will escalate both this week.',
    },
  ]);
  // The DEVELOPMENT-account stories get discussion too.
  await tree(T(19), 270, [
    {
      type: 'comment',
      author: steward,
      body: 'Holding this for a coordination check: same wording, many new accounts, all within a few minutes. No action taken yet.',
    },
    {
      type: 'comment',
      author: maya,
      parent: 0,
      body: 'Is there an original source for the closure claim, or only the reposts?',
    },
    {
      type: 'comment',
      author: steward,
      parent: 1,
      body: 'No primary source so far. If one appears the review clears; if not, the burst pattern stands on its own.',
    },
  ]);
  await tree(T(22), 280, [
    {
      type: 'comment',
      author: expert,
      body: 'Each lab measured independently with its own instrumentation; the three series overlap within error.',
      citations: [{ url: 'https://example.org/science/aquifer-drawdown-multilab#methods' }],
    },
    {
      type: 'comment',
      author: samd,
      parent: 0,
      body: 'Independent replication across labs is exactly what raises confidence here.',
    },
  ]);
  await tree(T(24), 290, [
    {
      type: 'comment',
      author: lena,
      body: 'Does the second sailing run on weekends too, or weekdays only?',
    },
    {
      type: 'comment',
      author: steward,
      parent: 0,
      body: 'Weekdays only for now; the bulletin says weekend service is under review for spring.',
    },
  ]);

  // Discussion on the remaining stories so EVERY story has a populated thread
  // (delivering the "every story has discussion" intent above): a clarifying
  // exchange on the room_only stories (S3, S6), civic Q&A (S14, S21, S26), the
  // archived recall write-up's method trail (S20), the expert methodology
  // exchange (S23), and a note folding the verbatim repost to the original (S25).
  // Transit timetable caveat (PRIVATE Transit room, room_only): the demo member
  // (the room's only member) pins the missing caveat awaiting evidence.
  await tree(T(3), 300, [
    {
      type: 'comment',
      author: demo,
      body: 'Which caveat is missing — that the higher frequency is peak-hours only?',
    },
    {
      type: 'comment',
      author: demo,
      parent: 0,
      body: 'Yes: reading the published timetable at face value, the headline frequency holds 7–9am and 4–6pm; midday service is unchanged. The timetable should say so.',
    },
  ]);
  // Lead-testing footnotes (the room_only story in a public room).
  await tree(T(6), 310, [
    {
      type: 'comment',
      author: maya,
      body: 'The footnotes switch the denominator from sampled homes to all service connections, so the headline rate reads lower than the per-home figure.',
    },
    {
      type: 'comment',
      author: demo,
      parent: 0,
      body: 'That matches my read. We should lead with the per-home rate and footnote the connection-level one, not the reverse.',
    },
  ]);
  // Harbor cleanup schedule (public local).
  await tree(T(14), 320, [
    {
      type: 'comment',
      author: theo,
      body: 'Is the pier rotation the same as last quarter, or did any piers swap weeks?',
    },
    {
      type: 'comment',
      author: lena,
      parent: 0,
      body: 'Two piers swapped weeks; the rest is unchanged. The bulletin has the updated calendar.',
    },
  ]);
  // Recall-petition write-up (public, archived): the method trail behind the
  // certified total.
  await tree(T(20), 330, [
    {
      type: 'comment',
      author: raj,
      body: 'How were duplicate signatures detected — by name, or by registered-voter id?',
    },
    {
      type: 'comment',
      author: admin,
      parent: 0,
      body: 'By registered-voter id against the voter file, so two distinct voters who share a name were never merged.',
    },
    {
      type: 'comment',
      author: samd,
      parent: 1,
      body: 'The published rejection log lists each excluded signature with its reason code.',
      citations: [{ url: 'https://example.org/elections/recall-rejection-log' }],
    },
  ]);
  // Winter-rate filing (public, just submitted): one opening question, kept
  // light because no interpretation has formed yet.
  await tree(T(21), 340, [
    {
      type: 'comment',
      author: samd,
      body: 'Does the filing ask for a flat winter surcharge, or a tiered rate by usage?',
    },
  ]);
  // Expert methodology story (public): a falsifiable-indicator exchange.
  await tree(T(23), 350, [
    {
      type: 'comment',
      author: samd,
      body: 'A pre-registered threshold on weather-normalized demand would separate noise from a real shift.',
    },
    {
      type: 'comment',
      author: theo,
      parent: 0,
      body: 'Only if the normalization baseline is fixed in advance — otherwise the threshold moves with the data.',
    },
  ]);
  // Verbatim repost of the winter-rate filing (public): a note folding it back to
  // the original so the discussion stays in one place (the dedup demonstration).
  await tree(T(25), 360, [
    {
      type: 'comment',
      author: maya,
      body: 'This is the same filing already posted; keeping the discussion on the original rather than splitting it here.',
    },
  ]);
  // Harbor water-clarity image post (public): seasonal trend or real improvement?
  await tree(T(26), 370, [
    {
      type: 'comment',
      author: theo,
      body: 'Is the clarity trend seasonal, or a real improvement after the cleanup?',
    },
    {
      type: 'comment',
      author: lena,
      parent: 0,
      body: 'Partly seasonal, but the post-cleanup readings are above the same months last year.',
    },
  ]);

  // -------------------------------------------------------------------------
  // WS-T dispute showcase: the §5.6 corrections tally + dispute badges render
  // from real adjudication state, so seed each posture through the same stores
  // the debate lifecycle writes (the tags below are exactly what
  // maybeEnterDebate / finalizeDebate would have left behind):
  //   • S(9)  — the chart-label correction challenges the STORY: a LIVE
  //             story-target arena ⇒ the story badge reads "Challenged".
  //   • S(10) — a cited correction challenges a comment's confounder claim:
  //             a LIVE comment arena ⇒ the card tally shows an hourglass.
  //   • S(11) — the certified-totals cross-check was challenged and UPHELD ⇒
  //             a "Validated" comment (the ✓ tally).
  //   • S(4)  — a correction PREVAILED against the national-spec claim ⇒ an
  //             "Incorrect" comment, kept visible but sunk (the ✗ tally).
  // Live-arena deadlines are freshly stamped, so the dev debate scheduler
  // treats them as newly opened rather than instantly due.
  // -------------------------------------------------------------------------
  const seedCorrection = async (spec: {
    n: number;
    threadId: string;
    author: string;
    body: string;
    citations: Cite[];
    metadata: ContributionMetadata;
  }): Promise<string> => {
    await forum.contributions.insert({
      contributionId: C(spec.n),
      threadId: spec.threadId,
      userId: spec.author,
      type: 'correction',
      body: spec.body,
      citations: spec.citations,
      metadata: spec.metadata,
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: `seed-${C(spec.n)}`,
      path: [],
      moderationState: 'published',
    });
    return C(spec.n);
  };
  const openSeedArena = async (spec: {
    debateId: string;
    storyId: string;
    threadId: string;
    targetContributionId: string | null;
    challengerContributionId: string;
    challengerUserId: string;
    challengerSummary: string;
    challengerCitations: Cite[];
  }): Promise<void> => {
    const story = await ingestion.stories.getById(spec.storyId);
    const openedAt = new Date(forum.now());
    const after = (ms: number): string => new Date(openedAt.getTime() + ms).toISOString();
    const incumbentUserId =
      spec.targetContributionId === null
        ? (story?.submittedBy ?? null)
        : ((await forum.contributions.getById(spec.targetContributionId))?.userId ?? null);
    await forum.debates.open({
      debateId: spec.debateId,
      storyId: spec.storyId,
      threadId: spec.threadId,
      roomId: story?.roomId ?? null,
      targetType: spec.targetContributionId === null ? 'story' : 'comment',
      targetContributionId: spec.targetContributionId,
      challengerContributionId: spec.challengerContributionId,
      incumbentUserId,
      challengerUserId: spec.challengerUserId,
      state: 'open',
      positions: {
        incumbent: { summary: '', citations: [], updatedAt: null },
        challenger: {
          summary: spec.challengerSummary,
          citations: spec.challengerCitations,
          updatedAt: openedAt.toISOString(),
        },
      },
      editDeadlineAt: after(DEBATE_EDIT_WINDOW_MS),
      resolveDueAt: after(DEBATE_LIVE_WINDOW_MS),
      lockedAt: null,
      lockedContent: null,
      incumbentLastActiveAt: openedAt.toISOString(),
      challengerLastActiveAt: openedAt.toISOString(),
      verdict: null,
      winner: null,
      decidedBy: null,
      rationale: null,
      confidence: null,
      aiOutputId: null,
      verdictAt: null,
      overrideDeadlineAt: null,
      overriddenByUserId: null,
      overrideReason: null,
      resolvedAt: null,
    });
  };

  // S(9): the existing chart-label correction C(142) argues in a live
  // story-target arena — the story itself is "Challenged".
  await openSeedArena({
    debateId: DEBATE(1),
    storyId: S(9),
    threadId: T(9),
    targetContributionId: null,
    challengerContributionId: C(142),
    challengerUserId: maya,
    challengerSummary:
      'The raw interval readings put the first peak on Tuesday; the chart labels are off by a day.',
    challengerCitations: [
      { url: 'https://example.org/grid/raw-readings', title: 'Raw interval readings' },
    ],
  });
  await ingestion.stories.update(S(9), { disputeStatus: 'under_debate' });

  // S(10): a live COMMENT arena — the confounder claim C(161) is challenged.
  const tariffCorrection = await seedCorrection({
    n: 380,
    threadId: T(10),
    author: samd,
    body: 'The neighboring market introduced an equivalent levy in the same quarter — it is not a tariff-free comparison.',
    citations: [
      { url: 'https://example.org/climate/neighbor-levy', title: 'Neighboring levy filing' },
    ],
    metadata: { target_contribution_id: C(161), debate_arena_id: DEBATE(2) },
  });
  await openSeedArena({
    debateId: DEBATE(2),
    storyId: S(10),
    threadId: T(10),
    targetContributionId: C(161),
    challengerContributionId: tariffCorrection,
    challengerUserId: samd,
    challengerSummary:
      'The comparison market is not tariff-free: an equivalent levy took effect the same quarter.',
    challengerCitations: [
      { url: 'https://example.org/climate/neighbor-levy', title: 'Neighboring levy filing' },
    ],
  });
  await forum.contributions.setDisputeStatus(C(161), 'under_debate');

  // S(11): a challenge that DID NOT hold — the cross-check C(182) stands as
  // accurate ("Validated", the terminal tag finalizeDebate writes on upheld).
  await seedCorrection({
    n: 381,
    threadId: T(11),
    author: theo,
    body: 'The three checked precincts were all early-count precincts; the sample may not generalize.',
    citations: [
      { url: 'https://example.org/elections/count-order', title: 'Count-order schedule' },
    ],
    metadata: { target_contribution_id: C(182) },
  });
  await forum.contributions.setDisputeStatus(C(182), 'validated');

  // S(4): a correction that PREVAILED — the national-spec claim C(102) is
  // "Incorrect": kept fully visible, demoted to the bottom of its section.
  await seedCorrection({
    n: 382,
    threadId: T(4),
    author: lena,
    body: 'The adjustment model matches the SUPERSEDED 2019 specification — the current national model added two covariates.',
    citations: [
      { url: 'https://example.org/standards/readmission-model-v2', title: 'Current model spec' },
    ],
    metadata: { target_contribution_id: C(102) },
  });
  await forum.contributions.setDisputeStatus(C(102), 'incorrect');

  // MinHash signatures for every seeded story (over the title + excerpt). These
  // are the SAME signatures the WS-F dedup pipeline writes, so the REAL MERI
  // batch detects near-duplicates from genuine signature collisions
  // (S21 ↔ S25) rather than hand-authored groups.
  for (const story of await ingestion.stories.listRecent(200)) {
    if (await ingestion.signatures.getByStoryId(story.storyId)) continue;
    const text = `${story.title} ${story.excerpt ?? ''}`.trim();
    const minhash = minhashSignature(text);
    await ingestion.signatures.upsert(
      {
        storyId: story.storyId,
        minhash,
        shingleK: MINHASH_SHINGLE_K,
        numHashes: MINHASH_NUM_HASHES,
        familyVersion: MINHASH_FAMILY_VERSION,
        textSource: 'submitted',
      },
      lshBandHashes(minhash),
    );
  }
}

// ---------------------------------------------------------------------------
// Operational signals: REAL invariant computation + reading signals (DEV only).
//
// Unlike a fixture, this COMPUTES the demo's invariant outputs and reading
// signals by running the actual production engines over the shaped content:
//   • the WS-H invariant batch (MERI exposure, SCOI divergence, …) reads the
//     seeded signatures / claim groups / lens contributions;
//   • the WS-E PWAtt scorer reads seeded bucketed attention aggregates and
//     PRODUCES the owner-scoped Signal Ledger exactly as it does for a reader.
// The reader-facing surfaces then read these stored outputs through the same
// paths as production. The hourly schedulers recompute from the same content,
// so this is a head start, not a divergent fixture. The single legitimately
// direct signal is the S19 MFCI risk STATE (a coordinated freeze cannot be
// manufactured by a static seed). NEVER runs in production (NODE_ENV-guarded).
// ---------------------------------------------------------------------------
export async function seedOperationalSignals(
  events: EventPipelineServices,
  invariants: InvariantPlatformServices,
  identity: IdentityServices,
  ingestion: IngestionServices,
): Promise<void> {
  // Idempotent: a prior boot already computed the feed MERI output.
  if (await events.invariantStore.latest('MERI', GLOBAL_FEED_TARGET_ID)) return;
  const nowMs = Date.now();

  // 1. The REAL WS-H batch over the shaped content: MERI exposure (from genuine
  //    MinHash-signature near-dup groups + claim independence groups),
  //    SCOI divergence (from the lens-tagged contributions' embeddings), and the
  //    rest — COMPUTED, never hand-authored. Every reader-facing invariant
  //    surface reads these stored shadow outputs through the production paths.
  await runBatchTier(invariants, events, ingestion, nowMs);

  // 2. MFCI per-target risk on the coordination-review story (S19). A genuine
  //    MFCI freeze needs coordinated actors a static seed cannot manufacture, so
  //    the demo sets the durable risk STATE directly — the one legitimately
  //    direct operational signal (a state, not a fabricated computation),
  //    consistent with S19's `under_review` thread posture.
  await invariants.mfciRiskStates.set({
    targetId: S(19),
    state: 'high',
    score: 3.4,
    reason: 'demo_seed_coordination_review',
    updatedAt: new Date(nowMs).toISOString(),
  });

  // 3. Reading signals through the REAL PWAtt scorer. Seed bucketed attention
  //    AGGREGATES (the §22.1 records — coarse buckets only, never raw traces)
  //    owned by the test accounts in the current hour window, then run the
  //    actual hourly PWAtt window so the owner-scoped Signal Ledger is PRODUCED
  //    by the scorer exactly as it is for a real reader (the in-browser pipeline
  //    adds more as a tester reads).
  const hourStart = windowStartMs(nowMs, '1h');
  const eventMs = hourStart + 60_000;
  const at = new Date(eventMs).toISOString();
  const sessionBucket = new Date(hourStart).toISOString();
  // Purge deadline computed exactly as the real ingest path does (the dev
  // accounts hold default retention settings at seed time), so the seeded rows
  // carry a proper retention deadline rather than lingering unbounded.
  const purgeAfter = attentionPurgeAfterIso('default', eventMs, nowMs);
  type Att = {
    owner: string;
    item: string;
    dwell: 'glance' | 'short' | 'medium' | 'long' | 'extended';
    source: boolean;
    context: boolean;
    branch: 'none' | 'shallow' | 'moderate' | 'deep';
    returns: 'none' | 'few' | 'several';
  };
  // Each owner is a login-able account, so whoever a tester signs in as sees
  // their own (and only their own) reading record.
  const attention: readonly Att[] = [
    {
      owner: SEED_USER.userId,
      item: DEMO_IDS.STORY_1,
      dwell: 'long',
      source: true,
      context: true,
      branch: 'moderate',
      returns: 'few',
    },
    {
      owner: SEED_USER.userId,
      item: S(9),
      dwell: 'medium',
      source: true,
      context: false,
      branch: 'shallow',
      returns: 'none',
    },
    {
      owner: SEED_USER.userId,
      item: S(2),
      dwell: 'extended',
      source: false,
      context: true,
      branch: 'deep',
      returns: 'several',
    },
    {
      owner: U(20),
      item: S(22),
      dwell: 'long',
      source: true,
      context: true,
      branch: 'moderate',
      returns: 'few',
    },
    {
      owner: U(20),
      item: S(11),
      dwell: 'medium',
      source: true,
      context: true,
      branch: 'shallow',
      returns: 'none',
    },
    {
      owner: U(20),
      item: S(19),
      dwell: 'short',
      source: false,
      context: true,
      branch: 'none',
      returns: 'none',
    },
    {
      owner: U(21),
      item: S(13),
      dwell: 'long',
      source: true,
      context: true,
      branch: 'moderate',
      returns: 'few',
    },
    {
      owner: U(21),
      item: S(4),
      dwell: 'medium',
      source: true,
      context: false,
      branch: 'shallow',
      returns: 'none',
    },
    {
      owner: U(21),
      item: S(8),
      dwell: 'glance',
      source: false,
      context: false,
      branch: 'none',
      returns: 'none',
    },
    {
      owner: U(22),
      item: S(22),
      dwell: 'extended',
      source: true,
      context: true,
      branch: 'deep',
      returns: 'few',
    },
    {
      owner: U(22),
      item: S(13),
      dwell: 'long',
      source: true,
      context: true,
      branch: 'moderate',
      returns: 'several',
    },
    {
      owner: U(22),
      item: S(10),
      dwell: 'medium',
      source: false,
      context: true,
      branch: 'moderate',
      returns: 'few',
    },
    {
      owner: U(23),
      item: S(11),
      dwell: 'long',
      source: true,
      context: true,
      branch: 'shallow',
      returns: 'none',
    },
    {
      owner: U(23),
      item: S(2),
      dwell: 'medium',
      source: true,
      context: false,
      branch: 'none',
      returns: 'none',
    },
  ];
  const rows: NewStoredEvent[] = attention.map((a) => {
    const event = attentionAggregateEventSchema.parse({
      event_id: randomUUID(),
      event_type: 'attention.aggregate',
      timestamp: at,
      schema_version: '1',
      nonce: randomUUID(),
      user_id: a.owner,
      privacy_level: 'standard',
      session_bucket: sessionBucket,
      items: [
        {
          story_id: a.item,
          active_dwell_bucket: a.dwell,
          source_opened: a.source,
          context_opened: a.context,
          reply_depth_bucket: a.branch,
          return_visit_count_bucket: a.returns,
        },
      ],
      privacy_classification: 'aggregated',
      retention_tier: 'attention_aggregated',
    });
    return {
      eventId: event.event_id,
      eventType: 'attention.aggregate',
      topic: 'attention.aggregate',
      timestamp: event.timestamp,
      privacyClassification: 'aggregated',
      retentionTier: 'attention_aggregated',
      payload: event as unknown as Record<string, unknown>,
      ownerUserId: a.owner,
      purgeAfter,
    };
  });
  await events.eventStore.insertMany(rows);
  await runPwattWindow(events, identity, hourStart, '1h');
}

/**
 * Lift the MERI invariant to `soft_constraint` in EVERY environment so its
 * ranking effect actually applies — the maintainer decision to run MERI live
 * (not shadow-gated) platform-wide.
 *
 * Every OTHER WS-H invariant is persisted SHADOW-only and gated behind the
 * promotion store; with no promotion records the ranking pipeline computes the
 * invariant values but applies zero effect, so a near-duplicate repost is never
 * demoted below its original. Seeding a single MERI promotion makes the §7.1
 * duplicate demotion visible in the served feed. Scoped to MERI on purpose: it
 * is a pure redundancy penalty (a demotion), so it carries none of the
 * whole-feed fallback risk of the GWEI deployment gate or the content-exclusion
 * risk of an MFCI severe state — the lowest-blast-radius invariant to run live.
 *
 * `soft_constraint` (never `hard_constraint`) keeps MERI a soft ranking penalty
 * rather than a hard feed-shaping exclusion. Idempotent: a re-run (or a later
 * boot against the same durable promotion store) finds the record present and
 * returns without appending. The kill switch (a demotion append) still reverts
 * the effect on the next read without a redeploy.
 */
export async function seedMeriRankingEnforcement(
  invariants: InvariantPlatformServices,
  lease: JobLeaseStore = new AlwaysGrantJobLeaseStore(),
): Promise<void> {
  const alreadyLive = async (): Promise<boolean> =>
    (await invariants.promotions.listForInvariant('MERI')).some(
      (r) => r.toStatus === 'soft_constraint',
    );
  // Fast path + the durable idempotency guarantee: a row already present ⇒ done.
  if (await alreadyLive()) return;
  // Serialize the one-shot boot promotion across replicas so concurrent
  // FIRST-boots don't each append a duplicate row (the store has no unique key).
  // `tryAcquire` grants AT MOST ONE holder per window, so:
  //   • holder (true) ⇒ this replica writes the row;
  //   • NON-holder (false) ⇒ another replica holds the LIVE lease and will write
  //     it, so YIELD without appending — the non-holder must NOT race the
  //     holder's commit, or the "serialize" guarantee is empty. A holder that
  //     dies between acquiring and appending self-heals on the next boot, which
  //     re-runs this seed;
  //   • lease store UNAVAILABLE (throw) ⇒ FAIL OPEN and write the row ourselves,
  //     so a broken lease can never leave MERI shadow-gated.
  let holdsLease = false;
  let leaseUnavailable = false;
  try {
    holdsLease = await lease.tryAcquire('seed:meri-enforcement', 60_000, 'platform-boot');
  } catch {
    leaseUnavailable = true;
  }
  if (!holdsLease && !leaseUnavailable) return; // another replica holds it → yield
  await invariants.promotions.append({
    invariantType: 'MERI',
    fromStatus: 'shadow',
    toStatus: 'soft_constraint',
    // The steward promotion history (`PromotionService.history`) reconstructs the
    // typed evidence shape, so populate ALL of its fields — a `note`-only record
    // would surface as fabricated zero coverage/confidence + an empty drift ref.
    // This is a maintainer OVERRIDE, not an evidence-driven promotion: it skipped
    // shadow (shadowDurationDays 0) and carries no shadow-observed metrics (0);
    // the drift reference names the decision so the audit trail reads it as an
    // explicit override rather than a broken evidence-based promotion.
    evidence: {
      note: 'maintainer decision: MERI runs live (soft_constraint) in all environments',
      shadowDurationDays: 0,
      driftReportRef: 'maintainer-decision/meri-live-all-envs',
      observedCoverage: 0,
      observedConfidence: 0,
    },
    owner: 'platform-boot',
    createdAt: new Date().toISOString(),
  });
}

/**
 * Seed a small WS-J moderation demo: two distinct reporters file a report
 * against one demo story, so a fresh dev console shows a non-empty report queue
 * (one standard case, report_count 2) that an authorized steward can review and
 * action.  Idempotent — the fixed operation ids make a re-run a no-op.  Runs on
 * non-prod boot AFTER the moderation services are wired.
 */
export async function seedModerationDemo(moderation: ModerationServices): Promise<void> {
  const target = DEMO_IDS.STORY_2;
  const reporters = [U(20), U(22)]; // the dev admin + expert accounts
  for (const [i, reporter] of reporters.entries()) {
    await submitReport(moderation, reporter, {
      target_type: 'content',
      target_id: target,
      content_kind: 'story',
      reason_code: 'MOD_SPAM_001',
      local_operation_id: `demo-report-${i}`,
    });
  }
  // One ROLE_EVIDENCE showcase decision: the methodology citation on the
  // sourced reply C(2) is marked a PRIMARY SOURCE, so the evidence queue and
  // the recent-decisions panel render real reviewed metadata on `pnpm dev`.
  // Best-effort + idempotent (a re-boot hits duplicate_decision and moves on).
  await applyEvidenceDecision(
    moderation,
    {
      userId: U(20),
      platformRoles: ['admin'],
      stewardRoles: [],
      mfaActive: true,
      mfaVerified: true,
    },
    {
      contribution_id: C(2),
      action: 'mark-primary-source',
      citation_url: 'https://example.org/methodology',
    },
  );
}

/** The demo room that ships GOVERNED (WS-U) — "Elections & Governance" (public). */
export const GOVERNANCE_DEMO_ROOM_ID = R(5);

/** First real published contribution id in a room (the demo agent's subject). */
async function firstContributionRefInRoom(
  forum: ForumServices,
  ingestion: IngestionServices,
  roomId: string,
): Promise<string | null> {
  const stories = await ingestion.stories.listByRoom(roomId, 10);
  for (const story of stories) {
    const thread = await ingestion.stories.getThreadByStoryId(story.storyId);
    if (!thread) continue;
    const [contribution] = await forum.contributions.listByThread(thread.threadId, {
      states: ['published'],
      limit: 1,
    });
    if (contribution) return contribution.contributionId;
  }
  return null;
}

/**
 * DEVELOPMENT showcase for WS-U (NEVER in production): make one room actually
 * governed so the "governed by" panel + the steward model-manager render real
 * data on `pnpm dev`. The elected steward (steward@licio.test, U(21)) proposes a
 * community model that flags link-spam; it clears the platform admission gate; a
 * member ratification activates the in-room agent; and one sample agent action is
 * logged via a DIRECT moderate() call — which writes only the agent action log,
 * NOT the human review queue, so the dev moderation queue stays the curated WS-J
 * set. Idempotent (bootstrap/propose are existence/duplicate-guarded) and
 * best-effort; runs AFTER the forum seed (the room must exist) + the governance
 * service is bound.
 */
export async function seedGovernanceDemo(
  governance: GovernanceService,
  forum: ForumServices,
  ingestion: IngestionServices,
): Promise<void> {
  const steward = U(21); // steward@licio.test
  await governance.bootstrapSeat(GOVERNANCE_DEMO_ROOM_ID, steward);
  const bundle = {
    bundleId: 'demo-civility',
    version: '1',
    name: 'Community civility policy',
    // The community-ratified in-room MODEL is an LLM conditioned by this prompt
    // (WS-U ADR-9); the platform's deterministic wrapper bounds whatever it
    // proposes (escalate-to-human-review ceiling + capability clamp). The prompt
    // is prose, not a DSL — the removed policy-DSL is gone.
    moderationPrompt:
      'Route link-heavy, spammy, or otherwise suspicious contributions to human review; allow civil, on-topic content.',
    promptTemplates: { summary: 'Summarize the discussion neutrally and briefly.' },
    config: { summaryStyle: 'neutral_brief', explanationVerbosity: 'standard' },
    // moderation + the Stage 4 lawmaking summary + the WS-T debate queue (all
    // permitted by the default law-pack) so the dev "governed by" panel shows
    // real facilitation activity and the demo room adjudicates its own
    // correction debates through its ratified agent.
    requestedCapabilities: ['moderate.flag', 'lawmaking.summarize', 'debate.judge'],
  };
  const proposed = await governance.proposeModel(
    GOVERNANCE_DEMO_ROOM_ID,
    steward,
    bundle,
    'Be neutral and concise; cite the community rule when you act, and never exceed your granted powers.',
    true, // the seeded steward is a room member (candidacy is a member power)
  );
  if (!proposed.ok) return;
  await governance.evaluateModel(proposed.value.modelId);
  const approved = await governance.approveModel(
    GOVERNANCE_DEMO_ROOM_ID,
    proposed.value.modelId,
    null,
    null,
  );
  if (!approved.ok) return;
  // A sample agent action so the "governed by" panel shows activity, referencing
  // a REAL contribution in the room (not a synthetic id). A direct moderate()
  // logs to the agent action log only (no review-queue hold).
  const subjectRef = await firstContributionRefInRoom(forum, ingestion, GOVERNANCE_DEMO_ROOM_ID);
  if (subjectRef !== null) {
    await governance.moderate(
      GOVERNANCE_DEMO_ROOM_ID,
      {
        contentText: 'check these out https://a.example https://b.example https://c.example',
        contentKind: 'comment',
        contentLength: 64,
        linkCount: 3,
        mentionCount: 0,
        hasMediaUpload: false,
        authorAccountAgeDays: 3,
        authorNewToRoom: true,
        priorRemovalsInRoom: 0,
      },
      subjectRef,
    );
  }
  // A Stage 4 lawmaking facilitation (a neutral proposal summary) so the panel
  // also shows the agent's lawmaking activity — capability-gated, deterministic.
  await governance.facilitateSummary(GOVERNANCE_DEMO_ROOM_ID, {
    proposalId: 'demo-proposal-1',
    title: 'Adopt a weekly community digest',
    body: 'Members propose an opt-in weekly digest summarising the most-discussed threads.',
    options: ['Adopt', 'Reject'],
  });
  // A SECOND eligible model put to an OPEN member ratification vote, so the dev
  // sees the member voting surface alongside the already-active agent (a steward
  // proposing an upgrade the community is currently ratifying).
  const upgrade = await governance.proposeModel(
    GOVERNANCE_DEMO_ROOM_ID,
    steward,
    { ...bundle, bundleId: 'demo-civility-v2', name: 'Community civility policy v2' },
    'Prefer a warning before a removal; otherwise as before.',
    true, // the seeded steward is a room member (candidacy is a member power)
  );
  if (!upgrade.ok) return;
  await governance.evaluateModel(upgrade.value.modelId);
  await governance.openRatification(GOVERNANCE_DEMO_ROOM_ID, steward, upgrade.value.modelId, null);
}
