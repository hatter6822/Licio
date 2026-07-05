// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread reading service (WS-G.3.3, SPEC §6.4/§15.4): the six structured
// sections, branch content in DFS tree order with depth indicators,
// `?root=` subtree reads off the materialized path, semantic anchors for
// deep links, and the layered summary status.
//
// Visibility (§18.4 default-hiding + tree integrity): readers see
// `published` rows; the AUTHOR also sees their own under_review rows
// (labeled); hidden/removed/under_review rows with published descendants
// render as empty TOMBSTONES so subtrees never orphan.
import type {
  ContributionAnchor,
  ContributionPublic,
  SummaryPublic,
  ThreadDetail,
  ThreadSummaryStatus,
} from '@licio/shared';
import type { IngestionServices } from '../ingestion/services.js';
import type { ThreadShellRecord } from '../ingestion/stores.js';
import type { ForumServices } from './services.js';
import type { ContributionRecord, SummaryRecord } from './stores.js';
import { orderDepthFirst, subtreeRootId } from './tree.js';

interface Bundle {
  forum: ForumServices;
  ingestion: IngestionServices;
}

/** Resolve a user's public identity for projections (null = tombstone). */
export type AuthorResolver = (
  userId: string | null,
) => Promise<{ handle: string; displayName: string } | null>;

