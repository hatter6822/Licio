// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Private Signal Ledger (SPEC §5.1, §19.3; WS-B.2.6). The ledger is the user's
// own, private view of how their attention was counted — buckets and cap status,
// never a public per-user score (no-applause doctrine). It mirrors the bucketed
// AttentionAggregate so the user sees exactly what the cap (WS-C.4.1c) did.
import { z } from 'zod';
import {
  branchDepthBucketSchema,
  dwellBucketSchema,
  returnVisitBucketSchema,
} from './attention.js';
import { isoTimestampSchema, paginatedSchema, uuidSchema } from './common.js';

export const signalLedgerEntrySchema = z.object({
  item_id: uuidSchema,
  story_title: z.string().min(1),
  recorded_at: isoTimestampSchema,
  active_dwell_bucket: dwellBucketSchema,
  source_opened: z.boolean(),
  context_opened: z.boolean(),
  branch_depth_bucket: branchDepthBucketSchema,
  return_visit_count_bucket: returnVisitBucketSchema,
  /** True when the per-item cap was reached and counting stopped (WS-C.4.1c). */
  cap_reached: z.boolean(),
});
export type SignalLedgerEntry = z.infer<typeof signalLedgerEntrySchema>;

export const signalLedgerResponseSchema = paginatedSchema(signalLedgerEntrySchema);
export type SignalLedgerResponse = z.infer<typeof signalLedgerResponseSchema>;
