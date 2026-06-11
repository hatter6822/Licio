// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Summary service (WS-G.1.4, SPEC §15.4/§24.3).  Three layers; user-facing
// creation covers community_synthesis (any verified member) and
// steward_summary (steward role required — validated at write time).
// Setting `Thread.current_summary_id` follows the layer ladder: an automated
// draft can NEVER become the current summary while no human layer exists,
// and a steward summary supersedes a community synthesis.  Every summary
// write and current-pointer change is audited.

import { randomUUID } from 'node:crypto';
import type { SummaryCreateRequest } from '@licio/shared';
import type { AuditStore } from '../identity/audit.js';
import type { EvidenceCardStore, StoryStore } from '../ingestion/stores.js';
import type { ForumServices } from './services.js';
import type { SummaryRecord } from './stores.js';

export interface SummaryDeps {
  forum: ForumServices;
  stories: StoryStore;
  evidence: EvidenceCardStore;
  audit: AuditStore;
}

export type SummaryCreateOutcome =
  | { ok: true; summary: SummaryRecord; becameCurrent: boolean }
  | {
      ok: false;
      status: 403 | 404 | 422;
      code: 'not_found' | 'steward_required' | 'invalid_citation';
      message: string;
    };

const LAYER_RANK = { automated_draft: 0, community_synthesis: 1, steward_summary: 2 } as const;

/** Whether `candidate` may take over the current-summary pointer. */
export function supersedesCurrent(
  candidate: SummaryRecord['layer'],
  current: SummaryRecord['layer'] | null,
): boolean {
  if (candidate === 'automated_draft') return false; // never final (§15.4)
  if (current === null) return true;
  return LAYER_RANK[candidate] >= LAYER_RANK[current];
}

/** Create a community/steward summary (WS-G.1.4). */
export async function createSummary(
  deps: SummaryDeps,
  request: SummaryCreateRequest,
  authorUserId: string,
  isSteward: boolean,
): Promise<SummaryCreateOutcome> {
  const thread = await deps.stories.getThreadById(request.thread_id);
  if (!thread) {
    return { ok: false, status: 404, code: 'not_found', message: 'Thread not found' };
  }
  if (request.layer === 'steward_summary' && !isSteward) {
    return {
      ok: false,
      status: 403,
      code: 'steward_required',
      message: 'Steward summaries require a steward role',
    };
  }
  // Cited branches must be contributions of THIS thread (WS-G.1.4: a
  // summary in another thread can never become current here; citations are
  // validated at write time for the same reason).
  for (const branchId of request.cited_branch_ids) {
    const branch = await deps.forum.contributions.getById(branchId);
    if (!branch || branch.threadId !== request.thread_id) {
      return {
        ok: false,
        status: 422,
        code: 'invalid_citation',
        message: 'Cited branches must be contributions in the same thread',
      };
    }
  }
  // Cited evidence must be REAL cards reachable from this thread — either
  // attached to its story or introduced by one of its contributions.  A
  // current summary's §24.3 provenance trail can never point at arbitrary
  // UUIDs or another story's evidence.
  for (const evidenceId of request.cited_evidence_ids) {
    const card = await deps.evidence.getById(evidenceId);
    const viaStory = card !== null && card.storyId !== null && card.storyId === thread.storyId;
    const viaContribution =
      card !== null &&
      card.contributionId !== null &&
      (await deps.forum.contributions.getById(card.contributionId))?.threadId === request.thread_id;
    if (!viaStory && !viaContribution) {
      return {
        ok: false,
        status: 422,
        code: 'invalid_citation',
        message: 'Cited evidence must belong to this thread or its story',
      };
    }
  }

  const summary = await deps.forum.summaries.insert({
    summaryId: randomUUID(),
    threadId: request.thread_id,
    layer: request.layer,
    body: request.body,
    citedBranchIds: request.cited_branch_ids,
    citedEvidenceIds: request.cited_evidence_ids,
    unresolvedUncertainty: request.unresolved_uncertainty,
    minorityViewsNote: request.minority_views_note ?? null,
    authoredBy: authorUserId,
    approvedBy: request.layer === 'steward_summary' ? authorUserId : null,
  });

  // Current-pointer ladder.
  const currentLayer =
    thread.currentSummaryId !== null
      ? ((await deps.forum.summaries.getById(thread.currentSummaryId))?.layer ?? null)
      : null;
  const becameCurrent = supersedesCurrent(summary.layer, currentLayer);
  if (becameCurrent) {
    await deps.stories.updateThread(thread.threadId, { currentSummaryId: summary.summaryId });
  }

  await deps.audit.append({
    actorUserId: authorUserId,
    eventType: 'summary_change',
    targetRef: summary.summaryId,
    context: {
      setting: 'summary_layer',
      new_value: summary.layer,
      reason: becameCurrent ? 'created; set as current summary' : 'created',
    },
  });
  deps.forum.metrics.increment(`summaries.created.${request.layer}`);
  return { ok: true, summary, becameCurrent };
}
