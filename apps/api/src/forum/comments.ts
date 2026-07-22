// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7 story comment reads.  Both the inline story-page section and the
// dedicated comment-centric page materialize up to TWO nested reply layers
// (`depth: 2`); the dedicated page additionally re-roots at any comment
// (`parentId`) so a reader drills as deep as they like one focused view at a
// time (a focused re-rooted view materializes `depth: 1`).  Either way the wire tree is
// assembled server-side from REPLY_PREVIEW-bounded fetches, then projected
// holistically (one visibility pass, one child-count batch, one author/media
// batch) so the recursion never fans out into N+1 round-trips.
import { type CommentItem, type ContributionPublic, isAnimatableImage } from '@licio/shared';
import type { IngestionServices } from '../ingestion/services.js';
import type { MediaUrlMinter } from '../lib/media-urls.js';
import type { ForumServices } from './services.js';
import {
  type ContributionRecord,
  type CreatedAtCursor,
  sectionRankOf,
  type UploadRecord,
} from './stores.js';
import {
  type AuthorResolver,
  toContributionPublic,
  viewerHideSet,
  visibleRows,
} from './threads.js';

/** Direct replies previewed per node before a "show more / continue" affordance. */
export const REPLY_PREVIEW = 3;

/** Every renderable state — tombstones (removed/hidden parents of visible rows)
 *  are kept so a subtree never orphans (see `visibleRows`). */
const RENDERABLE_STATES = ['published', 'under_review', 'hidden', 'removed'] as const;

interface Bundle {
  forum: ForumServices;
  ingestion: IngestionServices;
}

export type CommentFilter = 'sources' | 'corrections';

export interface CommentPageOptions {
  cursor: string | null;
  order: 'newest' | 'oldest';
  filter?: CommentFilter;
  /** Nested reply layers to materialize per listed root: 2 for the inline story
   *  section and the unrooted comment page, 1 for a focused re-rooted view. */
  depth: number;
  /** Focused (rooted) mode: list this comment's direct replies instead of the
   *  thread's top-level roots, and return the comment itself as `anchor`. */
  parentId?: string;
  /** WS-T — the id of the story's currently pinnable challenger correction (the
   *  live arena's challenger, or the one that prevailed and made the story
   *  `incorrect`).  That correction pins to the TOP of the unrooted section;
   *  null/absent ⇒ no pin. Scoped by identity, so a settled inconclusive/
   *  withdrawn story correction never pins. */
  pinnedCorrectionId?: string | null;
  restrictedMedia: boolean;
  mintMediaUrl: MediaUrlMinter;
}

export interface CommentPageResult {
  comments: CommentItem[];
  /** The focused comment (focused mode only); null for the unrooted thread view. */
  anchor: CommentItem | null;
  nextCursor: string | null;
  /** Focused mode: false ⇒ the anchor is missing or invisible ⇒ route 404s. */
  rootFound: boolean;
}

/**
 * Map the `listRoots`-backed section filter to store options.  The "Sources"
 * view is every SOURCED root (a comment carrying ≥1 citation), matching the
 * client's "Sourced" badge; the store's `sourced` predicate expresses that.
 * ("Corrections" is NOT here — it enumerates every correction thread-wide via
 * `listByThread`, since a comment-target correction is no longer a root.) */
function rootFilterOptions(filter: CommentFilter | undefined): { sourced?: boolean } {
  return filter === 'sources' ? { sourced: true } : {};
}

export function commentMediaOf(
  upload: UploadRecord,
  mint: MediaUrlMinter,
  restricted: boolean,
): NonNullable<ContributionPublic['media']>[number] | null {
  if (upload.scanState !== 'clear') return null;
  if (!upload.contentType.startsWith('image/')) return null;
  if (upload.altText === null) return null;
  return {
    upload_id: upload.uploadId,
    url: mint(upload.uploadId, restricted),
    kind: 'image',
    content_type: upload.contentType,
    alt_text: upload.altText,
    animatable: isAnimatableImage(upload.contentType),
  };
}

async function resolveMedia(
  bundle: Bundle,
  rows: readonly ContributionRecord[],
  mint: MediaUrlMinter,
  restricted: boolean,
): Promise<Map<string, NonNullable<ContributionPublic['media']>>> {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const id of row.metadata.attachment_ids ?? []) ids.add(id);
  }
  const uploads = new Map<string, UploadRecord>();
  for (const id of ids) {
    const upload = await bundle.forum.uploads.getRecord(id);
    if (upload) uploads.set(id, upload);
  }
  const byContribution = new Map<string, NonNullable<ContributionPublic['media']>>();
  for (const row of rows) {
    const media: NonNullable<ContributionPublic['media']> = [];
    for (const id of row.metadata.attachment_ids ?? []) {
      const upload = uploads.get(id);
      if (!upload) continue;
      const item = commentMediaOf(upload, mint, restricted);
      if (item) media.push(item);
    }
    if (media.length > 0) byContribution.set(row.contributionId, media);
  }
  return byContribution;
}

