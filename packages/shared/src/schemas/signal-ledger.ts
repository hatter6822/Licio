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

/**
 * Anti-signals a user may see applied in their own ledger (SPEC §5.3,
 * WS-E.2.1d transparency). Named after the §5.3 anti-signal table; the
 * plain-language `summary` explains each in words.
 */
export const LEDGER_ANTI_SIGNALS = [
  'rapid_repetition',
  'coordinated_burst',
  'rage_loop',
  'source_free_accusation',
  'brigading',
  'harassment_cascade',
] as const;
export type LedgerAntiSignal = (typeof LEDGER_ANTI_SIGNALS)[number];
export const ledgerAntiSignalSchema = z.enum(LEDGER_ANTI_SIGNALS);

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
  // --- WS-E.2.1d additions (optional: pre-WS-E entries omit them) -----------
  /** Anti-signals applied to this item/window, shown for transparency (§5.3). */
  anti_signals: z.array(ledgerAntiSignalSchema).max(8).optional(),
  /** The user's own PWAtt v0 shadow score for the item/window (0-1, §30.5). */
  pwatt_v0_score: z.number().min(0).max(1).optional(),
  /** Plain-language explanation of how the signals were counted (§19.3). */
  summary: z.string().min(1).max(500).optional(),
});
export type SignalLedgerEntry = z.infer<typeof signalLedgerEntrySchema>;

export const signalLedgerResponseSchema = paginatedSchema(signalLedgerEntrySchema);
export type SignalLedgerResponse = z.infer<typeof signalLedgerResponseSchema>;
