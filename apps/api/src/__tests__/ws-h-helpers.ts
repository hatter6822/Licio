// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared WS-H test fixtures: the full in-memory WS-D/E/F/G bundle plus the
// invariant platform (installed as the module singleton) with its consumers
// and hook closures registered.
import { randomUUID } from 'node:crypto';
import type { SensitivityLabel } from '@licio/shared';
import {
  createInMemoryInvariantServices,
  type InvariantPlatformServices,
  registerInvariantConsumers,
  setInvariantServices,
} from '../invariants/services.js';
import {
  freshWsGServices,
  seedThread,
  seedUserWithSession,
  type WsGFixture,
} from './ws-g-helpers.js';

export { seedThread, seedUserWithSession };

export interface WsHFixture extends WsGFixture {
  invariants: InvariantPlatformServices;
}

export function freshWsHServices(
  options: Parameters<typeof freshWsGServices>[0] & {
    invariantsNow?: () => number;
  } = {},
): WsHFixture {
  const base = freshWsGServices(options);
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
  fixture: WsHFixture,
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