// --- Phase 1: fetch the record forest (REPLY_PREVIEW-bounded, `depth` deep) ---

interface RawNode {
  record: ContributionRecord;
  /** True once we descended into this node's children (depth budget remained). */
  materialized: boolean;
  /** Materialized: more direct children exist than the REPLY_PREVIEW shown. */
  moreDirect: boolean;
  children: RawNode[];
}

async function fetchRawNode(
  bundle: Bundle,
  record: ContributionRecord,
  depth: number,
): Promise<RawNode> {
  if (depth <= 0) return { record, materialized: false, moreDirect: false, children: [] };
  // Reply previews stay newest-first (the "latest activity" snapshot), matching
  // the inline section; the focused list's chronological order is applied only
  // to the top level the caller paginates.
  const childRows = await bundle.forum.contributions.listChildren(record.contributionId, {
    states: RENDERABLE_STATES,
    limit: REPLY_PREVIEW + 1,
  });
  const moreDirect = childRows.length > REPLY_PREVIEW;
  const children = await Promise.all(
    childRows.slice(0, REPLY_PREVIEW).map((child) => fetchRawNode(bundle, child, depth - 1)),
  );
  return { record, materialized: true, moreDirect, children };
}

function collectRecords(node: RawNode, acc: ContributionRecord[]): void {
  acc.push(node.record);
  for (const child of node.children) collectRecords(child, acc);
}

// --- Phase 2: holistic projection (one visibility/child-count/author/media pass) -

interface ProjectCtx {
  requesterUserId: string | null;
  /** id → tombstone flag; absence means "not renderable" (drop the node). */
  visible: ReadonlyMap<string, boolean>;
  childCounts: ReadonlyMap<string, number>;
  authors: ReadonlyMap<string, { handle: string; displayName: string } | null>;
  media: ReadonlyMap<string, NonNullable<ContributionPublic['media']>>;
  /** WS-T — contribution id → the open debate arena challenging it (if any). */
  activeDebates: ReadonlyMap<string, string>;
  /** WS-T — correction contribution id → the arena it OPENED (any state), so the
   *  correction always resolves its `debate_arena_id` back-reference even after
   *  the arena resolves and independently of whether the write path persisted it
   *  onto the stored metadata. */
  correctionArenas: ReadonlyMap<string, string>;
  /** WS-T — the story's CURRENT challenger correction id (live or prevailed), so
   *  its node reports `story_challenge_active`; a settled inconclusive/withdrawn
   *  story challenge is not this id and renders as closed. Null in focused views. */
  pinnedCorrectionId: string | null;
}

async function buildProjectCtx(
  bundle: Bundle,
  records: readonly ContributionRecord[],
  requesterUserId: string | null,
  resolveAuthor: AuthorResolver,
  hide: ReadonlySet<string> | undefined,
  opts: CommentPageOptions,
): Promise<ProjectCtx> {
  const byId = new Map<string, ContributionRecord>();
  for (const record of records) byId.set(record.contributionId, record);
  const unique = [...byId.values()];
  const visibleArr = visibleRows(unique, requesterUserId, hide);
  const visible = new Map<string, boolean>();
  for (const entry of visibleArr) visible.set(entry.row.contributionId, entry.tombstone);
  const rendered = visibleArr.filter((entry) => !entry.tombstone).map((entry) => entry.row);
  // Authors are resolved for each UNIQUE author once (the resolver memoizes; the
  // distinct ids make concurrent calls race-free).  Child counts, author
  // resolution, and media all read independent stores, so run them concurrently.
  const authorIds = [
    ...new Set(rendered.map((record) => record.userId).filter((id): id is string => id !== null)),
  ];
  // WS-T — the open arena (if any) challenging a comment under debate; only rows
  // marked `under_debate` can have one, so query just those (bounded).
  const disputedIds = rendered
    .filter((record) => record.disputeStatus === 'under_debate')
    .map((record) => record.contributionId);
  // WS-T — the arena each rendered correction opened (any state), so the
  // correction's `debate_arena_id` back-reference always resolves — including
  // after the debate resolves, where the target carries no active_debate_id.
  const correctionIds = rendered
    .filter((record) => record.type === 'correction')
    .map((record) => record.contributionId);
  const [childCounts, authorEntries, media, activeDebates, correctionArenas] = await Promise.all([
    bundle.forum.contributions.childCounts(unique.map((record) => record.contributionId)),
    Promise.all(authorIds.map(async (id) => [id, await resolveAuthor(id)] as const)),
    resolveMedia(bundle, rendered, opts.mintMediaUrl, opts.restrictedMedia),
    disputedIds.length > 0
      ? bundle.forum.debates.activeDebateIdsForContributions(disputedIds)
      : Promise.resolve(new Map<string, string>()),
    correctionIds.length > 0
      ? bundle.forum.debates.debateIdsForCorrections(correctionIds)
      : Promise.resolve(new Map<string, string>()),
  ]);
  return {
    requesterUserId,
    visible,
    childCounts,
    authors: new Map(authorEntries),
    media,
    activeDebates,
    correctionArenas,
    // The pin applies to the unrooted section only (a story correction is a root).
    pinnedCorrectionId: opts.parentId === undefined ? (opts.pinnedCorrectionId ?? null) : null,
  };
}

