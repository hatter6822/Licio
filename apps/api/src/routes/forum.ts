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
  evidenceCreateRequestSchema,
  evidenceCreateResponseSchema,
  feedPreferencesPatchSchema,
  feedPreferencesSchema,
  linkBlocklistResponseSchema,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  personalizationSettingsSchema,
  privacyNotificationPreferencesSchema,
  privacySettingsSchema,
  summaryCreateRequestSchema,
  summaryPublicSchema,
  type ThreadSafetyState,
  threadConversationStateSchema,
  threadDetailSchema,
  threadSafetyStateSchema,
  UPLOAD_DOCUMENT_TYPES,
  UPLOAD_IMAGE_TYPES,
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
  removeContribution,
  threadVisibleToUser,
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
  visibleRows,
} from '../forum/threads.js';
import { applyConversationTransition, applyThreadSafetyTransition } from '../forum/transitions.js';
import { accountRef } from '../identity/crypto.js';
import { getIdentityServices, type IdentityServices } from '../identity/services.js';
import { readSessionToken, validateSession } from '../identity/sessions.js';
import { getIngestionServices } from '../ingestion/services.js';
import {
  type AuthEnv,
  authMiddleware,
  getAuth,
  requireSteward,
  requireVerifiedAccount,
} from '../middleware/auth.js';

const deny = (code: string, message: string) => ({ error: { code, message } });
const notFound = deny('not_found', 'Resource not found');

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
          if (!(await threadVisibleToUser(bundle, thread, userId))) return c.json(notFound, 404);
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
          if (!(await threadVisibleToUser(bundle, thread, userId))) return c.json(notFound, 404);
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
          if (!(await threadVisibleToUser(bundle, thread, userId))) return c.json(notFound, 404);
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
          if (!thread || !(await threadVisibleToUser(bundle, thread, userId))) {
            return c.json(notFound, 404);
          }
          const renderable = visibleRows([record], userId);
          if (renderable.length === 0 || renderable[0]?.tombstone) return c.json(notFound, 404);
          return c.json(contributionAnchorSchema.parse(contributionAnchor(record)));
        },
      )

      // --- Contribution writes (WS-G.3.1, §15.5) -----------------------------
      .post(
        '/contributions',
        authMiddleware(),
        requireVerifiedAccount(),
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
          if (!thread || !(await threadVisibleToUser(bundle, thread, auth.userId))) {
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
            { forum: bundle.forum, stories: bundle.ingestion.stories, audit: identity.audit },
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
          maxSize: MAX_DOCUMENT_BYTES + 64 * 1024,
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
          if (!isImage && !isDocument) {
            return c.json(deny('unsupported_type', 'Allowed: JPEG, PNG, WebP, AVIF, PDF'), 415);
          }
          const maxBytes = isImage ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
          if (file.size > maxBytes) {
            return c.json(deny('payload_too_large', 'Upload exceeds the size limit'), 413);
          }
          // Alt text is REQUIRED for images (WCAG; WS-G.3.7b acceptance).
          if (isImage && altText.length === 0) {
            return c.json(deny('alt_text_required', 'Images require alt text'), 422);
          }
          if (altText.length > 500) {
            return c.json(deny('alt_text_too_long', 'Alt text is limited to 500 characters'), 422);
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
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
          const forum = getForumServices();
          // The injectable scanner runs AFTER the inline local checks
          // (magic, size, strip).  Default: local checks ARE the scan
          // (clear); WS-J.2.6b swaps in the shared malware intelligence,
          // which may hold (`pending`) or reject (`flagged`) — the gate is
          // real either way (attachment and serving both require `clear`).
          const scan = await forum.uploadScanner.scan(stripped.bytes, contentType);
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
              byteSize: stripped.bytes.length,
              altText: isImage ? altText : null,
              storageRef: `uploads/${uploadId}`,
              metadataStripped: stripped.stripped || isImage,
              scanState: scan.state,
            },
            stripped.bytes,
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
          const bytes = await forum.uploads.getBytes(uploadId);
          if (!bytes) return c.json(notFound, 404);
          c.header('Content-Type', record.contentType);
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
          // PDFs download rather than render inline (embedded-JS viewers).
          c.header(
            'Content-Disposition',
            record.contentType === 'application/pdf'
              ? `attachment; filename="${uploadId}.pdf"`
              : 'inline',
          );
          return c.body(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          );
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
