// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G forum routes (SPEC §23.2): thread reading (overview/branches/subtree/
// anchor), contribution create/edit/remove, standalone evidence cards,
// summaries, feed preferences, uploads, the drainer blocklist, and the
// steward surface (thread-state transitions, forum config, metrics).
//
// Every response is re-validated against the shared schema on egress (the
// WS-C.1.2 boundary guarantee); logs and metrics carry ids and counts only.
import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import {
  branchContentSchema,
  branchIdSchema,
  contributionAnchorSchema,
  contributionCreateResponseSchema,
  contributionCreateSchema,
  contributionPublicSchema,
  contributionSubtreeSchema,
  contributionUpdateSchema,
  evidenceAddedEventSchema,
  evidenceCreateRequestSchema,
  evidenceCreateResponseSchema,
  feedPreferencesPatchSchema,
  feedPreferencesSchema,
  linkBlocklistResponseSchema,
  MAX_CAPTION_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  personalizationSettingsSchema,
  privacyNotificationPreferencesSchema,
  privacySettingsSchema,
  summaryCreateRequestSchema,
  summaryPublicSchema,
  type ThreadSafetyState,
  type ThreadSummary,
  TOPIC_REGISTRY,
  threadConversationStateSchema,
  threadDetailSchema,
  threadListResponseSchema,
  threadSafetyStateSchema,
  threadSummarySchema,
  UPLOAD_CAPTION_TYPES,
  UPLOAD_DOCUMENT_TYPES,
  UPLOAD_IMAGE_TYPES,
  UPLOAD_VIDEO_TYPES,
  uploadPublicSchema,
  uuidSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { getEventPipelineServices } from '../events/services.js';
import {
  FORUM_CONFIG_KEYS,
  storeForumConfigValue,
  validateForumConfigValue,
} from '../forum/config.js';
import {
  createContribution,
  editContribution,
  mapCardTypeToEventType,
  removeContribution,
  threadOnGlobalDirectory,
  threadReadableToUser,
} from '../forum/contributions.js';
import { stripUploadMetadata } from '../forum/exif.js';
import { getForumServices } from '../forum/services.js';
import type { ContributionRecord, UploadRecord } from '../forum/stores.js';
import { createSummary } from '../forum/summaries.js';
import {
  branchContent,
  contributionAnchor,
  subtreeContent,
  threadOverview,
  toContributionPublic,
  toSummaryPublic,
  viewerHideSet,
  visibleRows,
} from '../forum/threads.js';
import { applyConversationTransition, applyThreadSafetyTransition } from '../forum/transitions.js';
import { probeVideo } from '../forum/video.js';
import { accountRef } from '../identity/crypto.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { readSessionToken, validateSession } from '../identity/sessions.js';
import { getIngestionServices } from '../ingestion/services.js';
import type { ThreadShellRecord } from '../ingestion/stores.js';
import { verifyMediaToken } from '../lib/media-urls.js';
import {
  type AuthEnv,
  authMiddleware,
  getAuth,
  requireSteward,
  requireUnrestricted,
  requireVerifiedAccount,
} from '../middleware/auth.js';

const deny = (code: string, message: string) => ({ error: { code, message } });
const notFound = deny('not_found', 'Resource not found');

/**
 * Parse a single-range `Range: bytes=…` header against a known content length.
 * Returns the inclusive `{ start, end }`, `'unsatisfiable'` (→ 416), or null
 * (absent/invalid/multi-range ⇒ serve the full body, per RFC 9110 §14.2).
 */
function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or malformed ⇒ full body
  const startRaw = m[1] ?? '';
  const endRaw = m[2] ?? '';
  let start: number;
  let end: number;
  if (startRaw === '') {
    // Suffix range `bytes=-N`: the last N bytes.
    if (endRaw === '') return null;
    const suffix = Number(endRaw);
    if (suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return 'unsatisfiable';
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

/** Soft session read: user id when a valid cookie is present, else null. */
async function softUserId(
  cookieHeader: string | undefined,
  identity: IdentityServices,
): Promise<string | null> {
  const token = readSessionToken(cookieHeader);
  if (!token) return null;
  try {
    const validated = await validateSession(identity.sessions, token);
    return validated?.record.user_id ?? null;
  } catch {
    return null;
  }
}

/** Per-request author resolver with a memo (no N+1 on a 50-row page). */
function makeAuthorResolver(identity: IdentityServices) {
  const memo = new Map<string, { handle: string; displayName: string } | null>();
  return async (userId: string | null) => {
    if (userId === null) return null;
    const cached = memo.get(userId);
    if (cached !== undefined) return cached;
    const user = await identity.store.getUser(userId);
    const resolved = user ? { handle: user.handle, displayName: user.displayName } : null;
    memo.set(userId, resolved);
    return resolved;
  };
}

/** Bundle the three service containers a forum handler needs. */
function bundles() {
  return {
    forum: getForumServices(),
    ingestion: getIngestionServices(),
    events: getEventPipelineServices(),
  };
}

export function createForumRoutes() {
  return (
    new Hono<AuthEnv>()
      // --- Thread directory (WS-G.3.3) ---------------------------------------
      // The listing behind the primary `/threads` tab: a keyset page of the
      // PUBLIC conversations, most recent first.  Mirrors the rooms-directory
      // scan (rooms.ts) AND the feed's two-condition global containment
      // (filterByVisibility): walk the store-level `(created_at, thread_id)`
      // keyset in bounded batches until a full VISIBLE page accumulates —
      // `threadOnGlobalDirectory` keeps it to PUBLIC items from PUBLIC rooms,
      // dropping hidden stories, room_only items, private-room threads, and
      // moderation-removed threads — so no fixed fetch prefix can strand a
      // listable conversation and a filtered-out thread never stalls the walk.
      // The set is USER-INDEPENDENT (room-scoped conversations are reached
      // through their room), exactly like the front-page feed.
      .get(
        '/threads',
        zValidator('query', z.object({ cursor: z.string().min(1).max(512).optional() })),
        async (c) => {
          const { cursor } = c.req.valid('query');
          const bundle = bundles();
          const pageSize = bundle.forum.config().roomPageSize;

          // Recover the keyset position from the opaque cursor (the last thread
          // id of the previous page); an unknown cursor restarts from the top
          // (defensive, never an error — the branch/subtree cursor semantics).
          let before: { createdAt: string; threadId: string } | null = null;
          if (cursor !== undefined) {
            const last = await bundle.ingestion.stories.getThreadById(cursor);
            if (last) before = { createdAt: last.createdAt, threadId: last.threadId };
          }

          const visible: ThreadShellRecord[] = [];
          let exhausted = false;
          const BATCH = 200;
          const MAX_BATCHES = 25;
          for (let scan = 0; scan < MAX_BATCHES && visible.length <= pageSize; scan += 1) {
            const batch = await bundle.ingestion.stories.listThreads(before, BATCH);
            for (const thread of batch) {
              if (visible.length > pageSize) break;
              if (await threadOnGlobalDirectory(bundle, thread)) visible.push(thread);
            }
            const lastScanned = batch[batch.length - 1];
            if (!lastScanned || batch.length < BATCH) {
              exhausted = true;
              break;
            }
            before = { createdAt: lastScanned.createdAt, threadId: lastScanned.threadId };
          }
          const page = visible.slice(0, pageSize);
          const last = page[page.length - 1];
          const nextCursor =
            (visible.length > pageSize || !exhausted) && last ? last.threadId : null;

          const items: ThreadSummary[] = [];
          for (const thread of page) {
            const story = await bundle.ingestion.stories.getById(thread.storyId);
            if (!story) continue; // a thread can never outlive its story; defensive.
            const counts = await bundle.forum.contributions.countByType(thread.threadId, [
              'published',
            ]);
            const contributionCount = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
            items.push(
              threadSummarySchema.parse({
                thread_id: thread.threadId,
                story_id: thread.storyId,
                room_id: thread.roomId,
                branch_index: thread.branchIndex,
                title: story.title,
                conversation_state: thread.conversationState,
                safety_state: thread.safetyState,
                contribution_count: contributionCount,
                created_at: thread.createdAt,
                updated_at: thread.updatedAt,
              }),
            );
          }
          return c.json(threadListResponseSchema.parse({ items, nextCursor }));
        },
      )

      // --- Thread reading (WS-G.3.3) -----------------------------------------
      .get(
        '/threads/:threadId',
        zValidator('param', z.object({ threadId: uuidSchema })),
        async (c) => {
          const { threadId } = c.req.valid('param');
          const bundle = bundles();
          const identity = getIdentityServices();
          const userId = await softUserId(c.req.header('cookie'), identity);
          const thread = await bundle.ingestion.stories.getThreadById(threadId);
          if (!thread) return c.json(notFound, 404);
          if (!(await threadReadableToUser(bundle, thread, userId))) return c.json(notFound, 404);
          const story = await bundle.ingestion.stories.getById(thread.storyId);
          if (!story) return c.json(notFound, 404);
          const overview = await threadOverview(
            bundle,
            thread,
            story.title,
            makeAuthorResolver(identity),
          );
          return c.json(threadDetailSchema.parse(overview));
        },
      )

      .get(
        '/threads/:threadId/branches/:branch',
        zValidator('param', z.object({ threadId: uuidSchema, branch: branchIdSchema })),
        zValidator('query', z.object({ cursor: z.string().min(1).max(512).optional() })),
        async (c) => {
          const { threadId, branch } = c.req.valid('param');
          const { cursor } = c.req.valid('query');
          const bundle = bundles();
          const identity = getIdentityServices();
          const userId = await softUserId(c.req.header('cookie'), identity);
          const thread = await bundle.ingestion.stories.getThreadById(threadId);
          if (!thread) return c.json(notFound, 404);
          if (!(await threadReadableToUser(bundle, thread, userId))) return c.json(notFound, 404);
          const content = await branchContent(
            bundle,
            threadId,
            branch,
            userId,
            makeAuthorResolver(identity),
            cursor ?? null,
          );
          return c.json(branchContentSchema.parse(content));
        },
      )

      // Subtree read (WS-G.1.2d-2 `?root=`), keyset-paginated like branches.
      .get(
        '/threads/:threadId/contributions',
        zValidator('param', z.object({ threadId: uuidSchema })),
        zValidator(
          'query',
          z.object({ root: uuidSchema, cursor: z.string().min(1).max(512).optional() }),
        ),
        async (c) => {
          const { threadId } = c.req.valid('param');
          const { root, cursor } = c.req.valid('query');
          const bundle = bundles();
          const identity = getIdentityServices();
          const userId = await softUserId(c.req.header('cookie'), identity);
          const thread = await bundle.ingestion.stories.getThreadById(threadId);
          if (!thread) return c.json(notFound, 404);
          if (!(await threadReadableToUser(bundle, thread, userId))) return c.json(notFound, 404);
          const subtree = await subtreeContent(
            bundle,
            threadId,
            root,
            userId,
            makeAuthorResolver(identity),
            cursor ?? null,
          );
          if (!subtree.rootFound) return c.json(notFound, 404);
          return c.json(
            contributionSubtreeSchema.parse({
              thread_id: threadId,
              root_contribution_id: root,
              contributions: subtree.rows,
              next_cursor: subtree.nextCursor,
            }),
          );
        },
      )

      // Deep-link anchor (WS-G.3.3 semantic anchoring).
      .get(
        '/contributions/:contributionId/anchor',
        zValidator('param', z.object({ contributionId: uuidSchema })),
        async (c) => {
          const { contributionId } = c.req.valid('param');
          const bundle = bundles();
          const identity = getIdentityServices();
          const userId = await softUserId(c.req.header('cookie'), identity);
          const record = await bundle.forum.contributions.getById(contributionId);
          if (!record) return c.json(notFound, 404);
          const thread = await bundle.ingestion.stories.getThreadById(record.threadId);
          if (!thread || !(await threadReadableToUser(bundle, thread, userId))) {
            return c.json(notFound, 404);
          }
          // Apply the viewer's block/mute hide set (WS-J.1.2), like the branch +
          // subtree reads — otherwise this anchor leaks a blocked/muted author's
          // contribution and enables navigation to it.
          const hide = await viewerHideSet(bundle, userId);
          const renderable = visibleRows([record], userId, hide);
          if (renderable.length === 0 || renderable[0]?.tombstone) return c.json(notFound, 404);
          return c.json(contributionAnchorSchema.parse(contributionAnchor(record)));
        },
      )

      // --- Contribution writes (WS-G.3.1, §15.5) -----------------------------
      .post(
        '/contributions',
        authMiddleware(),
        requireVerifiedAccount(),
        requireUnrestricted(),
        zValidator('json', contributionCreateSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const bundle = bundles();
          const identity = getIdentityServices();
          const request = c.req.valid('json');
          const outcome = await createContribution(
            bundle,
            auth.userId,
            accountRef(identity.config.masterSecret, auth.userId),
            request,
          );
          if (!outcome.ok) {
            const rejection = outcome.rejection;
            if (rejection.status === 429) {
              c.header('Retry-After', String(rejection.retryAfterSec));
            }
            return c.json(deny(rejection.code, rejection.message), rejection.status);
          }
          const resolveAuthor = makeAuthorResolver(identity);
          const author = await resolveAuthor(auth.userId);
          const card =
            outcome.evidenceCardId !== null
              ? await bundle.ingestion.evidence.getById(outcome.evidenceCardId)
              : null;
          return c.json(
            contributionCreateResponseSchema.parse({
              contribution: toContributionPublic(
                outcome.contribution,
                author,
                0,
                auth.userId,
                false,
              ),
              evidence_card: card
                ? {
                    evidence_id: card.evidenceId,
                    claim_id: card.claimId,
                    source_id: card.sourceId,
                    contribution_id: card.contributionId,
                    submitted_by: card.submittedBy,
                    evidence_type: card.evidenceType,
                    relationship_type: card.relationshipType,
                    citation_url_or_ref: card.citationUrlOrRef,
                    relevance_note: card.relevanceNote,
                    verification_state: card.verificationState,
                    independence_group_id: card.independenceGroupId,
                    created_at: card.createdAt,
                  }
                : null,
              deduplicated: outcome.deduplicated,
            }),
            outcome.deduplicated ? 200 : 201,
          );
        },
      )

      .patch(
        '/contributions/:contributionId',
        authMiddleware(),
        requireVerifiedAccount(),
        // Editing existing public content IS a public contribution — a restricted
        // account is denied (it may still DELETE/retract, which only reduces
        // exposure; that route stays open).
        requireUnrestricted(),
        zValidator('param', z.object({ contributionId: uuidSchema })),
        zValidator('json', contributionUpdateSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { contributionId } = c.req.valid('param');
          const update = c.req.valid('json');
          if (update.contribution_id !== contributionId) {
            return c.json(deny('id_mismatch', 'Body and path ids must match'), 422);
          }
          const bundle = bundles();
          const outcome = await editContribution(bundle, auth.userId, contributionId, update);
          if (!outcome.ok) {
            return c.json(
              deny(outcome.rejection.code, outcome.rejection.message),
              outcome.rejection.status,
            );
          }
          const identity = getIdentityServices();
          const author = await makeAuthorResolver(identity)(auth.userId);
          const counts = await bundle.forum.contributions.childCounts([contributionId]);
          return c.json(
            contributionPublicSchema.parse(
              toContributionPublic(
                outcome.contribution,
                author,
                counts.get(contributionId) ?? 0,
                auth.userId,
                false,
              ),
            ),
          );
        },
      )

      .delete(
        '/contributions/:contributionId',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('param', z.object({ contributionId: uuidSchema })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { contributionId } = c.req.valid('param');
          const bundle = bundles();
          const outcome = await removeContribution(bundle, auth.userId, contributionId);
          if (!outcome.ok) {
            return c.json(
              deny(outcome.rejection.code, outcome.rejection.message),
              outcome.rejection.status,
            );
          }
          return c.json({ removed: true });
        },
      )

      // --- Standalone evidence cards (WS-G.3.2) ------------------------------
      .post(
        '/evidence',
        authMiddleware(),
        requireVerifiedAccount(),
        requireUnrestricted(),
        zValidator('json', evidenceCreateRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const bundle = bundles();
          const claim = await bundle.ingestion.claims.getById(c.req.valid('json').claim_id);
          if (!claim)
            return c.json(deny('unknown_claim', 'The referenced claim does not exist'), 422);
          const request = c.req.valid('json');
          if (request.contribution_id !== undefined) {
            const contribution = await bundle.forum.contributions.getById(request.contribution_id);
            if (!contribution || contribution.userId !== auth.userId) {
              return c.json(deny('invalid_contribution', 'The contribution must be yours'), 422);
            }
          }
          const card = await bundle.ingestion.evidence.insert({
            evidenceId: randomUUID(),
            claimId: request.claim_id,
            sourceId: null,
            contributionId: request.contribution_id ?? null,
            submittedBy: auth.userId,
            evidenceType: request.evidence_type,
            relationshipType: request.relationship_type,
            citationUrlOrRef: request.citation_url_or_ref,
            relevanceNote: request.relevance_note,
            verificationState: 'unverified',
            independenceGroupId: claim.independenceGroupId,
            storyId: claim.storyId,
          });
          bundle.forum.metrics.increment(`evidence.created.${card.evidenceType}`);
          // The standalone path emits the SAME durable `evidence.added` the
          // contribution co-create path does — the embedding and lifecycle
          // consumers only see cards through that event.  The wire requires
          // a thread id: resolve it through the claim's story; a storyless
          // claim has no thread to attribute, so its card stays unemitted
          // (counted, not silent).
          const threadShell =
            claim.storyId !== null
              ? await bundle.ingestion.stories.getThreadByStoryId(claim.storyId)
              : null;
          if (threadShell) {
            const added = evidenceAddedEventSchema.parse({
              event_id: randomUUID(),
              event_type: 'evidence.added',
              timestamp: card.createdAt,
              schema_version: '1',
              evidence_id: card.evidenceId,
              claim_id: card.claimId,
              thread_id: threadShell.threadId,
              user_id: auth.userId,
              evidence_type: mapCardTypeToEventType(card.evidenceType),
              source_id: null,
              contribution_id: card.contributionId,
              privacy_classification: 'public',
              retention_tier: 'public_contribution',
            });
            const registryEntry = TOPIC_REGISTRY['evidence.added'];
            await bundle.events.eventStore.insertMany([
              {
                eventId: added.event_id,
                eventType: added.event_type,
                topic: added.event_type,
                timestamp: added.timestamp,
                privacyClassification: registryEntry.privacy_classification,
                retentionTier: registryEntry.retention_tier,
                payload: added as unknown as Record<string, unknown>,
                ownerUserId: auth.userId,
                purgeAfter: null,
              },
            ]);
            bundle.forum.trackBackground(bundle.events.router.publish(added));
          } else {
            bundle.forum.metrics.increment('evidence.created.unemitted_no_thread');
          }
          return c.json(
            evidenceCreateResponseSchema.parse({
              evidence: {
                evidence_id: card.evidenceId,
                claim_id: card.claimId,
                source_id: card.sourceId,
                contribution_id: card.contributionId,
                submitted_by: card.submittedBy,
                evidence_type: card.evidenceType,
                relationship_type: card.relationshipType,
                citation_url_or_ref: card.citationUrlOrRef,
                relevance_note: card.relevanceNote,
                verification_state: card.verificationState,
                independence_group_id: card.independenceGroupId,
                created_at: card.createdAt,
              },
            }),
            201,
          );
        },
      )

      // --- Summaries (WS-G.1.4) ----------------------------------------------
      .post(
        '/threads/:threadId/summaries',
        authMiddleware(),
        requireVerifiedAccount(),
        requireUnrestricted(),
        zValidator('param', z.object({ threadId: uuidSchema })),
        zValidator('json', summaryCreateRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { threadId } = c.req.valid('param');
          const request = c.req.valid('json');
          if (request.thread_id !== threadId) {
            return c.json(deny('id_mismatch', 'Body and path ids must match'), 422);
          }
          const bundle = bundles();
          const identity = getIdentityServices();
          const thread = await bundle.ingestion.stories.getThreadById(threadId);
          if (!thread || !(await threadReadableToUser(bundle, thread, auth.userId))) {
            return c.json(notFound, 404);
          }
          // Steward check: platform steward role OR any WS-A.2.2 room-steward
          // role in the thread's room (WS-G.1.4 "role source WS-A.2.2 / WS-J").
          const platformSteward = auth.roles.includes('steward') || auth.roles.includes('admin');
          const roomSteward =
            thread.roomId !== null
              ? (await bundle.forum.rooms.stewardRolesFor(thread.roomId, auth.userId)).length > 0
              : false;
          const outcome = await createSummary(
            {
              forum: bundle.forum,
              stories: bundle.ingestion.stories,
              evidence: bundle.ingestion.evidence,
              audit: identity.audit,
            },
            request,
            auth.userId,
            platformSteward || roomSteward,
          );
          if (!outcome.ok) return c.json(deny(outcome.code, outcome.message), outcome.status);
          return c.json(
            summaryPublicSchema.parse(
              await toSummaryPublic(outcome.summary, makeAuthorResolver(identity)),
            ),
            201,
          );
        },
      )

      // --- Feed preferences (WS-G.3.8, SPEC §13/§23.2) ------------------------
      .get('/feed/preferences', authMiddleware(), requireVerifiedAccount(), async (c) => {
        const auth = getAuth(c);
        if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
        const identity = getIdentityServices();
        const user = await identity.store.getUser(auth.userId);
        if (!user) return c.json(notFound, 404);
        return c.json(
          feedPreferencesSchema.parse({
            feed_mode: user.personalizationSettings.feed_mode,
            topic_preferences: user.personalizationSettings.topic_preferences,
            personalization_enabled: user.privacySettings.personalization_enabled,
            attention_retention_preference: user.privacySettings.attention_retention_preference,
            notification_preferences: user.privacySettings.notification_preferences,
          }),
        );
      })

      .patch(
        '/feed/preferences',
        authMiddleware(),
        requireVerifiedAccount(),
        zValidator('json', feedPreferencesPatchSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const identity = getIdentityServices();
          const user = await identity.store.getUser(auth.userId);
          if (!user) return c.json(notFound, 404);
          const patch = c.req.valid('json');

          // Single source of truth: the WS-D settings blobs (clamped/audited
          // exactly like /v1/privacy/settings — this endpoint is the §23.2
          // canonical veneer, not a second store).
          const nextPersonalization = personalizationSettingsSchema.parse({
            ...user.personalizationSettings,
            ...(patch.feed_mode !== undefined ? { feed_mode: patch.feed_mode } : {}),
            ...(patch.topic_preferences !== undefined
              ? { topic_preferences: patch.topic_preferences }
              : {}),
          });
          const nextNotifications = privacyNotificationPreferencesSchema.parse({
            ...user.privacySettings.notification_preferences,
            ...(patch.notification_preferences ?? {}),
          });
          const nextPrivacy = privacySettingsSchema.parse({
            ...user.privacySettings,
            ...(patch.personalization_enabled !== undefined
              ? { personalization_enabled: patch.personalization_enabled }
              : {}),
            notification_preferences: nextNotifications,
          });
          await identity.store.updateUser(auth.userId, {
            privacySettings: nextPrivacy,
            personalizationSettings: nextPersonalization,
          });
          await identity.audit.append({
            actorUserId: auth.userId,
            eventType: 'privacy_setting_change',
            context: { setting: Object.keys(patch).join(','), reason: 'feed_preferences' },
          });
          if (patch.personalization_enabled !== undefined) {
            identity.onPrivacyChange?.({
              userId: auth.userId,
              personalizationEnabled: nextPrivacy.personalization_enabled,
              retention: nextPrivacy.attention_retention_preference,
            });
          }
          return c.json(
            feedPreferencesSchema.parse({
              feed_mode: nextPersonalization.feed_mode,
              topic_preferences: nextPersonalization.topic_preferences,
              personalization_enabled: nextPrivacy.personalization_enabled,
              attention_retention_preference: nextPrivacy.attention_retention_preference,
              notification_preferences: nextPrivacy.notification_preferences,
            }),
          );
        },
      )

      // --- Uploads (WS-G.3.7b) -------------------------------------------------
      .post(
        '/uploads',
        authMiddleware(),
        requireVerifiedAccount(),
        bodyLimit({
          // The largest admissible type (video) sets the body ceiling; per-type
          // caps below reject smaller-type overages with the precise reason.
          maxSize: MAX_VIDEO_BYTES + 64 * 1024,
          onError: (c) => c.json(deny('payload_too_large', 'Upload exceeds the size limit'), 413),
        }),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const body = await c.req.parseBody();
          const file = body['file'];
          if (!(file instanceof File)) {
            return c.json(deny('file_required', 'A multipart `file` field is required'), 422);
          }
          const altTextRaw = body['alt_text'];
          const altText = typeof altTextRaw === 'string' ? altTextRaw.trim() : '';
          const contentType = file.type;
          const isImage = (UPLOAD_IMAGE_TYPES as readonly string[]).includes(contentType);
          const isDocument = (UPLOAD_DOCUMENT_TYPES as readonly string[]).includes(contentType);
          const isVideo = (UPLOAD_VIDEO_TYPES as readonly string[]).includes(contentType);
          const isCaption = (UPLOAD_CAPTION_TYPES as readonly string[]).includes(contentType);
          if (!isImage && !isDocument && !isVideo && !isCaption) {
            return c.json(
              deny('unsupported_type', 'Allowed: JPEG, PNG, WebP, AVIF, PDF, MP4, WebM, VTT'),
              415,
            );
          }
          // The video byte cap is the steward-tunable `ingestion.video_max_bytes`
          // clamped to the hard DB ceiling (it may lower it, never raise it).
          const videoCfg = getIngestionServices().config();
          const maxVideoBytes = Math.min(videoCfg.videoMaxBytes, MAX_VIDEO_BYTES);
          const maxBytes = isImage
            ? MAX_IMAGE_BYTES
            : isVideo
              ? maxVideoBytes
              : isCaption
                ? MAX_CAPTION_BYTES
                : MAX_DOCUMENT_BYTES;
          if (file.size > maxBytes) {
            return c.json(deny('payload_too_large', 'Upload exceeds the size limit'), 413);
          }
          // Alt text is REQUIRED for images (WCAG; WS-G.3.7b acceptance);
          // videos/documents carry none (captions are a separate post field).
          if (isImage && altText.length === 0) {
            return c.json(deny('alt_text_required', 'Images require alt text'), 422);
          }
          if (altText.length > 500) {
            return c.json(deny('alt_text_too_long', 'Alt text is limited to 500 characters'), 422);
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          // Video rides the validate-only container probe (WS-Q.2.3d); images and
          // documents ride the metadata-stripping path (WS-G.3.7b).
          let storedBytes: Uint8Array;
          let metadataStripped: boolean;
          if (isVideo) {
            const probe = probeVideo(contentType, bytes);
            if (!probe.ok) {
              return c.json(deny('invalid_file', 'The file does not match its declared type'), 415);
            }
            if (
              probe.durationSeconds !== null &&
              probe.durationSeconds > videoCfg.videoMaxSeconds
            ) {
              return c.json(
                deny('video_too_long', `Video exceeds the ${videoCfg.videoMaxSeconds}s limit`),
                413,
              );
            }
            storedBytes = probe.bytes;
            metadataStripped = probe.stripped;
          } else {
            const stripped = stripUploadMetadata(contentType, bytes);
            if (!stripped.ok) {
              if (stripped.reason === 'metadata_strip_unsupported') {
                return c.json(
                  deny(
                    'metadata_strip_unsupported',
                    'This AVIF file carries metadata that cannot be stripped — re-export it without EXIF/XMP',
                  ),
                  422,
                );
              }
              return c.json(deny('invalid_file', 'The file does not match its declared type'), 415);
            }
            storedBytes = stripped.bytes;
            metadataStripped = stripped.stripped;
          }
          const forum = getForumServices();
          // The injectable scanner runs AFTER the inline local checks
          // (magic, size, strip).  Default: local checks ARE the scan
          // (clear); WS-J.2.6b swaps in the shared malware intelligence,
          // which may hold (`pending`) or reject (`flagged`) — the gate is
          // real either way (attachment and serving both require `clear`).
          const scan = await forum.uploadScanner.scan(storedBytes, contentType);
          if (scan.state === 'flagged') {
            forum.metrics.increment('uploads.flagged');
            return c.json(deny('upload_flagged', 'This file failed the safety scan'), 422);
          }
          const uploadId = randomUUID();
          const record = await forum.uploads.put(
            {
              uploadId,
              ownerUserId: auth.userId,
              contentType,
              byteSize: storedBytes.length,
              altText: isImage ? altText : null,
              storageRef: `uploads/${uploadId}`,
              metadataStripped: metadataStripped || isImage,
              scanState: scan.state,
              // Linked to its owning story at submission (WS-Q.5.2c); a
              // contribution attachment stays null and serves unrestricted.
              ownerStoryId: null,
            },
            storedBytes,
          );
          forum.metrics.increment(
            scan.state === 'clear' ? 'uploads.accepted' : 'uploads.pending_scan',
          );
          return c.json(uploadPublicSchema.parse(toUploadPublic(record)), 201);
        },
      )

      .get(
        '/uploads/:uploadId',
        zValidator('param', z.object({ uploadId: uuidSchema })),
        async (c) => {
          const { uploadId } = c.req.valid('param');
          const forum = getForumServices();
          const record = await forum.uploads.getRecord(uploadId);
          // Only scan-cleared uploads are served (WS-G.3.7b acceptance).
          if (record?.scanState !== 'clear') return c.json(notFound, 404);

          // WS-Q.5.2c — story-scoped authorization. An upload linked to a story
          // (story media OR a contribution attachment, whose thread inherits the
          // story's visibility, §14.5.6) is gated by that story: a taken-down/
          // safety-hidden story's media is refused outright (re-checked here, so
          // removal is immediate), and a room_only story's media is served ONLY
          // through a valid signed URL OR to its authenticated owner (so a user
          // can always retrieve their own upload, e.g. a DSAR export link).
          // Public-story media stays a stable bare URL; an upload with no owning
          // story (not yet linked) serves unrestricted.
          let restricted = false;
          if (record.ownerStoryId !== null) {
            const story = await getIngestionServices().stories.getById(record.ownerStoryId);
            if (story === null || story.hiddenState !== null) return c.json(notFound, 404);
            if (story.visibility === 'room_only') {
              restricted = true;
              const expiresAt = Number(c.req.query('e') ?? '');
              const signed = verifyMediaToken(
                getIdentityServices().config.masterSecret,
                uploadId,
                expiresAt,
                c.req.query('t') ?? '',
                Date.now(),
              );
              if (!signed) {
                const requester = await softUserId(c.req.header('cookie'), getIdentityServices());
                if (record.ownerUserId === null || requester !== record.ownerUserId) {
                  return c.json(notFound, 404);
                }
              }
            }
          }

          const bytes = await forum.uploads.getBytes(uploadId);
          if (!bytes) return c.json(notFound, 404);
          c.header('Content-Type', record.contentType);
          // A signed room_only URL is per-response + short-lived, so it must not
          // be shared-cached; public/contribution media stays immutable.
          c.header(
            'Cache-Control',
            restricted ? 'private, no-store' : 'public, max-age=31536000, immutable',
          );
          // PDFs download rather than render inline (embedded-JS viewers).
          c.header(
            'Content-Disposition',
            record.contentType === 'application/pdf'
              ? `attachment; filename="${uploadId}.pdf"`
              : 'inline',
          );
          // Range requests (WS-Q.2.3e): native <video> seeks via `Range`, so the
          // gated path advertises and honors single-range byte serving.
          c.header('Accept-Ranges', 'bytes');
          const slice = (from: number, to: number): ArrayBuffer =>
            bytes.buffer.slice(bytes.byteOffset + from, bytes.byteOffset + to) as ArrayBuffer;
          const range = parseByteRange(c.req.header('range'), bytes.byteLength);
          if (range === 'unsatisfiable') {
            c.header('Content-Range', `bytes */${bytes.byteLength}`);
            return c.body(null, 416);
          }
          if (range !== null) {
            c.header('Content-Range', `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
            c.header('Content-Length', String(range.end - range.start + 1));
            return c.body(slice(range.start, range.end + 1), 206);
          }
          return c.body(slice(0, bytes.byteLength));
        },
      )

      // --- Drainer blocklist (WS-G.4.2c; public, cache-busted) ----------------
      .get('/security/link-blocklist', (c) => {
        const { version, domains } = getForumServices().linkBlocklist();
        c.header('Cache-Control', 'public, max-age=300');
        c.header('ETag', `"${version}"`);
        return c.json(linkBlocklistResponseSchema.parse({ version, domains }));
      })

      // --- Steward surface -----------------------------------------------------
      // Thread state transitions (WS-G.1.1; audited with actor + reason).
      .patch(
        '/threads/:threadId/state',
        authMiddleware(),
        requireSteward(),
        zValidator('param', z.object({ threadId: uuidSchema })),
        zValidator(
          'json',
          z
            .object({
              dimension: z.enum(['conversation', 'safety']),
              to: z.string().min(1).max(32),
              reason: z.string().trim().min(1).max(256),
            })
            .strict(),
        ),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { threadId } = c.req.valid('param');
          const { dimension, to, reason } = c.req.valid('json');
          const bundle = bundles();
          const identity = getIdentityServices();
          const deps = {
            stories: bundle.ingestion.stories,
            events: bundle.events,
            audit: identity.audit,
            trackBackground: bundle.forum.trackBackground,
            now: bundle.forum.now,
          };
          if (dimension === 'conversation') {
            const parsed = threadConversationStateSchema.safeParse(to);
            if (!parsed.success)
              return c.json(deny('invalid_state', 'Unknown conversation state'), 422);
            const outcome = await applyConversationTransition(
              deps,
              threadId,
              parsed.data,
              auth.userId,
              reason,
            );
            if (!outcome.ok) {
              const status = outcome.reason === 'thread_not_found' ? 404 : 422;
              return c.json(deny(outcome.reason, outcome.message), status);
            }
            return c.json({
              thread_id: threadId,
              conversation_state: outcome.thread.conversationState,
            });
          }
          const parsed = threadSafetyStateSchema.safeParse(to);
          if (!parsed.success) return c.json(deny('invalid_state', 'Unknown safety state'), 422);
          const outcome = await applyThreadSafetyTransition(
            deps,
            threadId,
            parsed.data as ThreadSafetyState,
            auth.userId,
            reason,
          );
          if (!outcome.ok) {
            const status = outcome.reason === 'thread_not_found' ? 404 : 422;
            return c.json(deny(outcome.reason, outcome.message), status);
          }
          return c.json({ thread_id: threadId, safety_state: outcome.thread.safetyState });
        },
      )

      // Forum runtime config (validated write — 422 on a bad value).
      .get('/forum/admin/config', authMiddleware(), requireSteward(), (c) => {
        const forum = getForumServices();
        return c.json({ config: forum.config(), keys: FORUM_CONFIG_KEYS });
      })
      .patch(
        '/forum/admin/config',
        authMiddleware(),
        requireSteward(),
        zValidator(
          'json',
          z.object({ key: z.string().min(1).max(128), value: z.unknown() }).strict(),
        ),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const { key, value } = c.req.valid('json');
          const problem = validateForumConfigValue(key, value);
          if (problem !== null) return c.json(deny('invalid_config', problem), 422);
          const events = getEventPipelineServices();
          await storeForumConfigValue(events.configStore, key, value);
          const forum = getForumServices();
          await forum.reloadConfig();
          const identity = getIdentityServices();
          await identity.audit.append({
            actorUserId: auth.userId,
            eventType: 'forum_config_change',
            targetRef: key,
            context: { setting: key, new_value: JSON.stringify(value).slice(0, 256) },
          });
          return c.json({ config: forum.config() });
        },
      )
      .get('/forum/admin/metrics', authMiddleware(), requireSteward(), (c) => {
        return c.json({ counters: getForumServices().metrics.snapshot() });
      })
  );
}

function toUploadPublic(record: UploadRecord) {
  return {
    upload_id: record.uploadId,
    content_type: record.contentType,
    byte_size: record.byteSize,
    alt_text: record.altText,
    url: `/v1/uploads/${record.uploadId}`,
    metadata_stripped: record.metadataStripped,
    scan_state: record.scanState,
    created_at: record.createdAt,
  };
}

export type ForumRoutes = ReturnType<typeof createForumRoutes>;
export type { ContributionRecord };