function projectNode(node: RawNode, ctx: ProjectCtx): CommentItem | null {
  const tombstone = ctx.visible.get(node.record.contributionId);
  if (tombstone === undefined) return null;
  const author =
    tombstone || node.record.userId === null ? null : (ctx.authors.get(node.record.userId) ?? null);
  const childCount = ctx.childCounts.get(node.record.contributionId) ?? 0;
  const base = toContributionPublic(
    node.record,
    author,
    childCount,
    ctx.requesterUserId,
    tombstone,
  );
  const activeDebateId = tombstone
    ? null
    : (ctx.activeDebates.get(node.record.contributionId) ?? null);
  const withDebate = activeDebateId !== null ? { ...base, active_debate_id: activeDebateId } : base;
  // WS-T — a correction always carries the `debate_arena_id` of the arena it
  // opened (live OR resolved), so the client links it to its debate even when
  // the write path did not persist that back-reference onto the stored metadata.
  const correctionArenaId =
    !tombstone && node.record.type === 'correction'
      ? (node.record.metadata.debate_arena_id ??
        ctx.correctionArenas.get(node.record.contributionId) ??
        null)
      : null;
  const withArena =
    correctionArenaId !== null && withDebate.metadata.debate_arena_id == null
      ? { ...withDebate, metadata: { ...withDebate.metadata, debate_arena_id: correctionArenaId } }
      : withDebate;
  // WS-T — a STORY-target correction is the story's ACTIVE challenge only when it
  // is the pinned challenger (live, or prevailed → story `incorrect`); a settled
  // inconclusive/withdrawn one is not, so the UI renders it as a closed challenge.
  const withStanding =
    !tombstone &&
    node.record.type === 'correction' &&
    node.record.metadata.target_story_id !== undefined &&
    node.record.contributionId === ctx.pinnedCorrectionId
      ? { ...withArena, story_challenge_active: true }
      : withArena;
  const media = tombstone ? undefined : ctx.media.get(node.record.contributionId);
  const head = media ? { ...withStanding, media } : withStanding;
  const replies = node.children
    .map((child) => projectNode(child, ctx))
    .filter((child): child is CommentItem => child !== null);
  // A materialized node advertises "more" when it has more direct replies than
  // the preview; a leaf (depth budget exhausted) advertises any replies at all,
  // so the client offers "continue this thread" → the dedicated page.
  const hasMore = node.materialized
    ? node.moreDirect || childCount > REPLY_PREVIEW
    : childCount > 0;
  return { ...head, replies, reply_count: childCount, has_more_replies: hasMore };
}

/** Project the focused comment as a context header (its replies are `comments`). */
function projectAnchor(record: ContributionRecord, ctx: ProjectCtx): CommentItem | null {
  const item = projectNode({ record, materialized: false, moreDirect: false, children: [] }, ctx);
  return item ? { ...item, has_more_replies: false } : null;
}

