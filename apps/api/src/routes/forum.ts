// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G forum routes (SPEC §23.2): thread reading (overview/branches/subtree/
// anchor), contribution create/edit/remove, summaries, feed preferences,
// uploads, the drainer blocklist, and the steward surface (thread-state
// transitions, forum config, metrics).
//
// Every response is re-validated against the shared schema on egress (the
// WS-C.1.2 boundary guarantee); logs and metrics carry ids and counts only.
import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import {
  type ContributionPublic,
  contributionAnchorSchema,
  contributionCreateResponseSchema,
  contributionPublicSchema,
  contributionSubtreeSchema,
  contributionUpdateSchema,
  contributionWriteCreateSchema,
  debateArenaResponseSchema,
  debateOverrideRequestSchema,
  debatePositionUpdateSchema,
  feedPreferencesPatchSchema,
  feedPreferencesSchema,
  legacyPreservingFeedMode,
  linkBlocklistResponseSchema,
  MAX_CAPTION_BYTES,
  MAX_GIF_BYTES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  personalizationSettingsSchema,
  privacyNotificationPreferencesSchema,
  privacySettingsSchema,
  storyCommentsResponseSchema,
  storyDebatesResponseSchema,
  type ThreadSafetyState,
  type ThreadSummary,
  threadConversationStateSchema,
  threadDetailSchema,
  threadListResponseSchema,
  threadSafetyStateSchema,
  threadSummarySchema,
  UPLOAD_CAPTION_TYPES,
  UPLOAD_IMAGE_TYPES,
  UPLOAD_VIDEO_TYPES,
  uploadPublicSchema,
  uuidSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { getEventPipelineServices } from '../events/services.js';
import type { CommentFrame } from '../forum/comment-broadcaster.js';
import { commentMediaOf, commentPage } from '../forum/comments.js';
import {
  FORUM_CONFIG_KEYS,
  storeForumConfigValue,
  validateForumConfigValue,
} from '../forum/config.js';
import {
  createContribution,
  editContribution,
  removeContribution,
  threadOnGlobalDirectory,
  threadReadableToUser,
} from '../forum/contributions.js';
import {
  concedeDebate,
  overrideDebateVerdict,
  postDebatePosition,
  readDebateArenaContent,
  toDebateArenaPublic,
  toDebateArenaSummary,
  withdrawDebate,
} from '../forum/debate.js';
import { type DebateFrame, sseDebateFrame } from '../forum/debate-broadcaster.js';
import { buildDebateDeps } from '../forum/debate-scheduler.js';
import { stripUploadMetadata } from '../forum/exif.js';
import { getForumServices } from '../forum/services.js';
import type { ContributionRecord, UploadRecord } from '../forum/stores.js';
import {
  contributionAnchor,
  subtreeContent,
  threadOverview,
  toContributionPublic,
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
import { makeMediaUrlMinter, verifyMediaToken } from '../lib/media-urls.js';
import {
  getPreferences,
  getVapidConfig,
  sendBodylessWakeToUser,
  suppressionReason,
} from '../lib/push-service.js';
import { rateLimit } from '../lib/rate-limit.js';
import { replyNotifications } from '../lib/reply-notifications.js';
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

/** Assemble the WS-T debate-arena service deps from the request bundle (the
 *  ONE shared assembly — window scoping, story-content reads, and the
 *  ranking-feature refresh on a story dispute change never diverge here). */
function debateDepsFromBundle(bundle: ReturnType<typeof bundles>) {
  return buildDebateDeps(bundle.forum, bundle.ingestion);
}

const SSE_HEARTBEAT_MS = 25_000;
const STREAM_REPLAY_LIMIT = 200;

export function sseCommentFrame(frame: CommentFrame): string {
  return `id: ${frame.eventId}\nevent: comment\ndata: ${JSON.stringify(frame.contribution)}\n\n`;
}

async function liveContributionProjection(
  bundle: ReturnType<typeof bundles>,
  contribution: ContributionRecord,
  requesterUserId: string | null,
  resolveAuthor: ReturnType<typeof makeAuthorResolver>,
  restrictedMedia: boolean,
): Promise<ContributionPublic> {
  const childCounts = await bundle.forum.contributions.childCounts([contribution.contributionId]);
  const author = await resolveAuthor(contribution.userId);
  const projected = toContributionPublic(
    contribution,
    author,
    childCounts.get(contribution.contributionId) ?? 0,
    requesterUserId,
    false,
  );
  const media: NonNullable<ContributionPublic['media']> = [];
  const mint = makeMediaUrlMinter();
  for (const uploadId of contribution.metadata.attachment_ids ?? []) {
    const upload = await bundle.forum.uploads.getRecord(uploadId);
    if (!upload) continue;
    const item = commentMediaOf(upload, mint, restrictedMedia);
    if (item) media.push(item);
  }
  return media.length > 0 ? { ...projected, media } : projected;
}

async function replayFramesAfter(
  bundle: ReturnType<typeof bundles>,
  threadId: string,
  lastEventId: string | null,
  requesterUserId: string | null,
  resolveAuthor: ReturnType<typeof makeAuthorResolver>,
  restrictedMedia: boolean,
): Promise<CommentFrame[]> {
  if (lastEventId === null) return [];
  const resume = await bundle.forum.contributions.getById(lastEventId);
  if (!resume || resume.threadId !== threadId) return [];
  const rows = await bundle.forum.contributions.listByThread(threadId, {
    states: ['published'],
    after: { createdAt: resume.createdAt, id: resume.contributionId },
    limit: STREAM_REPLAY_LIMIT,
  });
  const hide = await viewerHideSet(bundle, requesterUserId);
  const visible = visibleRows(rows, requesterUserId, hide).filter((entry) => !entry.tombstone);
  const frames: CommentFrame[] = [];
  for (const entry of visible) {
    const contribution = await liveContributionProjection(
      bundle,
      entry.row,
      requesterUserId,
      resolveAuthor,
      restrictedMedia,
    );
    frames.push({ eventId: contribution.contribution_id, contribution });
  }
  return frames;
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
        // The cursor is an opaque thread id we minted; a non-UUID value (a
        // malformed/forged request) coerces to undefined → restart from the top,
        // never a Postgres uuid-cast 500 (defensive cursor semantics).
        zValidator('query', z.object({ cursor: uuidSchema.optional().catch(undefined) })),
        async (c) => {
          const { cursor } = c.req.valid('query');
          const bundle = bundles();
          const config = bundle.forum.config();
          const pageSize = config.roomPageSize;

          // Recover the keyset position from the cursor (the deepest scanned
          // thread id of the previous page); an unknown id restarts from the top.
          let before: { createdAt: string; threadId: string } | null = null;
          if (cursor !== undefined) {
            const last = await bundle.ingestion.stories.getThreadById(cursor);
            if (last) before = { createdAt: last.createdAt, threadId: last.threadId };
          }

          const visible: ThreadShellRecord[] = [];
          let exhausted = false;
          let scannedCursor: string | null = null; // deepest keyset position reached
          const BATCH = config.threadDirectoryScanBatch;
          const MAX_BATCHES = config.threadDirectoryMaxScanBatches;
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
            scannedCursor = lastScanned.threadId;
          }
          const page = visible.slice(0, pageSize);
          // Continuation: a full page resumes after the last SERVED row; a
          // budget-truncated partial page resumes from the deepest SCANNED row
          // (never the last visible row) so a long run of filtered
          // (private/room_only/removed) threads can never strand the older public
          // conversations behind it; a genuinely exhausted store has no next page.
          const nextCursor =
            visible.length > pageSize
              ? (page[page.length - 1]?.threadId ?? null)
              : exhausted
                ? null
                : scannedCursor;

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

      // --- Live story comments (WS-T.5) --------------------------------------
      .get(
        '/stories/:storyId/comments/stream',
        rateLimit({ limit: 250, windowMs: 60_000 }),
        zValidator('param', z.object({ storyId: uuidSchema })),
        zValidator('query', z.object({ since: uuidSchema.optional() })),
        async (c) => {
          const { storyId } = c.req.valid('param');
          const { since } = c.req.valid('query');
          const bundle = bundles();
          const identity = getIdentityServices();
          const userId = await softUserId(c.req.header('cookie'), identity);
          const [story, thread] = await Promise.all([
            bundle.ingestion.stories.getById(storyId),
            bundle.ingestion.stories.getThreadByStoryId(storyId),
          ]);
          if (!story || !thread) return c.json(notFound, 404);
          if (!(await threadReadableToUser(bundle, thread, userId))) return c.json(notFound, 404);

          const resolveAuthor = makeAuthorResolver(identity);
          const lastEventId = c.req.header('last-event-id') ?? since ?? null;
          const restrictedMedia = story.visibility === 'room_only';
          // Subscribe BEFORE the replay snapshot, awaiting transport readiness
          // (the Redis broadcaster resolves only after the SUBSCRIBE ack — pub/
          // sub drops, it never buffers), so no frame can fall between the
          // snapshot and the live stream.  Frames arriving while the stream is
          // still opening are buffered and flushed after the replay; the `sent`
          // set dedupes the overlap.
          let deliver: (frame: CommentFrame) => void;
          const buffered: CommentFrame[] = [];
          deliver = (frame) => {
            buffered.push(frame);
          };
          const unsubscribe = await bundle.forum.commentBroadcaster.subscribe(
            thread.threadId,
            (frame) => deliver(frame),
          );
          let replay: CommentFrame[];
          try {
            replay = await replayFramesAfter(
              bundle,
              thread.threadId,
              lastEventId,
              userId,
              resolveAuthor,
              restrictedMedia,
            );
          } catch (error) {
            unsubscribe(); // never leak the subscription on a failed replay read
            throw error;
          }
          const encoder = new TextEncoder();
          let cleanup = () => {};
          const readable = new ReadableStream<Uint8Array>({
            start(controller) {
              const sent = new Set(replay.map((frame) => frame.eventId));
              let heartbeat: ReturnType<typeof setInterval> | null = null;
              const write = (chunk: string) => {
                try {
                  controller.enqueue(encoder.encode(chunk));
                } catch {
                  unsubscribe();
                  if (heartbeat) clearInterval(heartbeat);
                }
              };
              const close = () => {
                unsubscribe();
                if (heartbeat) clearInterval(heartbeat);
                try {
                  controller.close();
                } catch {
                  // Already closed by the client; cleanup above is the important part.
                }
              };
              const emitLive = async (frame: CommentFrame): Promise<void> => {
                if (sent.has(frame.eventId)) return;
                if (!(await threadReadableToUser(bundle, thread, userId))) {
                  close();
                  return;
                }
                const row = await bundle.forum.contributions.getById(frame.eventId);
                if (!row) return;
                const hide = await viewerHideSet(bundle, userId);
                if (visibleRows([row], userId, hide).length === 0) return;
                sent.add(frame.eventId);
                write(sseCommentFrame(frame));
              };
              heartbeat = setInterval(() => write(': heartbeat\n\n'), SSE_HEARTBEAT_MS);
              cleanup = close;
              c.req.raw.signal.addEventListener('abort', close, { once: true });
              write(': heartbeat\n\n');
              for (const frame of replay) write(sseCommentFrame(frame));
              // Flush anything that arrived during setup, then go write-through.
              for (const frame of buffered) void emitLive(frame).catch(() => {});
              deliver = (frame) => {
                void emitLive(frame).catch(() => {});
              };
            },
            cancel() {
              cleanup();
            },
          });
          return new Response(readable, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-store, no-transform',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
            },
          });
        },
      )

      // --- Story comments (WS-T.3.1) -----------------------------------------
      .get(
        '/stories/:storyId/comments',
        zValidator('param', z.object({ storyId: uuidSchema })),
        zValidator(
          'query',
          z.object({
            cursor: z.string().min(1).max(512).optional(),
            order: z.enum(['newest', 'oldest']).optional().default('oldest'),
            root: uuidSchema.optional(),
            filter: z.enum(['sources', 'corrections']).optional(),
            // Nested reply layers to materialize: 1 = inline story section,
            // 2 = the dedicated comment-centric page (WS-T.7.2).
            depth: z.coerce.number().int().min(1).max(2).optional().default(1),
          }),
        ),
        async (c) => {
          const { storyId } = c.req.valid('param');
          const { cursor, order, root, filter, depth } = c.req.valid('query');
          const bundle = bundles();
          const identity = getIdentityServices();
          const userId = await softUserId(c.req.header('cookie'), identity);
          const [story, thread] = await Promise.all([
            bundle.ingestion.stories.getById(storyId),
            bundle.ingestion.stories.getThreadByStoryId(storyId),
          ]);
          if (!story || !thread) return c.json(notFound, 404);
          if (!(await threadReadableToUser(bundle, thread, userId))) return c.json(notFound, 404);
          const resolveAuthor = makeAuthorResolver(identity);
          const [counts, sourcesCount, debatesCount, incorrectCount] = await Promise.all([
            bundle.forum.contributions.countByType(thread.threadId, ['published']),
            bundle.forum.contributions.countSourced(thread.threadId, ['published']),
            bundle.forum.debates.countActiveForStory(storyId),
            bundle.forum.contributions.countByDisputeStatus(thread.threadId, 'incorrect'),
          ]);
          const page = await commentPage(bundle, thread.threadId, userId, resolveAuthor, {
            cursor: cursor ?? null,
            order,
            // Type filters apply to top-level roots only; in focused mode the
            // listed rows are a single comment's direct replies.
            ...(filter !== undefined && root === undefined ? { filter } : {}),
            depth,
            ...(root !== undefined ? { parentId: root } : {}),
            restrictedMedia: story.visibility === 'room_only',
            mintMediaUrl: makeMediaUrlMinter(),
          });
          // A focused read of a missing/invisible anchor is a 404 (it cannot
          // anchor enumeration of the conversation beneath it).
          if (root !== undefined && !page.rootFound) return c.json(notFound, 404);
          return c.json(
            storyCommentsResponseSchema.parse({
              comments: page.comments,
              anchor: page.anchor,
              next_cursor: page.nextCursor,
              overview: {
                comment_count: Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0),
                sources_count: sourcesCount,
                corrections_count: counts.correction ?? 0,
                debates_count: debatesCount,
                incorrect_count: incorrectCount,
              },
            }),
          );
        },
      )

      // --- Story active-debate discovery (WS-T) ------------------------------
      // A PUBLIC, display-only list of a story's ACTIVE (non-resolved) debate
      // arenas so anyone reading a story can find + watch a live debate as it
      // happens.  Soft-auth + the SAME thread-readability gate the comment reads
      // use (404-over-403), so it can never leak a restricted-room conversation.
      // Not a stream: the arena's own /debates/:id/stream carries live frames;
      // this list is a poll-on-open + a client-side countdown.
      .get(
        '/stories/:storyId/debates',
        zValidator('param', z.object({ storyId: uuidSchema })),
        async (c) => {
          const { storyId } = c.req.valid('param');
          const bundle = bundles();
          const identity = getIdentityServices();
          const userId = await softUserId(c.req.header('cookie'), identity);
          const [story, thread] = await Promise.all([
            bundle.ingestion.stories.getById(storyId),
            bundle.ingestion.stories.getThreadByStoryId(storyId),
          ]);
          if (!story || !thread) return c.json(notFound, 404);
          if (!(await threadReadableToUser(bundle, thread, userId))) return c.json(notFound, 404);
          const resolveAuthor = makeAuthorResolver(identity);
          const arenas = await bundle.forum.debates.listActiveForStory(storyId, 50);
          const debates = await Promise.all(
            arenas.map(async (arena) => {
              let excerpt: string | null = story.title;
              if (arena.targetType === 'comment' && arena.targetContributionId !== null) {
                const target = await bundle.forum.contributions.getById(arena.targetContributionId);
                // A moderation-withheld target (under_review/removed/hidden)
                // never leaks its text through the discovery excerpt — the
                // same suppression the arena projection applies.
                excerpt = target && target.moderationState === 'published' ? target.body : null;
              }
              return toDebateArenaSummary(arena, resolveAuthor, excerpt);
            }),
          );
          return c.json(storyDebatesResponseSchema.parse({ debates }));
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
          const overview = await threadOverview(bundle, thread, story.title);
          return c.json(threadDetailSchema.parse(overview));
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
        zValidator('json', contributionWriteCreateSchema),
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
          const thread = await bundle.ingestion.stories.getThreadById(
            outcome.contribution.threadId,
          );
          const story = thread ? await bundle.ingestion.stories.getById(thread.storyId) : null;
          const contribution = await liveContributionProjection(
            bundle,
            outcome.contribution,
            auth.userId,
            resolveAuthor,
            story?.visibility === 'room_only',
          );
          const broadcastContribution = await liveContributionProjection(
            bundle,
            outcome.contribution,
            null,
            resolveAuthor,
            story?.visibility === 'room_only',
          );
          if (!outcome.deduplicated && outcome.contribution.moderationState === 'published') {
            bundle.forum.commentBroadcaster.publish(outcome.contribution.threadId, {
              eventId: outcome.contribution.contributionId,
              contribution: broadcastContribution,
            });
            if (
              outcome.contribution.parentContributionId !== null &&
              thread !== null &&
              story !== null
            ) {
              const parent = await bundle.forum.contributions.getById(
                outcome.contribution.parentContributionId,
              );
              const recipientUserId = parent?.userId ?? null;
              if (
                recipientUserId !== null &&
                recipientUserId !== auth.userId &&
                !(await bundle.forum.relationshipReader?.interactionBlocked(
                  auth.userId,
                  recipientUserId,
                )) &&
                !(await viewerHideSet(bundle, recipientUserId))?.has(auth.userId) &&
                (await threadReadableToUser(bundle, thread, recipientUserId))
              ) {
                bundle.forum.trackBackground(
                  (async () => {
                    const notification = await replyNotifications.enqueue({
                      recipientUserId,
                      storyId: story.storyId,
                      threadId: thread.threadId,
                      commentId: outcome.contribution.contributionId,
                      parentCommentId: outcome.contribution.parentContributionId as string,
                      actorUserId: auth.userId,
                      actorHandle: contribution.author_handle ?? 'deleted-user',
                    });
                    const prefs = await getPreferences(recipientUserId);
                    const vapid = getVapidConfig();
                    const minuteOfDay = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
                    if (
                      notification &&
                      prefs.reply_notifications &&
                      suppressionReason(prefs, {
                        topic: story.roomId ?? undefined,
                        minuteOfDay,
                      }) === null &&
                      vapid
                    ) {
                      await sendBodylessWakeToUser(recipientUserId, vapid);
                    }
                  })(),
                );
              }
            }
          }
          return c.json(
            contributionCreateResponseSchema.parse({
              contribution,
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
          // canonical veneer, not a second store). Feed-mode writes store the
          // legacy-preserving spelling (rollout compat: stale bundles on the
          // same account keep parsing the echoed value; lossless for
          // best/new — see legacyPreservingFeedMode).
          const nextPersonalization = personalizationSettingsSchema.parse({
            ...user.personalizationSettings,
            ...(patch.feed_mode !== undefined
              ? { feed_mode: legacyPreservingFeedMode(patch.feed_mode) }
              : {}),
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
          const isVideo = (UPLOAD_VIDEO_TYPES as readonly string[]).includes(contentType);
          const isCaption = (UPLOAD_CAPTION_TYPES as readonly string[]).includes(contentType);
          if (!isImage && !isVideo && !isCaption) {
            return c.json(
              deny('unsupported_type', 'Allowed: JPEG, PNG, WebP, AVIF, GIF, MP4, WebM, VTT'),
              415,
            );
          }
          // The video byte cap is the steward-tunable `ingestion.video_max_bytes`
          // clamped to the hard DB ceiling (it may lower it, never raise it).
          const videoCfg = getIngestionServices().config();
          const maxVideoBytes = Math.min(videoCfg.videoMaxBytes, MAX_VIDEO_BYTES);
          const maxBytes = isImage
            ? contentType === 'image/gif'
              ? MAX_GIF_BYTES
              : MAX_IMAGE_BYTES
            : isVideo
              ? maxVideoBytes
              : MAX_CAPTION_BYTES;
          if (file.size > maxBytes) {
            return c.json(deny('payload_too_large', 'Upload exceeds the size limit'), 413);
          }
          // Alt text is REQUIRED for images (WCAG; WS-G.3.7b acceptance);
          // videos carry none (captions are a separate post field).
          if (isImage && altText.length === 0) {
            return c.json(deny('alt_text_required', 'Images require alt text'), 422);
          }
          if (altText.length > 500) {
            return c.json(deny('alt_text_too_long', 'Alt text is limited to 500 characters'), 422);
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          // Video rides the validate-only container probe (WS-Q.2.3d); images
          // ride the metadata-stripping path (WS-G.3.7b).
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
          // GRANDFATHERED legacy documents (the retired PDF upload path;
          // migration 0076 preserves the rows) download rather than render
          // inline — embedded-JS viewers must never execute in-origin.
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
      // --- WS-T debate arena (sourced-correction adjudication) ----------------
      // Read the arena (role-scoped: the caller sees whether they are the
      // incumbent, challenger, steward, or an observer).
      .get(
        '/debates/:debateId',
        authMiddleware(),
        zValidator('param', z.object({ debateId: uuidSchema })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const bundle = bundles();
          const { debateId } = c.req.valid('param');
          const arena = await bundle.forum.debates.getById(debateId);
          if (arena === null) return c.json(notFound, 404);
          // WS-T — a debate exposes the full arena (both sides' positions + their
          // sources).  Gate it behind the SAME thread-readability check the
          // comment reads use, so knowing a debate id does not reveal a
          // restricted-room conversation to a non-member (404-over-403).
          const thread = await bundle.ingestion.stories.getThreadByStoryId(arena.storyId);
          if (!thread || !(await threadReadableToUser(bundle, thread, auth.userId))) {
            return c.json(notFound, 404);
          }
          const identity = getIdentityServices();
          // Mirrors the DebateDeps isSteward closure: room grants, or the
          // platform ADMIN (the overrule affordance must render for whoever
          // the action gate admits).
          const isSteward =
            arena.roomId !== null &&
            ((await bundle.forum.rooms.stewardRolesFor(arena.roomId, auth.userId)).length > 0 ||
              auth.roles.includes('admin'));
          const deps = debateDepsFromBundle(bundle);
          const projected = await toDebateArenaPublic(
            arena,
            auth.userId,
            makeAuthorResolver(identity),
            isSteward,
            await readDebateArenaContent(deps.contributions, deps.storyContent, arena),
          );
          return c.json(debateArenaResponseSchema.parse({ debate: projected }));
        },
      )
      // Live arena stream (WS-T): pushes the underlying material + co-visible
      // rebuttal drafts, verdict, and resolution so each side sees the other's
      // current case AS THEY EDIT.  The frame is the OBSERVER projection — a
      // nudge; the client re-fetches its own role-scoped view for its edit
      // affordances.
      .get(
        '/debates/:debateId/stream',
        rateLimit({ limit: 250, windowMs: 60_000 }),
        authMiddleware(),
        zValidator('param', z.object({ debateId: uuidSchema })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const bundle = bundles();
          const { debateId } = c.req.valid('param');
          const current = await bundle.forum.debates.getById(debateId);
          if (current === null) return c.json(notFound, 404);
          // WS-T — the live stream carries the same full-arena projection, so it
          // is gated on thread readability exactly like the one-shot read above.
          const streamThread = await bundle.ingestion.stories.getThreadByStoryId(current.storyId);
          if (!streamThread || !(await threadReadableToUser(bundle, streamThread, auth.userId))) {
            return c.json(notFound, 404);
          }
          const streamDeps = debateDepsFromBundle(bundle);
          const observer = async () => {
            const arena = await bundle.forum.debates.getById(debateId);
            if (arena === null) return null;
            const content = await readDebateArenaContent(
              streamDeps.contributions,
              streamDeps.storyContent,
              arena,
            );
            return toDebateArenaPublic(arena, null, async () => null, false, content);
          };
          // Subscribe BEFORE priming, awaiting transport readiness (the Redis
          // broadcaster resolves only after the SUBSCRIBE ack), so an update
          // published by another replica while this stream opens is buffered
          // rather than dropped, then flushed after the prime.
          let deliver: (frame: DebateFrame) => void;
          const bufferedFrames: DebateFrame[] = [];
          deliver = (frame) => {
            bufferedFrames.push(frame);
          };
          const unsubscribe = await bundle.forum.debateBroadcaster.subscribe(debateId, (frame) =>
            deliver(frame),
          );
          const encoder = new TextEncoder();
          let cleanup = () => {};
          const readable = new ReadableStream<Uint8Array>({
            async start(controller) {
              let heartbeat: ReturnType<typeof setInterval> | null = null;
              const write = (chunk: string): void => {
                try {
                  controller.enqueue(encoder.encode(chunk));
                } catch {
                  unsubscribe();
                  if (heartbeat) clearInterval(heartbeat);
                }
              };
              const close = (): void => {
                unsubscribe();
                if (heartbeat) clearInterval(heartbeat);
                try {
                  controller.close();
                } catch {
                  // Already closed by the client.
                }
              };
              // Re-check thread readability before EVERY live frame (parity
              // with the comments stream): a member who left the room — or a
              // thread the floor removed — must stop receiving arena material
              // mid-stream, not only on the next fresh GET.
              const emitLive = async (frame: DebateFrame): Promise<void> => {
                if (!(await threadReadableToUser(bundle, streamThread, auth.userId))) {
                  close();
                  return;
                }
                write(sseDebateFrame(frame));
              };
              heartbeat = setInterval(() => write(': heartbeat\n\n'), SSE_HEARTBEAT_MS);
              cleanup = close;
              c.req.raw.signal.addEventListener('abort', close, { once: true });
              write(': heartbeat\n\n');
              // Prime with the current arena so a late joiner has the latest state.
              const initial = await observer();
              if (initial) write(sseDebateFrame({ eventId: initial.updated_at, arena: initial }));
              // Flush anything that arrived during setup, then go write-through.
              for (const frame of bufferedFrames) void emitLive(frame).catch(() => {});
              deliver = (frame) => {
                void emitLive(frame).catch(() => {});
              };
            },
            cancel() {
              cleanup();
            },
          });
          return new Response(readable, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-store, no-transform',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
            },
          });
        },
      )
      // Post/replace the caller's co-visible rebuttal statement (incumbent/
      // challenger only, while the arena is `open` — until the material locks
      // in on the 23h schedule or the both-sides-idle expedite).
      .post(
        '/debates/:debateId/position',
        authMiddleware(),
        requireVerifiedAccount(),
        requireUnrestricted(),
        zValidator('param', z.object({ debateId: uuidSchema })),
        zValidator('json', debatePositionUpdateSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const bundle = bundles();
          const { debateId } = c.req.valid('param');
          // WS-T — writes carry the same readability gate as the reads: a
          // party who lost access to the conversation cannot keep posting
          // rebuttal/source text into its arena.
          const gateArena = await bundle.forum.debates.getById(debateId);
          if (gateArena === null) return c.json(notFound, 404);
          if (!(await debateWriteReadable(bundle, gateArena, auth.userId))) {
            return c.json(notFound, 404);
          }
          const deps = debateDepsFromBundle(bundle);
          const outcome = await postDebatePosition(
            deps,
            debateId,
            auth.userId,
            c.req.valid('json'),
          );
          if (!outcome.ok) {
            const status =
              outcome.reason === 'not_found' ? 404 : outcome.reason === 'not_a_party' ? 403 : 409;
            return c.json(deny(outcome.reason, positionErrorMessage(outcome.reason)), status);
          }
          const identity = getIdentityServices();
          // Mirrors the DebateDeps isSteward closure (room grants ∪ platform admin).
          const isSteward =
            outcome.arena.roomId !== null &&
            ((await bundle.forum.rooms.stewardRolesFor(outcome.arena.roomId, auth.userId)).length >
              0 ||
              auth.roles.includes('admin'));
          const projected = await toDebateArenaPublic(
            outcome.arena,
            auth.userId,
            makeAuthorResolver(identity),
            isSteward,
            await readDebateArenaContent(deps.contributions, deps.storyContent, outcome.arena),
          );
          return c.json(debateArenaResponseSchema.parse({ debate: projected }));
        },
      )
      // The challenger retracts the correction while the arena is open: the
      // debate closes `withdrawn` — no verdict, the target's tag clears, and
      // the target stays re-challengeable.
      .post(
        '/debates/:debateId/withdraw',
        authMiddleware(),
        requireVerifiedAccount(),
        requireUnrestricted(),
        zValidator('param', z.object({ debateId: uuidSchema })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const bundle = bundles();
          const { debateId } = c.req.valid('param');
          // Same readability gate as the reads (404-over-403).
          const gateArena = await bundle.forum.debates.getById(debateId);
          if (gateArena === null) return c.json(notFound, 404);
          if (!(await debateWriteReadable(bundle, gateArena, auth.userId))) {
            return c.json(notFound, 404);
          }
          const deps = debateDepsFromBundle(bundle);
          const outcome = await withdrawDebate(deps, debateId, auth.userId);
          if (!outcome.ok) {
            const status =
              outcome.reason === 'not_found'
                ? 404
                : outcome.reason === 'not_challenger'
                  ? 403
                  : 409;
            return c.json(deny(outcome.reason, withdrawErrorMessage(outcome.reason)), status);
          }
          const projected = await toDebateArenaPublic(
            outcome.arena,
            auth.userId,
            makeAuthorResolver(getIdentityServices()),
            false,
            await readDebateArenaContent(deps.contributions, deps.storyContent, outcome.arena),
          );
          return c.json(debateArenaResponseSchema.parse({ debate: projected }));
        },
      )
      // The incumbent concedes while the arena is open: the challenger
      // prevails without adjudication (decided_by = 'concession').
      .post(
        '/debates/:debateId/concede',
        authMiddleware(),
        requireVerifiedAccount(),
        requireUnrestricted(),
        zValidator('param', z.object({ debateId: uuidSchema })),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const bundle = bundles();
          const { debateId } = c.req.valid('param');
          // Same readability gate as the reads (404-over-403).
          const gateArena = await bundle.forum.debates.getById(debateId);
          if (gateArena === null) return c.json(notFound, 404);
          if (!(await debateWriteReadable(bundle, gateArena, auth.userId))) {
            return c.json(notFound, 404);
          }
          const deps = debateDepsFromBundle(bundle);
          const outcome = await concedeDebate(deps, debateId, auth.userId);
          if (!outcome.ok) {
            const status =
              outcome.reason === 'not_found' ? 404 : outcome.reason === 'not_incumbent' ? 403 : 409;
            return c.json(deny(outcome.reason, concedeErrorMessage(outcome.reason)), status);
          }
          const projected = await toDebateArenaPublic(
            outcome.arena,
            auth.userId,
            makeAuthorResolver(getIdentityServices()),
            false,
            await readDebateArenaContent(deps.contributions, deps.storyContent, outcome.arena),
          );
          return c.json(debateArenaResponseSchema.parse({ debate: projected }));
        },
      )
      // The room steward fully overrules the AI verdict (either direction), within
      // 24h, audited (the service enforces the steward-only + window guard).
      .post(
        '/debates/:debateId/override',
        authMiddleware(),
        requireVerifiedAccount(),
        requireUnrestricted(),
        zValidator('param', z.object({ debateId: uuidSchema })),
        zValidator('json', debateOverrideRequestSchema),
        async (c) => {
          const auth = getAuth(c);
          if (!auth) return c.json(deny('unauthenticated', 'Authentication required'), 401);
          const bundle = bundles();
          const { debateId } = c.req.valid('param');
          const { winner, reason } = c.req.valid('json');
          // Same readability gate as the reads (404-over-403): overruling is a
          // room-governance power, exercised only from inside the conversation.
          const gateArena = await bundle.forum.debates.getById(debateId);
          if (gateArena === null) return c.json(notFound, 404);
          if (!(await debateWriteReadable(bundle, gateArena, auth.userId))) {
            return c.json(notFound, 404);
          }
          const outcome = await overrideDebateVerdict(
            debateDepsFromBundle(bundle),
            debateId,
            auth.userId,
            winner,
            reason,
          );
          if (!outcome.ok) {
            const status =
              outcome.reason === 'not_found' ? 404 : outcome.reason === 'not_steward' ? 403 : 409;
            return c.json(deny(outcome.reason, overrideErrorMessage(outcome.reason)), status);
          }
          // The override is durably recorded on the arena row (overridden_by +
          // override_reason) and the service audit log; no separate identity-
          // audit taxonomy entry is minted here.
          const overrideDeps = debateDepsFromBundle(bundle);
          const projected = await toDebateArenaPublic(
            outcome.arena,
            auth.userId,
            makeAuthorResolver(getIdentityServices()),
            true,
            await readDebateArenaContent(
              overrideDeps.contributions,
              overrideDeps.storyContent,
              outcome.arena,
            ),
          );
          return c.json(debateArenaResponseSchema.parse({ debate: projected }));
        },
      )
  );
}

/**
 * WS-T — debate WRITES are gated on the SAME thread-readability check as the
 * arena reads: a party (or steward) who has since lost access to the
 * conversation — left or was removed from a restricted room, or the thread was
 * pulled by the moderation floor — can no longer post to, close, or overrule
 * its arena (404-over-403, matching the reads above).
 */
async function debateWriteReadable(
  bundle: Parameters<typeof threadReadableToUser>[0] & {
    ingestion: {
      stories: { getThreadByStoryId(storyId: string): Promise<ThreadShellRecord | null> };
    };
  },
  arena: { storyId: string },
  userId: string,
): Promise<boolean> {
  const thread = await bundle.ingestion.stories.getThreadByStoryId(arena.storyId);
  if (!thread) return false;
  return threadReadableToUser(bundle, thread, userId);
}

function positionErrorMessage(reason: 'not_found' | 'not_a_party' | 'window_closed'): string {
  if (reason === 'not_found') return 'The debate no longer exists.';
  if (reason === 'not_a_party') return 'Only the incumbent or challenger may post a position.';
  return 'The debate material is locked in awaiting AI resolution.';
}

function withdrawErrorMessage(reason: 'not_found' | 'not_challenger' | 'window_closed'): string {
  if (reason === 'not_found') return 'The debate no longer exists.';
  if (reason === 'not_challenger') return 'Only the challenger may withdraw the correction.';
  return 'The debate material is locked in awaiting AI resolution.';
}

function concedeErrorMessage(reason: 'not_found' | 'not_incumbent' | 'window_closed'): string {
  if (reason === 'not_found') return 'The debate no longer exists.';
  if (reason === 'not_incumbent') return 'Only the challenged author may concede.';
  return 'The debate material is locked in awaiting AI resolution.';
}

function overrideErrorMessage(
  reason: 'not_found' | 'not_steward' | 'not_judged' | 'window_closed',
): string {
  if (reason === 'not_found') return 'The debate no longer exists.';
  if (reason === 'not_steward') return 'Only the room steward may overrule the verdict.';
  if (reason === 'not_judged') return 'The debate has no verdict to overrule yet.';
  return 'The 24-hour override window has closed.';
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
