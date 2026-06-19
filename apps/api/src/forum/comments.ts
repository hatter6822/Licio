// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7 story comment reads.  The story-page section materializes ONE nested
// reply layer (`depth: 1`); the dedicated comment-centric page materializes TWO
// (`depth: 2`) and can re-root at any comment (`parentId`) so a reader drills as
// deep as they like one focused view at a time.  Either way the wire tree is
// assembled server-side from REPLY_PREVIEW-bounded fetches, then projected
// holistically (one visibility pass, one child-count batch, one author/media
// batch) so the recursion never fans out into N+1 round-trips.
import { type CommentItem, type ContributionPublic, isAnimatableImage } from '@licio/shared';
import type { IngestionServices } from '../ingestion/services.js';
import type { MediaUrlMinter } from '../lib/media-urls.js';
import type { ForumServices } from './services.js';
import type { ContributionRecord, CreatedAtCursor, UploadRecord } from './stores.js';
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
  /** Nested reply layers to materialize per listed root: 1 for the inline story
   *  section, 2 for the dedicated comment-centric page. */
  depth: number;
  /** Focused (rooted) mode: list this comment's direct replies instead of the
   *  thread's top-level roots, and return the comment itself as `anchor`. */
  parentId?: string;
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

function filterTypes(
  filter: CommentFilter | undefined,
): readonly ('evidence' | 'correction')[] | undefined {
  if (filter === 'sources') return ['evidence'];
  if (filter === 'corrections') return ['correction'];
  return undefined;
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
  const [childCounts, authorEntries, media] = await Promise.all([
    bundle.forum.contributions.childCounts(unique.map((record) => record.contributionId)),
    Promise.all(authorIds.map(async (id) => [id, await resolveAuthor(id)] as const)),
    resolveMedia(bundle, rendered, opts.mintMediaUrl, opts.restrictedMedia),
  ]);
  return { requesterUserId, visible, childCounts, authors: new Map(authorEntries), media };
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
  const media = tombstone ? undefined : ctx.media.get(node.record.contributionId);
  const head = media ? { ...base, media } : base;
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

  // Keyset position (an unknown / foreign cursor restarts — defensive, never an error).
  let after: CreatedAtCursor | null = null;
  if (opts.cursor !== null) {
    const last = await bundle.forum.contributions.getById(opts.cursor);
    if (last && last.threadId === threadId)
      after = { createdAt: last.createdAt, id: last.contributionId };
  }

  // Focused mode: the anchor must exist, belong to the thread, and be visible to
  // the viewer (a removed — or blocked-author — comment cannot anchor a page).
  let anchorRecord: ContributionRecord | null = null;
  if (opts.parentId !== undefined) {
    const record = await bundle.forum.contributions.getById(opts.parentId);
    if (!record || record.threadId !== threadId) return empty(false);
    if (visibleRows([record], requesterUserId, hide).every((entry) => entry.tombstone))
      return empty(false);
    anchorRecord = record;
  }

  const types = filterTypes(opts.filter);
  const rootRecords = anchorRecord
    ? await bundle.forum.contributions.listChildren(anchorRecord.contributionId, {
        states: RENDERABLE_STATES,
        after,
        limit: pageSize + 1,
        order: opts.order,
      })
    : await bundle.forum.contributions.listRoots(threadId, {
        ...(types !== undefined ? { types } : {}),
        states: RENDERABLE_STATES,
        after,
        limit: pageSize + 1,
        order: opts.order,
      });

  const hasMore = rootRecords.length > pageSize;
  const page = rootRecords.slice(0, pageSize);
  const lastFetched = page[page.length - 1];

  const forest = await Promise.all(page.map((record) => fetchRawNode(bundle, record, opts.depth)));
  const allRecords: ContributionRecord[] = [];
  for (const node of forest) collectRecords(node, allRecords);
  if (anchorRecord) allRecords.push(anchorRecord);

  const ctx = await buildProjectCtx(bundle, allRecords, requesterUserId, resolveAuthor, hide, opts);

  const comments = forest
    .map((node) => projectNode(node, ctx))
    .filter((node): node is CommentItem => node !== null);

  return {
    comments,
    anchor: anchorRecord ? projectAnchor(anchorRecord, ctx) : null,
    nextCursor: hasMore && lastFetched ? lastFetched.contributionId : null,
    rootFound: true,
  };
}
