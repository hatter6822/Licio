// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread + branch contracts (SPEC §22.1 Thread, §23.2 routes). A thread is read
// through six fixed semantic branches (WS-B.2.12), not a flat comment stream.
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { safetyStateSchema } from './feed.js';

/** The six canonical thread branches (WS-B.2.12). Order is the tab order. */
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

/** Lifecycle of a conversation (SPEC §22.1 conversation_state). */
export const conversationStateSchema = z.enum([
  'emerging',
  'active',
  'deepening',
  'resolved',
  'dormant',
]);

export const threadSummarySchema = z.object({
  thread_id: uuidSchema,
  story_id: uuidSchema,
  room_id: uuidSchema.nullable(),
  title: z.string().min(1),
  conversation_state: conversationStateSchema,
  safety_state: safetyStateSchema,
  created_at: isoTimestampSchema,
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadDetailSchema = threadSummarySchema.extend({
  /** Branches that currently hold content (drives the WS-B.2.12 tab set). */
  available_branches: z.array(branchIdSchema),
  current_summary: z.string().nullable(),
});
export type ThreadDetail = z.infer<typeof threadDetailSchema>;

/** A single rendered contribution within a branch. */
export const branchContributionSchema = z.object({
  contribution_id: uuidSchema,
  author_handle: z.string().min(1),
  body: z.string(),
  created_at: isoTimestampSchema,
});

export const branchContentSchema = z.object({
  thread_id: uuidSchema,
  branch: branchIdSchema,
  contributions: z.array(branchContributionSchema),
});
export type BranchContent = z.infer<typeof branchContentSchema>;