/** Project a stored contribution to the public wire shape. */
export function toContributionPublic(
  record: ContributionRecord,
  author: { handle: string; displayName: string } | null,
  childCount: number,
  requesterUserId: string | null,
  tombstone: boolean,
): ContributionPublic {
  return {
    contribution_id: record.contributionId,
    thread_id: record.threadId,
    type: record.type,
    body: tombstone ? '' : record.body,
    citations: tombstone ? [] : record.citations,
    metadata: tombstone ? {} : record.metadata,
    target_claim_id: record.targetClaimId,
    parent_contribution_id: record.parentContributionId,
    author_handle: tombstone ? null : (author?.handle ?? null),
    author_display_name: tombstone ? null : (author?.displayName ?? null),
    is_author: requesterUserId !== null && record.userId === requesterUserId,
    depth: record.path.length,
    child_count: childCount,
    moderation_state: record.moderationState,
    // WS-T dispute posture (visible-but-sunk); a tombstone carries none. The open
    // arena id (active_debate_id) is threaded in by the comment/thread readers
    // that hold the debate store; a bare projection defaults to null.
    dispute_status: tombstone ? 'none' : record.disputeStatus,
    active_debate_id: null,
    edited: record.editHistoryRef !== null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

/**
 * Visibility filter + tombstone marking (see module header).  Returns the
 * rows to render in order, with a tombstone flag per row.
 */
export function visibleRows(
  rows: readonly ContributionRecord[],
  requesterUserId: string | null,
  hideAuthorIds?: ReadonlySet<string>,
): Array<{ row: ContributionRecord; tombstone: boolean }> {
  // WS-J.1.2 — content authored by a blocked/muted user is hidden FROM THE
  // VIEWER (a row with visible descendants still tombstones for tree integrity;
  // a leaf simply disappears).  The viewer's own rows are never in their set.
  const visible = (row: ContributionRecord): boolean =>
    (row.moderationState === 'published' ||
      (row.moderationState === 'under_review' &&
        requesterUserId !== null &&
        row.userId === requesterUserId)) &&
    (hideAuthorIds === undefined || row.userId === null || !hideAuthorIds.has(row.userId));
  const visibleIds = new Set(rows.filter(visible).map((row) => row.contributionId));
  // A non-visible row renders as a tombstone exactly when a visible row
  // descends from it (tree integrity).
  const tombstoneIds = new Set<string>();
  for (const row of rows) {
    if (!visibleIds.has(row.contributionId)) continue;
    for (const ancestor of row.path) {
      if (!visibleIds.has(ancestor)) tombstoneIds.add(ancestor);
    }
  }
  return rows
    .filter((row) => visibleIds.has(row.contributionId) || tombstoneIds.has(row.contributionId))
    .map((row) => ({ row, tombstone: !visibleIds.has(row.contributionId) }));
}

/**
 * The viewer's blocked∪muted author-id hide set (WS-J.1.2), or undefined when
 * there is no viewer or no relationship reader is wired (forum standalone).
 */
export async function viewerHideSet(
  bundle: Bundle,
  requesterUserId: string | null,
): Promise<Set<string> | undefined> {
  const reader = bundle.forum.relationshipReader;
  if (requesterUserId === null || reader === null) return undefined;
  const sets = await reader.setsFor(requesterUserId);
  const hide = new Set<string>(sets.blocked);
  for (const id of sets.muted) hide.add(id);
  return hide.size > 0 ? hide : undefined;
}

function summaryStatus(summaries: readonly SummaryRecord[]): ThreadSummaryStatus {
  if (summaries.some((s) => s.layer === 'steward_summary')) return 'steward_summary';
  if (summaries.some((s) => s.layer === 'community_synthesis')) return 'community_synthesis';
  if (summaries.some((s) => s.layer === 'automated_draft')) return 'automated_draft';
  return 'none';
}

export async function toSummaryPublic(
  summary: SummaryRecord,
  resolveAuthor: AuthorResolver,
): Promise<SummaryPublic> {
  const author = await resolveAuthor(summary.authoredBy);
  const approver = await resolveAuthor(summary.approvedBy);
  return {
    summary_id: summary.summaryId,
    thread_id: summary.threadId,
    layer: summary.layer,
    body: summary.body,
    cited_contribution_ids:
      (summary.citedContributionIds?.length ?? 0) > 0
        ? (summary.citedContributionIds ?? [])
        : summary.citedBranchIds,
    cited_evidence_ids: summary.citedEvidenceIds,
    unresolved_uncertainty: summary.unresolvedUncertainty,
    minority_views_note: summary.minorityViewsNote,
    machine_generated: summary.layer === 'automated_draft',
    authored_by_handle: author?.handle ?? null,
    approved_by_handle: approver?.handle ?? null,
    created_at: summary.createdAt,
    updated_at: summary.updatedAt,
  };
}

/** Thread overview (WS-G.3.3): branch index + summary status. */
export async function threadOverview(
  bundle: Bundle,
  thread: ThreadShellRecord,
  title: string,
  resolveAuthor: AuthorResolver,
): Promise<ThreadDetail> {
  const counts = await bundle.forum.contributions.countByType(thread.threadId, ['published']);
  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  const section = (types: readonly string[]): number =>
    types.reduce((sum, type) => sum + (counts[type as keyof typeof counts] ?? 0), 0);

  const summaries = await bundle.forum.summaries.listByThread(thread.threadId);
  const current =
    thread.currentSummaryId !== null
      ? (summaries.find((s) => s.summaryId === thread.currentSummaryId) ?? null)
      : null;

  return {
    thread_id: thread.threadId,
    story_id: thread.storyId,
    room_id: thread.roomId,
    branch_index: thread.branchIndex,
    title,
    conversation_state: thread.conversationState,
    safety_state: thread.safetyState,
    contribution_count: total,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    sections: {
      overview: section(['synthesis']),
      questions: section(['question', 'answer']),
      evidence: section(['evidence', 'counterexample']),
      challenges: section(['correction']),
      lenses: section(['local_context', 'direct_experience']),
      chronology: total,
    },
    summary_status: summaryStatus(summaries),
    current_summary: current ? await toSummaryPublic(current, resolveAuthor) : null,
    summary_layers: [...new Set(summaries.map((s) => s.layer))],
  };
}

/**
 * Subtree read (WS-G.1.2d-2 `?root=`): a root and its descendants, paged.
 * Pagination is COMPLETE over arbitrarily large subtrees: pages walk the
 * store-level `(created_at, id)` keyset (the cursor is the last fetched
 * contribution id, recovered to its keyset position via one read), and each
 * page is depth-first ordered locally — a row whose parent landed on an
 * earlier page renders as a local root with its ABSOLUTE depth indicator
 * preserved (the documented `orderDepthFirst` degradation).  The cursor
 * advances over rows the requester cannot see (visibility filtering happens
 * after the fetch), so hidden rows can never stall the walk.
 */
export async function subtreeContent(
  bundle: Bundle,
  threadId: string,
  rootId: string,
  requesterUserId: string | null,
  resolveAuthor: AuthorResolver,
  cursor: string | null,
): Promise<{ rows: ContributionPublic[]; rootFound: boolean; nextCursor: string | null }> {
  const empty = { rows: [], rootFound: false, nextCursor: null };
  const root = await bundle.forum.contributions.getById(rootId);
  if (!root || root.threadId !== threadId) return empty;
  const hide = await viewerHideSet(bundle, requesterUserId);
  // An invisible root gates EVERY page (a removed — or blocked-author —
  // contribution must not anchor enumeration of the conversation beneath it).
  if (visibleRows([root], requesterUserId, hide).length === 0) return empty;
  const config = bundle.forum.config();

  // Recover the keyset position from the opaque cursor; an unknown or
  // foreign-subtree cursor restarts from the beginning (the branchContent
  // fallback semantics — defensive, never an error).
  let after: { createdAt: string; id: string } | null = null;
  if (cursor !== null) {
    const last = await bundle.forum.contributions.getById(cursor);
    if (last && (last.contributionId === rootId || last.path.includes(rootId))) {
      after = { createdAt: last.createdAt, id: last.contributionId };
    }
  }

  const pageSize = config.branchPageSize;
  const fetched = await bundle.forum.contributions.listDescendants(rootId, {
    after,
    limit: pageSize + 1,
  });
  const hasMore = fetched.length > pageSize;
  const page = fetched.slice(0, pageSize);
  const lastFetched = page[page.length - 1];

  // The root row itself heads the first page only.
  const candidates = after === null ? [root, ...page] : page;
  const renderable = visibleRows(candidates, requesterUserId, hide);
  const byId = new Map(renderable.map((entry) => [entry.row.contributionId, entry]));
  const ordered = orderDepthFirst(renderable.map((entry) => entry.row));
  const childCounts = await bundle.forum.contributions.childCounts(
    ordered.map((row) => row.contributionId),
  );
  const rows: ContributionPublic[] = [];
  for (const row of ordered) {
    const entry = byId.get(row.contributionId);
    if (!entry) continue;
    const author = entry.tombstone ? null : await resolveAuthor(entry.row.userId);
    rows.push(
      toContributionPublic(
        entry.row,
        author,
        childCounts.get(row.contributionId) ?? 0,
        requesterUserId,
        entry.tombstone,
      ),
    );
  }
  return {
    rows,
    rootFound: true,
    nextCursor: hasMore && lastFetched ? lastFetched.contributionId : null,
  };
}

/** Semantic anchor for a deep link (WS-G.3.3). */
export function contributionAnchor(record: ContributionRecord): ContributionAnchor {
  return {
    contribution_id: record.contributionId,
    thread_id: record.threadId,
    root_contribution_id: subtreeRootId(record),
  };
}
