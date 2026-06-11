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
  BranchContent,
  BranchId,
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
import { orderDepthFirst, SECTION_TYPES, sectionOfType, subtreeRootId } from './tree.js';

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
): Array<{ row: ContributionRecord; tombstone: boolean }> {
  const visible = (row: ContributionRecord): boolean =>
    row.moderationState === 'published' ||
    (row.moderationState === 'under_review' &&
      requesterUserId !== null &&
      row.userId === requesterUserId);
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
    cited_branch_ids: summary.citedBranchIds,
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
      overview: section(SECTION_TYPES.overview),
      questions: section(SECTION_TYPES.questions),
      evidence: section(SECTION_TYPES.evidence),
      challenges: section(SECTION_TYPES.challenges),
      lenses: section(SECTION_TYPES.lenses),
      chronology: total,
    },
    summary_status: summaryStatus(summaries),
    current_summary: current ? await toSummaryPublic(current, resolveAuthor) : null,
    summary_layers: [...new Set(summaries.map((s) => s.layer))],
  };
}

/**
 * One structured section's content (WS-G.3.3 branch endpoint).  Tree
 * sections page over the deterministic DFS sequence; chronology pages over
 * flat `(created_at, id)` order.  `cursor` is the last contribution id of
 * the previous page (recompute-and-skip over the bounded fetch — the order
 * is deterministic, so resumption is exact).
 */
export async function branchContent(
  bundle: Bundle,
  threadId: string,
  branch: BranchId,
  requesterUserId: string | null,
  resolveAuthor: AuthorResolver,
  cursor: string | null,
): Promise<BranchContent> {
  const config = bundle.forum.config();
  const fetchOpts = {
    states: ['published', 'under_review', 'hidden', 'removed'] as const,
    limit: config.threadFetchLimit,
  };
  const rows =
    branch === 'chronology'
      ? await bundle.forum.contributions.listByThread(threadId, { ...fetchOpts })
      : await bundle.forum.contributions.listByThread(threadId, {
          ...fetchOpts,
          types: SECTION_TYPES[branch],
        });

  const renderable = visibleRows(rows, requesterUserId);
  const ordered =
    branch === 'chronology'
      ? renderable // already (created_at, id) ascending
      : (() => {
          const byId = new Map(renderable.map((entry) => [entry.row.contributionId, entry]));
          return orderDepthFirst(renderable.map((entry) => entry.row)).map((row) => {
            const entry = byId.get(row.contributionId);
            return entry ?? { row, tombstone: true };
          });
        })();

  const startIndex =
    cursor === null
      ? 0
      : (() => {
          const at = ordered.findIndex((entry) => entry.row.contributionId === cursor);
          return at >= 0 ? at + 1 : 0;
        })();
  const page = ordered.slice(startIndex, startIndex + config.branchPageSize);
  const last = page[page.length - 1];
  const nextCursor =
    startIndex + page.length < ordered.length && last ? last.row.contributionId : null;

  const childCounts = await bundle.forum.contributions.childCounts(
    page.map((entry) => entry.row.contributionId),
  );
  const contributions: ContributionPublic[] = [];
  for (const entry of page) {
    const author = entry.tombstone ? null : await resolveAuthor(entry.row.userId);
    contributions.push(
      toContributionPublic(
        entry.row,
        author,
        childCounts.get(entry.row.contributionId) ?? 0,
        requesterUserId,
        entry.tombstone,
      ),
    );
  }
  return { thread_id: threadId, branch, contributions, next_cursor: nextCursor };
}

/** Subtree read (WS-G.1.2d-2 `?root=`): a root and all its descendants. */
export async function subtreeContent(
  bundle: Bundle,
  threadId: string,
  rootId: string,
  requesterUserId: string | null,
  resolveAuthor: AuthorResolver,
): Promise<{ rows: ContributionPublic[]; rootFound: boolean }> {
  const root = await bundle.forum.contributions.getById(rootId);
  if (!root || root.threadId !== threadId) return { rows: [], rootFound: false };
  const config = bundle.forum.config();
  const descendants = await bundle.forum.contributions.listDescendants(rootId, config.subtreeLimit);
  const renderable = visibleRows([root, ...descendants], requesterUserId);
  const byId = new Map(renderable.map((entry) => [entry.row.contributionId, entry]));
  if (!byId.has(rootId)) return { rows: [], rootFound: false }; // invisible root, no oracle
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
  return { rows, rootFound: true };
}

/** Semantic anchor for a deep link (WS-G.3.3). */
export function contributionAnchor(record: ContributionRecord): ContributionAnchor {
  return {
    contribution_id: record.contributionId,
    thread_id: record.threadId,
    branch: sectionOfType(record.type),
    root_contribution_id: subtreeRootId(record),
  };
}
