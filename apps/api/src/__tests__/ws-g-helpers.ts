// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared WS-G test fixtures: a fresh in-memory identity + events + ingestion
// + FORUM bundle (installed as the module singletons), plus canonical thread
// and contribution builders.  `settle()` on both bundles makes detached event
// publication deterministic in tests.
import { randomUUID } from 'node:crypto';
import type { ContributionCreate } from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import type { ForumRuntimeConfig } from '../forum/config.js';
import {
  createInMemoryForumServices,
  type ForumServices,
  setForumServices,
} from '../forum/services.js';
import type { IdentityServices } from '../identity/services.js';
import type { IngestionRuntimeConfig } from '../ingestion/config.js';
import type { IngestionServices } from '../ingestion/services.js';
import { freshWsFServices, seedUserWithSession, type WsFFixture } from './ws-f-helpers.js';

export { seedUserWithSession };

export interface WsGFixture extends WsFFixture {
  forum: ForumServices;
  /** Settle BOTH detached queues (ingestion pipeline + forum events). */
  settleAll: () => Promise<void>;
}

export function freshWsGServices(
  options: {
    config?: Partial<IngestionRuntimeConfig>;
    forumConfig?: Partial<ForumRuntimeConfig>;
    now?: () => number;
  } = {},
): WsGFixture {
  const base = freshWsFServices({
    ...(options.config ? { config: options.config } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const forum = createInMemoryForumServices({
    events: base.events,
    ingestion: base.ingestion,
    ...(options.forumConfig ? { config: options.forumConfig } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  setForumServices(forum);
  return {
    ...base,
    forum,
    settleAll: async () => {
      await base.ingestion.settle();
      await forum.settle();
    },
  };
}

/** Create a story (with its thread shell) directly through the stores. */
export async function seedThread(
  fixture: { ingestion: IngestionServices },
  options: { storyId?: string; threadId?: string; roomId?: string | null; title?: string } = {},
): Promise<{ storyId: string; threadId: string }> {
  const storyId = options.storyId ?? randomUUID();
  const threadId = options.threadId ?? randomUUID();
  const created = await fixture.ingestion.stories.createWithThread(
    {
      storyId,
      canonicalUrl: null,
      title: options.title ?? `Story ${storyId.slice(0, 8)}`,
      titleHash: `hash-${storyId}`,
      submittedBy: randomUUID(),
      sourceId: null,
      language: 'en',
      topicIds: [randomUUID()],
      locationScope: null,
      sensitivityLabels: [],
      lifecycleState: 'gathering_attention',
      submissionType: 'original_brief',
      submissionMetadata: { submission_type: 'original_brief', body: 'Seed body.' },
      excerpt: 'Seed body.',
      publisher: null,
      author: null,
      publishedAt: null,
      mediaType: null,
      extractionState: 'not_applicable',
      hiddenState: null,
    },
    threadId,
  );
  if (!created.ok) throw new Error('seedThread: story creation failed');
  if (options.roomId !== undefined && options.roomId !== null) {
    await fixture.ingestion.stories.updateThread(threadId, { roomId: options.roomId });
  }
  return { storyId, threadId };
}

/** Seed a claim (target for evidence/correction/counterexample). */
export async function seedClaim(
  fixture: { ingestion: IngestionServices },
  storyId: string | null = null,
): Promise<string> {
  const claim = await fixture.ingestion.claims.insert({
    claimId: randomUUID(),
    storyId,
    canonicalText: 'The reservoir level fell by 12% in May.',
    normalizedTextHash: randomUUID().replaceAll('-', ''),
    claimStatus: 'candidate',
    firstSeenStoryId: storyId,
    independenceGroupId: null,
    createdBy: null,
    extractionSource: 'system',
    extractionConfidence: null,
    modelVersion: null,
  });
  return claim.claimId;
}

/** A valid create body for the given type, against a seeded thread/claim. */
export function contributionBody(
  type: ContributionCreate['type'],
  threadId: string,
  extra: { claimId?: string; parentId?: string; targetId?: string } = {},
): Record<string, unknown> {
  const base = { thread_id: threadId, client_draft_id: `draft-${randomUUID()}` };
  const citation = { url: 'https://example.org/source' };
  switch (type) {
    case 'question':
      return { ...base, type, body: 'What evidence supports the employment claim?' };
    case 'answer':
      return {
        ...base,
        type,
        body: 'Table 3 of the labor report.',
        parent_contribution_id: extra.parentId,
      };
    case 'evidence':
      return {
        ...base,
        type,
        body: 'Primary dataset for the claim.',
        citations: [citation],
        target_claim_id: extra.claimId,
        evidence_type: 'dataset',
      };
    case 'correction':
      return {
        ...base,
        type,
        body: 'The date is wrong; the vote was on Wednesday.',
        target_claim_id: extra.claimId,
        citations: [citation],
        target_text_excerpt: 'on Tuesday evening',
      };
    case 'synthesis':
      return {
        ...base,
        type,
        body: 'Both branches agree the dataset is authentic.',
        included_branch_ids: [extra.parentId, extra.targetId].filter(Boolean),
      };
    case 'counterexample':
      return {
        ...base,
        type,
        body: 'County B adopted the same policy with the opposite result.',
        target_claim_id: extra.claimId,
        relevance_explanation: 'Same policy, different outcome.',
      };
    case 'explanation':
      return { ...base, type, body: 'The statute defines this term narrowly.' };
    case 'local_context':
      return {
        ...base,
        type,
        body: 'The intersection floods every spring.',
        scope: 'Riverside resident',
      };
    case 'direct_experience':
      return {
        ...base,
        type,
        body: 'I attended the hearing and the room was full.',
        scope: 'Hearing attendee',
        privacy_acknowledged: true,
      };
    case 'moderation_concern':
      return {
        ...base,
        type,
        body: 'This is targeted harassment of a named person.',
        target_contribution_id: extra.targetId,
        reason_code: 'MOD_HARASS_001',
        urgency: 'normal',
      };
    case 'meta_discussion':
      return { ...base, type, body: 'Should these two branches be merged?' };
  }
}

export function jsonRequest(path: string, method: string, body: unknown, cookie?: string): Request {
  return new Request(`http://local${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie !== undefined ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

export type { EventPipelineServices, IdentityServices };