export async function commentPage(
  bundle: Bundle,
  threadId: string,
  requesterUserId: string | null,
  resolveAuthor: AuthorResolver,
  opts: CommentPageOptions,
): Promise<CommentPageResult> {
  const pageSize = bundle.forum.config().branchPageSize;
  const hide = await viewerHideSet(bundle, requesterUserId);
  const empty = (rootFound: boolean): CommentPageResult => ({
    comments: [],
    anchor: null,
    nextCursor: null,
    rootFound,
  });

  // WS-T — the story's currently pinnable challenger correction pins to the TOP
  // of the section (the caller resolves its identity from the live/prevailed
  // arena). Only the UNROOTED section pins (a story correction is a root); a
  // focused (rooted) sub-thread view never lists a story-target root.
  const pinnedCorrectionId = opts.parentId === undefined ? (opts.pinnedCorrectionId ?? null) : null;

  // Keyset position (an unknown / foreign cursor restarts — defensive, never an error).
  // The cursor row's SECTION RANK is carried so the pinned story challenge stays on
  // top and `incorrect` rows stay sunk to the bottom across pagination (WS-T).
  let after: CreatedAtCursor | null = null;
  if (opts.cursor !== null) {
    const last = await bundle.forum.contributions.getById(opts.cursor);
    if (last && last.threadId === threadId)
      after = {
        createdAt: last.createdAt,
        id: last.contributionId,
        sectionRank: sectionRankOf(last, pinnedCorrectionId),
      };
  }

  // Focused mode: the anchor must exist and belong to the thread.  A removed or
  // blocked-author anchor that STILL has a visible reply remains anchorable — it
  // renders as a content-free tombstone (tree integrity, exactly as it appears
  // inline), so navigating "up one level" onto a moderated parent never dead-ends
  // on the error state.  It is rejected (404) only when NOTHING beneath it is
  // renderable — checked after projection, below.
  let anchorRecord: ContributionRecord | null = null;
  if (opts.parentId !== undefined) {
    const record = await bundle.forum.contributions.getById(opts.parentId);
    if (!record || record.threadId !== threadId) return empty(false);
    anchorRecord = record;
  }

  const rootRecords = anchorRecord
    ? await bundle.forum.contributions.listChildren(anchorRecord.contributionId, {
        states: RENDERABLE_STATES,
        after,
        limit: pageSize + 1,
        order: opts.order,
      })
    : opts.filter === 'corrections'
      ? // The "Corrections" view enumerates EVERY correction in the thread. A
        // comment-target correction now threads UNDER the comment it corrects
        // (server-derived parent), so root-only enumeration (`listRoots`) would
        // hide it — list by thread instead so both comment- and story-target
        // corrections appear, in the requested chronological order. Each is
        // projected FLAT (depth 0 below), so a correction that itself targets
        // another correction never appears twice (once listed, once nested).
        await bundle.forum.contributions.listByThread(threadId, {
          types: ['correction'],
          states: RENDERABLE_STATES,
          after,
          limit: pageSize + 1,
          order: opts.order,
        })
      : await bundle.forum.contributions.listRoots(threadId, {
          ...rootFilterOptions(opts.filter),
          states: RENDERABLE_STATES,
          after,
          limit: pageSize + 1,
          order: opts.order,
          pinnedCorrectionId,
        });

  const hasMore = rootRecords.length > pageSize;
  const page = rootRecords.slice(0, pageSize);
  const lastFetched = page[page.length - 1];

  // The "Corrections" view lists each correction FLAT (no reply subtree): a
  // correction that targets ANOTHER correction is a child of it, so materializing
  // subtrees would render it twice (once listed thread-wide, once nested). The
  // main + focused views keep their nested reply layers.
  const forestDepth = opts.filter === 'corrections' ? 0 : opts.depth;
  const forest = await Promise.all(page.map((record) => fetchRawNode(bundle, record, forestDepth)));
  const allRecords: ContributionRecord[] = [];
  for (const node of forest) collectRecords(node, allRecords);
  if (anchorRecord) allRecords.push(anchorRecord);

  const ctx = await buildProjectCtx(bundle, allRecords, requesterUserId, resolveAuthor, hide, opts);

  const comments = forest
    .map((node) => projectNode(node, ctx))
    .filter((node): node is CommentItem => node !== null);

  // `projectAnchor` returns null only when the anchor is neither visible nor a
  // tombstone with a visible descendant — i.e. nothing under it is renderable, so
  // a focused read of it is a 404.  A tombstone anchor with visible replies (the
  // moderated-parent case) projects as a content-free placeholder and is served.
  const anchor = anchorRecord ? projectAnchor(anchorRecord, ctx) : null;
  if (anchorRecord !== null && anchor === null) return empty(false);

  return {
    comments,
    anchor,
    nextCursor: hasMore && lastFetched ? lastFetched.contributionId : null,
    rootFound: true,
  };
}
