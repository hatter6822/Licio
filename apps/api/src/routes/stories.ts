// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F public ingestion surface: POST /v1/stories (WS-F.1.4a), the
// claim/evidence read paths (WS-F.1.2a/2.5a navigability), the public source
// profile (§14.3 context-and-history — no truth score exists to expose),
// GET /v1/search (WS-F.3.1b), and the public takedown intake (WS-F.1.4f).
// Every response is re-validated against its shared schema on egress (the
// stated boundary guarantee), and all error bodies use the house
// `{ error: { code, message } }` shape.
import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import {
  type ClaimPublic,
  claimEvidenceResponseSchema,
  type EvidenceCardPublic,
  type SourcePublic,
  type StoryPublic,
  searchRequestSchema,
  searchResponseSchema,
  sourcePublicSchema,
  storyClaimsResponseSchema,
  storyCreateRequestSchema,
  storyCreateResponseSchema,
  storyDuplicateResponseSchema,
  storyPublicSchema,
  takedownCreateRequestSchema,
  takedownCreateResponseSchema,
  uuidSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { getEventPipelineServices } from '../events/services.js';
import { getIdentityServices } from '../identity/services.js';
import { getIngestionServices } from '../ingestion/services.js';
import type {
  ClaimRecord,
  EvidenceCardRecord,
  SourceRecord,
  StoryRecord,
} from '../ingestion/stores.js';
import { submitStory } from '../ingestion/submission.js';
import { rateLimit } from '../lib/rate-limit.js';
import { type AuthEnv, authMiddleware, getAuth } from '../middleware/auth.js';

const deny = (code: string, message: string) => ({ error: { code, message } });

/** Map a stored story to the public projection (the ONLY read shape). */
export function toStoryPublic(story: StoryRecord, threadId: string | null): StoryPublic {
  return storyPublicSchema.parse({
    story_id: story.storyId,
    title: story.title,
    submission_type: story.submissionType,
    canonical_url: story.canonicalUrl,
    source_id: story.sourceId,
    submitted_by: story.submittedBy,
    language: story.language,
    topic_ids: story.topicIds,
    location_scope: story.locationScope,
    sensitivity_labels: story.sensitivityLabels,
    lifecycle_state: story.lifecycleState,
    thread_id: threadId,
    excerpt: story.excerpt,
    publisher: story.publisher,
    author: story.author,
    published_at: story.publishedAt,
    media_type: story.mediaType,
    created_at: story.createdAt,
    updated_at: story.updatedAt,
  });
}

function toClaimPublic(claim: ClaimRecord): ClaimPublic {
  return {
    claim_id: claim.claimId,
    story_id: claim.storyId,
    canonical_text: claim.canonicalText,
    claim_status: claim.claimStatus,
    first_seen_story_id: claim.firstSeenStoryId,
    independence_group_id: claim.independenceGroupId,
    extraction_source: claim.extractionSource,
    created_at: claim.createdAt,
    updated_at: claim.updatedAt,
  };
}

function toEvidencePublic(card: EvidenceCardRecord): EvidenceCardPublic {
  return {
    evidence_id: card.evidenceId,
    claim_id: card.claimId,
    source_id: card.sourceId,
    submitted_by: card.submittedBy,
    evidence_type: card.evidenceType,
    citation_url_or_ref: card.citationUrlOrRef,
    relevance_note: card.relevanceNote,
    verification_state: card.verificationState,
    independence_group_id: card.independenceGroupId,
    created_at: card.createdAt,
  };
}

function toSourcePublic(source: SourceRecord): SourcePublic {
  return sourcePublicSchema.parse({
    source_id: source.sourceId,
    name: source.name,
    canonical_domain: source.canonicalDomain,
    publisher_lineage: source.publisherLineage,
    typical_topics: source.typicalTopics,
    correction_history: source.correctionHistory,
    evidence_type_frequency: source.evidenceTypeFrequency,
    community_notes: source.communityNotes,
    display_restrictions: source.displayRestrictions,
    created_at: source.createdAt,
    updated_at: source.updatedAt,
  });
}

export function createStoriesRoutes() {
  return (
    new Hono<AuthEnv>()
      // --- Story submission (WS-F.1.4a) ----------------------------------
      .post(
        '/stories',
        authMiddleware(),
        zValidator('json', storyCreateRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const ingestion = getIngestionServices();
          const outcome = await submitStory(
            ingestion,
            getEventPipelineServices(),
            getIdentityServices(),
            auth.userId,
            c.req.valid('json'),
          );
          if (!outcome.ok) {
            const rejection = outcome.rejection;
            if (rejection.status === 429) {
              c.header('Retry-After', String(rejection.retryAfterSec));
              return c.json(deny(rejection.code, rejection.message), 429);
            }
            if (rejection.status === 409) {
              return c.json(
                storyDuplicateResponseSchema.parse({
                  error: { code: 'duplicate_story', message: rejection.message },
                  existing_story_id: rejection.existingStoryId,
                }),
                409,
              );
            }
            return c.json(deny(rejection.code, rejection.message), rejection.status);
          }
          return c.json(
            storyCreateResponseSchema.parse({
              story: toStoryPublic(outcome.story, outcome.threadId),
              story_id: outcome.story.storyId,
              thread_id: outcome.threadId,
              lifecycle_state: outcome.story.lifecycleState,
              similar_story_ids: outcome.similarStoryIds,
              review_flags: outcome.reviewFlags,
            }),
            201,
          );
        },
      )

      // --- Claim/evidence navigability (WS-F.1.2a / WS-F.2.5a) -----------
      .get(
        '/stories/:storyId/claims',
        zValidator('param', z.object({ storyId: uuidSchema })),
        async (c) => {
          const ingestion = getIngestionServices();
          const story = await ingestion.stories.getById(c.req.valid('param').storyId);
          if (!story || story.hiddenState !== null) {
            return c.json(deny('not_found', 'Resource not found'), 404);
          }
          const claims = await ingestion.claims.listByStory(story.storyId);
          return c.json(
            storyClaimsResponseSchema.parse({ items: claims.slice(0, 100).map(toClaimPublic) }),
          );
        },
      )
      .get(
        '/claims/:claimId/evidence',
        zValidator('param', z.object({ claimId: uuidSchema })),
        async (c) => {
          const ingestion = getIngestionServices();
          const claim = await ingestion.claims.getById(c.req.valid('param').claimId);
          if (!claim) return c.json(deny('not_found', 'Resource not found'), 404);
          const cards = await ingestion.evidence.listByClaim(claim.claimId);
          return c.json(
            claimEvidenceResponseSchema.parse({
              claim: toClaimPublic(claim),
              items: cards
                .filter((card) => card.verificationState !== 'retracted')
                .slice(0, 200)
                .map(toEvidencePublic),
            }),
          );
        },
      )

      // --- Public source profile (§14.3: context + history) ---------------
      .get(
        '/sources/:sourceId',
        zValidator('param', z.object({ sourceId: uuidSchema })),
        async (c) => {
          const ingestion = getIngestionServices();
          const source = await ingestion.sources.getById(c.req.valid('param').sourceId);
          if (!source) return c.json(deny('not_found', 'Resource not found'), 404);
          return c.json(toSourcePublic(source));
        },
      )

      // --- Search (WS-F.3.1b): public, rate-limited, visibility-filtered ---
      .get(
        '/search',
        rateLimit({ limit: 300, windowMs: 60_000 }),
        zValidator('query', searchRequestSchema),
        async (c) => {
          const ingestion = getIngestionServices();
          const result = await ingestion.searchIndex.search(c.req.valid('query'));
          ingestion.metrics.increment('search.requests');
          return c.json(
            searchResponseSchema.parse({ items: result.items, nextCursor: result.nextCursor }),
          );
        },
      )

      // --- Takedown intake (WS-F.1.4f): PUBLIC, structured, rate-limited ---
      // A rights holder need not hold an account; the global budget bounds
      // abuse and review (WS-J.2 seam) gates any action.
      .post(
        '/takedowns',
        rateLimit({ limit: 30, windowMs: 60_000 }),
        zValidator('json', takedownCreateRequestSchema),
        async (c) => {
          const ingestion = getIngestionServices();
          const request = c.req.valid('json');
          const record = await ingestion.takedowns.insert({
            takedownId: randomUUID(),
            targetType: request.target_type,
            targetId: request.target_id,
            requesterContact: request.requester_contact,
            legalBasis: request.legal_basis,
            claimDetail: request.claim_detail,
            status: 'received',
            resolutionNote: null,
            actionedBy: null,
            actionedAt: null,
          });
          ingestion.metrics.increment('takedowns.received');
          ingestion.log('ingestion.takedown_received', {
            takedown_id: record.takedownId,
            target_type: record.targetType,
          });
          return c.json(
            takedownCreateResponseSchema.parse({
              takedown_id: record.takedownId,
              status: 'received',
            }),
            202,
          );
        },
      )
  );
}

export type StoriesRoutes = ReturnType<typeof createStoriesRoutes>;
