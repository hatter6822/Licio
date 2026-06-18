// SPDX-License-Identifier: AGPL-3.0-or-later
import { type CommentItem, type ContributionPublic, isAnimatableImage } from '@licio/shared';
import type { IngestionServices } from '../ingestion/services.js';
import type { MediaUrlMinter } from '../lib/media-urls.js';
import type { ForumServices } from './services.js';
import type { ContributionRecord, UploadRecord } from './stores.js';
import type { AuthorResolver } from './threads.js';
import { toContributionPublic, viewerHideSet, visibleRows } from './threads.js';

export const REPLY_PREVIEW = 3;

interface Bundle {
  forum: ForumServices;
  ingestion: IngestionServices;
}

export type CommentFilter = 'sources' | 'corrections';

export interface CommentPageOptions {
  cursor: string | null;
  order: 'newest' | 'oldest';
  filter?: CommentFilter;
  restrictedMedia: boolean;
  mintMediaUrl: MediaUrlMinter;
}

export interface CommentPageResult {
  comments: CommentItem[];
  nextCursor: string | null;
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

async function projectRows(
  bundle: Bundle,
  rows: readonly { row: ContributionRecord; tombstone: boolean }[],
  requesterUserId: string | null,
  resolveAuthor: AuthorResolver,
  mediaById: ReadonlyMap<string, NonNullable<ContributionPublic['media']>>,
): Promise<ContributionPublic[]> {
  const childCounts = await bundle.forum.contributions.childCounts(
    rows.map((entry) => entry.row.contributionId),
  );
  const projected: ContributionPublic[] = [];
  for (const entry of rows) {
    const author = entry.tombstone ? null : await resolveAuthor(entry.row.userId);
    const item = toContributionPublic(
      entry.row,
      author,
      childCounts.get(entry.row.contributionId) ?? 0,
      requesterUserId,
      entry.tombstone,
    );
    const media = entry.tombstone ? undefined : mediaById.get(entry.row.contributionId);
    projected.push(media ? { ...item, media } : item);
  }
  return projected;
}

async function toCommentItem(
  bundle: Bundle,
  root: ContributionRecord,
  requesterUserId: string | null,
  resolveAuthor: AuthorResolver,
  hide: ReadonlySet<string> | undefined,
  mediaById: ReadonlyMap<string, NonNullable<ContributionPublic['media']>>,
): Promise<CommentItem | null> {
  const children = await bundle.forum.contributions.listChildren(root.contributionId, {
    states: ['published', 'under_review', 'hidden', 'removed'],
    limit: REPLY_PREVIEW + 1,
  });
  const visibleWithPreview = visibleRows(
    [root, ...children.slice(0, REPLY_PREVIEW)],
    requesterUserId,
    hide,
  );
  const rootVisible = visibleWithPreview.filter(
    (entry) => entry.row.contributionId === root.contributionId,
  );
  if (rootVisible.length === 0) return null;
  const visibleChildren = visibleWithPreview.filter(
    (entry) => entry.row.contributionId !== root.contributionId,
  );
  const projected = await projectRows(
    bundle,
    [...rootVisible, ...visibleChildren],
    requesterUserId,
    resolveAuthor,
    mediaById,
  );
  const [head, ...replies] = projected;
  if (!head) return null;
  return {
    ...head,
    replies: replies.map((reply) => ({
      ...reply,
      replies: [],
      reply_count: reply.child_count,
      has_more_replies: reply.child_count > 0,
    })),
    reply_count: head.child_count,
    has_more_replies: children.length > REPLY_PREVIEW || head.child_count > REPLY_PREVIEW,
  };
}

export async function commentPage(
  bundle: Bundle,
  threadId: string,
  requesterUserId: string | null,
  resolveAuthor: AuthorResolver,
  opts: CommentPageOptions,
): Promise<CommentPageResult> {
  const pageSize = bundle.forum.config().branchPageSize;
  let after: { createdAt: string; id: string } | null = null;
  if (opts.cursor !== null) {
    const last = await bundle.forum.contributions.getById(opts.cursor);
    if (last && last.threadId === threadId)
      after = { createdAt: last.createdAt, id: last.contributionId };
  }
  const types = filterTypes(opts.filter);
  const roots = await bundle.forum.contributions.listRoots(threadId, {
    ...(types !== undefined ? { types } : {}),
    states: ['published', 'under_review', 'hidden', 'removed'],
    after,
    limit: pageSize + 1,
    order: opts.order,
  });
  const hasMore = roots.length > pageSize;
  const page = roots.slice(0, pageSize);
  const lastFetched = page[page.length - 1];
  const hide = await viewerHideSet(bundle, requesterUserId);
  const childrenForMedia: ContributionRecord[] = [];
  for (const root of page) {
    childrenForMedia.push(
      ...(await bundle.forum.contributions.listChildren(root.contributionId, {
        states: ['published', 'under_review', 'hidden', 'removed'],
        limit: REPLY_PREVIEW,
      })),
    );
  }
  const mediaById = await resolveMedia(
    bundle,
    [...page, ...childrenForMedia],
    opts.mintMediaUrl,
    opts.restrictedMedia,
  );
  const comments: CommentItem[] = [];
  for (const root of page) {
    const item = await toCommentItem(bundle, root, requesterUserId, resolveAuthor, hide, mediaById);
    if (item) comments.push(item);
  }
  return { comments, nextCursor: hasMore && lastFetched ? lastFetched.contributionId : null };
}
