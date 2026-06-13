// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical thread contracts + state machines (WS-G.1.1/WS-G.3.3, SPEC
// §22.1/§6.4/§15.4).  A thread is the conversation shell of a story branch,
// read through six fixed STRUCTURED SECTIONS (§6.4) — never a flat list —
// and carries two ORTHOGONAL state dimensions:
//
//   conversation_state — the discourse lifecycle (WS-G.1.1 graph below);
//   safety_state       — the trust-and-safety posture (audited, WS-J seam).
//
// Design note (documented deviation): the WS-G.1.1 transition text lists
// `restricted` as an `under_review` outcome, but `restricted` is not a member
// of the six-value conversation enum — it is a SAFETY state.  A review that
// ends in restriction therefore transitions `safety_state → restricted`
// while the conversation dimension returns to `active`/`resolved`/`archived`.
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { contributionPublicSchema } from './contribution.js';
import { summaryLayerSchema, summaryPublicSchema } from './summary.js';

// ---------------------------------------------------------------------------
// Structured reading sections (§6.4; the tab order is fixed).
// ---------------------------------------------------------------------------

export const BRANCH_IDS = [
  'overview',
  'questions',
  'evidence',
  'challenges',
  'lenses',
  'chronology',
] as const;
export type BranchId = (typeof BRANCH_IDS)[number];
export const branchIdSchema = z.enum(BRANCH_IDS);

// ---------------------------------------------------------------------------
// Conversation state (WS-G.1.1).
// ---------------------------------------------------------------------------

export const THREAD_CONVERSATION_STATES = [
  'active',
  'deepening',
  'tense',
  'under_review',
  'resolved',
  'archived',
] as const;
export type ThreadConversationState = (typeof THREAD_CONVERSATION_STATES)[number];
export const threadConversationStateSchema = z.enum(THREAD_CONVERSATION_STATES);

/**
 * The WS-G.1.1 legal conversation graph:
 *   active → {deepening, tense, under_review, resolved}
 *   tense ⇄ under_review
 *   under_review → {active, resolved}   (restriction rides safety_state)
 *   any non-archived state → archived
 * Self-loops are not transitions; `archived` is terminal.
 */
const CONVERSATION_GRAPH: Readonly<
  Record<ThreadConversationState, readonly ThreadConversationState[]>
> = {
  active: ['deepening', 'tense', 'under_review', 'resolved', 'archived'],
  deepening: ['archived'],
  tense: ['under_review', 'archived'],
  under_review: ['tense', 'active', 'resolved', 'archived'],
  resolved: ['archived'],
  archived: [],
};

/** Whether `from → to` is a legal WS-G.1.1 conversation transition. */
export function isLegalConversationTransition(
  from: ThreadConversationState,
  to: ThreadConversationState,
): boolean {
  return CONVERSATION_GRAPH[from].includes(to);
}

// ---------------------------------------------------------------------------
// Thread safety state (WS-G.1.1).  Distinct from the WS-E ITEM safety states
// (normal/frozen/removed) that pin PWAtt scores — this dimension describes
// the THREAD's moderation posture and every change is audit-logged.
// ---------------------------------------------------------------------------

export const THREAD_SAFETY_STATES = ['normal', 'elevated', 'under_review', 'restricted'] as const;
export type ThreadSafetyState = (typeof THREAD_SAFETY_STATES)[number];
export const threadSafetyStateSchema = z.enum(THREAD_SAFETY_STATES);

/**
 * Safety graph (WS-G.1.1 "transitions are validated"; design documented in
 * docs/forum/README.md): escalation may move one step or — for imminent harm
 * (§18.3 emergency flows) — jump straight to `restricted`; de-escalation
 * always passes review (`restricted → under_review` is the appeal path).
 */
const SAFETY_GRAPH: Readonly<Record<ThreadSafetyState, readonly ThreadSafetyState[]>> = {
  normal: ['elevated', 'under_review', 'restricted'],
  elevated: ['normal', 'under_review', 'restricted'],
  under_review: ['normal', 'elevated', 'restricted'],
  restricted: ['under_review'],
};

/** Whether `from → to` is a legal thread-safety transition. */
export function isLegalThreadSafetyTransition(
  from: ThreadSafetyState,
  to: ThreadSafetyState,
): boolean {
  return SAFETY_GRAPH[from].includes(to);
}

// ---------------------------------------------------------------------------
// Wire projections.
// ---------------------------------------------------------------------------

export const threadSummarySchema = z
  .object({
    thread_id: uuidSchema,
    story_id: uuidSchema,
    room_id: uuidSchema.nullable(),
    branch_index: z.number().int().min(0),
    title: z.string().min(1),
    conversation_state: threadConversationStateSchema,
    safety_state: threadSafetyStateSchema,
    contribution_count: z.number().int().min(0),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

/** Active-conversation list (GET /v1/threads): keyset-paginated summaries. */
export const threadListResponseSchema = z
  .object({
    threads: z.array(threadSummarySchema).max(50),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type ThreadListResponse = z.infer<typeof threadListResponseSchema>;

/** Current-summary status shown in the overview (§15.4 three layers). */
export const threadSummaryStatusSchema = z.enum([
  'none',
  'automated_draft',
  'community_synthesis',
  'steward_summary',
]);
export type ThreadSummaryStatus = z.infer<typeof threadSummaryStatusSchema>;

/**
 * Thread overview (WS-G.3.3 `GET /v1/threads/:id`): the branch index — each
 * structured section with its contribution count — plus the current summary.
 * Section contents load lazily through the branch endpoint.
 */
export const threadDetailSchema = threadSummarySchema
  .extend({
    sections: z
      .object({
        overview: z.number().int().min(0),
        questions: z.number().int().min(0),
        evidence: z.number().int().min(0),
        challenges: z.number().int().min(0),
        lenses: z.number().int().min(0),
        chronology: z.number().int().min(0),
      })
      .strict(),
    summary_status: threadSummaryStatusSchema,
    current_summary: summaryPublicSchema.nullable(),
    /** All summary layers present on this thread (§15.4). */
    summary_layers: z.array(summaryLayerSchema),
  })
  .strict();
export type ThreadDetail = z.infer<typeof threadDetailSchema>;

/**
 * One structured section's content (WS-G.3.3 branch endpoint): contributions
 * in tree order with depth indicators, lazily loaded (cursor after 50).
 */
export const branchContentSchema = z
  .object({
    thread_id: uuidSchema,
    branch: branchIdSchema,
    contributions: z.array(contributionPublicSchema).max(50),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type BranchContent = z.infer<typeof branchContentSchema>;

/** Subtree read (WS-G.1.2d-2 `?root=` view): a root and its descendants. */
export const contributionSubtreeSchema = z
  .object({
    thread_id: uuidSchema,
    root_contribution_id: uuidSchema,
    contributions: z.array(contributionPublicSchema).max(500),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type ContributionSubtree = z.infer<typeof contributionSubtreeSchema>;
