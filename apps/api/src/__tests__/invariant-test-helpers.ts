// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Invariant-platform in-memory test fixtures: the full identity/events/
// ingestion/forum bundle plus the invariant platform (module singleton) with its
// and hook closures registered.
import { randomUUID } from 'node:crypto';
import { COMMONS_ROOM_ID, type SensitivityLabel } from '@licio/shared';
import {
  createInMemoryInvariantServices,
  type InvariantPlatformServices,
  registerInvariantConsumers,
  setInvariantServices,
} from '../invariants/services.js';
import {
  type ForumServicesFixture,
  freshForumServices,
  seedThread,
  seedUserWithSession,
} from './forum-test-helpers.js';

export { seedThread, seedUserWithSession };

export interface InvariantServicesFixture extends ForumServicesFixture {
  invariants: InvariantPlatformServices;
}

export function freshInvariantServices(
  options: Parameters<typeof freshForumServices>[0] & {
    invariantsNow?: () => number;
  } = {},
): InvariantServicesFixture {
  const base = freshForumServices(options);
  const invariants = createInMemoryInvariantServices(
    base.events,
    base.identity,
    base.ingestion,
    base.forum,
    options.invariantsNow ? { now: options.invariantsNow } : {},
  );
  setInvariantServices(invariants);
  registerInvariantConsumers(base.events, base.ingestion, base.identity, invariants);
  return { ...base, invariants };
}

/** Seed a story with explicit grouping inputs for MERI assembly. */
export async function seedStory(
  fixture: InvariantServicesFixture,
  options: {
    storyId?: string;
    canonicalUrl?: string | null;
    title?: string;
    sourceId?: string | null;
    topicIds?: string[];
    sensitivityLabels?: SensitivityLabel[];
  } = {},
): Promise<{ storyId: string; threadId: string }> {
  const storyId = options.storyId ?? randomUUID();
  const threadId = randomUUID();
  const created = await fixture.ingestion.stories.createWithThread(
    {
      storyId,
      canonicalUrl: options.canonicalUrl ?? null,
      title: options.title ?? `Story ${storyId.slice(0, 8)}`,
      titleHash: `hash-${storyId}`,
      submittedBy: randomUUID(),
      sourceId: options.sourceId ?? null,
      roomId: COMMONS_ROOM_ID,
      visibility: 'public',
      mediaUploadRef: null,
      canonicalPublicStoryId: null,
      language: 'en',
      topicIds: options.topicIds ?? ['topic-default'],
      locationScope: null,
      sensitivityLabels: options.sensitivityLabels ?? [],
      lifecycleState: 'gathering_attention',
      submissionType: 'original_brief',
      submissionMetadata: { submission_type: 'original_brief', body: 'Seed body.' },
      excerpt: null,
      publisher: null,
      author: null,
      publishedAt: null,
      mediaType: null,
      extractionState: 'pending',
      hiddenState: null,
    },
    threadId,
  );
  if (!created.ok) throw new Error(`seedStory failed: ${created.reason}`);
  return { storyId, threadId };
}
