// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F public ingestion surface: POST /v1/stories (WS-F.1.4a), the public
// source profile (§14.3 context-and-history — no truth score exists to
// expose), GET /v1/search (WS-F.3.1b), and the public takedown intake
// (WS-F.1.4f).
// Every response is re-validated against its shared schema on egress (the
// stated boundary guarantee), and all error bodies use the house
// `{ error: { code, message } }` shape.
import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import {
  isSentinelTopicId,
  type SourcePublic,
  type StoryPublic,
  searchRequestSchema,
  searchResponseSchema,
  sourcePublicSchema,
  storyCreateRequestSchema,
  storyCreateResponseSchema,
  storyDuplicateResponseSchema,
  storyPublicSchema,
  storyVisibilityPatchRequestSchema,
  takedownCreateRequestSchema,
  takedownCreateResponseSchema,
  uuidSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { getEventPipelineServices } from '../events/services.js';
import { roomContentVisibleToUser, storyReadableByUser } from '../forum/rooms.js';
import { getForumServices } from '../forum/services.js';
import { viewerHideSet } from '../forum/threads.js';
import { getIdentityServices } from '../identity/services.js';
import { readSessionToken, validateSession } from '../identity/sessions.js';
import { getIngestionServices } from '../ingestion/services.js';
import type { SourceRecord, StoryRecord } from '../ingestion/stores.js';
import { submitStory } from '../ingestion/submission.js';
import { changeStoryVisibility } from '../ingestion/visibility.js';
import { rateLimit } from '../lib/rate-limit.js';
import { type AuthEnv, authMiddleware, getAuth, requireUnrestricted } from '../middleware/auth.js';

const deny = (code: string, message: string) => ({ error: { code, message } });

/** Map a stored story to the public projection (the ONLY read shape). */
export function toStoryPublic(story: StoryRecord, threadId: string | null): StoryPublic {
  // WS-Q — the image post's required alt text is the accessible media text;
  // video captions are carried separately (the player renders them).
  const mediaAltText =
    story.submissionMetadata.submission_type === 'image_post'
      ? story.submissionMetadata.alt_text
      : null;
  return storyPublicSchema.parse({
    story_id: story.storyId,
    title: story.title,
    submission_type: story.submissionType,
    canonical_url: story.canonicalUrl,
    source_id: story.sourceId,
    room_id: story.roomId,
    visibility: story.visibility,
    media_upload_ref: story.mediaUploadRef,
    media_alt_text: mediaAltText,
    canonical_public_story_id: story.canonicalPublicStoryId,
    submitted_by: story.submittedBy,
    language: story.language,
    // Never surface the UNCLASSIFIED sentinel as a topic on the wire (it is not
    // a subject topic — no topic chip / repeats control for it).
    topic_ids: story.topicIds.filter((id) => !isSentinelTopicId(id)),
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

function toSourcePublic(source: SourceRecord): SourcePublic {
  return sourcePublicSchema.parse({
    source_id: source.sourceId,
    name: source.name,
    canonical_domain: source.canonicalDomain,
    publisher_lineage: source.publisherLineage,
    typical_topics: source.typicalTopics,
    correction_history: source.correctionHistory,
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
        requireUnrestricted(),
        zValidator('json', storyCreateRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const ingestion = getIngestionServices();
          const outcome = await submitStory(
            ingestion,
            getEventPipelineServices(),
            getIdentityServices(),
            getForumServices(),
            auth.userId,
            c.req.valid('json'),
          );
          if (!outcome.ok) {
            const rejection = outcome.rejection;
            if (rejection.status === 429) {
              c.header('Retry-After', String(rejection.retryAfterSec));
              return c.json(deny(rejection.code, rejection.message), 429);
            }
            // WS-S.1.3 — a P2P-room submission is a non-duplicate 409 carrying
            // no existing-story id; discriminate by code so it serializes as a
            // plain error, not the duplicate-story shape.
            if (rejection.status === 409 && rejection.code === 'duplicate_story') {
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

      // --- Author visibility transition (WS-Q.2.4a/b) --------------------
      .patch(
        '/stories/:storyId/visibility',
        authMiddleware(),
        zValidator('param', z.object({ storyId: uuidSchema })),
        zValidator('json', storyVisibilityPatchRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          // A `restricted` account may NARROW (retract) its own content but not
          // WIDEN it to the public tier — widening increases public reach and is
          // a public-contribution attempt (WS-J `restrict`).  Narrowing only
          // reduces exposure, so it stays available.
          if (auth.accountState === 'restricted' && c.req.valid('json').visibility === 'public') {
            return c.json(
              deny('account_restricted', 'Your account is restricted from posting'),
              403,
            );
          }
          const outcome = await changeStoryVisibility(
            getIngestionServices(),
            getEventPipelineServices(),
            getIdentityServices(),
            getForumServices(),
            auth.userId,
            c.req.valid('param').storyId,
            c.req.valid('json').visibility,
          );
          if (!outcome.ok) {
            if (outcome.status === 409) {
              return c.json(
                storyDuplicateResponseSchema.parse({
                  error: { code: 'duplicate_story', message: outcome.message },
                  existing_story_id: outcome.existingStoryId,
                }),
                409,
              );
            }
            return c.json(deny(outcome.code, outcome.message), outcome.status);
          }
          return c.json({ visibility: outcome.visibility, changed: outcome.changed });
        },
      )

      // DEPRECATED — rollout compatibility only. The public claim projection
      // (WS-F.1.2a claim navigability) was removed with the
      // independent-sources drawer — comment-centric sourcing superseded it —
      // but pre-removal cached bundles still call this path when the stale
      // drawer opens, so it keeps serving the CONSTANT empty payload (uniform
      // for any UUID — no existence oracle, no content) until those bundles
      // age out (remove with the drawer's other compat artifacts, tracked in
      // docs/ranking/README.md). The claim MODEL is unchanged; claims +
      // independence groups stay MERI/WS-K inputs.
      .get(
        '/stories/:storyId/claims',
        zValidator('param', z.object({ storyId: uuidSchema })),
        (c) => c.json({ items: [] }),
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
          const forum = getForumServices();
          const query = c.req.valid('query');
          // Resolve the OPTIONAL viewer once: the room read bar and the
          // WS-J.1.2 comment hide set both key off it. Anonymous callers are
          // always served (never rejected) — userId stays null on any failure.
          const identity = getIdentityServices();
          const token = readSessionToken(c.req.header('cookie'));
          let userId: string | null = null;
          if (token) {
            try {
              userId = (await validateSession(identity.sessions, token))?.record.user_id ?? null;
            } catch {
              userId = null;
            }
          }
          // WS-Q.2.5b — a room-scoped query must pass the room read bar first
          // (existence is tier one; CONTENT search is tier two → 404 otherwise).
          if (query.room !== undefined) {
            const room = await forum.rooms.getById(query.room);
            if (room === null || !(await roomContentVisibleToUser(forum, room, userId))) {
              return c.json(deny('not_found', 'Resource not found'), 404);
            }
          }
          // WS-T.7.3 — a story-scoped query searches that story's conversation,
          // so it must pass the SAME item read bar every direct story/comment
          // read enforces (WS-Q.3.2 `storyReadableByUser`): a hidden story, an
          // unknown id, or a private room the caller is not in is a 404, never
          // an empty result set (which would leak existence).
          if (query.story !== undefined) {
            const story = await ingestion.stories.getById(query.story);
            const room = story === null ? null : await forum.rooms.getById(story.roomId);
            if (
              story === null ||
              room === null ||
              !(await storyReadableByUser(forum, story, room, userId))
            ) {
              return c.json(deny('not_found', 'Resource not found'), 404);
            }
          }
          // WS-J.1.2 — a blocked∪muted author's comments never surface for
          // this viewer: the SAME hide set the comment read path enforces
          // (viewerHideSet + visibleRows), so search cannot resurface what
          // the destination surface hides.
          const hide = await viewerHideSet({ forum, ingestion }, userId);
          const result = await ingestion.searchIndex.search(
            query,
            hide !== undefined ? { hiddenAuthorIds: hide } : undefined,
          );
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
