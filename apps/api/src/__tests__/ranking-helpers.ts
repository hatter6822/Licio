// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared WS-I test fixtures: fresh in-memory bundles across the five service
// containers (identity, events, ingestion, forum, invariants, ranking),
// installed as the module singletons, plus story/invariant-output seeders.

import { randomUUID } from 'node:crypto';
import {
  createInMemoryEventPipelineServices,
  type EventPipelineServices,
  type InMemoryEventServicesOptions,
  setEventPipelineServices,
} from '../events/services.js';
import type { InvariantOutputRecord } from '../events/stores.js';
import {
  createInMemoryForumServices,
  type ForumServices,
  setForumServices,
} from '../forum/services.js';
import {
  createInMemoryIdentityServices,
  type IdentityServices,
  setIdentityServices,
} from '../identity/services.js';
import {
  createInMemoryIngestionServices,
  type IngestionServices,
  setIngestionServices,
} from '../ingestion/services.js';
import type { StoryRecord } from '../ingestion/stores.js';
import {
  createInMemoryInvariantServices,
  type InvariantPlatformServices,
  setInvariantServices,
} from '../invariants/services.js';
import {
  createInMemoryRankingServices,
  type RankingServices,
  type RankingServicesOptions,
  resetRankingServices,
  setRankingServices,
} from '../ranking/services.js';
import { TEST_IDENTITY_CONFIG } from './ws-e-helpers.js';

export interface RankingFixture {
  identity: IdentityServices;
  events: EventPipelineServices;
  ingestion: IngestionServices;
  forum: ForumServices;
  invariants: InvariantPlatformServices;
  ranking: RankingServices;
}

/** Fresh in-memory bundles installed as the module singletons. */
export function freshRankingServices(
  eventOptions: InMemoryEventServicesOptions = {},
  rankingOptions: RankingServicesOptions = {},
): RankingFixture {
  resetRankingServices();
  const identity = createInMemoryIdentityServices(TEST_IDENTITY_CONFIG);
  const events = createInMemoryEventPipelineServices(eventOptions);
  const ingestion = createInMemoryIngestionServices({ events });
  const forum = createInMemoryForumServices({ events, ingestion });
  const invariants = createInMemoryInvariantServices(events, identity, ingestion, forum);
  const ranking = createInMemoryRankingServices(
    events,
    identity,
    ingestion,
    forum,
    invariants,
    rankingOptions,
  );
  setIdentityServices(identity);
  setEventPipelineServices(events);
  setIngestionServices(ingestion);
  setForumServices(forum);
  setInvariantServices(invariants);
  setRankingServices(ranking);
  return { identity, events, ingestion, forum, invariants, ranking };
}

export interface SeedStoryOptions {
  title?: string;
  topicIds?: string[];
  sourceId?: string | null;
  /** Controls the candidate freshness timestamp deterministically. */
  publishedAt?: string;
  sensitivityLabels?: StoryRecord['sensitivityLabels'];
  lifecycleState?: StoryRecord['lifecycleState'];
  hiddenState?: StoryRecord['hiddenState'];
  locationScope?: StoryRecord['locationScope'];
  submittedBy?: string;
  canonicalUrl?: string | null;
  roomId?: string | null;
}

export interface SeededStory {
  storyId: string;
  threadId: string;
}

/** Seed one story (+ thread shell) directly through the real store. */
export async function seedStory(
  ingestion: IngestionServices,
  options: SeedStoryOptions = {},
): Promise<SeededStory> {
  const storyId = randomUUID();
  const threadId = randomUUID();
  const outcome = await ingestion.stories.createWithThread(
    {
      storyId,
      canonicalUrl: options.canonicalUrl ?? `https://example.org/${storyId}`,
      title: options.title ?? `Story ${storyId.slice(0, 8)}`,
      titleHash: `hash-${storyId}`,
      submittedBy: options.submittedBy ?? randomUUID(),
      sourceId: options.sourceId === undefined ? null : options.sourceId,
      language: 'en',
      topicIds: options.topicIds ?? ['civics'],
      locationScope: options.locationScope ?? null,
      sensitivityLabels: options.sensitivityLabels ?? [],
      lifecycleState: options.lifecycleState ?? 'gathering_attention',
      submissionType: 'link',
      submissionMetadata: {
        submission_type: 'link',
        url: options.canonicalUrl ?? `https://example.org/${storyId}`,
        reason: 'test seed',
      } as unknown as StoryRecord['submissionMetadata'],
      excerpt: 'A short excerpt for reading-minute estimation purposes.',
      publisher: 'Example Publisher',
      author: null,
      publishedAt: options.publishedAt ?? new Date().toISOString(),
      mediaType: 'article',
      extractionState: 'completed',
      hiddenState: options.hiddenState ?? null,
    },
    threadId,
  );
  if (!outcome.ok) throw new Error(`seedStory failed: ${outcome.reason}`);
  if (options.roomId !== undefined && options.roomId !== null) {
    await ingestion.stories.updateThread(threadId, { roomId: options.roomId });
  }
  return { storyId, threadId };
}

/** Insert one invariant output row (the WS-H artifact ranking joins on). */
export async function seedInvariantOutput(
  events: EventPipelineServices,
  partial: Partial<InvariantOutputRecord> & {
    invariantType: string;
    targetId: string;
    scoreVector: Record<string, unknown>;
  },
): Promise<void> {
  await events.invariantStore.upsert({
    targetType: 'story',
    timeWindow: {
      start: '2026-06-10T00:00:00.000Z',
      end: '2026-06-10T01:00:00.000Z',
    },
    version: '1.0.0',
    explanationSummary: null,
    confidence: 1,
    coverage: 1,
    reasonCodes: [],
    fallbackUsed: false,
    versionMetadata: { config: 'test' },
    shadowMode: true,
    createdAt: new Date().toISOString(),
    ...partial,
  });
}

/** Promote one invariant out of shadow (append the WS-H.1.2e record). */
export async function promoteInvariant(
  invariants: InvariantPlatformServices,
  invariantType: string,
): Promise<void> {
  await invariants.promotions.append({
    invariantType,
    fromStatus: 'shadow',
    toStatus: 'soft_constraint',
    evidence: {
      shadowDurationDays: 30,
      driftReportRef: 'test-drift-report',
      observedCoverage: 0.95,
      observedConfidence: 0.95,
    },
    owner: 'test-owner',
    createdAt: new Date().toISOString(),
  });
}
